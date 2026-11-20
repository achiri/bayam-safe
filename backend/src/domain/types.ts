/**
 * Core domain model. All money is integer FCFA (XAF has no minor unit).
 * All timestamps are ISO-8601 strings so objects round-trip through JSON/JSONB unchanged.
 */

export type Lang = 'fr' | 'en';
export type OrderType = 'INTRA_CITY' | 'INTER_CITY';
export type PaymentMode = 'ESCROW' | 'COD';
export type Operator = 'MTN' | 'ORANGE';
export type VehicleType = 'MOTO' | 'CAR' | 'VAN';

export type OrderStatus =
  | 'PENDING_PAYMENT' // escrow order created, buyer has not paid yet
  | 'AWAITING_RIDER' // paid (or COD) and waiting for a first-mile rider
  | 'RIDER_ASSIGNED' // rider accepted, heading to merchant
  | 'IN_TRANSIT' // parcel picked up from merchant
  | 'AT_AGENCY' // inter-city: dropped at bus agency, waybill recorded
  | 'AT_DESTINATION_HUB' // inter-city: bus arrived in destination city
  | 'LAST_MILE_ASSIGNED' // inter-city: destination rider accepted
  | 'OUT_FOR_DELIVERY' // inter-city: destination rider collected parcel from agency
  | 'DELIVERED' // buyer gave the release code; payouts in progress
  | 'SETTLED' // all payouts sent
  | 'DISPUTED' // funds frozen pending admin decision
  | 'REFUNDED' // dispute resolved in buyer's favour, refund sent/pending
  | 'CANCELLED'
  | 'EXPIRED';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export type KycStatus = 'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface User {
  id: string;
  version: number;
  telegramId: number;
  phone: string; // E.164, e.g. +237671234567
  fullName: string;
  shopName: string;
  city?: string;
  lang: Lang;
  kycStatus: KycStatus;
  /** Seller verification documents (Telegram file ids; files stay on Telegram's servers). */
  cniNumber?: string;
  selfieFileId?: string;
  cniFrontFileId?: string;
  cniBackFileId?: string;
  shopPhotoFileId?: string;
  shopLocation?: GeoPoint;
  kycSubmittedAt?: string;
  kycReviewedAt?: string;
  /** Reason shown to the seller when verification is refused. */
  kycNote?: string;
  /** Sign-up in progress (merchant or rider), saved after every step so nothing is lost. */
  draft?: OnboardingDraft;
  /** Set by an admin: the seller can't create new sales (existing orders run their course). */
  suspendedAt?: string;
  suspendNote?: string;
  /** Mobile Money number for payouts, if different from the Telegram number (admin-approved). */
  payoutPhone?: string;
  /** Requested new payout number, waiting for admin approval. */
  pendingPayoutPhone?: string;
  /** FCFA the seller owes the platform (e.g. half delivery fee after a late cancel); taken from next payouts. */
  owedToPlatform?: number;
  /** Times a rider reported the seller absent at pickup. */
  absentAtPickup?: number;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingDraft {
  kind: 'merchant' | 'rider';
  step: string;
  data: Record<string, string | number | GeoPoint | undefined>;
  startedAt: string;
}

export type RiderStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export interface Rider {
  id: string;
  version: number;
  userId: string;
  telegramId: number;
  /** Public rider number printed on the badge, e.g. BSR-7K4Q. Anyone can check it with /verify. */
  riderCode: string;
  fullName: string; // legal name as on the ID card
  phone: string;
  cniNumber: string;
  selfieFileId?: string;
  cniFrontFileId?: string;
  cniBackFileId?: string;
  vehiclePhotoFileId?: string;
  plateNumber: string;
  vehicleType: VehicleType;
  city?: string;
  status: RiderStatus;
  reviewNote?: string;
  reviewedAt?: string;
  onDuty: boolean;
  /** Collateral float held by the platform on the rider's behalf (FCFA). */
  floatBalance: number;
  /** Portion of the float locked against COD orders currently in progress. */
  floatReserved: number;
  completedDeliveries: number;
  /** Accepted jobs never picked up (auto-released after 45 min). */
  noShows?: number;
  location?: GeoPoint;
  locationUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TravelAgency {
  id: string;
  name: string;
  city: string;
  terminalName: string;
  location: GeoPoint;
}

export type PayoutKind = 'MERCHANT' | 'FIRST_MILE_RIDER' | 'LAST_MILE_RIDER' | 'BUYER_REFUND';
/**
 * PENDING -> SENDING -> SENT | FAILED (retried automatically).
 * A payout found in SENDING after a crash, or that failed too often, becomes NEEDS_REVIEW:
 * an admin must check the provider dashboard before it is retried, to avoid paying twice.
 */
export type PayoutStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'NEEDS_REVIEW';

export interface Payout {
  id: string;
  kind: PayoutKind;
  phone: string;
  amount: number;
  status: PayoutStatus;
  attempts: number;
  reference?: string;
  lastError?: string;
  lastAttemptAt?: string;
  sentAt?: string;
}

export interface StatusEvent {
  status: OrderStatus;
  at: string;
  note?: string;
}

export interface Dispute {
  reason: string;
  openedBy: 'BUYER' | 'RIDER' | 'MERCHANT' | 'SYSTEM';
  openedAt: string;
  /** Status before the dispute, used to judge whether delivery was attempted. */
  fromStatus: OrderStatus;
  resolution?: 'REFUND_BUYER' | 'RELEASE_TO_MERCHANT' | 'SPLIT' | 'RESUMED';
  resolutionNote?: string;
  resolvedAt?: string;
  /**
   * BUYER_ABSENT / BUYER_REFUSED / SELLER_RETURN resolve automatically (buyer refunded, riders keep
   * the legs they ran) once the seller confirms the parcel is back. OTHER needs an admin decision.
   */
  kind?: 'BUYER_ABSENT' | 'BUYER_REFUSED' | 'SELLER_RETURN' | 'CODE_LOCK' | 'OTHER';
  /** The parcel must come back to the seller before money moves. */
  returnRequired?: boolean;
  returnReceivedAt?: string;
  /** Media ids of photos the buyer attached. */
  evidence?: string[];
}

export interface Order {
  id: string;
  version: number;
  trackingCode: string; // public, human readable: BS-7KQ4-M2XD
  type: OrderType;
  paymentMode: PaymentMode;
  status: OrderStatus;

  merchantId: string;
  merchantName: string;
  merchantPhone: string;
  merchantVerified: boolean; // snapshot at creation time

  buyerPhone: string;
  buyerName?: string;
  /** Person receiving the parcel, when not the buyer (e.g. buyer abroad). */
  recipientName?: string;
  recipientPhone?: string;

  itemTitle: string;
  itemPrice: number;
  deliveryFee: number;
  agencyFee: number;
  commission: number;
  total: number; // what the buyer pays = itemPrice + deliveryFee + agencyFee

  /** City the parcel starts from (merchant city or origin agency city); used for dispatch fallback. */
  originCity?: string;
  pickupAddress: string;
  pickupLocation?: GeoPoint;
  dropoffAddress?: string;
  dropoffLocation?: GeoPoint;
  landmark?: string;
  voiceNoteId?: string;

  // Inter-city
  originAgencyId?: string;
  destinationCity?: string;
  waybillNumber?: string;
  waybillPhotoFileId?: string;

  firstMileRiderId?: string;
  lastMileRiderId?: string;
  /** The seller's own rider (by BayamSafe rider number): only they are offered the first leg. */
  preferredRiderId?: string;

  /** Buyer following the order on Telegram (linked from the checkout page). */
  buyerTelegramId?: number;
  buyerLang?: Lang;
  /** One-time token for the "follow on Telegram" deep link. */
  followTokenHash?: string;
  followTokenExpiresAt?: string;
  /** Device session that created the follow link; the code is sent only if it is the paying device. */
  followSessionHash?: string;
  /** Set once the buyer has been told the rider is close. */
  riderNearNotifiedAt?: string;
  /** Last time seller/buyer/admins were told no rider is available (to avoid repeating it). */
  noRiderNoticeAt?: string;
  /** Photos taken by the rider: parcel at pickup, handover at delivery. */
  pickupPhotoFileId?: string;
  deliveryPhotoFileId?: string;
  /** A rider waited at the door / at the shop and nobody came. */
  absence?: { side: 'BUYER' | 'SELLER'; riderId: string; at: string; location?: GeoPoint };
  /** Reminder keys already sent (e.g. "stalled-6h"), so each is sent once. */
  reminders?: string[];
  /** COD buyer refused or wasn't there: counts towards the prepaid-only rule. */
  buyerRefusalAt?: string;
  /** Rider says the agency charged more than declared; the seller approves the difference. */
  agencyFeeClaim?: { amount: number; status: 'PENDING' | 'APPROVED' | 'REJECTED'; at: string };
  /** COD: rider whose float is reserved against this order. */
  codRiderId?: string;
  codReserved: number;

  /** sha256(APP_SECRET, token) of the buyer link token. */
  buyerTokenHash: string;
  /** Hash of the device session that started payment; only it may see the release code. */
  buyerSessionHash?: string;
  /** AES-256-GCM encrypted 4-digit release code. */
  releaseCodeEnc: string;
  codeAttempts: number;

  payment: {
    operator?: Operator;
    payerPhone?: string;
    reference?: string;
    /** Session hash of the device that started the current attempt; promoted on confirmation. */
    pendingSessionHash?: string;
    initiatedAt?: string;
    confirmedAt?: string;
    lastCheckedAt?: string;
    /** Every payment attempt, so late or duplicate payments can be refunded to the right number. */
    attempts?: { reference: string; payerPhone: string; at: string }[];
  };

  payouts: Payout[];
  dispute?: Dispute;
  history: StatusEvent[];

  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type LedgerAccount =
  | 'GATEWAY_CLEARING' // money at the payment provider (in/out of mobile money)
  | 'ESCROW' // buyer funds held for an order
  | 'MERCHANT_PAYABLE'
  | 'RIDER_PAYABLE'
  | 'BUYER_REFUND_PAYABLE'
  | 'PLATFORM_REVENUE'
  | 'RIDER_FLOAT' // rider collateral float
  | 'MERCHANT_RECEIVABLE'; // what sellers owe the platform (negative = owed), recovered from payouts

export interface LedgerLine {
  account: LedgerAccount;
  /** Order id or rider id the line belongs to. */
  refId: string;
  /** Signed FCFA amount; lines of one journal sum to zero. */
  amount: number;
}

export interface Journal {
  key: string; // idempotency key, e.g. "order:<id>:settle"
  description: string;
  lines: LedgerLine[];
  createdAt: string;
}

export type TopupStatus = 'PENDING' | 'SENDING' | 'CONFIRMED' | 'FAILED' | 'NEEDS_REVIEW';

export interface FloatTopup {
  id: string;
  /** TOPUP: rider pays in. WITHDRAWAL: rider takes unlocked float back. */
  kind?: 'TOPUP' | 'WITHDRAWAL';
  riderId: string;
  amount: number;
  phone: string;
  reference?: string;
  status: TopupStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Media {
  id: string;
  orderId: string;
  mime: string;
  data: Buffer;
  createdAt: string;
}

/** Who did what in the admin dashboard, for accountability. */
export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target?: string;
  note?: string;
}
