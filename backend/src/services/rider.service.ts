import { AppError, invalid, notFound } from '../domain/errors.js';
import { assertGeoPoint } from '../domain/geo.js';
import { assertAmount } from '../domain/money.js';
import { newId, newRiderCode } from '../domain/secrets.js';
import { FloatTopup, GeoPoint, Rider, TopupStatus, VehicleType } from '../domain/types.js';
import { PaymentGateway, Transaction } from '../payments/gateway.js';
import { Store } from '../storage/store.js';
import { EventBus } from './events.js';
import { PAYOUT_CHANGE_HOLD_MS, UserService, normalizeIdNumber } from './user.service.js';

export interface RiderApplication {
  legalName: string;
  cniNumber: string;
  selfieFileId: string;
  cniFrontFileId: string;
  cniBackFileId: string;
  vehicleType: VehicleType;
  plateNumber: string;
  vehiclePhotoFileId: string;
  city: string;
}

/** What anyone may learn about a rider from the number on their badge. */
export interface PublicRiderCard {
  riderCode: string;
  firstName: string;
  plateNumber: string;
  vehicleType: VehicleType;
  city?: string;
  verified: boolean;
  completedDeliveries: number;
  selfieFileId?: string;
}

/** A withdrawal still SENDING after this long was lost mid-call: an admin must check it. */
const WITHDRAWAL_STUCK_MS = 10 * 60_000;

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

  /**
   * Rider applies with legal name, selfie, both sides of the ID card, vehicle and plate photo.
   * An admin approves after comparing the selfie with the ID. A refused rider can resubmit.
   */
  async submitApplication(telegramId: number, app: RiderApplication): Promise<Rider> {
    const user = await this.users.require(telegramId);
    const existing = await this.store.getRiderByTelegram(telegramId);
    if (existing && existing.status !== 'REJECTED') throw invalid(`You already have a rider account (${existing.status}).`);
    const legalName = app.legalName.replace(/\s+/g, ' ').trim();
    if (legalName.length < 4 || legalName.length > 80 || !legalName.includes(' ')) throw invalid('Enter your first and last name as on your ID card');
    const cni = normalizeIdNumber(app.cniNumber);
    const plate = app.plateNumber.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z0-9-]{4,12}$/.test(plate)) throw invalid('Invalid plate number');
    if (!['MOTO', 'CAR', 'VAN'].includes(app.vehicleType)) throw invalid('Invalid vehicle type');
    for (const k of ['selfieFileId', 'cniFrontFileId', 'cniBackFileId', 'vehiclePhotoFileId'] as const) {
      if (!app[k]) throw invalid(`Missing ${k.replace('FileId', '')} photo`);
    }
    const now = new Date().toISOString();
    const fields = {
      fullName: legalName,
      phone: user.phone,
      cniNumber: cni,
      selfieFileId: app.selfieFileId,
      cniFrontFileId: app.cniFrontFileId,
      cniBackFileId: app.cniBackFileId,
      vehiclePhotoFileId: app.vehiclePhotoFileId,
      plateNumber: plate,
      vehicleType: app.vehicleType,
      city: app.city.slice(0, 40),
      status: 'PENDING' as const,
      reviewNote: undefined,
      updatedAt: now
    };
    let rider: Rider;
    if (existing) {
      rider = await this.store.updateRider({ ...existing, ...fields });
    } else {
      rider = {
        id: newId(), version: 1, userId: user.id, telegramId, riderCode: await this.uniqueCode(),
        onDuty: false, floatBalance: 0, floatReserved: 0, completedDeliveries: 0, createdAt: now, ...fields
      };
      await this.store.insertRider(rider);
    }
    if (user.draft?.kind === 'rider') await this.users.clearDraft(telegramId);
    this.events.emit({ type: 'rider.applied', rider });
    return rider;
  }

  private async uniqueCode(): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const code = newRiderCode();
      if (!(await this.store.getRiderByCode(code))) return code;
    }
    throw new Error('Could not allocate a rider code');
  }

  async decide(riderId: string, status: 'APPROVED' | 'REJECTED' | 'SUSPENDED', note?: string): Promise<Rider> {
    const r = await this.store.getRider(riderId);
    if (!r) throw notFound('Rider');
    if (status !== 'APPROVED' && !note?.trim()) throw invalid('Give the rider a reason');
    r.status = status;
    r.reviewNote = status === 'APPROVED' ? undefined : note!.trim().slice(0, 300);
    r.reviewedAt = new Date().toISOString();
    if (status !== 'APPROVED') r.onDuty = false;
    r.updatedAt = r.reviewedAt;
    const saved = await this.store.updateRider(r);
    this.events.emit({ type: 'rider.decided', rider: saved });
    return saved;
  }

  /** Public check of a rider badge number: at the door, a buyer can confirm who they are dealing with. */
  async verifyCode(code: string): Promise<PublicRiderCard | undefined> {
    const r = await this.store.getRiderByCode(code.trim().toUpperCase());
    if (!r) return undefined;
    return {
      riderCode: r.riderCode,
      firstName: r.fullName.split(' ')[0],
      plateNumber: r.plateNumber,
      vehicleType: r.vehicleType,
      city: r.city,
      verified: r.status === 'APPROVED',
      completedDeliveries: r.completedDeliveries,
      selfieFileId: r.status === 'APPROVED' ? r.selfieFileId : undefined
    };
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

  /** Applies a provider transaction to a pending top-up or withdrawal (idempotent). */
  async applyTopupTransaction(tx: Transaction): Promise<void> {
    const topup = await this.store.getTopupByRef(tx.reference);
    if (!topup) return;
    if (topup.kind === 'WITHDRAWAL') return this.applyWithdrawalTransaction(topup, tx);
    if (topup.status !== 'PENDING') return;
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
      if (!fresh || fresh.status !== 'PENDING' || fresh.kind === 'WITHDRAWAL') return undefined;
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

  /** A withdrawal the provider answered later (webhook / poll): paid out, or sent back to the float. */
  private async applyWithdrawalTransaction(topup: FloatTopup, tx: Transaction): Promise<void> {
    if (topup.status !== 'PENDING' && topup.status !== 'SENDING') return;
    if (tx.status === 'FAILED') {
      await this.reverseWithdrawal(topup.id);
      return;
    }
    if (tx.status !== 'SUCCESSFUL') return;
    if (tx.amount !== topup.amount) {
      console.error(`[withdraw] amount mismatch for ${topup.id}: expected ${topup.amount}, got ${tx.amount}`);
      return;
    }
    await this.store.tx(async (repo) => {
      const fresh = await repo.getTopup(topup.id);
      if (!fresh || (fresh.status !== 'PENDING' && fresh.status !== 'SENDING')) return;
      await repo.updateTopup({ ...fresh, status: 'CONFIRMED', updatedAt: new Date().toISOString() });
    });
  }

  /** Gives a failed withdrawal's amount back to the float, once (journal key + status guard). */
  private async reverseWithdrawal(topupId: string): Promise<void> {
    const later = new Date().toISOString();
    await this.store.tx(async (repo) => {
      const t = await repo.getTopup(topupId);
      if (!t || t.kind !== 'WITHDRAWAL' || (t.status !== 'PENDING' && t.status !== 'SENDING')) return;
      const r = await repo.getRider(t.riderId);
      if (!r) throw notFound('Rider');
      const added = await repo.addJournal({
        key: `float-withdraw-reversal:${topupId}`,
        description: `Float withdrawal reversed ${t.amount} FCFA`,
        createdAt: later,
        lines: [
          { account: 'GATEWAY_CLEARING', refId: r.id, amount: -t.amount },
          { account: 'RIDER_FLOAT', refId: r.id, amount: t.amount }
        ]
      });
      if (added) {
        r.floatBalance += t.amount;
        r.updatedAt = later;
        await repo.updateRider(r);
      }
      await repo.updateTopup({ ...t, status: 'FAILED', updatedAt: later });
    });
  }

  /**
   * Sends the rider's unlocked float (not reserved against COD parcels) back to their mobile money.
   * The float is debited and the withdrawal saved as SENDING before the provider is called. Only an
   * explicit provider FAILED gives the money back; a thrown error (timeout, network) leaves it debited
   * and flags the withdrawal for an admin, because the provider may well have paid.
   */
  async withdrawFloat(telegramId: number, amount: number): Promise<{ rider: Rider; topup: FloatTopup; message?: string }> {
    const r0 = await this.requireApproved(telegramId);
    assertAmount('amount', amount, { min: 500, max: 500_000 });
    // A payout-number change pauses withdrawals until 24 h after it became active (policy 8).
    const activated = await this.users.activatePayoutPhoneIfDue(r0.userId);
    const owner = activated ?? (await this.store.getUser(r0.userId));
    const changedAt = owner?.payoutPhoneChangedAt ? Date.parse(owner.payoutPhoneChangedAt) : 0;
    if (owner?.pendingPayoutPhone || Date.now() - changedAt < PAYOUT_CHANGE_HOLD_MS) {
      throw new AppError('PAYOUT_CHANGE_HOLD', 'Les retraits sont suspendus pendant 24 h après un changement de numéro de paiement, par sécurité.', 409);
    }
    const now = new Date().toISOString();
    const topupId = newId();
    const topup: FloatTopup = { id: topupId, kind: 'WITHDRAWAL', riderId: r0.id, amount, phone: r0.phone, status: 'SENDING', createdAt: now, updatedAt: now };

    const rider = await this.store.tx(async (repo) => {
      const r = await repo.getRider(r0.id);
      if (!r) throw notFound('Rider');
      if (amount > r.floatBalance - r.floatReserved) throw invalid('Montant supérieur à votre solde disponible (hors colis en cours).');
      const added = await repo.addJournal({
        key: `float-withdraw:${topupId}`,
        description: `Float withdrawal ${amount} FCFA`,
        createdAt: now,
        lines: [
          { account: 'RIDER_FLOAT', refId: r.id, amount: -amount },
          { account: 'GATEWAY_CLEARING', refId: r.id, amount }
        ]
      });
      if (!added) throw invalid('Retrait déjà enregistré.');
      r.floatBalance -= amount;
      r.updatedAt = now;
      await repo.insertTopup(topup);
      return repo.updateRider(r);
    });

    let tx: Transaction;
    try {
      tx = await this.gateway.withdraw({
        amount,
        phone: r0.phone,
        description: 'BayamSafe float withdrawal',
        externalReference: `float-withdraw:${topupId}`
      });
    } catch (err) {
      // Ambiguous: the money may have left. Keep it debited, put it in front of an admin.
      console.error(`[float-withdraw] ${topupId} ambiguous provider error:`, err);
      topup.status = 'NEEDS_REVIEW';
      topup.updatedAt = new Date().toISOString();
      await this.store.updateTopup(topup);
      this.events.emit({ type: 'topup.attention', rider, topup: { ...topup } });
      return { rider, topup, message: 'Retrait en vérification : votre solde reste débité le temps que nous vérifiions avec l’opérateur. Ne refaites pas la demande.' };
    }

    if (tx.status === 'FAILED') {
      await this.reverseWithdrawal(topupId);
      throw new AppError('WITHDRAW_FAILED', 'Le retrait a échoué, votre solde n’a pas été débité. Réessayez plus tard.', 502);
    }
    topup.reference = tx.reference;
    topup.updatedAt = new Date().toISOString();
    if (tx.status === 'SUCCESSFUL') {
      topup.status = 'CONFIRMED';
    } else {
      topup.status = 'PENDING'; // the webhook / poll resolves it through applyTopupTransaction
    }
    await this.store.updateTopup(topup);
    return { rider, topup, message: topup.status === 'PENDING' ? 'Retrait en cours de traitement par l’opérateur.' : undefined };
  }

  /**
   * Withdrawals the provider never answered: PENDING ones are re-read from the provider and applied;
   * SENDING ones older than 10 min (we crashed or timed out mid-call) go to an admin as NEEDS_REVIEW.
   */
  async sweepWithdrawals(now = Date.now()): Promise<{ checked: number; flagged: number }> {
    let checked = 0;
    let flagged = 0;
    const pending = await this.store.listTopups({ statuses: ['PENDING'], kind: 'WITHDRAWAL', limit: 200 });
    for (const t of pending) {
      if (!t.reference) continue;
      checked++;
      try {
        await this.applyTopupTransaction(await this.gateway.getTransaction(t.reference));
      } catch (e) {
        console.warn(`[withdraw-sweep] ${t.id}:`, (e as Error).message);
      }
    }
    const sending = await this.store.listTopups({ statuses: ['SENDING'], kind: 'WITHDRAWAL', limit: 200 });
    for (const t of sending) {
      if (now - Date.parse(t.updatedAt) < WITHDRAWAL_STUCK_MS) continue;
      const later = new Date().toISOString();
      const fresh = await this.store.getTopup(t.id);
      if (!fresh || fresh.status !== 'SENDING') continue;
      const next: FloatTopup = { ...fresh, status: 'NEEDS_REVIEW', updatedAt: later };
      await this.store.updateTopup(next);
      const rider = await this.store.getRider(t.riderId);
      if (rider) this.events.emit({ type: 'topup.attention', rider, topup: next });
      flagged++;
    }
    return { checked, flagged };
  }

  /** Withdrawals an admin must look at, with the rider's identity. */
  async listWithdrawalsForReview(status: TopupStatus = 'NEEDS_REVIEW') {
    const list = await this.store.listTopups({ statuses: [status], kind: 'WITHDRAWAL', limit: 200 });
    const out = [];
    for (const t of list) {
      const r = await this.store.getRider(t.riderId);
      out.push({ ...t, rider: r && { id: r.id, name: r.fullName, code: r.riderCode, phone: r.phone } });
    }
    return out;
  }

  /**
   * Admin decision on a NEEDS_REVIEW withdrawal, after checking the provider dashboard.
   * MARK_SENT: the money did leave, the float stays debited (CONFIRMED). REVERSE: it did not, the float is credited back (FAILED).
   */
  async resolveWithdrawal(topupId: string, action: 'MARK_SENT' | 'REVERSE', note: string, reference?: string): Promise<FloatTopup> {
    const why = String(note ?? '').replace(/\s+/g, ' ').trim();
    if (why.length < 3) throw invalid('Une note est obligatoire.');
    if (action !== 'MARK_SENT' && action !== 'REVERSE') throw invalid('action must be MARK_SENT or REVERSE');
    const now = new Date().toISOString();
    return this.store.tx(async (repo) => {
      const t = await repo.getTopup(topupId);
      if (!t || t.kind !== 'WITHDRAWAL') throw notFound('Withdrawal');
      if (t.status !== 'NEEDS_REVIEW') throw new AppError('CONFLICT', `Ce retrait est ${t.status} : seuls les retraits à vérifier peuvent être traités.`, 409);
      if (action === 'MARK_SENT') {
        const next: FloatTopup = { ...t, status: 'CONFIRMED', reference: reference?.trim() ? reference.trim().slice(0, 100) : t.reference, updatedAt: now };
        await repo.updateTopup(next);
        return next;
      }
      const r = await repo.getRider(t.riderId);
      if (!r) throw notFound('Rider');
      const added = await repo.addJournal({
        key: `float-withdraw-reversal:${t.id}`,
        description: `Float withdrawal reversed by admin ${t.amount} FCFA`,
        createdAt: now,
        lines: [
          { account: 'GATEWAY_CLEARING', refId: r.id, amount: -t.amount },
          { account: 'RIDER_FLOAT', refId: r.id, amount: t.amount }
        ]
      });
      if (added) {
        r.floatBalance += t.amount;
        r.updatedAt = now;
        await repo.updateRider(r);
      }
      const next: FloatTopup = { ...t, status: 'FAILED', updatedAt: now };
      await repo.updateTopup(next);
      return next;
    });
  }

  async leaderboard(limit = 5): Promise<Rider[]> {
    const riders = await this.store.listRiders({ status: 'APPROVED' });
    return riders.sort((a, b) => b.completedDeliveries - a.completedDeliveries).slice(0, limit);
  }

  pendingApplications() {
    return this.store.listRiders({ status: 'PENDING' });
  }
}
