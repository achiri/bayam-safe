import { AppError, invalid, notFound } from '../domain/errors.js';
import { assertGeoPoint } from '../domain/geo.js';
import { assertAmount } from '../domain/money.js';
import { newId } from '../domain/secrets.js';
import { FloatTopup, GeoPoint, Rider, VehicleType } from '../domain/types.js';
import { PaymentGateway, Transaction } from '../payments/gateway.js';
import { Store } from '../storage/store.js';
import { EventBus } from './events.js';
import { UserService } from './user.service.js';

export interface RiderApplication {
  cniNumber: string;
  plateNumber: string;
  vehicleType: VehicleType;
  city: string;
}

export class RiderService {
  constructor(
    private readonly store: Store,
    private readonly users: UserService,
    private readonly gateway: PaymentGateway,
    private readonly events: EventBus
  ) {}

  getByTelegram(telegramId: number) {
    return this.store.getRiderByTelegram(telegramId);
  }

  async requireApproved(telegramId: number): Promise<Rider> {
    const r = await this.store.getRiderByTelegram(telegramId);
    if (!r) throw new AppError('NOT_A_RIDER', 'You are not registered as a rider (/register_rider).', 403);
    if (r.status !== 'APPROVED') throw new AppError('RIDER_NOT_APPROVED', `Your rider account is ${r.status}.`, 403);
    return r;
  }

  /** Rider applies; an admin approves after checking the ID and plate in person. */
  async apply(telegramId: number, app: RiderApplication): Promise<Rider> {
    const user = await this.users.require(telegramId);
    if (await this.store.getRiderByTelegram(telegramId)) throw invalid('You already applied as a rider.');
    const cni = app.cniNumber.replace(/\s/g, '').toUpperCase();
    const plate = app.plateNumber.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z0-9]{6,20}$/.test(cni)) throw invalid('Invalid ID number');
    if (!/^[A-Z0-9-]{4,12}$/.test(plate)) throw invalid('Invalid plate number');
    const now = new Date().toISOString();
    const rider: Rider = {
      id: newId(),
      version: 1,
      userId: user.id,
      telegramId,
      fullName: user.fullName,
      phone: user.phone,
      cniNumber: cni,
      plateNumber: plate,
      vehicleType: app.vehicleType,
      city: app.city,
      status: 'PENDING',
      onDuty: false,
      floatBalance: 0,
      floatReserved: 0,
      completedDeliveries: 0,
      createdAt: now,
      updatedAt: now
    };
    await this.store.insertRider(rider);
    this.events.emit({ type: 'rider.applied', rider });
    return rider;
  }

  async decide(riderId: string, status: 'APPROVED' | 'SUSPENDED'): Promise<Rider> {
    const r = await this.store.getRider(riderId);
    if (!r) throw notFound('Rider');
    r.status = status;
    if (status === 'SUSPENDED') r.onDuty = false;
    r.updatedAt = new Date().toISOString();
    const saved = await this.store.updateRider(r);
    this.events.emit({ type: 'rider.decided', rider: saved });
    return saved;
  }

  async setDuty(telegramId: number, onDuty: boolean): Promise<Rider> {
    const r = await this.requireApproved(telegramId);
    r.onDuty = onDuty;
    r.updatedAt = new Date().toISOString();
    return this.store.updateRider(r);
  }

  /** From Telegram (live) location shares. Silently ignores unknown senders. */
  async updateLocation(telegramId: number, point: GeoPoint): Promise<Rider | undefined> {
    const r = await this.store.getRiderByTelegram(telegramId);
    if (!r) return undefined;
    r.location = assertGeoPoint(point);
    r.locationUpdatedAt = new Date().toISOString();
    try {
      return await this.store.updateRider(r);
    } catch {
      return undefined; // a concurrent update won; the next live-location tick will land
    }
  }

  /** Starts a mobile-money collection that credits the rider's COD collateral float. */
  async requestTopup(telegramId: number, amount: number): Promise<{ topup: FloatTopup; ussdCode?: string }> {
    const r = await this.requireApproved(telegramId);
    assertAmount('amount', amount, { min: 1000, max: 500_000 });
    const now = new Date().toISOString();
    const topup: FloatTopup = { id: newId(), riderId: r.id, amount, phone: r.phone, status: 'PENDING', createdAt: now, updatedAt: now };
    await this.store.insertTopup(topup);
    const res = await this.gateway.collect({
      amount,
      phone: r.phone,
      description: `BayamSafe float top-up`,
      externalReference: `topup:${topup.id}`
    });
    topup.reference = res.reference;
    await this.store.updateTopup(topup);
    return { topup, ussdCode: res.ussdCode };
  }

  /** Applies a provider transaction to a pending top-up (idempotent). */
  async applyTopupTransaction(tx: Transaction): Promise<void> {
    const topup = await this.store.getTopupByRef(tx.reference);
    if (!topup || topup.status !== 'PENDING') return;
    if (tx.status === 'FAILED') {
      await this.store.updateTopup({ ...topup, status: 'FAILED', updatedAt: new Date().toISOString() });
      return;
    }
    if (tx.status !== 'SUCCESSFUL') return;
    if (tx.amount !== topup.amount) {
      console.error(`[topup] amount mismatch for ${topup.id}: expected ${topup.amount}, got ${tx.amount}`);
      return;
    }
    const now = new Date().toISOString();
    const rider = await this.store.tx(async (repo) => {
      const fresh = await repo.getTopup(topup.id);
      if (!fresh || fresh.status !== 'PENDING') return undefined;
      const added = await repo.addJournal({
        key: `topup:${topup.id}`,
        description: `Float top-up ${topup.amount} FCFA`,
        createdAt: now,
        lines: [
          { account: 'GATEWAY_CLEARING', refId: topup.riderId, amount: -topup.amount },
          { account: 'RIDER_FLOAT', refId: topup.riderId, amount: topup.amount }
        ]
      });
      if (!added) return undefined;
      const r = await repo.getRider(topup.riderId);
      if (!r) throw notFound('Rider');
      r.floatBalance += topup.amount;
      r.updatedAt = now;
      await repo.updateTopup({ ...fresh, status: 'CONFIRMED', updatedAt: now });
      return repo.updateRider(r);
    });
    if (rider) this.events.emit({ type: 'topup.confirmed', rider, topup: { ...topup, status: 'CONFIRMED' } });
  }

  async leaderboard(limit = 5): Promise<Rider[]> {
    const riders = await this.store.listRiders({ status: 'APPROVED' });
    return riders.sort((a, b) => b.completedDeliveries - a.completedDeliveries).slice(0, limit);
  }

  pendingApplications() {
    return this.store.listRiders({ status: 'PENDING' });
  }
}
