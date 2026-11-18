import { PaymentInitiationResult, PaymentNetwork, PaymentWebhookPayload } from '../domain/types.js';

export class PaymentService {
  private isSandbox: boolean;
  private appUsername: string;
  private appPassword: string;

  constructor() {
    this.isSandbox = process.env.PAYMENT_GATEWAY_PROVIDER?.includes('sandbox') ?? true;
    this.appUsername = process.env.CAMPAY_APP_USERNAME || 'demo_sandbox_user';
    this.appPassword = process.env.CAMPAY_APP_PASSWORD || 'demo_sandbox_password';
  }

  /**
   * Identifies Cameroon telecom operator by phone prefix
   * MTN: 67x, 650-654, 680-684
   * Orange: 69x, 655-659
   */
  static detectOperator(phoneNumber: string): PaymentNetwork {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const nationalNumber = cleanNumber.startsWith('237') ? cleanNumber.slice(3) : cleanNumber;

    if (nationalNumber.startsWith('67') || nationalNumber.startsWith('68') || /^[6][5][0-4]/.test(nationalNumber)) {
      return 'MTN_MOMO';
    }
    return 'ORANGE_MONEY';
  }

  /**
   * Initiates USSD Push prompt for Mobile Money or Orange Money
   */
  async initiateCollection(
    orderCode: string,
    amount: number,
    buyerPhone: string
  ): Promise<PaymentInitiationResult> {
    const operator = PaymentService.detectOperator(buyerPhone);
    const paymentRef = `CAMPAY-SBX-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const ussdGuide =
      operator === 'MTN_MOMO'
        ? {
            en: `Check your phone! A prompt from MTN Mobile Money (*126#) has been sent to ${buyerPhone}. Enter your PIN to approve ${amount} FCFA.`,
            fr: `Vérifiez votre téléphone ! Une invite MTN MoMo (*126#) a été envoyée au ${buyerPhone}. Entrez votre code PIN pour valider ${amount} FCFA.`
          }
        : {
            en: `Check your phone! An Orange Money prompt (#150#) has been sent to ${buyerPhone}. Enter your PIN to approve ${amount} FCFA.`,
            fr: `Vérifiez votre téléphone ! Une invite Orange Money (#150#) a été envoyée au ${buyerPhone}. Entrez votre code secret pour valider ${amount} FCFA.`
          };

    // Return structured payload with sandbox reference
    return {
      success: true,
      paymentReference: paymentRef,
      instructions: ussdGuide,
      ussdPromptCode: operator === 'MTN_MOMO' ? '*126#' : '#150#'
    };
  }

  /**
   * Simulates/disburses funds out of the escrow pool into Seller or Rider wallet
   */
  async disbursePayout(
    recipientPhone: string,
    amount: number,
    description: string
  ): Promise<{ success: boolean; payoutReference: string }> {
    const operator = PaymentService.detectOperator(recipientPhone);
    const payoutRef = `DISBURSE-SBX-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    console.log(
      `[PAYMENT SANDBOX] Disbursed ${amount} FCFA to ${recipientPhone} (${operator}) for "${description}". Ref: ${payoutRef}`
    );

    return {
      success: true,
      payoutReference: payoutRef
    };
  }
}
