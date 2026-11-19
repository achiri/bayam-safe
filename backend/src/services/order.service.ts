import { AGENCIES, CITIES, getAgency } from '../domain/agencies.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../domain/errors.js';
import { assertGeoPoint } from '../domain/geo.js';
import { computePricing, refundPlan, settlementPlan, PayoutPlanLine } from '../domain/money.js';
import { DISPUTABLE_STATUSES, TERMINAL_STATUSES, deliverableStatus, transition } from '../domain/order-state.js';
import { detectOperator, normalizeCameroonPhone } from '../domain/phone.js';
import { Secrets, newId, newReleaseCode, newTrackingCode, safeEqual } from '../domain/secrets.js';
import {
  Dispute, GeoPoint, LedgerAccount, Operator, Order, OrderStatus, OrderType, PaymentMode, Payout, PayoutKind, Rider, User
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
  can: { pay: boolean; editDelivery: boolean; dispute: boolean };
  /** Only present for the device that paid (escrow) or the link holder (COD). */
  releaseCode?: string;
  /** True when the order is paid but this device is not the one that paid. */
  releaseCodeOnOtherDevice: boolean;
  dispute?: Pick<Dispute, 'reason' | 'openedAt' | 'resolution'>;
}

const MAX_PAYOUT_ATTEMPTS = 5;
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
    return this.store.tx(async (repo) => {
      const o = await repo.getOrder(orderId);
      if (!o) throw notFound('Order');
      const result = await fn(o, repo);
      const order = await repo.updateOrder(o);
      return { order, result };
    });
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
    if (!['INTRA_CITY', 'INTER_CITY'].includes(input.type)) throw invalid('Invalid order type');
    if (!['ESCROW', 'COD'].includes(input.paymentMode)) throw invalid('Invalid payment mode');
    if (input.type === 'INTER_CITY' && input.paymentMode === 'COD') {
      throw invalid('Cash on delivery is only available for deliveries within the same city.');
    }

    const buyerPhone = normalizeCameroonPhone(input.buyerPhone);
    if (buyerPhone === merchant.phone) throw invalid('The buyer phone must be different from your own.');

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
      ...pricing,
      originCity,
      pickupAddress: text(input.pickupAddress, 'Pickup address', 3, 200),
      pickupLocation: input.pickupLocation ? assertGeoPoint(input.pickupLocation) : undefined,
      originAgencyId: input.type === 'INTER_CITY' ? input.originAgencyId : undefined,
      destinationCity,
      itemTitle: text(input.itemTitle, 'Item title', 2, 120),
      codReserved: 0,
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
    return this.toBuyerView(o, sessionToken);
  }

  private toBuyerView(o: Order, sessionToken?: string): BuyerView {
    const agency = getAgency(o.originAgencyId ?? '');
    const active = !TERMINAL_STATUSES.includes(o.status) && o.status !== 'DELIVERED';
    const sessionOk = this.secrets.verifyToken(sessionToken, o.buyerSessionHash);
    const paid = o.status !== 'PENDING_PAYMENT' && !!o.payment.confirmedAt;
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
        dispute: DISPUTABLE_STATUSES.includes(o.status)
      },
      releaseCode: showCode ? this.secrets.decrypt(o.releaseCodeEnc) : undefined,
      releaseCodeOnOtherDevice: active && o.paymentMode === 'ESCROW' && paid && !sessionOk,
      dispute: o.dispute && { reason: o.dispute.reason, openedAt: o.dispute.openedAt, resolution: o.dispute.resolution }
    };
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
    return this.toBuyerView(order);
  }

  async attachVoiceNote(orderId: string, buyerToken: string | undefined, mime: string, data: Buffer): Promise<void> {
    await this.requireBuyer(orderId, buyerToken);
    if (!/^audio\/[a-z0-9.+-]+$/i.test(mime)) throw invalid('Voice note must be an audio file');
    if (data.length < 200 || data.length > 400_000) throw invalid('Voice note must be under 400 KB (about 15 seconds)');
    const mediaId = newId();
    await this.store.tx(async (repo) => {
      const o = await repo.getOrder(orderId);
      if (!o) throw notFound('Order');
      if (NON_EDITABLE.includes(o.status)) throw conflict('Delivery details can no longer be changed.');
      await repo.putMedia({ id: mediaId, orderId, mime: mime.split(';')[0], data, createdAt: new Date().toISOString() });
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
  async initiatePayment(orderId: string, buyerToken: string | undefined, payerPhoneInput: string) {
    let o = await this.requireBuyer(orderId, buyerToken);
    if (o.paymentMode !== 'ESCROW') throw invalid('This order is paid in cash on delivery.');
    if (o.status !== 'PENDING_PAYMENT') throw conflict('This order is already paid or closed.');
    if (o.expiresAt && o.expiresAt <= new Date().toISOString()) throw conflict('This payment link has expired.');
    const payerPhone = normalizeCameroonPhone(payerPhoneInput);

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
    const sessionToken = Secrets.token();
    const now = new Date().toISOString();
    await this.mutate(orderId, (ord) => {
      if (ord.status !== 'PENDING_PAYMENT') throw conflict('This order is already paid or closed.');
      ord.payment = {
        operator: res.operator ?? detectOperator(payerPhone),
        payerPhone,
        reference: res.reference,
        pendingSessionHash: this.secrets.hashToken(sessionToken),
        initiatedAt: now,
        lastCheckedAt: now
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
      // Money arrived that we can't match cleanly (late/duplicate attempt, wrong amount, expired order).
      if (await this.store.markEventProcessed(`mismatch:${tx.reference}`)) {
        this.events.emit({ type: 'order.payment_mismatch', order, paidAmount: tx.amount });
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

  async buyerOpenDispute(orderId: string, buyerToken: string | undefined, reason: string): Promise<BuyerView> {
    await this.requireBuyer(orderId, buyerToken);
    const order = await this.openDispute(orderId, 'BUYER', reason);
    return this.toBuyerView(order);
  }

  // ------------------------------------------------------------------ riders

  async offerToRiders(order: Order, leg: 'FIRST' | 'LAST'): Promise<void> {
    const offers = await this.dispatch.candidates(order, leg);
    this.events.emit(offers.length ? { type: 'order.offer', order, leg, offers } : { type: 'order.no_riders', order, leg });
  }

  /** First rider to accept wins; concurrent accepts fail with a version conflict. */
  async claim(riderTelegramId: number, orderId: string): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    if (!rider.onDuty) throw invalid('Go on duty first (/on_duty).');
    try {
      const { order } = await this.mutate(orderId, async (o, repo) => {
        const r = await repo.getRider(rider.id);
        if (!r) throw notFound('Rider');
        if (o.status === 'AWAITING_RIDER') {
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

  async confirmPickup(riderTelegramId: number, orderId: string): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const { order } = await this.mutate(orderId, (o) => {
      if (o.status === 'RIDER_ASSIGNED' && o.firstMileRiderId === rider.id) transition(o, 'IN_TRANSIT', 'picked up from merchant');
      else if (o.status === 'LAST_MILE_ASSIGNED' && o.lastMileRiderId === rider.id) transition(o, 'OUT_FOR_DELIVERY', 'collected from agency');
      else throw conflict('Nothing to pick up for you on this order.');
    });
    this.events.emit({ type: 'order.status', order });
    return order;
  }

  async recordAgencyDropoff(riderTelegramId: number, orderId: string, waybillNumber: string, waybillPhotoFileId: string): Promise<Order> {
    const rider = await this.riders.requireApproved(riderTelegramId);
    const waybill = waybillNumber.trim().toUpperCase();
    if (!/^[A-Z0-9/-]{3,30}$/.test(waybill)) throw invalid('Invalid waybill number');
    if (!waybillPhotoFileId) throw invalid('A photo of the waybill is required');
    const { order } = await this.mutate(orderId, (o) => {
      if (o.type !== 'INTER_CITY') throw invalid('Only inter-city orders go through an agency.');
      if (o.status !== 'IN_TRANSIT' || o.firstMileRiderId !== rider.id) throw conflict('This parcel is not in transit with you.');
      o.waybillNumber = waybill;
      o.waybillPhotoFileId = waybillPhotoFileId;
      transition(o, 'AT_AGENCY', `waybill ${waybill}`);
    });
    this.events.emit({ type: 'order.status', order });
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
          this.applyDispute(o, 'SYSTEM', 'Too many wrong release codes');
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
        return o.payment.payerPhone ?? o.buyerPhone;
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

    if (o.paymentMode === 'ESCROW') {
      const plan = settlementPlan(o);
      o.payouts = this.buildPayouts(o, plan, riders);
      await repo.addJournal({
        key: `order:${o.id}:settle`,
        description: `Delivery confirmed for ${o.trackingCode}`,
        createdAt: now,
        lines: [
          { account: 'ESCROW', refId: o.id, amount: -o.total },
          ...plan.map((l) => ({ account: PAYABLE[l.kind], refId: o.id, amount: l.amount })),
          { account: 'PLATFORM_REVENUE', refId: o.id, amount: o.commission }
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
      const merchantShare = o.itemPrice - o.commission;
      o.payouts = merchantShare > 0 ? this.buildPayouts(o, [{ kind: 'MERCHANT', amount: merchantShare }], riders) : [];
      await repo.addJournal({
        key: `order:${o.id}:cod-settle`,
        description: `COD delivery confirmed for ${o.trackingCode}`,
        createdAt: now,
        lines: [
          { account: 'RIDER_FLOAT', refId: rider.id, amount: -o.itemPrice },
          { account: 'MERCHANT_PAYABLE', refId: o.id, amount: merchantShare },
          { account: 'PLATFORM_REVENUE', refId: o.id, amount: o.commission }
        ]
      });
    }

    for (const r of riders.values()) {
      if (r.id === o.firstMileRiderId || r.id === o.lastMileRiderId) r.completedDeliveries += 1;
      r.updatedAt = now;
      await repo.updateRider(r);
    }
  }

  private applyDispute(o: Order, openedBy: Dispute['openedBy'], reason: string) {
    o.dispute = { reason, openedBy, openedAt: new Date().toISOString(), fromStatus: o.status };
    transition(o, 'DISPUTED', `${openedBy.toLowerCase()}: ${reason}`);
  }

  async openDispute(orderId: string, openedBy: Dispute['openedBy'], reasonInput: string): Promise<Order> {
    const reason = text(reasonInput, 'Reason', 3, 500);
    const { order } = await this.mutate(orderId, (o) => {
      if (!DISPUTABLE_STATUSES.includes(o.status)) throw conflict('A problem can only be reported while the parcel is on its way.');
      this.applyDispute(o, openedBy, reason);
    });
    this.events.emit({ type: 'order.disputed', order });
    return order;
  }

  /** Admin decision after hearing both sides (and getting the parcel back to the merchant if refunding). */
  async resolveDispute(orderId: string, resolution: 'REFUND_BUYER' | 'RELEASE_TO_MERCHANT', note?: string): Promise<Order> {
    const { order } = await this.mutate(orderId, async (o, repo) => {
      if (o.status !== 'DISPUTED' || !o.dispute) throw conflict('Order is not disputed.');
      o.dispute.resolution = resolution;
      o.dispute.resolutionNote = optText(note, 'Note', 500);
      o.dispute.resolvedAt = new Date().toISOString();

      if (resolution === 'RELEASE_TO_MERCHANT') {
        await this.settle(o, repo, 'released by admin');
        return;
      }
      if (o.paymentMode === 'ESCROW') {
        const seen = new Set(o.history.map((h) => h.status));
        const plan = refundPlan(o, {
          pickedUp: seen.has('IN_TRANSIT'),
          reachedAgency: seen.has('AT_AGENCY'),
          lastMileRan: seen.has('OUT_FOR_DELIVERY')
        });
        await this.bookRefund(o, repo, plan);
      } else {
        await this.releaseCodReserve(o, repo);
      }
      transition(o, 'REFUNDED', 'refunded by admin');
    });
    this.events.emit({ type: 'order.status', order });
    await this.processPayouts(order.id);
    return (await this.store.getOrder(order.id)) ?? order;
  }

  private async bookRefund(o: Order, repo: Repo, plan: PayoutPlanLine[]) {
    const riders = await this.loadRiders(o, repo);
    o.payouts = this.buildPayouts(o, plan, riders);
    await repo.addJournal({
      key: `order:${o.id}:refund`,
      description: `Refund for ${o.trackingCode}`,
      createdAt: new Date().toISOString(),
      lines: [{ account: 'ESCROW', refId: o.id, amount: -o.total }, ...plan.map((l) => ({ account: PAYABLE[l.kind], refId: o.id, amount: l.amount }))]
    });
  }

  /** Merchant or admin cancels before the parcel is picked up. Paid escrow is refunded in full. */
  async cancel(orderId: string, actor: { merchantId?: string; admin?: boolean }): Promise<Order> {
    const current = await this.store.getOrder(orderId);
    if (!current) throw notFound('Order');
    if (!actor.admin && current.merchantId !== actor.merchantId) throw forbidden();
    if (current.status === 'PENDING_PAYMENT' && current.payment.reference) {
      await this.syncPayment(current).catch(() => undefined);
    }
    const { order } = await this.mutate(orderId, async (o, repo) => {
      if (o.status === 'PENDING_PAYMENT') {
        if (o.payment.reference && Date.now() - Date.parse(o.payment.initiatedAt ?? '0') < 10 * 60_000) {
          throw conflict('The buyer is paying right now. Try again in a few minutes.');
        }
        transition(o, 'CANCELLED', 'cancelled before payment');
      } else if (o.status === 'AWAITING_RIDER' || o.status === 'RIDER_ASSIGNED') {
        if (o.paymentMode === 'COD') {
          await this.releaseCodReserve(o, repo);
          transition(o, 'CANCELLED', 'cancelled before pickup');
        } else {
          await this.bookRefund(o, repo, [{ kind: 'BUYER_REFUND', amount: o.total }]);
          transition(o, 'REFUNDED', 'cancelled before pickup, full refund');
        }
      } else {
        throw conflict('The parcel has already been picked up. Report a problem instead.');
      }
    });
    this.events.emit({ type: 'order.status', order });
    if (order.payouts.length) await this.processPayouts(order.id);
    return (await this.store.getOrder(order.id)) ?? order;
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
    const waiting = await this.store.listOrders({ statuses: ['AWAITING_RIDER', 'AT_DESTINATION_HUB'], limit: 200 });
    let n = 0;
    for (const o of waiting) {
      if (now - Date.parse(o.updatedAt) < olderThanMs) continue;
      await this.offerToRiders(o, o.status === 'AWAITING_RIDER' ? 'FIRST' : 'LAST');
      n++;
    }
    return n;
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
      await this.finishPayout(orderId, payoutId, false, undefined, (e as Error).message);
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
      return x.status === 'NEEDS_REVIEW' ? { ...x } : undefined;
    });
    if (flagged) this.events.emit({ type: 'payout.attention', order, payout: flagged });
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
