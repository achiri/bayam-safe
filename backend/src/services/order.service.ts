import { AGENCIES, CITIES, getAgency } from '../domain/agencies.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../domain/errors.js';
import { assertGeoPoint, haversineKm } from '../domain/geo.js';
import { computePricing, formatFcfa, refundPlan, settlementPlan, PayoutPlanLine, SELLER_DEBT_COD_LIMIT } from '../domain/money.js';
import { DISPUTABLE_STATUSES, TERMINAL_STATUSES, canTransition, deliverableStatus, transition } from '../domain/order-state.js';
import { detectOperator, normalizeCameroonPhone, normalizeContactPhone } from '../domain/phone.js';
import { Secrets, newId, newReleaseCode, newTrackingCode, safeEqual } from '../domain/secrets.js';
import {
  Dispute, GeoPoint, Lang, LedgerAccount, Operator, Order, OrderStatus, OrderType, PaymentMode, Payout, PayoutKind, Rider, User
} from '../domain/types.js';
import { PaymentGateway, Transaction } from '../payments/gateway.js';
import { Repo, Store } from '../storage/store.js';
import { DispatchService } from './dispatch.service.js';
import { EventBus } from './events.js';
import { RiderService } from './rider.service.js';

export interface OrderSettings {
  commissionPct: number;
  paymentTtlHours: number;
  maxCodeAttempts: number;
  publicUrl: string;
}

export interface CreateOrderInput {
  type: OrderType;
  paymentMode: PaymentMode;
  itemTitle: string;
  itemPrice: number;
  deliveryFee: number;
  agencyFee?: number;
  buyerPhone: string;
  buyerName?: string;
  pickupAddress: string;
  pickupLocation?: GeoPoint;
  originAgencyId?: string;
  destinationCity?: string;
  /** The seller's own rider, by the number on their badge (BSR-XXXX). */
  preferredRiderCode?: string;
  /** Person receiving the parcel, if not the buyer. */
  recipientName?: string;
  recipientPhone?: string;
}

export interface DeliveryDetailsPatch {
  dropoffAddress?: string;
  dropoffLocation?: GeoPoint;
  landmark?: string;
}

/** What the buyer's checkout page is allowed to see. */
export interface BuyerView {
  trackingCode: string;
  status: OrderStatus;
  type: OrderType;
  paymentMode: PaymentMode;
  merchantName: string;
  merchantVerified: boolean;
  itemTitle: string;
  itemPrice: number;
  deliveryFee: number;
  agencyFee: number;
  total: number;
  dropoffAddress?: string;
  dropoffLocation?: GeoPoint;
  landmark?: string;
  hasVoiceNote: boolean;
  destinationCity?: string;
  agency?: { name: string; terminal: string; city: string };
  waybillNumber?: string;
  history: { status: OrderStatus; at: string }[];
  payment: { pending: boolean; operator?: Operator; payerPhoneHint?: string };
  can: { pay: boolean; editDelivery: boolean; dispute: boolean; cancel: boolean; confirmReceived: boolean; confirmArrival: boolean; addEvidence: boolean };
  recipient?: { name?: string; phone?: string };
  absence?: { side: 'BUYER' | 'SELLER'; at: string };
  /** Only present for the device that paid (escrow) or the link holder (COD). */
  releaseCode?: string;
  /** True when the order is paid but this device is not the one that paid. */
  releaseCodeOnOtherDevice: boolean;
  /** The rider currently carrying the parcel, so the buyer knows who will knock. */
  rider?: { firstName: string; plateNumber: string; riderCode: string; vehicleType: string; hasPhoto: boolean; /** Only for the paying device (any device for COD), once the parcel is on its way. */ phone?: string };
  /** FCFA the buyer loses if they cancel now (half the delivery fee once a rider accepted a prepaid order); only present while cancellable at RIDER_ASSIGNED. */
  cancelFee?: number;
  /** Live position of the rider while the parcel is on its way to the buyer. */
  tracking?: { lat: number; lng: number; at: string; distanceKm?: number; etaMin?: number; near: boolean };
  /** Whether a Telegram account follows this order. */
  followingOnTelegram: boolean;
  dispute?: Pick<Dispute, 'reason' | 'openedAt' | 'resolution'>;
}

const MAX_PAYOUT_ATTEMPTS = 5;
const MAX_MUTATE_ATTEMPTS = 3;
/** Background jobs look at most this many orders per run, in pages of JOB_PAGE_SIZE (oldest first). */
const JOB_ORDER_CAP = 5000;
const JOB_PAGE_SIZE = 500;
const STALL_TRANSIT_MS = 6 * 3600_000;
const STALL_HUB_MS = 24 * 3600_000;
const STALL_RETURN_MS = 48 * 3600_000;
const FOLLOW_TOKEN_TTL_MS = 30 * 60 * 1000;
const NEAR_KM = 0.4;
/** Until a rider has the parcel, either side can simply cancel. */
export const CANCELLABLE: OrderStatus[] = ['PENDING_PAYMENT', 'AWAITING_RIDER', 'RIDER_ASSIGNED'];
/** "No rider found" is said at most this often per order (the search itself retries every 10 min). */
const NO_RIDER_NOTICE_MS = 6 * 3600_000;
/** Statuses in which a rider is busy with a job. */
const ACTIVE_RIDER_STATUSES: OrderStatus[] = ['RIDER_ASSIGNED', 'IN_TRANSIT', 'LAST_MILE_ASSIGNED', 'OUT_FOR_DELIVERY'];
const MAX_ACTIVE_JOBS = 3;
/** Paid but no rider for 48 h → automatic refund. */
const NO_RIDER_REFUND_MS = 48 * 3600_000;
/** Rider accepted but didn't pick up within 45 min → job released. */
const NO_SHOW_MS = 45 * 60_000;
/** How long a rider waits at the door before taking the parcel back. */
const BUYER_WAIT_MS = 15 * 60_000;
const TRACKING_FRESH_MS = 15 * 60 * 1000;
/** The buyer's "I received it" fallback only works this long after the rider picked the parcel up. */
const BUYER_CONFIRM_MIN_MS = 20 * 60_000;
/** A rider reporting an absent buyer must have shared their live position this recently... */
const ABSENCE_LOCATION_MAX_AGE_MS = 5 * 60_000;
/** ...and be within this distance (km) of the drop-off pin. */
const ABSENCE_MAX_DISTANCE_KM = 0.25;
/** Statuses in which the parcel is travelling towards the buyer. */
const HEADING_TO_BUYER: OrderStatus[] = ['IN_TRANSIT', 'OUT_FOR_DELIVERY'];
const PAYMENT_PENDING_WINDOW_MS = 2 * 60 * 1000;
const PAYMENT_POLL_INTERVAL_MS = 5 * 1000;
const SENDING_STUCK_MS = 10 * 60 * 1000;
const NON_EDITABLE: OrderStatus[] = ['DELIVERED', 'SETTLED', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'DISPUTED'];

const PAYABLE: Record<PayoutKind, LedgerAccount> = {
  MERCHANT: 'MERCHANT_PAYABLE',
  FIRST_MILE_RIDER: 'RIDER_PAYABLE',
  LAST_MILE_RIDER: 'RIDER_PAYABLE',
  BUYER_REFUND: 'BUYER_REFUND_PAYABLE'
};

/** Identifies JPEG / PNG / WebP by magic bytes. */
export function sniffImageMime(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

const text = (v: unknown, name: string, min: number, max: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < min || s.length > max) throw invalid(`${name} must be ${min}-${max} characters`);
  return s;
};
const optText = (v: unknown, name: string, max: number) => (v === undefined || v === null || v === '' ? undefined : text(v, name, 1, max));

export class OrderService {
  private readonly payoutLocks = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly gateway: PaymentGateway,
    private readonly events: EventBus,
    private readonly secrets: Secrets,
    private readonly dispatch: DispatchService,
    private readonly riders: RiderService,
    private readonly settings: OrderSettings
  ) {}

  // ------------------------------------------------------------------ helpers

  /** Loads an order inside a transaction, applies fn, saves it. fn may touch other entities via repo. */
  private async mutate<T = void>(orderId: string, fn: (o: Order, repo: Repo) => Promise<T> | T): Promise<{ order: Order; result: T }> {
    // A concurrent write to any versioned row touched by fn (the order, a rider, the seller) rolls the
    // whole transaction back with VERSION_CONFLICT. Every callback re-reads the order and re-validates
    // its preconditions on each run, so it is safe to simply run it again (bounded).
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.store.tx(async (repo) => {
          const o = await repo.getOrder(orderId);
          if (!o) throw notFound('Order');
          const result = await fn(o, repo);
          const order = await repo.updateOrder(o);
          return { order, result };
        });
      } catch (e) {
        if (attempt < MAX_MUTATE_ATTEMPTS && e instanceof AppError && e.code === 'VERSION_CONFLICT') continue;
        throw e;
      }
    }
  }

  /** Pages through every order in `statuses`, oldest first (so none is starved by newer ones), up to `cap`. */
  private async listAllOldestFirst(statuses: OrderStatus[], opts: { withPaymentReference?: boolean } = {}, cap = JOB_ORDER_CAP): Promise<Order[]> {
    const out: Order[] = [];
    let after: { updatedAt: string; id: string } | undefined;
    while (out.length < cap) {
      const want = Math.min(JOB_PAGE_SIZE, cap - out.length);
      const page = await this.store.listOrdersByStatusOldestFirst(statuses, want, after, opts);
      out.push(...page);
      if (page.length < want) break;
      const last = page[page.length - 1];
      after = { updatedAt: last.updatedAt, id: last.id };
    }
    return out;
  }

  checkoutUrl(order: Pick<Order, 'id'>, buyerToken: string): string {
    // Token goes in the URL fragment: never sent to servers, logs or referrers.
    return `${this.settings.publicUrl.replace(/\/$/, '')}/checkout.html#o=${order.id}&t=${buyerToken}`;
  }

  async get(orderId: string) {
    return this.store.getOrder(orderId);
  }

  // ------------------------------------------------------------------ creation

  async createOrder(merchant: User, input: CreateOrderInput): Promise<{ order: Order; buyerToken: string; checkoutUrl: string }> {
    if (merchant.kycStatus === 'NONE') throw new AppError('PROFILE_INCOMPLETE', 'Complete your seller profile first (/start).', 403);
    if (merchant.kycStatus === 'REJECTED') throw new AppError('PROFILE_REJECTED', 'Your seller profile was refused. Send /start to resubmit.', 403);
    if (!['INTRA_CITY', 'INTER_CITY'].includes(input.type)) throw invalid('Invalid order type');
    if (!['ESCROW', 'COD'].includes(input.paymentMode)) throw invalid('Invalid payment mode');
    if (input.type === 'INTER_CITY' && input.paymentMode === 'COD') {
      throw invalid('Cash on delivery is only available for deliveries within the same city.');
    }

    if (merchant.suspendedAt) throw new AppError('SELLER_SUSPENDED', `Votre compte vendeur est suspendu${merchant.suspendNote ? ` : ${merchant.suspendNote}` : ''}. Contactez le support.`, 403);
    const buyerPhone = normalizeContactPhone(input.buyerPhone); // contact only: may be a foreign WhatsApp number
    if (buyerPhone === merchant.phone) throw invalid('The buyer phone must be different from your own.');
    if (input.paymentMode === 'COD' && (await this.buyerPrepaidOnly(buyerPhone))) {
      throw new AppError('BUYER_PREPAID_ONLY', 'Ce client a refusé 2 livraisons en cash ces 90 derniers jours : paiement à l’avance (séquestre) obligatoire.', 409);
    }
    if (input.paymentMode === 'COD' && (merchant.owedToPlatform ?? 0) > SELLER_DEBT_COD_LIMIT) {
      throw new AppError(
        'SELLER_DEBT_PREPAID_ONLY',
        `Vous devez ${formatFcfa(merchant.owedToPlatform ?? 0)} à BayamSafe (plafond ${formatFcfa(SELLER_DEBT_COD_LIMIT)}) : tant que cette dette n’est pas remboursée, seules les commandes payées à l’avance (séquestre) sont possibles.`,
        409
      );
    }
    const recipientPhone = input.recipientPhone ? normalizeContactPhone(input.recipientPhone) : undefined;

    let originCity = merchant.city;
    let agencyFee = 0;
    let destinationCity: string | undefined;
    if (input.type === 'INTER_CITY') {
      const agency = getAgency(input.originAgencyId ?? '');
      if (!agency) throw invalid('Unknown travel agency');
      destinationCity = CITIES.find((c) => c.toLowerCase() === String(input.destinationCity ?? '').toLowerCase());
      if (!destinationCity) throw invalid(`Destination city must be one of: ${CITIES.join(', ')}`);
      if (destinationCity === agency.city) throw invalid('Destination must be a different city than the departure agency.');
      if (!AGENCIES.some((a) => a.name === agency.name && a.city === destinationCity)) {
        throw invalid(`${agency.name} has no listed terminal in ${destinationCity}.`);
      }
      originCity = agency.city;
      agencyFee = input.agencyFee ?? 0;
    }

    const pricing = computePricing(input.itemPrice, input.deliveryFee, agencyFee, this.settings.commissionPct);
    const preferredRiderId = input.preferredRiderCode ? (await this.requireBookableRider(input.preferredRiderCode)).id : undefined;
    const now = new Date();
    const buyerToken = Secrets.token();
    const isCod = input.paymentMode === 'COD';

    const order: Order = {
      id: newId(),
      version: 1,
      trackingCode: newTrackingCode(),
      type: input.type,
      paymentMode: input.paymentMode,
      status: isCod ? 'AWAITING_RIDER' : 'PENDING_PAYMENT',
      merchantId: merchant.id,
      merchantName: merchant.shopName,
      merchantPhone: merchant.phone,
      merchantVerified: merchant.kycStatus === 'VERIFIED',
      buyerPhone,
      buyerName: optText(input.buyerName, 'Buyer name', 80),
      recipientName: optText(input.recipientName, 'Recipient name', 80),
      recipientPhone,
      ...pricing,
      originCity,
      pickupAddress: text(input.pickupAddress, 'Pickup address', 3, 200),
      pickupLocation: input.pickupLocation ? assertGeoPoint(input.pickupLocation) : undefined,
      originAgencyId: input.type === 'INTER_CITY' ? input.originAgencyId : undefined,
      destinationCity,
      itemTitle: text(input.itemTitle, 'Item title', 2, 120),
      codReserved: 0,
      preferredRiderId,
      buyerTokenHash: this.secrets.hashToken(buyerToken),
      releaseCodeEnc: this.secrets.encrypt(newReleaseCode()),
      codeAttempts: 0,
      payment: {},
      payouts: [],
      history: [{ status: isCod ? 'AWAITING_RIDER' : 'PENDING_PAYMENT', at: now.toISOString() }],
      expiresAt: isCod ? undefined : new Date(now.getTime() + this.settings.paymentTtlHours * 3600_000).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    await this.store.insertOrder(order);
    this.events.emit({ type: 'order.created', order });
    if (isCod) await this.offerToRiders(order, 'FIRST');
    return { order, buyerToken, checkoutUrl: this.checkoutUrl(order, buyerToken) };
  }

  // ------------------------------------------------------------------ buyer (checkout page)

  private async requireBuyer(orderId: string, buyerToken: string | undefined): Promise<Order> {
    const o = await this.store.getOrder(orderId);
    // Same error whether the order is missing or the token is wrong: don't leak existence.
    if (!o || !this.secrets.verifyToken(buyerToken, o.buyerTokenHash)) throw notFound('Order');
    return o;
  }

  async buyerView(orderId: string, buyerToken: string | undefined, sessionToken?: string): Promise<BuyerView> {
    let o = await this.requireBuyer(orderId, buyerToken);
    if (o.status === 'PENDING_PAYMENT' && o.payment.reference) {
      const last = Date.parse(o.payment.lastCheckedAt ?? o.payment.initiatedAt ?? '0');
      if (Date.now() - last > PAYMENT_POLL_INTERVAL_MS) {
        await this.syncPayment(o).catch((e) => console.warn('[payment] status poll failed:', e.message));
        o = (await this.store.getOrder(orderId))!;
      }
    }
    return this.view(o, sessionToken);
  }

  /** The rider the buyer should expect right now, if any. */
  async activeRider(o: Order): Promise<Rider | undefined> {
    const id = ['RIDER_ASSIGNED', 'IN_TRANSIT'].includes(o.status)
      ? o.firstMileRiderId
      : ['LAST_MILE_ASSIGNED', 'OUT_FOR_DELIVERY'].includes(o.status)
        ? o.lastMileRiderId
        : undefined;
    return id ? this.store.getRider(id) : undefined;
  }

  private async view(o: Order, sessionToken?: string): Promise<BuyerView> {
    const v = this.toBuyerView(o, sessionToken);
    const r = await this.activeRider(o);
    if (r) {
      // The rider's number is shown once the parcel is on its way, and (escrow) only to the device that paid.
      const showPhone = HEADING_TO_BUYER.includes(o.status) && (o.paymentMode === 'COD' || this.secrets.verifyToken(sessionToken, o.buyerSessionHash));
      v.rider = { firstName: r.fullName.split(' ')[0], plateNumber: r.plateNumber, riderCode: r.riderCode, vehicleType: r.vehicleType, hasPhoto: !!r.selfieFileId, phone: showPhone ? r.phone : undefined };
      v.tracking = this.trackingFor(o, r);
    }
    return v;
  }

  /**
   * Rider position for the buyer, only while the parcel is heading to them and the rider's
   * live location is recent. Distance and a rough moto ETA (~20 km/h in city traffic).
   */
  trackingFor(o: Order, r: Rider): BuyerView['tracking'] {
    if (!HEADING_TO_BUYER.includes(o.status) || !r.location || !r.locationUpdatedAt) return undefined;
    if (Date.now() - Date.parse(r.locationUpdatedAt) > TRACKING_FRESH_MS) return undefined;
    const distanceKm = o.dropoffLocation ? Math.round(haversineKm(r.location, o.dropoffLocation) * 10) / 10 : undefined;
    return {
      lat: r.location.lat,
      lng: r.location.lng,
      at: r.locationUpdatedAt,
      distanceKm,
      etaMin: distanceKm === undefined ? undefined : Math.max(1, Math.round((distanceKm / 20) * 60)),
      near: distanceKm !== undefined && distanceKm <= NEAR_KM
    };
  }

  /** Buyer-authenticated access to the active rider's selfie file id. */
  async riderPhotoFileId(orderId: string, buyerToken: string | undefined): Promise<string | undefined> {
    const o = await this.requireBuyer(orderId, buyerToken);
    return (await this.activeRider(o))?.selfieFileId;
  }

  private toBuyerView(o: Order, sessionToken?: string): BuyerView {
    const agency = getAgency(o.originAgencyId ?? '');
    const active = !TERMINAL_STATUSES.includes(o.status) && o.status !== 'DELIVERED';
    const sessionOk = this.secrets.verifyToken(sessionToken, o.buyerSessionHash);
    const paid = o.status !== 'PENDING_PAYMENT' && !!o.payment.confirmedAt;
    // Paid escrow: only the device that paid may act (confirm, report a problem, add photos).
    const mayAct = o.paymentMode !== 'ESCROW' || !paid || sessionOk;
    const showCode = active && (o.paymentMode === 'COD' || (paid && sessionOk));
    return {
      trackingCode: o.trackingCode,
      status: o.status,
      type: o.type,
      paymentMode: o.paymentMode,
      merchantName: o.merchantName,
      merchantVerified: o.merchantVerified,
      itemTitle: o.itemTitle,
      itemPrice: o.itemPrice,
      deliveryFee: o.deliveryFee,
      agencyFee: o.agencyFee,
      total: o.total,
      dropoffAddress: o.dropoffAddress,
      dropoffLocation: o.dropoffLocation,
      landmark: o.landmark,
      hasVoiceNote: !!o.voiceNoteId,
      destinationCity: o.destinationCity,
      agency: agency && { name: agency.name, terminal: agency.terminalName, city: agency.city },
      waybillNumber: o.waybillNumber,
      history: o.history.map(({ status, at }) => ({ status, at })),
      payment: {
        pending: o.status === 'PENDING_PAYMENT' && !!o.payment.reference,
        operator: o.payment.operator,
        payerPhoneHint: o.payment.payerPhone ? `•••${o.payment.payerPhone.slice(-3)}` : undefined
      },
      can: {
        pay: o.status === 'PENDING_PAYMENT' && o.paymentMode === 'ESCROW',
        editDelivery: !NON_EDITABLE.includes(o.status),
        dispute: DISPUTABLE_STATUSES.includes(o.status) && mayAct,
        cancel: CANCELLABLE.includes(o.status),
        // Cash orders are confirmed by the rider with the code, after the money changed hands.
        confirmReceived: o.paymentMode === 'ESCROW' && o.status === deliverableStatus(o) && sessionOk,
        confirmArrival: o.status === 'AT_AGENCY' && mayAct,
        addEvidence: o.status === 'DISPUTED' && (o.dispute?.evidence?.length ?? 0) < 5 && mayAct
      },
      cancelFee: o.status === 'RIDER_ASSIGNED' && CANCELLABLE.includes(o.status) ? this.buyerCancelFee(o) : undefined,
      recipient: o.recipientName || o.recipientPhone ? { name: o.recipientName, phone: o.recipientPhone } : undefined,
      absence: o.absence?.side === 'BUYER' && o.status === deliverableStatus(o) ? { side: 'BUYER', at: o.absence.at } : undefined,
      releaseCode: showCode ? this.secrets.decrypt(o.releaseCodeEnc) : undefined,
      releaseCodeOnOtherDevice: active && o.paymentMode === 'ESCROW' && paid && !sessionOk,
      followingOnTelegram: !!o.buyerTelegramId,
      dispute: o.dispute && { reason: o.dispute.reason, openedAt: o.dispute.openedAt, resolution: o.dispute.resolution }
    };
  }

  /** What a buyer cancel costs at this moment: half the delivery fee to the rider, prepaid orders only (cash: nothing is held). */
  private buyerCancelFee(o: Order): number {
    return o.status === 'RIDER_ASSIGNED' && !!o.firstMileRiderId && o.paymentMode === 'ESCROW' ? Math.floor(o.deliveryFee / 2) : 0;
  }

  async updateDeliveryDetails(orderId: string, buyerToken: string | undefined, patch: DeliveryDetailsPatch): Promise<BuyerView> {
    await this.requireBuyer(orderId, buyerToken);
    const { order } = await this.mutate(orderId, (o) => {
      if (NON_EDITABLE.includes(o.status)) throw conflict('Delivery details can no longer be changed.');
      if (patch.dropoffLocation !== undefined) o.dropoffLocation = assertGeoPoint(patch.dropoffLocation);
      if (patch.dropoffAddress !== undefined) o.dropoffAddress = optText(patch.dropoffAddress, 'Address', 200);
      if (patch.landmark !== undefined) o.landmark = optText(patch.landmark, 'Landmark', 200);
      o.updatedAt = new Date().toISOString();
    });
    const rider = await this.activeRider(order);
    if (rider) this.events.emit({ type: 'order.address_changed', order, rider });
    return this.view(order);
  }

  async attachVoiceNote(orderId: string, buyerToken: string | undefined, mime: string, data: Buffer): Promise<void> {
    await this.requireBuyer(orderId, buyerToken);
    const baseMime = mime.split(';')[0].trim().toLowerCase();
    if (!/^audio\/[a-z0-9.+-]+$/.test(baseMime)) throw invalid('Voice note must be an audio file');
    if (data.length < 200 || data.length > 400_000) throw invalid('Voice note must be under 400 KB (about 15 seconds)');
    const mediaId = newId();
    await this.store.tx(async (repo) => {
      const o = await repo.getOrder(orderId);
      if (!o) throw notFound('Order');
      if (NON_EDITABLE.includes(o.status)) throw conflict('Delivery details can no longer be changed.');
      await repo.putMedia({ id: mediaId, orderId, mime: baseMime, data, createdAt: new Date().toISOString() });
      if (o.voiceNoteId) await repo.deleteMedia(o.voiceNoteId); // replaced: don't keep the old recording
      o.voiceNoteId = mediaId;
      o.updatedAt = new Date().toISOString();
      await repo.updateOrder(o);
    });
  }

  async getVoiceNote(order: Order) {
    return order.voiceNoteId ? this.store.getMedia(order.voiceNoteId) : undefined;
  }

  /**
   * Sends a USSD payment prompt to the payer's phone. Returns a fresh device session token:
   * the device holding it is the only one that will be shown the release code once paid.
   */
  async initiatePayment(orderId: string, buyerToken: string | undefined, payerPhoneInput: string, existingSession?: string) {
    let o = await this.requireBuyer(orderId, buyerToken);
    if (o.paymentMode !== 'ESCROW') throw invalid('This order is paid in cash on delivery.');
    if (o.status !== 'PENDING_PAYMENT') throw conflict('This order is already paid or closed.');
    if (o.expiresAt && o.expiresAt <= new Date().toISOString()) throw conflict('This payment link has expired.');
    const payerPhone = normalizeCameroonPhone(payerPhoneInput);
    // The seller must not pay their own order (it would let them hold the paying device's session).
    const merchant = await this.store.getUser(o.merchantId);
    const sellerNumbers = [o.merchantPhone, merchant?.phone, merchant?.payoutPhone, merchant?.pendingPayoutPhone].filter(Boolean);
    if (sellerNumbers.includes(payerPhone)) {
      throw new AppError('PAYER_IS_SELLER', 'Le numéro qui paie ne peut pas être celui du vendeur.', 400);
    }

    if (o.payment.reference) {
      await this.syncPayment(o);
      o = (await this.store.getOrder(orderId))!;
      if (o.status !== 'PENDING_PAYMENT') throw conflict('This order is already paid.');
      const since = Date.now() - Date.parse(o.payment.initiatedAt ?? '0');
      if (o.payment.reference && since < PAYMENT_PENDING_WINDOW_MS) {
        throw new AppError('PAYMENT_IN_PROGRESS', 'A payment request was just sent. Approve it on your phone or try again in 2 minutes.', 409);
      }
    }

    const res = await this.gateway.collect({
      amount: o.total,
      phone: payerPhone,
      description: `BayamSafe ${o.trackingCode}`,
      externalReference: `order:${o.id}`
    });
    // Keep this device's existing session (e.g. from "follow on Telegram") so the code follows it.
    const sessionToken = existingSession && /^[A-Za-z0-9_-]{20,64}$/.test(existingSession) ? existingSession : Secrets.token();
    const now = new Date().toISOString();
    await this.mutate(orderId, (ord) => {
      if (ord.status !== 'PENDING_PAYMENT') throw conflict('This order is already paid or closed.');
      ord.payment = {
        operator: res.operator ?? detectOperator(payerPhone),
        payerPhone,
        reference: res.reference,
        pendingSessionHash: this.secrets.hashToken(sessionToken),
        initiatedAt: now,
        lastCheckedAt: now,
        attempts: [...(ord.payment.attempts ?? []), { reference: res.reference, payerPhone, at: now }].slice(-20)
      };
      ord.updatedAt = now;
    });
    return { sessionToken, operator: res.operator ?? detectOperator(payerPhone), ussdCode: res.ussdCode };
  }

  /** Re-reads the current payment attempt from the provider and applies it. */
  async syncPayment(o: Order): Promise<void> {
    if (!o.payment.reference) return;
    const tx = await this.gateway.getTransaction(o.payment.reference);
    if (tx.status === 'PENDING') {
      await this.mutate(o.id, (ord) => {
        ord.payment.lastCheckedAt = new Date().toISOString();
      }).catch(() => undefined);
      return;
    }
    await this.applyOrderTransaction(tx);
  }

  /** Applies a provider transaction (from webhook or polling). Idempotent. */
  async applyOrderTransaction(tx: Transaction): Promise<void> {
    let order = await this.store.getOrderByPaymentRef(tx.reference);
    if (!order && tx.externalReference?.startsWith('order:')) {
      order = await this.store.getOrder(tx.externalReference.slice(6));
    }
    if (!order) return;

    if (tx.status === 'FAILED') {
      if (order.status === 'PENDING_PAYMENT' && order.payment.reference === tx.reference) {
        await this.mutate(order.id, (o) => {
          if (o.payment.reference !== tx.reference) return;
          o.payment = { ...o.payment, reference: undefined, pendingSessionHash: undefined, lastCheckedAt: new Date().toISOString() };
        });
      }
      return;
    }
    if (tx.status !== 'SUCCESSFUL') return;

    const isCurrentAttempt = order.payment.reference === tx.reference;
    if (order.status !== 'PENDING_PAYMENT' || !isCurrentAttempt || tx.amount !== order.total) {
      if (order.payment.confirmedAt && isCurrentAttempt) return; // already applied
      // Money arrived that we can't match cleanly (late/duplicate attempt, wrong amount, expired order):
      // send it straight back to the number that paid, and tell the admins.
      // No pre-marker: the idempotent `stray:<ref>` journal (written in the same transaction as the
      // refund payout) is the only dedupe key, so a failed attempt is simply retried on the next
      // webhook/poll, and duplicates neither re-refund nor re-notify.
      try {
        const booked = await this.refundStrayPayment(order, tx);
        if (booked) this.events.emit({ type: 'order.payment_mismatch', order: booked.order, paidAmount: tx.amount });
        if (booked?.needsReview) this.events.emit({ type: 'payout.attention', order: booked.order, payout: booked.needsReview });
        if (booked) await this.processPayouts(booked.order.id);
      } catch (e) {
        console.error('[payment] stray refund failed:', e);
      }
      return;
    }

    const now = new Date().toISOString();
    const { order: paid } = await this.mutate(order.id, async (o, repo) => {
      if (o.status !== 'PENDING_PAYMENT' || o.payment.reference !== tx.reference) throw conflict('Payment already applied');
      transition(o, 'AWAITING_RIDER', 'payment confirmed');
      o.payment.confirmedAt = now;
      o.payment.operator = tx.operator ?? o.payment.operator;
      o.buyerSessionHash = o.payment.pendingSessionHash;
      o.expiresAt = undefined;
      await repo.addJournal({
        key: `order:${o.id}:paid`,
        description: `Escrow funded for ${o.trackingCode}`,
        createdAt: now,
        lines: [
          { account: 'GATEWAY_CLEARING', refId: o.id, amount: -o.total },
          { account: 'ESCROW', refId: o.id, amount: o.total }
        ]
      });
    }).catch((e) => {
      if (e instanceof AppError && (e.code === 'CONFLICT' || e.code === 'VERSION_CONFLICT')) return { order: undefined };
      throw e;
    });
    if (!paid) return;
    this.events.emit({ type: 'order.paid', order: paid });
    await this.offerToRiders(paid, 'FIRST');
  }

  /** Paid escrow orders: only the device that paid may act for the buyer. */
  private requirePayerDevice(o: Order, sessionToken: string | undefined) {
    if (o.paymentMode === 'ESCROW' && o.payment.confirmedAt && !this.secrets.verifyToken(sessionToken, o.buyerSessionHash)) {
      throw forbidden('Seul le téléphone qui a payé peut faire cette action.');
    }
  }

  async buyerOpenDispute(orderId: string, buyerToken: string | undefined, reason: string, sessionToken?: string): Promise<BuyerView> {
    const cur = await this.requireBuyer(orderId, buyerToken);
    this.requirePayerDevice(cur, sessionToken);
    const order = await this.openDispute(orderId, 'BUYER', reason);
    return this.view(order, sessionToken);
  }

  // ------------------------------------------------------------------ seller's own rider

  private async requireBookableRider(code: string): Promise<Rider> {
    const r = await this.store.getRiderByCode(code.trim().toUpperCase());
    if (!r) throw new AppError('RIDER_UNKNOWN', 'Aucun livreur BayamSafe avec ce numéro. Demandez-lui le numéro BSR-XXXX affiché dans son espace livreur.', 404);
    if (r.status !== 'APPROVED') throw new AppError('RIDER_NOT_APPROVED', 'Ce livreur n’est pas encore vérifié par BayamSafe.', 409);
    return r;
  }

  /** Seller assigns their own rider (code) or opens the job to everyone (null), before pickup. */
  async setPreferredRider(orderId: string, merchantId: string, code: string | null): Promise<{ order: Order; rider?: Rider }> {
    const rider = code ? await this.requireBookableRider(code) : undefined;
    const { order } = await this.mutate(orderId, (o) => {
      if (o.merchantId !== merchantId) throw forbidden();
      if (!['PENDING_PAYMENT', 'AWAITING_RIDER'].includes(o.status)) throw conflict('Un livreur a déjà accepté cette course.');
      o.preferredRiderId = rider?.id;
      o.updatedAt = new Date().toISOString();
    });
    if (order.status === 'AWAITING_RIDER') await this.offerToRiders(order, 'FIRST');
    return { order, rider };
  }

  // ------------------------------------------------------------------ buyer on Telegram

  /**
   * Creates a one-time deep-link payload for the bot (/start f_<order>_<token>). The device
   * session is remembered, so the release code is only sent if this device is the one that pays.
   */
  async createFollowLink(orderId: string, buyerToken: string | undefined, sessionToken?: string) {
    const cur = await this.requireBuyer(orderId, buyerToken);
    // Once paid, only the paying device may (re)bind a Telegram account: it will receive the release code.
    if (cur.payment.confirmedAt && !this.secrets.verifyToken(sessionToken, cur.buyerSessionHash)) {
      throw forbidden('Seul le téléphone qui a payé peut lier Telegram à cette commande.');
    }
    const session = sessionToken && /^[A-Za-z0-9_-]{20,64}$/.test(sessionToken) ? sessionToken : Secrets.token();
    const token = Secrets.token(16);
    await this.mutate(orderId, (o) => {
      if (o.payment.confirmedAt && !this.secrets.verifyToken(session, o.buyerSessionHash)) throw forbidden('Seul le téléphone qui a payé peut lier Telegram à cette commande.');
      o.followTokenHash = this.secrets.hashToken(token);
      o.followTokenExpiresAt = new Date(Date.now() + FOLLOW_TOKEN_TTL_MS).toISOString();
      o.followSessionHash = this.secrets.hashToken(session);
    });
    return { payload: `f_${orderId.replace(/-/g, '')}_${token}`, sessionToken: session };
  }

  /** Called by the bot on /start f_...: binds the buyer's Telegram to the order. */
  async linkBuyerTelegram(payload: string, telegramId: number, lang: Lang): Promise<Order> {
    const m = payload.match(/^f_([0-9a-f]{32})_([A-Za-z0-9_-]{16,40})$/);
    if (!m) throw new AppError('LINK_INVALID', 'Lien de suivi invalide.', 400);
    const id = m[1].replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const { order } = await this.mutate(id, (o) => {
      const fresh = !!o.followTokenExpiresAt && o.followTokenExpiresAt > new Date().toISOString();
      if (!fresh || !this.secrets.verifyToken(m[2], o.followTokenHash)) {
        throw new AppError('LINK_EXPIRED', 'Ce lien de suivi a expiré. Ouvrez à nouveau la page de paiement et appuyez sur « Suivre sur Telegram ».', 410);
      }
      if (o.buyerTelegramId && o.buyerTelegramId !== telegramId) {
        throw new AppError('ALREADY_LINKED', 'Cette commande est déjà suivie depuis un autre compte Telegram.', 409);
      }
      o.buyerTelegramId = telegramId;
      o.buyerLang = lang;
      o.followTokenHash = undefined; // one-time
      o.followTokenExpiresAt = undefined;
    });
    this.events.emit({ type: 'order.buyer_linked', order });
    return order;
  }

  /** Rider number for the buyer's Telegram: only once the parcel is on its way, and (escrow) only if Telegram is bound to the paying device (policy 12). */
  riderPhoneForTelegram(o: Order, rider?: { phone: string }): string | undefined {
    if (!rider || !HEADING_TO_BUYER.includes(o.status) || !o.buyerTelegramId) return undefined;
    if (o.paymentMode === 'COD') return rider.phone;
    const paidOnThisDevice = !!o.payment.confirmedAt && !!o.buyerSessionHash && o.buyerSessionHash === o.followSessionHash;
    return paidOnThisDevice ? rider.phone : undefined;
  }

  /**
   * The release code for the buyer's Telegram: for cash orders always (anyone with the link sees it),
   * for escrow only once paid and only if Telegram was linked from the device that paid.
   */
  releaseCodeForTelegram(o: Order): string | undefined {
    const active = !TERMINAL_STATUSES.includes(o.status) && o.status !== 'DELIVERED';
    if (!active || !o.buyerTelegramId) return undefined;
    if (o.paymentMode === 'COD') return this.secrets.decrypt(o.releaseCodeEnc);
    const paidOnThisDevice = !!o.payment.confirmedAt && !!o.buyerSessionHash && o.buyerSessionHash === o.followSessionHash;
    return paidOnThisDevice ? this.secrets.decrypt(o.releaseCodeEnc) : undefined;
  }

  /** Tells the buyer once when the delivering rider gets close to the drop-off pin. */
  async onRiderMoved(rider: Rider): Promise<void> {
    if (!rider.location) return;
    const active = await this.store.listOrders({ riderId: rider.id, statuses: HEADING_TO_BUYER, limit: 20 });
    for (const o of active) {
      const delivering = o.type === 'INTER_CITY' ? o.lastMileRiderId : o.firstMileRiderId;
      if (delivering !== rider.id || !o.dropoffLocation || o.riderNearNotifiedAt) continue;
      const d = haversineKm(rider.location, o.dropoffLocation);
      if (d > NEAR_KM) continue;
      const updated = await this.mutate(o.id, (ord) => {
        if (ord.riderNearNotifiedAt) throw conflict('already notified');
        ord.riderNearNotifiedAt = new Date().toISOString();
      }).catch(() => undefined);
      if (updated) this.events.emit({ type: 'order.rider_near', order: updated.order, rider, distanceKm: Math.round(d * 100) / 100 });
    }
  }

  // ------------------------------------------------------------------ riders

  async offerToRiders(order: Order, leg: 'FIRST' | 'LAST'): Promise<void> {
    if (leg === 'FIRST' && order.preferredRiderId) {
      // The seller brought their own rider: only they get the job, wherever they are.
      const r = await this.store.getRider(order.preferredRiderId);
      if (r && r.status === 'APPROVED') this.events.emit({ type: 'order.offer', order, leg, offers: [{ rider: r }] });
      else await this.noRiders(order, leg);
      return;
    }
    const offers = await this.dispatch.candidates(order, leg);
    if (offers.length) this.events.emit({ type: 'order.offer', order, leg, offers });
    else await this.noRiders(order, leg);
  }

  private async noRiders(order: Order, leg: 'FIRST' | 'LAST') {
    const last = order.noRiderNoticeAt ? Date.parse(order.noRiderNoticeAt) : 0;
    if (Date.now() - last < NO_RIDER_NOTICE_MS) return;
    const updated = await this.mutate(order.id, (o) => {
      o.noRiderNoticeAt = new Date().toISOString();
    }).catch(() => undefined);
    this.events.emit({ type: 'order.no_riders', order: updated?.order ?? order, leg });
  }

  /** First rider to accept wins; concurrent accepts fail with a version conflict. */
  async claim(riderTelegramId: number, orderId: string): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const current = await this.store.getOrder(orderId);
    const chosen = current?.status === 'AWAITING_RIDER' && current.preferredRiderId === rider.id;
    if (!rider.onDuty && !chosen) throw invalid('Go on duty first (/on_duty).');
    const active = await this.store.listOrders({ riderId: rider.id, statuses: ACTIVE_RIDER_STATUSES, limit: 20 });
    if (active.length >= MAX_ACTIVE_JOBS) {
      throw new AppError('TOO_MANY_JOBS', `Vous avez déjà ${active.length} courses en cours. Terminez-en une avant d’en accepter une autre.`, 409);
    }
    try {
      const { order } = await this.mutate(orderId, async (o, repo) => {
        const r = await repo.getRider(rider.id);
        if (!r) throw notFound('Rider');
        if (o.status === 'AWAITING_RIDER') {
          if (o.preferredRiderId && o.preferredRiderId !== r.id) {
            throw new AppError('RESERVED', 'Cette course est réservée au livreur choisi par le vendeur.', 409);
          }
          if (o.paymentMode === 'COD') {
            const available = r.floatBalance - r.floatReserved;
            if (available < o.itemPrice) {
              throw new AppError('INSUFFICIENT_FLOAT', `Your available float (${available} FCFA) must cover the item price (${o.itemPrice} FCFA). Top up with /float.`, 409);
            }
            r.floatReserved += o.itemPrice;
            r.updatedAt = new Date().toISOString();
            await repo.updateRider(r);
            o.codRiderId = r.id;
            o.codReserved = o.itemPrice;
          }
          o.firstMileRiderId = r.id;
          o.sellerChoseRider = o.preferredRiderId === r.id ? true : undefined;
          transition(o, 'RIDER_ASSIGNED', r.fullName);
        } else if (o.status === 'AT_AGENCY' || o.status === 'AT_DESTINATION_HUB') {
          if (o.firstMileRiderId === r.id) throw invalid('You already ran the first leg of this order.');
          o.lastMileRiderId = r.id;
          transition(o, 'LAST_MILE_ASSIGNED', r.fullName);
        } else {
          throw conflict('This job is no longer available.');
        }
      });
      this.events.emit({ type: 'order.status', order });
      return order;
    } catch (e) {
      if (e instanceof AppError && e.code === 'VERSION_CONFLICT') throw conflict('Another rider accepted this job first.');
      throw e;
    }
  }

  /** Rider gives the job back before picking the parcel up. */
  async unassign(riderTelegramId: number, orderId: string): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const { order, result: leg } = await this.mutate(orderId, async (o, repo) => {
      if (o.status === 'RIDER_ASSIGNED' && o.firstMileRiderId === rider.id) {
        await this.releaseCodReserve(o, repo);
        o.firstMileRiderId = undefined;
        o.sellerChoseRider = undefined;
        if (o.preferredRiderId === rider.id) o.preferredRiderId = undefined; // open the job to everyone
        this.resetStallReminders(o);
        transition(o, 'AWAITING_RIDER', 'rider released the job');
        return 'FIRST' as const;
      }
      if (o.status === 'LAST_MILE_ASSIGNED' && o.lastMileRiderId === rider.id) {
        o.lastMileRiderId = undefined;
        transition(o, 'AT_DESTINATION_HUB', 'rider released the job');
        return 'LAST' as const;
      }
      throw conflict('You can only release a job you accepted and have not picked up yet.');
    });
    this.events.emit({ type: 'order.status', order });
    await this.offerToRiders(order, leg);
    return order;
  }

  async confirmPickup(riderTelegramId: number, orderId: string, photoFileId?: string): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const { order } = await this.mutate(orderId, (o) => {
      if (photoFileId) o.pickupPhotoFileId = photoFileId;
      o.absence = undefined;
      if (o.status === 'RIDER_ASSIGNED' && o.firstMileRiderId === rider.id) transition(o, 'IN_TRANSIT', 'picked up from merchant');
      else if (o.status === 'LAST_MILE_ASSIGNED' && o.lastMileRiderId === rider.id) transition(o, 'OUT_FOR_DELIVERY', 'collected from agency');
      else throw conflict('Nothing to pick up for you on this order.');
    });
    this.events.emit({ type: 'order.status', order });
    return order;
  }

  async recordAgencyDropoff(riderTelegramId: number, orderId: string, waybillNumber: string, waybillPhotoFileId: string, actualAgencyFee?: number): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const waybill = waybillNumber.trim().toUpperCase();
    if (!/^[A-Z0-9/-]{3,30}$/.test(waybill)) throw invalid('Invalid waybill number');
    if (!waybillPhotoFileId) throw invalid('A photo of the waybill is required');
    const { order } = await this.mutate(orderId, (o) => {
      if (o.type !== 'INTER_CITY') throw invalid('Only inter-city orders go through an agency.');
      if (o.status !== 'IN_TRANSIT' || o.firstMileRiderId !== rider.id) throw conflict('This parcel is not in transit with you.');
      o.waybillNumber = waybill;
      o.waybillPhotoFileId = waybillPhotoFileId;
      if (actualAgencyFee !== undefined && actualAgencyFee > o.agencyFee) {
        if (!Number.isSafeInteger(actualAgencyFee) || actualAgencyFee > o.agencyFee + 50_000) throw invalid('Montant de l’agence invalide');
        o.agencyFeeClaim = { amount: actualAgencyFee, status: 'PENDING', at: new Date().toISOString() };
      }
      transition(o, 'AT_AGENCY', `waybill ${waybill}`);
    });
    this.events.emit({ type: 'order.status', order });
    if (order.agencyFeeClaim?.status === 'PENDING') this.events.emit({ type: 'order.agency_fee_claim', order });
    return order;
  }

  /** Merchant (who hears from the agency) or an admin marks the bus as arrived. */
  async markArrivedAtHub(orderId: string, actor: { merchantId?: string; admin?: boolean }): Promise<Order> {
    const { order } = await this.mutate(orderId, (o) => {
      if (!actor.admin && o.merchantId !== actor.merchantId) throw forbidden();
      if (o.status !== 'AT_AGENCY') throw conflict('The parcel is not waiting at the departure agency.');
      transition(o, 'AT_DESTINATION_HUB', `arrived in ${o.destinationCity}`);
    });
    this.events.emit({ type: 'order.status', order });
    await this.offerToRiders(order, 'LAST');
    return order;
  }

  /**
   * The delivering rider types the code the buyer reads out after inspecting the parcel.
   * Too many wrong codes freezes the order for admin review.
   */
  async deliver(riderTelegramId: number, orderId: string, code: string): Promise<{ ok: boolean; order: Order; attemptsLeft: number }> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const { order, result } = await this.mutate(orderId, async (o, repo) => {
      const deliveringRider = o.type === 'INTER_CITY' ? o.lastMileRiderId : o.firstMileRiderId;
      if (deliveringRider !== rider.id) throw forbidden('You are not the delivering rider for this order.');
      if (o.status !== deliverableStatus(o)) throw conflict('This order is not out for delivery.');

      const expected = this.secrets.decrypt(o.releaseCodeEnc);
      if (!safeEqual(expected, String(code).replace(/\D/g, ''))) {
        o.codeAttempts += 1;
        o.updatedAt = new Date().toISOString();
        if (o.codeAttempts >= this.settings.maxCodeAttempts) {
          this.applyDispute(o, 'SYSTEM', 'Too many wrong release codes', 'CODE_LOCK');
        }
        return { ok: false, attemptsLeft: Math.max(0, this.settings.maxCodeAttempts - o.codeAttempts) };
      }
      await this.settle(o, repo, 'release code confirmed');
      return { ok: true, attemptsLeft: this.settings.maxCodeAttempts - o.codeAttempts };
    });
    if (order.status === 'DISPUTED') this.events.emit({ type: 'order.disputed', order });
    if (result.ok) {
      this.events.emit({ type: 'order.status', order });
      await this.processPayouts(order.id);
    }
    return { ...result, order: (await this.store.getOrder(order.id)) ?? order };
  }

  async riderOpenDispute(riderTelegramId: number, orderId: string, reason: string): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const o = await this.store.getOrder(orderId);
    if (!o || (o.firstMileRiderId !== rider.id && o.lastMileRiderId !== rider.id)) throw notFound('Order');
    return this.openDispute(orderId, 'RIDER', reason);
  }

  // ------------------------------------------------------------------ settlement & disputes

  private phoneFor(kind: PayoutKind, o: Order, riders: Map<string, Rider>): string {
    switch (kind) {
      case 'MERCHANT':
        return o.merchantPhone;
      case 'BUYER_REFUND':
        // Refunds go back to the Mobile Money number that paid (the buyer contact may be foreign).
        return o.payment.payerPhone ?? '';
      case 'FIRST_MILE_RIDER':
        return riders.get(o.firstMileRiderId ?? '')?.phone ?? '';
      case 'LAST_MILE_RIDER':
        return riders.get(o.lastMileRiderId ?? '')?.phone ?? '';
    }
  }

  private async loadRiders(o: Order, repo: Repo): Promise<Map<string, Rider>> {
    const map = new Map<string, Rider>();
    for (const id of [o.firstMileRiderId, o.lastMileRiderId, o.codRiderId]) {
      if (id && !map.has(id)) {
        const r = await repo.getRider(id);
        if (r) map.set(id, r);
      }
    }
    return map;
  }

  private buildPayouts(o: Order, plan: PayoutPlanLine[], riders: Map<string, Rider>): Payout[] {
    return plan.map((l) => {
      const phone = this.phoneFor(l.kind, o, riders);
      if (!phone) throw new Error(`No phone for payout ${l.kind} on ${o.trackingCode}`);
      return { id: newId(), kind: l.kind, phone, amount: l.amount, status: 'PENDING', attempts: 0 };
    });
  }

  private async releaseCodReserve(o: Order, repo: Repo) {
    if (!o.codRiderId || !o.codReserved) return;
    const r = await repo.getRider(o.codRiderId);
    if (r) {
      r.floatReserved = Math.max(0, r.floatReserved - o.codReserved);
      r.updatedAt = new Date().toISOString();
      await repo.updateRider(r);
    }
    o.codReserved = 0;
  }

  /** Marks delivered, books the ledger and queues payouts. Caller saves the order. */
  private async settle(o: Order, repo: Repo, note: string) {
    const now = new Date().toISOString();
    transition(o, 'DELIVERED', note);
    const riders = await this.loadRiders(o, repo);

    const merchant = await repo.getUser(o.merchantId);
    if (merchant?.payoutPhone) o.merchantPhone = merchant.payoutPhone;

    if (o.paymentMode === 'ESCROW') {
      const plan = this.withAgencyExtra(o, settlementPlan(o));
      const recovered = await this.recoverSellerDebt(o, plan, merchant, repo);
      o.payouts = [...o.payouts, ...this.buildPayouts(o, plan.filter((l) => l.amount > 0), riders)];
      await repo.addJournal({
        key: `order:${o.id}:settle`,
        description: `Delivery confirmed for ${o.trackingCode}`,
        createdAt: now,
        lines: [
          { account: 'ESCROW', refId: o.id, amount: -o.total },
          ...plan.filter((l) => l.amount > 0).map((l) => ({ account: PAYABLE[l.kind], refId: o.id, amount: l.amount })),
          { account: 'PLATFORM_REVENUE', refId: o.id, amount: o.commission },
          ...(recovered ? [{ account: 'MERCHANT_RECEIVABLE' as LedgerAccount, refId: o.merchantId, amount: recovered }] : [])
        ]
      });
    } else {
      // COD: the rider collected cash from the buyer and keeps the delivery fee. The merchant's
      // share comes out of the rider's collateral float, which the platform already holds.
      const rider = riders.get(o.codRiderId ?? '');
      if (!rider) throw new Error(`COD rider missing on ${o.trackingCode}`);
      rider.floatReserved = Math.max(0, rider.floatReserved - o.codReserved);
      rider.floatBalance -= o.itemPrice;
      o.codReserved = 0;
      const plan: PayoutPlanLine[] = [{ kind: 'MERCHANT', amount: o.itemPrice - o.commission }];
      const recovered = await this.recoverSellerDebt(o, plan, merchant, repo);
      const merchantShare = plan[0].amount;
      o.payouts = [...o.payouts, ...(merchantShare > 0 ? this.buildPayouts(o, plan, riders) : [])];
      await repo.addJournal({
        key: `order:${o.id}:cod-settle`,
        description: `COD delivery confirmed for ${o.trackingCode}`,
        createdAt: now,
        lines: [
          { account: 'RIDER_FLOAT', refId: rider.id, amount: -o.itemPrice },
          ...(merchantShare > 0 ? [{ account: 'MERCHANT_PAYABLE' as LedgerAccount, refId: o.id, amount: merchantShare }] : []),
          { account: 'PLATFORM_REVENUE', refId: o.id, amount: o.commission },
          ...(recovered ? [{ account: 'MERCHANT_RECEIVABLE' as LedgerAccount, refId: o.merchantId, amount: recovered }] : [])
        ]
      });
    }

    for (const r of riders.values()) {
      if (r.id === o.firstMileRiderId || r.id === o.lastMileRiderId) r.completedDeliveries += 1;
      r.updatedAt = now;
      await repo.updateRider(r);
    }
  }

  private applyDispute(o: Order, openedBy: Dispute['openedBy'], reason: string, kind: Dispute['kind'] = 'OTHER') {
    const returnRequired = kind === 'BUYER_ABSENT' || kind === 'BUYER_REFUSED' || kind === 'SELLER_RETURN';
    o.dispute = { reason, openedBy, openedAt: new Date().toISOString(), fromStatus: o.status, kind, returnRequired };
    if (o.paymentMode === 'COD' && (kind === 'BUYER_ABSENT' || kind === 'BUYER_REFUSED')) o.buyerRefusalAt = new Date().toISOString();
    transition(o, 'DISPUTED', `${openedBy.toLowerCase()}: ${reason}`);
  }

  async openDispute(orderId: string, openedBy: Dispute['openedBy'], reasonInput: string, kind: Dispute['kind'] = 'OTHER'): Promise<Order> {
    const reason = text(reasonInput, 'Reason', 3, 500);
    const { order } = await this.mutate(orderId, (o) => {
      if (!DISPUTABLE_STATUSES.includes(o.status)) throw conflict('A problem can only be reported while the parcel is on its way.');
      this.applyDispute(o, openedBy, reason, kind);
    });
    this.events.emit({ type: 'order.disputed', order });
    return order;
  }

  /** Admin decision after hearing both sides (and getting the parcel back to the merchant if refunding). */
  async resolveDispute(
    orderId: string,
    resolution: 'REFUND_BUYER' | 'RELEASE_TO_MERCHANT' | 'SPLIT',
    note?: string,
    opts: { buyerAmount?: number; by?: string; markReturnReceived?: boolean } = {}
  ): Promise<Order> {
    const { order } = await this.mutate(orderId, async (o, repo) => {
      if (o.status !== 'DISPUTED' || !o.dispute) throw conflict('Order is not disputed.');
      // Recorded in the same transaction as the refund: if the refund fails, nothing is half-done.
      if (opts.markReturnReceived && !o.dispute.returnReceivedAt) o.dispute.returnReceivedAt = new Date().toISOString();
      o.dispute.resolution = resolution;
      o.dispute.resolutionNote = optText(note, 'Note', 500);
      o.dispute.resolvedAt = new Date().toISOString();
      const by = opts.by ?? 'admin';

      if (resolution === 'RELEASE_TO_MERCHANT') {
        o.buyerRefusalAt = undefined; // the refusal report was wrong: it must not count against the buyer
        await this.settle(o, repo, `released by ${by}`);
        return;
      }
      const seen = new Set(o.history.map((h) => h.status));
      const legs = refundPlan(o, { pickedUp: seen.has('IN_TRANSIT'), reachedAgency: seen.has('AT_AGENCY'), lastMileRan: seen.has('OUT_FOR_DELIVERY') });
      if (resolution === 'SPLIT') {
        if (o.paymentMode !== 'ESCROW') throw invalid('A split only applies to prepaid orders.');
        await this.bookSplit(o, repo, legs, opts.buyerAmount ?? -1);
        // Ends in DELIVERED (so payouts settle it) but it is NOT a normal delivery: o.dispute.resolution === 'SPLIT'.
        // Notifications must check that before saying "delivered" (bot's concern).
        transition(o, 'DELIVERED', `split decided by ${by} (dispute split, not a normal delivery)`);
        return;
      }
      const failedDelivery = o.dispute.kind === 'BUYER_ABSENT' || o.dispute.kind === 'BUYER_REFUSED';
      if (o.paymentMode === 'ESCROW') {
        if (o.dispute.kind === 'SELLER_RETURN') {
          // The seller asked for the return: buyer gets everything back, riders are paid by the seller.
          await this.bookRefund(o, repo, [{ kind: 'BUYER_REFUND', amount: o.total }]);
          await this.chargeSellerForRiders(o, repo, legs.filter((l) => l.kind !== 'BUYER_REFUND'), 'return requested by seller');
        } else if (failedDelivery && o.sellerChoseRider && o.type !== 'INTER_CITY') {
          // Inter-city deliveries are made by the destination-city rider, never the seller's chosen (first-leg) rider.
          // The seller's own rider reported absent/refused (policy 7): the buyer is not charged, the seller pays the legs.
          await this.bookRefund(o, repo, [{ kind: 'BUYER_REFUND', amount: o.total }]);
          await this.chargeSellerForRiders(o, repo, legs.filter((l) => l.kind !== 'BUYER_REFUND'), 'failed delivery by the seller own rider');
        } else {
          await this.bookRefund(o, repo, legs);
        }
      } else {
        await this.releaseCodReserve(o, repo);
        if (o.dispute.kind === 'SELLER_RETURN') {
          await this.chargeSellerForRiders(o, repo, [{ kind: 'FIRST_MILE_RIDER' as PayoutKind, amount: o.deliveryFee }].filter((l) => l.amount > 0), 'return requested by seller');
        } else if (failedDelivery) {
          // Cash order, buyer absent or refused (policy 10): the rider ran the leg, the seller pays the delivery fee.
          await this.chargeSellerForRiders(o, repo, [{ kind: 'FIRST_MILE_RIDER' as PayoutKind, amount: o.deliveryFee }], 'cash buyer absent or refused');
        }
      }
      transition(o, 'REFUNDED', `refunded by ${by}`);
    });
    this.events.emit({ type: 'order.status', order });
    await this.processPayouts(order.id);
    return (await this.store.getOrder(order.id)) ?? order;
  }

  private async bookRefund(o: Order, repo: Repo, plan: PayoutPlanLine[]) {
    const added = await repo.addJournal({
      key: `order:${o.id}:refund`,
      description: `Refund for ${o.trackingCode}`,
      createdAt: new Date().toISOString(),
      lines: [{ account: 'ESCROW', refId: o.id, amount: -o.total }, ...plan.map((l) => ({ account: PAYABLE[l.kind], refId: o.id, amount: l.amount }))]
    });
    if (!added) {
      // Already booked once: queueing payouts again would pay the money out twice.
      console.warn(`[refund] ${o.trackingCode}: refund journal already exists, not queueing payouts again`);
      return;
    }
    const riders = await this.loadRiders(o, repo);
    o.payouts = [...o.payouts, ...this.buildPayouts(o, plan.filter((l) => l.amount > 0), riders)];
  }

  /** A new waiting period starts: the 6 h / 24 h "no rider" reminders may fire again (the 48 h refund anchor does not move). */
  private resetStallReminders(o: Order) {
    if (o.reminders?.length) o.reminders = o.reminders.filter((k) => k !== 'stalled-6h' && k !== 'stalled-24h');
  }

  /** Merchant or admin cancels before the parcel is picked up. Paid escrow is refunded in full. */
  async cancel(orderId: string, actor: { merchantId?: string; admin?: boolean; buyer?: boolean }): Promise<Order> {
    const current = await this.store.getOrder(orderId);
    if (!current) throw notFound('Order');
    if (!actor.admin && !actor.buyer && current.merchantId !== actor.merchantId) throw forbidden();
    const by = actor.buyer ? 'buyer' : actor.admin ? 'admin' : 'seller';
    if (current.status === 'PENDING_PAYMENT' && current.payment.reference) {
      await this.syncPayment(current).catch(() => undefined);
    }
    const { order } = await this.mutate(orderId, async (o, repo) => {
      if (o.status === 'PENDING_PAYMENT') {
        if (o.payment.reference && Date.now() - Date.parse(o.payment.initiatedAt ?? '0') < 10 * 60_000) {
          throw conflict('The buyer is paying right now. Try again in a few minutes.');
        }
        transition(o, 'CANCELLED', `cancelled by ${by} before payment`);
      } else if (o.status === 'AWAITING_RIDER' || o.status === 'RIDER_ASSIGNED') {
        const lateSellerCancel = by === 'seller' && o.status === 'RIDER_ASSIGNED' && !!o.firstMileRiderId;
        // Buyer cancels after a rider accepted a prepaid order: half the delivery fee goes to the rider, out of the refund (policy 9).
        const riderShare = by === 'buyer' ? this.buyerCancelFee(o) : 0;
        if (o.paymentMode === 'COD') {
          await this.releaseCodReserve(o, repo);
        } else if (riderShare > 0) {
          await this.bookRefund(o, repo, [{ kind: 'BUYER_REFUND', amount: o.total - riderShare }, { kind: 'FIRST_MILE_RIDER', amount: riderShare }]);
        } else {
          await this.bookRefund(o, repo, [{ kind: 'BUYER_REFUND', amount: o.total }]);
        }
        if (lateSellerCancel) {
          const fee = Math.floor(o.deliveryFee / 2);
          if (fee > 0) await this.chargeSellerForRiders(o, repo, [{ kind: 'FIRST_MILE_RIDER', amount: fee }], 'seller cancelled after the rider set off');
        }
        if (o.paymentMode === 'COD') transition(o, 'CANCELLED', `cancelled by ${by} before pickup`);
        else transition(o, 'REFUNDED', riderShare > 0 ? `cancelled by ${by} before pickup, refund minus ${riderShare} FCFA for the rider` : `cancelled by ${by} before pickup, full refund`);
      } else {
        throw new AppError('ALREADY_PICKED_UP', 'Le colis a déjà été récupéré : il faut d’abord le retourner au vendeur.', 409);
      }
    });
    this.events.emit({ type: 'order.status', order });
    if (order.payouts.length) await this.processPayouts(order.id);
    return (await this.store.getOrder(order.id)) ?? order;
  }

  /**
   * The seller can stop a deal at any point: before pickup it is a normal cancellation (full
   * refund); after pickup the parcel must come back first, so it opens a return for admins.
   */
  async sellerCancel(orderId: string, merchantId: string): Promise<{ order: Order; kind: 'cancelled' | 'return_opened' }> {
    const o = await this.store.getOrder(orderId);
    if (!o || o.merchantId !== merchantId) throw notFound('Order');
    if (DISPUTABLE_STATUSES.includes(o.status)) {
      return { order: await this.openDispute(orderId, 'MERCHANT', 'Annulation demandée par le vendeur : retour du colis', 'SELLER_RETURN'), kind: 'return_opened' };
    }
    return { order: await this.cancel(orderId, { merchantId }), kind: 'cancelled' };
  }

  /** The buyer cancels from the checkout page or Telegram, until the parcel is picked up. */
  async buyerCancel(orderId: string, buyerToken: string | undefined, sessionToken?: string): Promise<BuyerView> {
    const current = await this.requireBuyer(orderId, buyerToken);
    if (!CANCELLABLE.includes(current.status)) return this.view(await this.cancel(orderId, { buyer: true }), sessionToken); // gives the precise reason
    if (current.paymentMode === 'ESCROW' && current.payment.confirmedAt && !this.secrets.verifyToken(sessionToken, current.buyerSessionHash)) {
      throw forbidden('Une commande payée ne peut être annulée que depuis le téléphone qui a payé.');
    }
    const o = await this.cancel(orderId, { buyer: true });
    return this.view(o, sessionToken);
  }

  /** Same, from the buyer's Telegram (the account that follows the order). */
  async buyerCancelFromTelegram(orderId: string, telegramId: number): Promise<Order> {
    const o = await this.store.getOrder(orderId);
    if (!o || o.buyerTelegramId !== telegramId) throw notFound('Order');
    if (!CANCELLABLE.includes(o.status)) return this.cancel(orderId, { buyer: true }); // gives the precise reason
    if (o.paymentMode === 'ESCROW' && o.payment.confirmedAt && (!o.buyerSessionHash || o.buyerSessionHash !== o.followSessionHash)) {
      throw forbidden('Une commande payée ne peut être annulée que depuis le téléphone qui a payé (ouvrez la page de paiement sur ce téléphone).');
    }
    return this.cancel(orderId, { buyer: true });
  }

  async expireStale(now = new Date()): Promise<number> {
    let n = 0;
    for (const o of await this.store.listPendingExpired(now.toISOString())) {
      try {
        if (o.payment.reference) await this.syncPayment(o);
        await this.mutate(o.id, (ord) => {
          if (ord.status === 'PENDING_PAYMENT') transition(ord, 'EXPIRED', 'payment link expired', now);
        });
        n++;
      } catch (e) {
        console.warn(`[expire] ${o.trackingCode}:`, (e as Error).message);
      }
    }
    return n;
  }

  /** Re-sends offers for jobs nobody has accepted for a while. */
  async reofferStale(olderThanMs = 10 * 60_000, now = Date.now()): Promise<number> {
    const waiting = await this.listAllOldestFirst(['AWAITING_RIDER', 'AT_DESTINATION_HUB']);
    let n = 0;
    for (const o of waiting) {
      if (now - Date.parse(o.updatedAt) < olderThanMs) continue;
      await this.offerToRiders(o, o.status === 'AWAITING_RIDER' ? 'FIRST' : 'LAST');
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ money helpers

  /** An approved extra agency fee moves from the seller's share to the first-mile rider who paid it. */
  private withAgencyExtra(o: Order, plan: PayoutPlanLine[]): PayoutPlanLine[] {
    const claim = o.agencyFeeClaim;
    if (!claim || claim.status !== 'APPROVED') return plan;
    const merchant = plan.find((l) => l.kind === 'MERCHANT');
    const extra = Math.min(claim.amount - o.agencyFee, merchant?.amount ?? 0);
    if (!merchant || extra <= 0) return plan;
    merchant.amount -= extra;
    const first = plan.find((l) => l.kind === 'FIRST_MILE_RIDER');
    if (first) first.amount += extra;
    else plan.push({ kind: 'FIRST_MILE_RIDER', amount: extra });
    return plan;
  }

  /** Takes what the seller owes the platform out of their share of this sale. Returns the amount recovered. */
  private async recoverSellerDebt(o: Order, plan: PayoutPlanLine[], merchant: User | undefined, repo: Repo): Promise<number> {
    const owed = merchant?.owedToPlatform ?? 0;
    const line = plan.find((l) => l.kind === 'MERCHANT');
    if (!merchant || owed <= 0 || !line || line.amount <= 0) return 0;
    const take = Math.min(owed, line.amount);
    line.amount -= take;
    merchant.owedToPlatform = owed - take;
    merchant.updatedAt = new Date().toISOString();
    await repo.updateUser(merchant);
    return take;
  }

  /** Riders are paid now; the seller owes it to the platform and it comes out of their next payouts. */
  private async chargeSellerForRiders(o: Order, repo: Repo, lines: PayoutPlanLine[], why: string) {
    const valid = lines.filter((l) => l.amount > 0);
    if (!valid.length) return;
    const total = valid.reduce((s, l) => s + l.amount, 0);
    const slug = why.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const added = await repo.addJournal({
      key: `order:${o.id}:seller-charge:${slug}`,
      description: `Rider fee charged to the seller (${why}) for ${o.trackingCode}`,
      createdAt: new Date().toISOString(),
      lines: [
        ...valid.map((l) => ({ account: PAYABLE[l.kind], refId: o.id, amount: l.amount })),
        { account: 'MERCHANT_RECEIVABLE' as LedgerAccount, refId: o.merchantId, amount: -total }
      ]
    });
    if (!added) {
      console.warn(`[seller-charge] ${o.trackingCode}: "${why}" already charged, skipping`);
      return;
    }
    const riders = await this.loadRiders(o, repo);
    o.payouts = [...o.payouts, ...this.buildPayouts(o, valid, riders)];
    const m = await repo.getUser(o.merchantId);
    if (m) {
      m.owedToPlatform = (m.owedToPlatform ?? 0) + total;
      m.updatedAt = new Date().toISOString();
      await repo.updateUser(m);
    }
  }

  /** Admin split: riders keep the legs they ran, the buyer gets `buyerAmount`, the seller the rest (minus commission). */
  private async bookSplit(o: Order, repo: Repo, legs: PayoutPlanLine[], buyerAmount: number) {
    const riderLines = legs.filter((l) => l.kind !== 'BUYER_REFUND' && l.amount > 0);
    const riderTotal = riderLines.reduce((s, l) => s + l.amount, 0);
    const max = o.total - riderTotal;
    if (!Number.isSafeInteger(buyerAmount) || buyerAmount < 0 || buyerAmount > max) {
      throw invalid(`Le remboursement du client doit être entre 0 et ${max} FCFA.`);
    }
    const merchantGross = max - buyerAmount;
    const commission = Math.round((merchantGross * this.settings.commissionPct) / 100);
    const plan: PayoutPlanLine[] = riderLines.map((l) => ({ ...l }));
    if (buyerAmount > 0) plan.push({ kind: 'BUYER_REFUND', amount: buyerAmount });
    if (merchantGross - commission > 0) plan.push({ kind: 'MERCHANT', amount: merchantGross - commission });
    o.commission = commission;
    // Same treatment as a normal settlement: payout number, approved agency extra, seller debt.
    const merchant = await repo.getUser(o.merchantId);
    if (merchant?.payoutPhone) o.merchantPhone = merchant.payoutPhone;
    this.withAgencyExtra(o, plan);
    const recovered = await this.recoverSellerDebt(o, plan, merchant, repo);
    const lines = plan.filter((l) => l.amount > 0);
    const riders = await this.loadRiders(o, repo);
    o.payouts = [...o.payouts, ...this.buildPayouts(o, lines, riders)];
    const added = await repo.addJournal({
      key: `order:${o.id}:split`,
      description: `Split decision for ${o.trackingCode}`,
      createdAt: new Date().toISOString(),
      lines: [
        { account: 'ESCROW', refId: o.id, amount: -o.total },
        ...lines.map((l) => ({ account: PAYABLE[l.kind], refId: o.id, amount: l.amount })),
        { account: 'PLATFORM_REVENUE', refId: o.id, amount: commission },
        ...(recovered ? [{ account: 'MERCHANT_RECEIVABLE' as LedgerAccount, refId: o.merchantId, amount: recovered }] : [])
      ]
    });
    if (!added) throw conflict('This split was already booked.');
  }

  /** Money that can't be matched to an unpaid order (late duplicate, wrong amount) goes straight back. */
  /**
   * Returns undefined when nothing new was booked (duplicate delivery, or zero amount). Otherwise the
   * updated order, plus the NEEDS_REVIEW payout when the payer's number is unknown (an admin must then
   * refund by hand: the money is on the books either way, never silently dropped).
   */
  private async refundStrayPayment(order: Order, tx: Transaction): Promise<{ order: Order; needsReview?: Payout } | undefined> {
    if (!(tx.amount > 0)) return undefined;
    const now = new Date().toISOString();
    const { order: saved, result } = await this.mutate(order.id, async (o, repo) => {
      // Looked up on the fresh row: the attempt list may have changed since the caller's snapshot.
      const attempt = o.payment.attempts?.find((a) => a.reference === tx.reference);
      const phone = attempt?.payerPhone ?? (o.payment.reference === tx.reference ? o.payment.payerPhone : undefined);
      const added = await repo.addJournal({
        key: `stray:${tx.reference}`,
        description: `Unmatched payment refunded for ${o.trackingCode}`,
        createdAt: now,
        lines: [
          { account: 'GATEWAY_CLEARING', refId: o.id, amount: -tx.amount },
          { account: 'BUYER_REFUND_PAYABLE', refId: o.id, amount: tx.amount }
        ]
      });
      if (!added) return undefined;
      const payout: Payout = phone
        ? { id: newId(), kind: 'BUYER_REFUND', phone, amount: tx.amount, status: 'PENDING', attempts: 0 }
        : { id: newId(), kind: 'BUYER_REFUND', phone: '', amount: tx.amount, status: 'NEEDS_REVIEW', attempts: 0, lastError: `Payer number unknown for provider reference ${tx.reference}: refund by hand` };
      o.payouts.push(payout);
      if (o.status === 'PENDING_PAYMENT' && o.payment.reference === tx.reference) {
        // Wrong amount on the current attempt: refund it and let the buyer pay again.
        o.payment = { ...o.payment, reference: undefined, pendingSessionHash: undefined };
      }
      return payout;
    });
    if (!result) return undefined;
    return { order: saved, needsReview: result.status === 'NEEDS_REVIEW' ? { ...result } : undefined };
  }

  /** Two refused (or missed) cash deliveries in 90 days → this buyer number pays upfront only. */
  async buyerPrepaidOnly(phone: string): Promise<boolean> {
    let normalized: string;
    try {
      normalized = normalizeContactPhone(phone);
    } catch {
      return false;
    }
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    return (await this.store.countBuyerRefusals(normalized, since)) >= 2;
  }

  // ------------------------------------------------------------------ timeouts (background job)

  private statusSince(o: Order): number {
    for (let i = o.history.length - 1; i >= 0; i--) if (o.history[i].status === o.status) return Date.parse(o.history[i].at);
    return Date.parse(o.updatedAt);
  }

  /** Marks reminder keys as sent; returns true if the first key was new. */
  private async remindOnce(o: Order, keys: string[]): Promise<boolean> {
    if (o.reminders?.includes(keys[0])) return false;
    const res = await this.mutate(o.id, (ord) => {
      if (ord.reminders?.includes(keys[0])) throw conflict('already reminded');
      ord.reminders = [...new Set([...(ord.reminders ?? []), ...keys])];
    }).catch(() => undefined);
    return !!res;
  }

  /**
   * Nothing waits forever:
   * - no rider 6 h / 24 h (since the order last went back to the pool) -> reminders;
   * - no rider 48 h after the order was first paid (escrow: payment.confirmedAt, COD: createdAt) ->
   *   automatic full refund / cancellation. Claim/release cycles do NOT restart this clock;
   * - a rider who accepted but didn't pick up within 45 min is released and the job re-offered;
   * - parcel at the departure agency for 24 h -> reminder to confirm the bus arrived;
   * - stalls with no automatic action (in transit / out for delivery > 6 h, at the destination hub > 24 h,
   *   a required return not received > 48 h) -> one admin-facing `order.stalled` event each.
   * Every automatic decision is re-checked inside the transaction against the fresh row.
   */
  async enforceTimeouts(now = Date.now()): Promise<{ reminded: number; refunded: number; released: number }> {
    const res = { reminded: 0, refunded: 0, released: 0 };
    const list = await this.listAllOldestFirst([
      'AWAITING_RIDER', 'RIDER_ASSIGNED', 'LAST_MILE_ASSIGNED', 'AT_AGENCY',
      'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'AT_DESTINATION_HUB', 'DISPUTED'
    ]);
    for (const o of list) {
      const age = now - this.statusSince(o);
      try {
        if (o.status === 'AWAITING_RIDER') {
          if (now - this.refundAnchor(o) >= NO_RIDER_REFUND_MS) {
            if (await this.autoRefundUnpicked(o.id, now)) res.refunded++;
          } else if (age >= 24 * 3600_000 && (await this.remindOnce(o, ['stalled-24h', 'stalled-6h']))) {
            this.events.emit({ type: 'order.stalled', order: o, hours: 24 });
            res.reminded++;
          } else if (age >= 6 * 3600_000 && (await this.remindOnce(o, ['stalled-6h']))) {
            this.events.emit({ type: 'order.stalled', order: o, hours: 6 });
            res.reminded++;
          }
        } else if (o.status === 'RIDER_ASSIGNED' || o.status === 'LAST_MILE_ASSIGNED') {
          if (age >= NO_SHOW_MS) {
            if (await this.releaseNoShow(o, now)) res.released++;
          }
        } else if (o.status === 'AT_AGENCY' && age >= 24 * 3600_000 && (await this.remindOnce(o, ['agency-24h']))) {
          this.events.emit({ type: 'order.stalled', order: o, hours: 24 });
          res.reminded++;
        } else if (o.status === 'IN_TRANSIT' && age >= STALL_TRANSIT_MS && (await this.remindOnce(o, ['transit-6h']))) {
          this.events.emit({ type: 'order.stalled', order: o, hours: 6 });
          res.reminded++;
        } else if (o.status === 'OUT_FOR_DELIVERY' && age >= STALL_TRANSIT_MS && (await this.remindOnce(o, ['delivery-6h']))) {
          this.events.emit({ type: 'order.stalled', order: o, hours: 6 });
          res.reminded++;
        } else if (o.status === 'AT_DESTINATION_HUB' && age >= STALL_HUB_MS && (await this.remindOnce(o, ['hub-24h']))) {
          this.events.emit({ type: 'order.stalled', order: o, hours: 24 });
          res.reminded++;
        } else if (o.status === 'DISPUTED' && o.dispute?.returnRequired && !o.dispute.returnReceivedAt && age >= STALL_RETURN_MS && (await this.remindOnce(o, ['return-48h']))) {
          this.events.emit({ type: 'order.stalled', order: o, hours: 48 });
          res.reminded++;
        }
      } catch (e) {
        console.warn(`[timeouts] ${o.trackingCode}:`, (e as Error).message);
      }
    }
    return res;
  }

  /** When the order first became a paid job waiting for a rider (the 48 h refund clock starts here). */
  private refundAnchor(o: Order): number {
    const at = o.paymentMode === 'ESCROW' ? o.payment.confirmedAt ?? o.createdAt : o.createdAt;
    return Date.parse(at);
  }

  /** Returns false when the fresh row no longer qualifies (someone else moved it first). */
  private async autoRefundUnpicked(orderId: string, now: number): Promise<boolean> {
    let order: Order;
    try {
      ({ order } = await this.mutate(orderId, async (o, repo) => {
        if (o.status !== 'AWAITING_RIDER') throw conflict('moved on');
        if (now - this.refundAnchor(o) < NO_RIDER_REFUND_MS) throw conflict('not old enough');
        if (o.paymentMode === 'COD') {
          transition(o, 'CANCELLED', 'no rider within 48 h');
        } else {
          await this.bookRefund(o, repo, [{ kind: 'BUYER_REFUND', amount: o.total }]);
          transition(o, 'REFUNDED', 'no rider within 48 h, full refund');
        }
      }));
    } catch (e) {
      if (e instanceof AppError && e.code === 'CONFLICT') return false;
      throw e;
    }
    this.events.emit({ type: 'order.status', order });
    if (order.payouts.length) await this.processPayouts(order.id);
    return true;
  }

  private async releaseNoShow(snapshot: Order, now: number): Promise<boolean> {
    let rider: Rider | undefined;
    const snapRiderId = snapshot.status === 'RIDER_ASSIGNED' ? snapshot.firstMileRiderId : snapshot.lastMileRiderId;
    let done: { order: Order; leg: 'FIRST' | 'LAST' };
    try {
      const { order, result: leg } = await this.mutate(snapshot.id, async (o, repo) => {
        // Re-check on the fresh row: same status, same rider, still past the deadline.
        if (o.status !== snapshot.status) throw conflict('moved on');
        const first = o.status === 'RIDER_ASSIGNED';
        const riderId = first ? o.firstMileRiderId : o.lastMileRiderId;
        if (!riderId || riderId !== snapRiderId) throw conflict('rider changed');
        if (now - this.statusSince(o) < NO_SHOW_MS) throw conflict('not old enough');
        if (first) {
          await this.releaseCodReserve(o, repo);
          o.firstMileRiderId = undefined;
          o.sellerChoseRider = undefined;
          if (o.preferredRiderId === riderId) o.preferredRiderId = undefined; // open the job to everyone
          this.resetStallReminders(o);
          transition(o, 'AWAITING_RIDER', 'rider did not pick up within 45 min');
        } else {
          o.lastMileRiderId = undefined;
          transition(o, 'AT_DESTINATION_HUB', 'rider did not pick up within 45 min');
        }
        const r = await repo.getRider(riderId);
        if (r) {
          r.noShows = (r.noShows ?? 0) + 1;
          r.updatedAt = new Date().toISOString();
          rider = await repo.updateRider(r);
        }
        return first ? ('FIRST' as const) : ('LAST' as const);
      });
      done = { order, leg };
    } catch (e) {
      if (e instanceof AppError && e.code === 'CONFLICT') return false;
      throw e;
    }
    if (rider) this.events.emit({ type: 'rider.no_show', order: done.order, rider });
    this.events.emit({ type: 'order.status', order: done.order });
    await this.offerToRiders(done.order, done.leg);
    return true;
  }

  /** Background check of payment attempts started in the last 30 minutes (webhooks can get lost). */
  async syncPendingPayments(now = Date.now()): Promise<number> {
    let n = 0;
    for (const o of await this.listAllOldestFirst(['PENDING_PAYMENT'], { withPaymentReference: true })) {
      if (!o.payment.reference || !o.payment.initiatedAt) continue;
      if (now - Date.parse(o.payment.initiatedAt) > 30 * 60_000) continue;
      if (now - Date.parse(o.payment.lastCheckedAt ?? '0') < 60_000) continue;
      await this.syncPayment(o).catch((e) => console.warn('[payment] sync failed:', e.message));
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ buyer actions

  /** Fallback when the rider can't enter the code (dead phone, no data): the buyer confirms receipt. */
  async buyerConfirmReceived(orderId: string, buyerToken: string | undefined, sessionToken?: string): Promise<BuyerView> {
    const cur = await this.requireBuyer(orderId, buyerToken);
    if (cur.paymentMode === 'COD') {
      throw new AppError('COD_CONFIRM_BY_RIDER', 'Pour une commande en cash, c’est le livreur qui confirme avec le code, après avoir reçu l’argent.', 403);
    }
    if (!this.secrets.verifyToken(sessionToken, cur.buyerSessionHash)) {
      throw forbidden('Seul le téléphone qui a payé peut confirmer la réception.');
    }
    const { order } = await this.mutate(orderId, async (o, repo) => {
      if (o.status !== deliverableStatus(o)) throw conflict('Le colis n’est pas encore en cours de livraison.');
      const left = BUYER_CONFIRM_MIN_MS - (Date.now() - this.pickupTime(o));
      if (left > 0) {
        const min = Math.ceil(left / 60_000);
        throw new AppError('TOO_EARLY', `Trop tôt : le colis a été récupéré il y a moins de 20 min. Réessayez dans ${min} min.`, 409);
      }
      await this.settle(o, repo, 'buyer confirmed receipt');
    });
    this.events.emit({ type: 'order.buyer_confirmed', order });
    this.events.emit({ type: 'order.status', order });
    await this.processPayouts(order.id);
    return this.view((await this.store.getOrder(orderId))!, sessionToken);
  }

  /** When the delivering rider picked the parcel up for the buyer (first IN_TRANSIT / OUT_FOR_DELIVERY entry). */
  private pickupTime(o: Order): number {
    const status: OrderStatus = o.type === 'INTER_CITY' ? 'OUT_FOR_DELIVERY' : 'IN_TRANSIT';
    const h = o.history.find((x) => x.status === status);
    return h ? Date.parse(h.at) : Date.now();
  }

  /** The buyer heard from the agency that the bus arrived. */
  async buyerConfirmArrival(orderId: string, buyerToken: string | undefined, sessionToken?: string): Promise<BuyerView> {
    const cur = await this.requireBuyer(orderId, buyerToken);
    this.requirePayerDevice(cur, sessionToken);
    const { order } = await this.mutate(orderId, (o) => {
      if (o.status !== 'AT_AGENCY') throw conflict('Le colis n’attend pas à l’agence de départ.');
      transition(o, 'AT_DESTINATION_HUB', `arrival confirmed by the buyer in ${o.destinationCity}`);
    });
    this.events.emit({ type: 'order.status', order });
    await this.offerToRiders(order, 'LAST');
    return this.view(order, sessionToken);
  }

  /** Photos attached by the buyer to a dispute (max 5, 2.5 MB each). */
  async buyerAddEvidence(orderId: string, buyerToken: string | undefined, mime: string, data: Buffer, sessionToken?: string): Promise<void> {
    const cur = await this.requireBuyer(orderId, buyerToken);
    this.requirePayerDevice(cur, sessionToken);
    if (!/^image\/(jpeg|png|webp)$/i.test(mime.split(';')[0].trim())) throw invalid('Envoyez une photo (JPEG, PNG ou WebP).');
    if (data.length < 500 || data.length > 2_500_000) throw invalid('La photo doit faire moins de 2,5 Mo.');
    // Trust the bytes, not the header: the stored type is what the admin's browser will be told.
    const sniffed = sniffImageMime(data);
    if (!sniffed) throw invalid('Ce fichier n’est pas une photo valide (JPEG, PNG ou WebP).');
    const mediaId = newId();
    await this.store.tx(async (repo) => {
      const o = await repo.getOrder(orderId);
      if (!o) throw notFound('Order');
      if (o.status !== 'DISPUTED' || !o.dispute) throw conflict('Ouvrez d’abord un signalement.');
      if ((o.dispute.evidence?.length ?? 0) >= 5) throw invalid('5 photos maximum.');
      await repo.putMedia({ id: mediaId, orderId, mime: sniffed, data, createdAt: new Date().toISOString() });
      o.dispute.evidence = [...(o.dispute.evidence ?? []), mediaId];
      await repo.updateOrder(o);
    });
  }

  // ------------------------------------------------------------------ rider: absences, returns, photos

  private deliveringRiderId(o: Order) {
    return o.type === 'INTER_CITY' ? o.lastMileRiderId : o.firstMileRiderId;
  }

  /** Absence claims need a fresh live location close to the drop-off pin (when the order has one). */
  private assertAtDoor(rider: Rider, o: Order) {
    if (!o.dropoffLocation) return; // nothing to compare with: the position is still recorded on the absence
    const fresh = !!rider.location && !!rider.locationUpdatedAt && Date.now() - Date.parse(rider.locationUpdatedAt) <= ABSENCE_LOCATION_MAX_AGE_MS;
    if (!fresh) throw new AppError('LOCATION_STALE', 'Partagez votre position en direct (Telegram) pour signaler une absence.', 409);
    const km = haversineKm(rider.location!, o.dropoffLocation);
    if (km > ABSENCE_MAX_DISTANCE_KM) {
      throw new AppError('TOO_FAR', `Vous êtes à ${Math.round(km * 1000)} m de l’adresse de livraison : rapprochez-vous pour signaler l’absence.`, 409);
    }
  }

  /** Rider is at the door and nobody answers: the buyer is told and gets 15 minutes. */
  async riderReportBuyerAbsent(riderTelegramId: number, orderId: string): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const { order } = await this.mutate(orderId, (o) => {
      if (this.deliveringRiderId(o) !== rider.id) throw forbidden('You are not the delivering rider for this order.');
      if (o.status !== deliverableStatus(o)) throw conflict('This order is not out for delivery.');
      if (o.absence?.side !== 'BUYER') this.assertAtDoor(rider, o);
      if (o.absence?.side === 'BUYER') return;
      o.absence = { side: 'BUYER', riderId: rider.id, at: new Date().toISOString(), location: rider.location };
    });
    this.events.emit({ type: 'order.absence', order, side: 'BUYER' });
    return order;
  }

  /** After waiting (absent) or a refusal at the door, the parcel goes back to the seller. */
  async riderReturnParcel(riderTelegramId: number, orderId: string, reason: 'ABSENT' | 'REFUSED'): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const o = await this.store.getOrder(orderId);
    if (!o || this.deliveringRiderId(o) !== rider.id) throw notFound('Order');
    if (o.status !== deliverableStatus(o)) throw conflict('This order is not out for delivery.');
    this.assertAtDoor(rider, o); // a refusal also happens at the door
    if (reason === 'ABSENT') {
      const waited = o.absence?.side === 'BUYER' ? Date.now() - Date.parse(o.absence.at) : 0;
      if (waited < BUYER_WAIT_MS) {
        const left = Math.ceil((BUYER_WAIT_MS - waited) / 60_000);
        throw new AppError('KEEP_WAITING', o.absence ? `Attendez encore ${left} min : le client a été prévenu.` : 'Signalez d’abord « Client absent » pour lancer les 15 minutes d’attente.', 409);
      }
    }
    return this.openDispute(
      orderId,
      'RIDER',
      reason === 'ABSENT' ? 'Client absent après 15 min d’attente : retour au vendeur' : 'Le client a refusé le colis : retour au vendeur',
      reason === 'ABSENT' ? 'BUYER_ABSENT' : 'BUYER_REFUSED'
    );
  }

  /** Rider reached the shop and the seller isn't there: the job goes back to the pool, no penalty for the rider. */
  async riderReportSellerAbsent(riderTelegramId: number, orderId: string): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const { order } = await this.mutate(orderId, async (o, repo) => {
      if (o.status !== 'RIDER_ASSIGNED' || o.firstMileRiderId !== rider.id) throw conflict('Nothing to pick up for you on this order.');
      await this.releaseCodReserve(o, repo);
      o.firstMileRiderId = undefined;
      o.sellerChoseRider = undefined;
      o.absence = { side: 'SELLER', riderId: rider.id, at: new Date().toISOString(), location: rider.location };
      this.resetStallReminders(o);
      transition(o, 'AWAITING_RIDER', 'seller absent at pickup');
      const m = await repo.getUser(o.merchantId);
      if (m) {
        m.absentAtPickup = (m.absentAtPickup ?? 0) + 1;
        m.updatedAt = new Date().toISOString();
        await repo.updateUser(m);
      }
    });
    this.events.emit({ type: 'order.absence', order, side: 'SELLER' });
    this.events.emit({ type: 'order.status', order });
    await this.offerToRiders(order, 'FIRST');
    return order;
  }

  /** Optional handover photo, taken by the rider right after delivery. */
  async setDeliveryPhoto(riderTelegramId: number, orderId: string, fileId: string): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const { order } = await this.mutate(orderId, (o) => {
      if (this.deliveringRiderId(o) !== rider.id) throw forbidden('You are not the delivering rider for this order.');
      if (o.status !== 'DELIVERED' && o.status !== 'SETTLED') throw conflict('Delivery is not confirmed yet.');
      o.deliveryPhotoFileId = fileId;
    });
    return order;
  }

  /** Rider's earnings: payouts received, still pending, and cash kept on cash-on-delivery jobs. */
  async riderEarnings(riderTelegramId: number) {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const list = await this.store.listOrders({ riderId: rider.id, limit: 500 });
    const now = Date.now();
    const sum = { week: 0, month: 0, total: 0, pending: 0, cashKept: 0, deliveries: rider.completedDeliveries };
    for (const o of list) {
      for (const p of o.payouts) {
        const mine = (p.kind === 'FIRST_MILE_RIDER' && o.firstMileRiderId === rider.id) || (p.kind === 'LAST_MILE_RIDER' && o.lastMileRiderId === rider.id);
        if (!mine) continue;
        if (p.status === 'SENT') {
          sum.total += p.amount;
          const age = now - Date.parse(p.sentAt ?? o.updatedAt);
          if (age < 7 * 86_400_000) sum.week += p.amount;
          if (age < 30 * 86_400_000) sum.month += p.amount;
        } else {
          sum.pending += p.amount;
        }
      }
      if (o.paymentMode === 'COD' && o.codRiderId === rider.id && (o.status === 'DELIVERED' || o.status === 'SETTLED')) sum.cashKept += o.deliveryFee;
    }
    return sum;
  }

  // ------------------------------------------------------------------ seller actions

  /** The parcel is back with the seller after a return: buyer refunded automatically. */
  async sellerConfirmReturn(orderId: string, merchantId: string): Promise<Order> {
    const o = await this.store.getOrder(orderId);
    if (!o || o.merchantId !== merchantId) throw notFound('Order');
    if (o.status !== 'DISPUTED' || !o.dispute?.returnRequired) throw conflict('Aucun retour en attente pour cette commande.');
    // Atomic with the refund. If a previous attempt recorded the return but the refund failed (order
    // still DISPUTED), calling this again simply retries the resolution.
    return this.resolveDispute(orderId, 'REFUND_BUYER', 'parcel back with the seller', { by: 'system', markReturnReceived: true });
  }

  /** New buyer link (the old one stops working), while nothing has been paid or picked up. */
  async rotateBuyerLink(orderId: string, merchantId: string): Promise<{ order: Order; checkoutUrl: string }> {
    const token = Secrets.token();
    const { order } = await this.mutate(orderId, (o) => {
      if (o.merchantId !== merchantId) throw forbidden();
      if (!CANCELLABLE.includes(o.status)) throw conflict('Le colis est déjà en route : le lien ne peut plus être changé.');
      if (o.payment.confirmedAt) throw conflict('Le client a déjà payé avec ce lien.');
      o.buyerTokenHash = this.secrets.hashToken(token);
      o.followTokenHash = undefined;
      o.updatedAt = new Date().toISOString();
    });
    return { order, checkoutUrl: this.checkoutUrl(order, token) };
  }

  /** Fix price, delivery fee, title or buyer number before anyone has paid or a rider accepted. */
  async editBeforePayment(orderId: string, merchant: User, patch: { itemTitle?: string; itemPrice?: number; deliveryFee?: number; buyerPhone?: string }): Promise<Order> {
    const { order } = await this.mutate(orderId, (o) => {
      if (o.merchantId !== merchant.id) throw forbidden();
      const editable = (o.paymentMode === 'ESCROW' && o.status === 'PENDING_PAYMENT' && !o.payment.reference) || (o.paymentMode === 'COD' && o.status === 'AWAITING_RIDER');
      if (!editable) throw conflict('La commande ne peut plus être modifiée (paiement en cours, payée, ou livreur déjà en route).');
      if (patch.itemTitle !== undefined) o.itemTitle = text(patch.itemTitle, 'Item title', 2, 120);
      if (patch.buyerPhone !== undefined) {
        const p = normalizeContactPhone(patch.buyerPhone);
        if (p === merchant.phone) throw invalid('The buyer phone must be different from your own.');
        o.buyerPhone = p;
      }
      const pricing = computePricing(patch.itemPrice ?? o.itemPrice, patch.deliveryFee ?? o.deliveryFee, o.agencyFee, this.settings.commissionPct);
      Object.assign(o, pricing);
      o.updatedAt = new Date().toISOString();
      o.history.push({ status: o.status, at: o.updatedAt, note: 'edited by seller' });
    });
    return order;
  }

  /** Seller's answer to a rider's claim that the agency charged more than declared. */
  async sellerDecideAgencyFee(orderId: string, merchantId: string, approve: boolean): Promise<Order> {
    const { order } = await this.mutate(orderId, (o) => {
      if (o.merchantId !== merchantId) throw forbidden();
      if (o.agencyFeeClaim?.status !== 'PENDING') throw conflict('Pas de demande en attente.');
      o.agencyFeeClaim = { ...o.agencyFeeClaim, status: approve ? 'APPROVED' : 'REJECTED' };
    });
    this.events.emit({ type: 'order.agency_fee_claim', order });
    return order;
  }

  // ------------------------------------------------------------------ admin tools

  /** Unfreeze an order and continue where it stopped (e.g. a code typo lock-out, a false report). */
  async adminResume(orderId: string, note?: string): Promise<Order> {
    const { order } = await this.mutate(orderId, (o) => {
      if (o.status !== 'DISPUTED' || !o.dispute) throw conflict('Order is not disputed.');
      const target = o.dispute.fromStatus;
      if (!canTransition('DISPUTED', target)) throw conflict(`Cannot resume to ${target}.`);
      o.codeAttempts = 0;
      o.absence = undefined;
      o.buyerRefusalAt = undefined; // a false refusal/absence report must not push the buyer to prepaid-only
      o.dispute.resolution = 'RESUMED';
      o.dispute.resolutionNote = optText(note, 'Note', 500);
      o.dispute.resolvedAt = new Date().toISOString();
      transition(o, target, 'resumed by admin');
    });
    this.events.emit({ type: 'order.status', order });
    return order;
  }

  /** Remove the rider (back to the pool), or hand the job to a specific rider (e.g. after an accident). */
  async adminReassign(orderId: string, riderCode: string | null): Promise<Order> {
    if (!riderCode) {
      const { order, result: leg } = await this.mutate(orderId, async (o, repo) => {
        if (o.status === 'RIDER_ASSIGNED') {
          await this.releaseCodReserve(o, repo);
          if (o.preferredRiderId === o.firstMileRiderId) o.preferredRiderId = undefined; // open the job to everyone
          o.firstMileRiderId = undefined;
          o.sellerChoseRider = undefined;
          this.resetStallReminders(o);
          transition(o, 'AWAITING_RIDER', 'rider removed by admin');
          return 'FIRST' as const;
        }
        if (o.status === 'LAST_MILE_ASSIGNED') {
          o.lastMileRiderId = undefined;
          transition(o, 'AT_DESTINATION_HUB', 'rider removed by admin');
          return 'LAST' as const;
        }
        throw conflict('The parcel is already picked up: name the rider who takes over.');
      });
      this.events.emit({ type: 'order.status', order });
      await this.offerToRiders(order, leg);
      return order;
    }
    const rider = await this.requireBookableRider(riderCode);
    const { order } = await this.mutate(orderId, async (o, repo) => {
      const firstLeg = o.status === 'RIDER_ASSIGNED' || o.status === 'IN_TRANSIT';
      const lastLeg = o.status === 'LAST_MILE_ASSIGNED' || o.status === 'OUT_FOR_DELIVERY';
      if (!firstLeg && !lastLeg) throw conflict('No rider to replace at this step.');
      // Same rule as `claim`: one rider can't run both legs of an inter-city order.
      if (firstLeg && o.lastMileRiderId === rider.id) throw invalid('This rider already runs the last leg of this order.');
      if (lastLeg && o.firstMileRiderId === rider.id) throw invalid('This rider already ran the first leg of this order.');
      if (firstLeg) {
        // Once the parcel is picked up it is physically with the old rider, so their COD reservation
        // stays put (it backs the cash/parcel they hold); only before pickup does the reserve move.
        if (o.paymentMode === 'COD' && o.status === 'RIDER_ASSIGNED') {
          await this.releaseCodReserve(o, repo);
          const r = await repo.getRider(rider.id);
          if (!r || r.floatBalance - r.floatReserved < o.itemPrice) throw new AppError('INSUFFICIENT_FLOAT', 'Ce livreur n’a pas assez de caution pour une course cash.', 409);
          r.floatReserved += o.itemPrice;
          r.updatedAt = new Date().toISOString();
          await repo.updateRider(r);
          o.codRiderId = r.id;
          o.codReserved = o.itemPrice;
        }
        o.firstMileRiderId = rider.id;
        o.sellerChoseRider = o.preferredRiderId === rider.id ? true : undefined; // an admin-picked rider is not the seller's choice
      } else {
        o.lastMileRiderId = rider.id;
      }
      const pickedUp = o.status === 'IN_TRANSIT' || o.status === 'OUT_FOR_DELIVERY';
      o.history.push({
        status: o.status,
        at: new Date().toISOString(),
        note: `rider replaced by admin: ${rider.riderCode}${pickedUp && o.paymentMode === 'COD' ? ' (after pickup: COD reserve stays with the previous rider)' : ''}`
      });
    });
    this.events.emit({ type: 'order.reassigned', order, rider });
    return order;
  }

  /** After checking identity by phone, send the release code to the buyer's linked Telegram. */
  async adminResendCode(orderId: string): Promise<Order> {
    const o = await this.store.getOrder(orderId);
    if (!o) throw notFound('Order');
    if (!o.buyerTelegramId) throw invalid('Le client ne suit pas cette commande sur Telegram : demandez-lui d’appuyer sur « Suivre sur Telegram ».');
    if (TERMINAL_STATUSES.includes(o.status) || o.status === 'DELIVERED') throw conflict('La commande est terminée.');
    this.events.emit({ type: 'order.code_resent', order: o, code: this.secrets.decrypt(o.releaseCodeEnc) });
    return o;
  }

  // ------------------------------------------------------------------ payouts

  /**
   * Sends queued payouts. Each payout is marked SENDING (persisted) before the provider call so
   * two workers can't both send it, and a crash mid-call is surfaced for review rather than retried.
   */
  async processPayouts(orderId: string, now = Date.now()): Promise<Order | undefined> {
    if (this.payoutLocks.has(orderId)) return undefined;
    this.payoutLocks.add(orderId);
    try {
      const initial = await this.store.getOrder(orderId);
      if (!initial) return undefined;
      for (const p of initial.payouts) {
        await this.processOnePayout(orderId, p.id, now).catch((e) => console.error(`[payout] ${p.id}:`, e.message));
      }
      const o = await this.store.getOrder(orderId);
      if (o && o.status === 'DELIVERED' && o.payouts.every((p) => p.status === 'SENT')) {
        const { order } = await this.mutate(orderId, (ord) => {
          if (ord.status === 'DELIVERED') transition(ord, 'SETTLED', 'all payouts sent');
        });
        this.events.emit({ type: 'order.status', order });
        return order;
      }
      return o;
    } finally {
      this.payoutLocks.delete(orderId);
    }
  }

  private async processOnePayout(orderId: string, payoutId: string, now: number) {
    const o = await this.store.getOrder(orderId);
    const p = o?.payouts.find((x) => x.id === payoutId);
    if (!o || !p) return;

    if (p.status === 'SENDING') {
      if (p.reference) {
        const tx = await this.gateway.getTransaction(p.reference);
        if (tx.status !== 'PENDING') await this.finishPayout(orderId, payoutId, tx.status === 'SUCCESSFUL', p.reference, 'provider reported failure');
      } else if (now - Date.parse(p.lastAttemptAt ?? '0') > SENDING_STUCK_MS) {
        await this.flagPayout(orderId, payoutId, 'Interrupted while sending: check the provider dashboard before retrying.');
      }
      return;
    }
    if (p.status === 'FAILED') {
      const backoffMs = 2 ** p.attempts * 60_000;
      if (now - Date.parse(p.lastAttemptAt ?? '0') < backoffMs) return;
    } else if (p.status !== 'PENDING') {
      return;
    }

    // Claim it.
    try {
      await this.mutate(orderId, (ord) => {
        const x = ord.payouts.find((y) => y.id === payoutId)!;
        if (x.status !== 'PENDING' && x.status !== 'FAILED') throw conflict('payout already handled');
        x.status = 'SENDING';
        x.attempts += 1;
        x.lastAttemptAt = new Date(now).toISOString();
      });
    } catch {
      return; // someone else claimed it
    }

    try {
      const tx = await this.gateway.withdraw({
        amount: p.amount,
        phone: p.phone,
        description: `BayamSafe ${o.trackingCode}`,
        externalReference: `payout:${p.id}`
      });
      if (tx.status === 'PENDING') {
        await this.mutate(orderId, (ord) => {
          ord.payouts.find((y) => y.id === payoutId)!.reference = tx.reference;
        });
      } else {
        await this.finishPayout(orderId, payoutId, tx.status === 'SUCCESSFUL', tx.reference, 'provider reported failure');
      }
    } catch (e) {
      // Timeout / network / HTTP error: the provider may or may not have sent the money. The gateway
      // can't look a payout up by our reference, so never auto-retry (that could pay twice): a human checks.
      await this.flagPayout(orderId, payoutId, `Ambiguous provider error, check the provider dashboard before retrying: ${(e as Error).message}`.slice(0, 300));
    }
  }

  private async finishPayout(orderId: string, payoutId: string, success: boolean, reference: string | undefined, error: string) {
    const nowIso = new Date().toISOString();
    const { order, result: flagged } = await this.mutate(orderId, async (ord, repo) => {
      const x = ord.payouts.find((y) => y.id === payoutId)!;
      if (x.status !== 'SENDING') return undefined;
      x.reference = reference ?? x.reference;
      if (success) {
        x.status = 'SENT';
        x.sentAt = nowIso;
        x.lastError = undefined;
        await repo.addJournal({
          key: `payout:${x.id}`,
          description: `Payout ${x.kind} for ${ord.trackingCode}`,
          createdAt: nowIso,
          lines: [
            { account: PAYABLE[x.kind], refId: ord.id, amount: -x.amount },
            { account: 'GATEWAY_CLEARING', refId: ord.id, amount: x.amount }
          ]
        });
        return undefined;
      }
      x.lastError = error.slice(0, 300);
      x.status = x.attempts >= MAX_PAYOUT_ATTEMPTS ? 'NEEDS_REVIEW' : 'FAILED';
      return { ...x };
    });
    if (!flagged) return;
    if (flagged.status === 'NEEDS_REVIEW') this.events.emit({ type: 'payout.attention', order, payout: flagged });
    if (flagged.attempts === 1 && flagged.kind !== 'BUYER_REFUND') this.events.emit({ type: 'payout.delayed', order, payout: flagged });
  }

  private async flagPayout(orderId: string, payoutId: string, reason: string) {
    const { order, result } = await this.mutate(orderId, (ord) => {
      const x = ord.payouts.find((y) => y.id === payoutId)!;
      x.status = 'NEEDS_REVIEW';
      x.lastError = reason;
      return { ...x };
    });
    this.events.emit({ type: 'payout.attention', order, payout: result });
  }

  /** Admin, after checking the provider dashboard: either it was paid, or it is safe to retry. */
  async reviewPayout(orderId: string, payoutId: string, action: 'MARK_SENT' | 'RETRY', reference?: string): Promise<Order | undefined> {
    await this.mutate(orderId, async (ord, repo) => {
      const x = ord.payouts.find((y) => y.id === payoutId);
      if (!x) throw notFound('Payout');
      if (x.status !== 'NEEDS_REVIEW' && x.status !== 'FAILED') throw conflict(`Payout is ${x.status}`);
      if (action === 'RETRY') {
        if (!x.phone) throw invalid('This payout has no destination number: pay it by hand, then mark it as sent.');
        x.status = 'PENDING';
        x.attempts = 0;
        return;
      }
      x.status = 'SENT';
      x.reference = reference ?? x.reference;
      x.sentAt = new Date().toISOString();
      await repo.addJournal({
        key: `payout:${x.id}`,
        description: `Payout ${x.kind} for ${ord.trackingCode} (confirmed by admin)`,
        createdAt: x.sentAt,
        lines: [
          { account: PAYABLE[x.kind], refId: ord.id, amount: -x.amount },
          { account: 'GATEWAY_CLEARING', refId: ord.id, amount: x.amount }
        ]
      });
    });
    return this.processPayouts(orderId);
  }

  async processAllPendingPayouts(): Promise<void> {
    for (const o of await this.store.listOrdersWithPendingPayouts()) {
      await this.processPayouts(o.id).catch((e) => console.error(`[payout] ${o.trackingCode}:`, e.message));
    }
  }

  // ------------------------------------------------------------------ queries

  listForMerchant(merchantId: string, limit = 10) {
    return this.store.listOrders({ merchantId, limit });
  }

  listForRider(riderId: string, limit = 10) {
    return this.store.listOrders({ riderId, limit });
  }

  async getForMerchant(orderId: string, merchantId: string): Promise<Order> {
    const o = await this.store.getOrder(orderId);
    if (!o || o.merchantId !== merchantId) throw notFound('Order');
    return o;
  }

  async publicStatus(trackingCode: string) {
    const o = await this.store.getOrderByTracking(trackingCode.trim().toUpperCase());
    if (!o) throw notFound('Order');
    return { trackingCode: o.trackingCode, status: o.status, updatedAt: o.updatedAt };
  }
}
