export type UserRole = 'SELLER' | 'BUYER' | 'RIDER' | 'ADMIN';
export type SupportedLanguage = 'fr' | 'en';

export type EscrowStatus =
  | 'DRAFT'
  | 'PENDING_PAYMENT'
  | 'ESCROW_LOCKED'
  | 'IN_TRANSIT'
  | 'DELIVERED_PENDING_CONFIRM'
  | 'COMPLETED'
  | 'DISPUTED'
  | 'REFUNDED_FULL'
  | 'REFUNDED_PARTIAL'
  | 'EXPIRED';

export type PaymentNetwork = 'MTN_MOMO' | 'ORANGE_MONEY';

export interface User {
  id: string;
  telegramId?: number;
  phoneNumber: string;
  fullName: string;
  role: UserRole;
  preferredLanguage: SupportedLanguage;
  isVerifiedMerchant: boolean;
}

export interface EscrowOrder {
  id: string;
  orderCode: string;
  sellerId: string;
  sellerName: string;
  sellerPhone: string;
  
  buyerId?: string;
  buyerName?: string;
  buyerPhone?: string;

  riderId?: string;
  riderName?: string;
  riderPhone?: string;

  itemTitle: string;
  itemDescription?: string;
  itemPrice: number;        // FCFA
  deliveryFee: number;      // FCFA
  platformFee: number;      // 2.5%
  totalAmount: number;      // itemPrice + deliveryFee + feeShare

  status: EscrowStatus;
  paymentNetwork?: PaymentNetwork;
  paymentReference?: string;

  releaseCodeHash?: string;
  rawReleaseCodeForTesting?: string; // Kept in memory only in sandbox/test mode
  verificationAttempts: number;
  maxVerificationAttempts: number;

  deliveryAddress?: string;
  disputeReason?: string;

  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

export interface CreateOrderDTO {
  sellerTelegramId?: number;
  sellerName: string;
  sellerPhone: string;
  itemTitle: string;
  itemDescription?: string;
  itemPrice: number;
  deliveryFee: number;
  buyerPhone?: string;
  deliveryAddress?: string;
}

export interface PaymentInitiationResult {
  success: boolean;
  paymentReference: string;
  instructions: {
    en: string;
    fr: string;
  };
  ussdPromptCode?: string;
  redirectUrl?: string;
}

export interface PaymentWebhookPayload {
  event: 'payment.successful' | 'payment.failed';
  orderCode: string;
  amount: number;
  operator: 'MTN' | 'ORANGE';
  reference: string;
  phoneNumber: string;
}
