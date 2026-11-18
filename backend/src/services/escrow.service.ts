import {
  CreateUnifiedOrderDTO,
  EscrowOrderStatus,
  UnifiedOrder,
  PaymentMode
} from '../domain/types.js';
import { OtpService } from './otp.service.js';
import { PaymentService } from './payment.service.js';
import { DispatchService } from './dispatch.service.js';
import { AgencyService } from './agency.service.js';

export class EscrowService {
  private orders: Map<string, UnifiedOrder> = new Map();
  private paymentService: PaymentService;
  private dispatchService: DispatchService;
  private agencyService: AgencyService;
  private readonly platformCommissionPct = 2.5; // 2.5%

  constructor() {
    this.paymentService = new PaymentService();
    this.dispatchService = new DispatchService();
    this.agencyService = new AgencyService();
  }

  private generateTrackingCode(cityPrefix: string = 'DLA'): string {
    const randomSuffix = Math.floor(10000 + Math.random() * 90000);
    return `BS-${cityPrefix}-${randomSuffix}`;
  }

  /**
   * Creates a unified order: Intra-City direct or Inter-City Agency Concierge
   */
  async createUnifiedOrder(dto: CreateUnifiedOrderDTO): Promise<UnifiedOrder> {
    const trackingCode = this.generateTrackingCode(dto.orderType === 'INTER_CITY_AGENCY' ? 'INT' : 'DLA');
    const id = `order_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    const platformCommission = Math.round((dto.itemPrice * this.platformCommissionPct) / 100);
    const agencyFee = dto.agencyFee || 0;
    const totalAmount = dto.itemPrice + dto.deliveryFee + agencyFee;
    const codAmount = dto.paymentMode === 'CASH_ON_DELIVERY' ? totalAmount : 0;

    // Cryptographic 4-digit release OTP
    const rawReleaseCode = OtpService.generate4DigitCode();
    const deliveryOtpHash = OtpService.hashCode(rawReleaseCode);

    let agencyName: string | undefined;
    let agencyTerminal: string | undefined;
    if (dto.agencyId) {
      const agency = this.agencyService.getAgencyById(dto.agencyId);
      if (agency) {
        agencyName = agency.name;
        agencyTerminal = agency.terminalName;
      }
    }

    const order: UnifiedOrder = {
      id,
      trackingCode,
      orderType: dto.orderType,
      merchantId: `merchant_${dto.merchantPhone}`,
      merchantName: dto.merchantName,
      merchantPhone: dto.merchantPhone,
      recipientPhone: dto.recipientPhone,
      recipientName: dto.recipientName,
      agencyId: dto.agencyId,
      agencyName,
      agencyTerminal,
      pickupAddress: dto.pickupAddress,
      pickupLocation: dto.pickupLocation,
      dropoffAddress: dto.dropoffAddress,
      dropoffLocation: dto.dropoffLocation,
      landmarkNotes: dto.landmarkNotes,
      voiceNoteUrl: dto.voiceNoteUrl,
      itemTitle: dto.itemTitle,
      itemPrice: dto.itemPrice,
      deliveryFee: dto.deliveryFee,
      agencyFee,
      platformCommission,
      totalAmount,
      codAmount,
      paymentMode: dto.paymentMode,
      deliveryOtpHash,
      rawReleaseCodeForTesting: rawReleaseCode,
      verificationAttempts: 0,
      maxVerificationAttempts: 3,
      status: dto.paymentMode === 'DIGITAL_ESCROW' ? 'DRAFT' : 'SEARCHING_RIDER',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.orders.set(trackingCode, order);
    return order;
  }

  getOrder(code: string): UnifiedOrder | undefined {
    return this.orders.get(code);
  }

  getAllOrders(): UnifiedOrder[] {
    return Array.from(this.orders.values());
  }

  /**
   * Called when digital MoMo / OM payment succeeds
   */
  async confirmPayment(orderCode: string, paymentRef: string): Promise<UnifiedOrder> {
    const order = this.orders.get(orderCode);
    if (!order) throw new Error(`Order ${orderCode} not found`);

    order.paymentReference = paymentRef;
    order.status = 'SEARCHING_RIDER';
    order.updatedAt = new Date();

    console.log(`[ESCROW LOCKED] Order ${orderCode}: Secured ${order.totalAmount} FCFA. Status -> SEARCHING_RIDER`);
    return order;
  }

  /**
   * Rider claims and is assigned to gig (via Redis Redlock mutex)
   */
  async assignRider(orderCode: string, riderId: string): Promise<UnifiedOrder> {
    const order = this.orders.get(orderCode);
    if (!order) throw new Error(`Order ${orderCode} not found`);

    const rider = this.dispatchService.getRider(riderId);
    if (!rider) throw new Error(`Rider ${riderId} not found`);

    // Concurrency safety check
    const acquired = await this.dispatchService.acquireOrderGig(order.id, riderId);
    if (!acquired) {
      throw new Error('Order gig was already acquired by another rider.');
    }

    // Collateral float validation for COD
    if (order.paymentMode === 'CASH_ON_DELIVERY') {
      if (rider.walletBalance < order.codAmount) {
        this.dispatchService.releaseOrderGig(order.id);
        throw new Error(`Insufficient wallet collateral float (${rider.walletBalance} FCFA < ${order.codAmount} FCFA required)`);
      }
    }

    order.firstMileRiderId = rider.userId;
    order.firstMileRiderName = rider.fullName;
    order.firstMileRiderPhone = rider.phoneNumber;
    order.status = 'ASSIGNED';
    order.updatedAt = new Date();

    return order;
  }

  /**
   * Rider arrives at merchant location & collects parcel
   */
  async markAtPickupAndInTransit(orderCode: string): Promise<UnifiedOrder> {
    const order = this.orders.get(orderCode);
    if (!order) throw new Error(`Order ${orderCode} not found`);

    order.status = 'IN_TRANSIT';
    order.updatedAt = new Date();
    return order;
  }

  /**
   * Inter-City Agency Leg: Rider drops parcel at bus terminal and uploads waybill receipt
   */
  async recordAgencyDropoff(orderCode: string, waybillNumber: string, waybillUrl?: string): Promise<UnifiedOrder> {
    const order = this.orders.get(orderCode);
    if (!order) throw new Error(`Order ${orderCode} not found`);

    if (order.orderType !== 'INTER_CITY_AGENCY') {
      throw new Error('Agency drop-off is only valid for Inter-City orders.');
    }

    order.agencyWaybillNumber = waybillNumber;
    order.agencyWaybillUrl = waybillUrl || `https://storage.bayamsafe.cm/waybills/${orderCode}.jpg`;
    order.status = 'AGENCY_DROPPED';
    order.updatedAt = new Date();

    console.log(`[AGENCY DROPPED] Order ${orderCode}: Handed to ${order.agencyName}. Waybill: ${waybillNumber}`);
    return order;
  }

  /**
   * Inter-City Agency Leg: Bus arrives at destination terminal hub
   */
  async recordDestinationHubArrival(orderCode: string): Promise<UnifiedOrder> {
    const order = this.orders.get(orderCode);
    if (!order) throw new Error(`Order ${orderCode} not found`);

    order.status = 'DESTINATION_HUB';
    order.updatedAt = new Date();
    return order;
  }

  /**
   * Inter-City Agency Leg: Assign last-mile delivery rider in destination city
   */
  async assignLastMileRider(orderCode: string, riderId: string): Promise<UnifiedOrder> {
    const order = this.orders.get(orderCode);
    if (!order) throw new Error(`Order ${orderCode} not found`);

    const rider = this.dispatchService.getRider(riderId);
    if (!rider) throw new Error(`Destination rider ${riderId} not found`);

    order.lastMileRiderId = rider.userId;
    order.lastMileRiderName = rider.fullName;
    order.lastMileRiderPhone = rider.phoneNumber;
    order.status = 'LAST_MILE_TRANSIT';
    order.updatedAt = new Date();

    return order;
  }

  /**
   * Final Delivery Handshake: 4-digit OTP verified + PoD photo captured
   */
  async verifyDeliveryAndSettle(
    orderCode: string,
    inputOtp: string,
    podPhotoUrl?: string
  ): Promise<{
    success: boolean;
    order: UnifiedOrder;
    merchantPayout: number;
    firstMilePayout: number;
    lastMilePayout: number;
    message?: string;
  }> {
    const order = this.orders.get(orderCode);
    if (!order) throw new Error(`Order ${orderCode} not found`);

    if (order.verificationAttempts >= order.maxVerificationAttempts) {
      order.status = 'DISPUTED';
      throw new Error('Maximum verification attempts exceeded. Locked for manual arbitration.');
    }

    const isValid = OtpService.verifyCode(inputOtp, order.deliveryOtpHash);
    if (!isValid) {
      order.verificationAttempts += 1;
      return {
        success: false,
        order,
        merchantPayout: 0,
        firstMilePayout: 0,
        lastMilePayout: 0,
        message: `Code OTP erroné. ${order.maxVerificationAttempts - order.verificationAttempts} tentatives restantes.`
      };
    }

    order.status = 'DELIVERED';
    if (podPhotoUrl) order.podPhotoUrl = podPhotoUrl;
    order.updatedAt = new Date();

    // Settle Ledger
    const merchantPayout = order.itemPrice - order.platformCommission;
    let firstMilePayout = order.deliveryFee;
    let lastMilePayout = 0;

    if (order.orderType === 'INTER_CITY_AGENCY' && order.lastMileRiderId) {
      // Split delivery fee between first-mile rider and destination rider
      firstMilePayout = Math.round(order.deliveryFee * 0.5);
      lastMilePayout = Math.round(order.deliveryFee * 0.5);
    }

    if (order.paymentMode === 'DIGITAL_ESCROW') {
      // Disburse from Escrow Pool via MoMo/OM
      await this.paymentService.disbursePayout(
        order.merchantPhone,
        merchantPayout,
        `Escrow Payout for ${order.itemTitle} (${order.trackingCode})`
      );
      if (order.firstMileRiderPhone) {
        await this.paymentService.disbursePayout(
          order.firstMileRiderPhone,
          firstMilePayout,
          `First-mile delivery fee for (${order.trackingCode})`
        );
      }
      if (order.lastMileRiderPhone && lastMilePayout > 0) {
        await this.paymentService.disbursePayout(
          order.lastMileRiderPhone,
          lastMilePayout,
          `Last-mile delivery fee for (${order.trackingCode})`
        );
      }
    } else {
      // CASH ON DELIVERY (COD):
      // The delivering rider collected cash from recipient.
      // Rider float balance is debited, merchant wallet is credited.
      const deliveringRider = this.dispatchService.getRider(order.lastMileRiderId || order.firstMileRiderId || '');
      if (deliveringRider) {
        deliveringRider.walletBalance -= order.codAmount;
      }
      await this.paymentService.disbursePayout(
        order.merchantPhone,
        merchantPayout,
        `COD Settlement for ${order.itemTitle} (${order.trackingCode})`
      );
    }

    order.status = 'SETTLED';
    order.updatedAt = new Date();

    return {
      success: true,
      order,
      merchantPayout,
      firstMilePayout,
      lastMilePayout
    };
  }

  getDispatchService(): DispatchService {
    return this.dispatchService;
  }

  getAgencyService(): AgencyService {
    return this.agencyService;
  }
}
