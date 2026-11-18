import { CreateOrderDTO, EscrowOrder, EscrowStatus } from '../domain/types.js';
import { OtpService } from './otp.service.js';
import { PaymentService } from './payment.service.js';

export class EscrowService {
  private orders: Map<string, EscrowOrder> = new Map();
  private paymentService: PaymentService;
  private readonly feePercent: number = 2.5; // 2.5%

  constructor() {
    this.paymentService = new PaymentService();
  }

  /**
   * Generates public readable order code: CM-ESC-XXXXX
   */
  private generateOrderCode(): string {
    const randomSuffix = Math.floor(10000 + Math.random() * 90000);
    return `CM-ESC-${randomSuffix}`;
  }

  /**
   * Creates a new escrow order initiated by a social seller
   */
  async createOrder(dto: CreateOrderDTO): Promise<EscrowOrder> {
    const code = this.generateOrderCode();
    const id = `order_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const platformFee = Math.round((dto.itemPrice * this.feePercent) / 100);
    const totalAmount = dto.itemPrice + dto.deliveryFee;

    const order: EscrowOrder = {
      id,
      orderCode: code,
      sellerId: dto.sellerTelegramId ? `tg_${dto.sellerTelegramId}` : `seller_${Date.now()}`,
      sellerName: dto.sellerName,
      sellerPhone: dto.sellerPhone,
      itemTitle: dto.itemTitle,
      itemDescription: dto.itemDescription,
      itemPrice: dto.itemPrice,
      deliveryFee: dto.deliveryFee,
      platformFee,
      totalAmount,
      status: 'PENDING_PAYMENT',
      verificationAttempts: 0,
      maxVerificationAttempts: 3,
      buyerPhone: dto.buyerPhone,
      deliveryAddress: dto.deliveryAddress,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours expiration
    };

    this.orders.set(code, order);
    return order;
  }

  getOrder(code: string): EscrowOrder | undefined {
    return this.orders.get(code);
  }

  getAllOrders(): EscrowOrder[] {
    return Array.from(this.orders.values());
  }

  /**
   * Called when MoMo / Orange Money confirms payment collection
   */
  async confirmPayment(orderCode: string, paymentRef: string, buyerPhone?: string): Promise<{
    order: EscrowOrder;
    releaseCode: string;
  }> {
    const order = this.orders.get(orderCode);
    if (!order) {
      throw new Error(`Order ${orderCode} not found`);
    }

    if (order.status !== 'PENDING_PAYMENT') {
      throw new Error(`Invalid order state transition: ${order.status} -> ESCROW_LOCKED`);
    }

    // Generate secret 4-digit release code
    const rawReleaseCode = OtpService.generate4DigitCode();
    const codeHash = OtpService.hashCode(rawReleaseCode);

    order.status = 'ESCROW_LOCKED';
    order.paymentReference = paymentRef;
    order.releaseCodeHash = codeHash;
    order.rawReleaseCodeForTesting = rawReleaseCode; // for sandbox testing
    if (buyerPhone) order.buyerPhone = buyerPhone;
    order.updatedAt = new Date();

    console.log(`[ESCROW LOCKED] Order ${orderCode}: Secured ${order.totalAmount} FCFA. Code: ${rawReleaseCode}`);

    return {
      order,
      releaseCode: rawReleaseCode
    };
  }

  /**
   * Seller or Rider marks order as dispatched / in transit
   */
  async dispatchOrder(orderCode: string, riderPhone?: string, riderName?: string): Promise<EscrowOrder> {
    const order = this.orders.get(orderCode);
    if (!order) throw new Error(`Order ${orderCode} not found`);

    if (order.status !== 'ESCROW_LOCKED') {
      throw new Error(`Order cannot be dispatched from state: ${order.status}`);
    }

    order.status = 'IN_TRANSIT';
    if (riderPhone) order.riderPhone = riderPhone;
    if (riderName) order.riderName = riderName;
    order.updatedAt = new Date();
    return order;
  }

  /**
   * Rider marks arrival at customer door
   */
  async markArrivedForInspection(orderCode: string): Promise<EscrowOrder> {
    const order = this.orders.get(orderCode);
    if (!order) throw new Error(`Order ${orderCode} not found`);

    order.status = 'DELIVERED_PENDING_CONFIRM';
    order.updatedAt = new Date();
    return order;
  }

  /**
   * Release code verification by Buyer or Moto Rider upon handover
   */
  async verifyReleaseCode(orderCode: string, inputCode: string): Promise<{
    success: boolean;
    order: EscrowOrder;
    sellerPayout?: number;
    riderPayout?: number;
    message?: string;
  }> {
    const order = this.orders.get(orderCode);
    if (!order) throw new Error(`Order ${orderCode} not found`);

    if (order.status !== 'ESCROW_LOCKED' && order.status !== 'IN_TRANSIT' && order.status !== 'DELIVERED_PENDING_CONFIRM') {
      throw new Error(`Cannot verify release code for order in state: ${order.status}`);
    }

    if (order.verificationAttempts >= order.maxVerificationAttempts) {
      order.status = 'DISPUTED';
      order.disputeReason = 'Excessive incorrect verification attempts.';
      throw new Error('Maximum verification attempts exceeded. Order locked for support.');
    }

    const isValid = OtpService.verifyCode(inputCode, order.releaseCodeHash || '');

    if (!isValid) {
      order.verificationAttempts += 1;
      return {
        success: false,
        order,
        message: `Code incorrect. ${order.maxVerificationAttempts - order.verificationAttempts} attempts remaining.`
      };
    }

    // Success: State transition to COMPLETED
    order.status = 'COMPLETED';
    order.updatedAt = new Date();

    // Automated Payout Disbursements
    // Platform fee (2.5%) deducted from seller payout
    const sellerPayout = order.itemPrice - order.platformFee;
    const riderPayout = order.deliveryFee;

    // Disburse to seller
    await this.paymentService.disbursePayout(
      order.sellerPhone,
      sellerPayout,
      `Escrow release for ${order.itemTitle} (${order.orderCode})`
    );

    // Disburse to rider if delivery fee exists
    if (riderPayout > 0 && order.riderPhone) {
      await this.paymentService.disbursePayout(
        order.riderPhone,
        riderPayout,
        `Delivery fee payout for (${order.orderCode})`
      );
    }

    return {
      success: true,
      order,
      sellerPayout,
      riderPayout
    };
  }

  /**
   * Dispute / Rejection Flow: Protects Rider Delivery Fee!
   */
  async disputeOrder(orderCode: string, reason: string): Promise<{
    order: EscrowOrder;
    riderCompensated: boolean;
  }> {
    const order = this.orders.get(orderCode);
    if (!order) throw new Error(`Order ${orderCode} not found`);

    order.status = 'DISPUTED';
    order.disputeReason = reason;
    order.updatedAt = new Date();

    // Rider fee protection: If rider dispatched, rider still gets paid from escrow
    let riderCompensated = false;
    if (order.deliveryFee > 0 && order.riderPhone) {
      await this.paymentService.disbursePayout(
        order.riderPhone,
        order.deliveryFee,
        `Guaranteed delivery fee on returned order (${order.orderCode})`
      );
      riderCompensated = true;
    }

    return { order, riderCompensated };
  }
}
