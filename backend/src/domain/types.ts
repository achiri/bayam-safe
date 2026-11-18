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

export interface User {
  id: string;
  telegramId?: number;
  phoneNumber: string;
  fullName: string;
  role: UserRole;
  preferredLanguage: SupportedLanguage;
  
  // Merchant specific fields
  shopName?: string;
  city?: string;
  isVerifiedMerchant: boolean;
  kycLevel: 1 | 2; // Level 1 = Phone verified, Level 2 = CNI verified badge
  cniNumber?: string;
  cniPhotoUrl?: string;
  totalVolumeProcessed: number;
  unlockedCreditLimit: number; // Working capital inventory loan capability (FCFA)
  
  createdAt: Date;
  updatedAt: Date;
}

export interface RiderProfile {
  userId: string;
  telegramId?: number;
  fullName: string;
  phoneNumber: string;
  cniNumber: string;
  cniPhotoUrl?: string;
  vehicleType: 'MOTO' | 'CAR' | 'VAN';
  plateNumber: string;
  walletBalance: number; // In-app collateral float (FCFA)
  isActive: boolean;     // /on_duty vs /off_duty
  trustScore: number;    // 1.0 to 5.0
  completedDeliveries: number;
  currentLocation?: GeoLocation;
  lastLocationUpdate?: Date;
}

export interface TravelAgency {
  id: string;
  name: string;
  city: string;
  terminalName: string;
  contactPhone: string;
  location: GeoLocation;
}

export interface UnifiedOrder {
  id: string;
  trackingCode: string;
  orderType: OrderType;
  
  merchantId: string;
  merchantName: string;
  merchantPhone: string;
  isMerchantVerified?: boolean;

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

  pickupAddress: string;
  pickupLocation?: GeoLocation;
  dropoffAddress: string;
  dropoffLocation?: GeoLocation;
  landmarkNotes?: string;
  voiceNoteUrl?: string;

  itemTitle: string;
  itemPrice: number;
  deliveryFee: number;
  agencyFee: number;
  platformCommission: number;
  totalAmount: number;
  codAmount: number;
  paymentMode: PaymentMode;
  paymentNetwork?: PaymentNetwork;
  paymentReference?: string;

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
  isMerchantVerified?: boolean;
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
