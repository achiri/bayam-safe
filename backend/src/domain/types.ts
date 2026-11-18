export type UserRole = 'MERCHANT' | 'BUYER' | 'RIDER' | 'ADMIN';
export type SupportedLanguage = 'fr' | 'en';

export type OrderType = 'INTRA_CITY' | 'INTER_CITY_AGENCY';
export type PaymentMode = 'DIGITAL_ESCROW' | 'CASH_ON_DELIVERY';
export type PaymentNetwork = 'MTN_MOMO' | 'ORANGE_MONEY';

export type EscrowOrderStatus =
  | 'DRAFT'
  | 'SEARCHING_RIDER'
  | 'ASSIGNED'
  | 'AT_PICKUP'
  | 'IN_TRANSIT'
  | 'AGENCY_DROPPED'
  | 'DESTINATION_HUB'
  | 'LAST_MILE_ASSIGNED'
  | 'LAST_MILE_TRANSIT'
  | 'DELIVERED'
  | 'SETTLED'
  | 'DISPUTED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface GeoLocation {
  latitude: number;
  longitude: number;
}

export interface TravelAgency {
  id: string;
  name: string;           // e.g. "Moghamo Express", "Guarantee Express"
  city: string;           // "Douala", "Yaoundé", "Bamenda", "Buea"
  terminalName: string;   // "Bonaberi Terminal", "Mvan Agency"
  contactPhone: string;
  location: GeoLocation;
}

export interface RiderProfile {
  userId: string;
  fullName: string;
  phoneNumber: string;
  cniNumber: string;
  vehicleType: 'MOTO' | 'CAR' | 'VAN';
  walletBalance: number;  // Collateral float (FCFA)
  isActive: boolean;      // /on_duty or /off_duty
  trustScore: number;     // 1.0 - 5.0
  currentLocation?: GeoLocation;
  lastLocationUpdate?: Date;
}

export interface UnifiedOrder {
  id: string;
  trackingCode: string;   // e.g. "BS-DLA-83921"
  orderType: OrderType;
  
  merchantId: string;
  merchantName: string;
  merchantPhone: string;

  recipientPhone: string;
  recipientName?: string;

  firstMileRiderId?: string;
  firstMileRiderName?: string;
  firstMileRiderPhone?: string;

  lastMileRiderId?: string;
  lastMileRiderName?: string;
  lastMileRiderPhone?: string;

  agencyId?: string;
  agencyName?: string;
  agencyTerminal?: string;
  agencyWaybillNumber?: string;
  agencyWaybillUrl?: string;

  // Informal Cameroon Waypoints
  pickupAddress: string;
  pickupLocation?: GeoLocation;
  dropoffAddress: string;
  dropoffLocation?: GeoLocation;
  landmarkNotes?: string;
  voiceNoteUrl?: string;

  // Financials
  itemTitle: string;
  itemPrice: number;            // FCFA
  deliveryFee: number;          // FCFA
  agencyFee: number;            // FCFA
  platformCommission: number;   // 2.5%
  totalAmount: number;
  codAmount: number;            // FCFA if COD
  paymentMode: PaymentMode;
  paymentNetwork?: PaymentNetwork;
  paymentReference?: string;

  // Verification & PoD
  deliveryOtpHash: string;
  rawReleaseCodeForTesting?: string;
  verificationAttempts: number;
  maxVerificationAttempts: number;
  podPhotoUrl?: string;

  status: EscrowOrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUnifiedOrderDTO {
  orderType: OrderType;
  merchantName: string;
  merchantPhone: string;
  recipientPhone: string;
  recipientName?: string;
  itemTitle: string;
  itemPrice: number;
  deliveryFee: number;
  agencyId?: string;
  agencyFee?: number;
  paymentMode: PaymentMode;
  pickupAddress: string;
  pickupLocation?: GeoLocation;
  dropoffAddress: string;
  dropoffLocation?: GeoLocation;
  landmarkNotes?: string;
  voiceNoteUrl?: string;
}

export interface DispatchCandidate {
  rider: RiderProfile;
  distanceKm: number;
  isFloatEligible: boolean;
}
