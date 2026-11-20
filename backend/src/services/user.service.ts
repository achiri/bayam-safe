import { AppError, forbidden, invalid, notFound } from '../domain/errors.js';
import { assertGeoPoint } from '../domain/geo.js';
import { normalizeCameroonPhone } from '../domain/phone.js';
import { newId } from '../domain/secrets.js';
import { conflict } from '../domain/errors.js';
import { GeoPoint, Lang, OnboardingDraft, User } from '../domain/types.js';

export interface MerchantProfileInput {
  shopName?: string;
  city?: string;
  shopAddress?: string;
  cniNumber?: string;
  selfieFileId?: string;
  cniFrontFileId?: string;
  cniBackFileId?: string;
  shopPhotoFileId?: string;
  shopLocation?: GeoPoint;
}

export interface UpdateProfilePatch {
  shopName?: string;
  city?: string;
  shopAddress?: string;
  shopLocation?: GeoPoint;
  shopPhotoFileId?: string;
  lang?: Lang;
}

/** Cameroon CNI numbers are digits; passports and receipts mix letters. Accept 6-20 alphanumerics. */
export function normalizeIdNumber(raw: string): string {
  const v = raw.replace(/[\s.-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(v)) throw invalid('Invalid ID number (6 to 20 letters or digits)');
  return v;
}
import { Store } from '../storage/store.js';
import { EventBus } from './events.js';

export interface TelegramContact {
  phone_number: string;
  first_name?: string;
  last_name?: string;
  user_id?: number;
}

const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/** An approved payout-number change only takes effect this long after approval (policy 8). */
export const PAYOUT_PHONE_DELAY_MS = 24 * 3600_000;
/** Withdrawals stay paused this long after the new number became active. */
export const PAYOUT_CHANGE_HOLD_MS = 24 * 3600_000;

export class UserService {
  constructor(
    private readonly store: Store,
    private readonly events: EventBus
  ) {}

  getByTelegram(telegramId: number) {
    return this.store.getUserByTelegram(telegramId);
  }

  async require(telegramId: number): Promise<User> {
    const u = await this.store.getUserByTelegram(telegramId);
    if (!u) throw new AppError('NOT_REGISTERED', 'Not registered: share your phone contact with the bot first (/start).', 403);
    return u;
  }

  /**
   * 1-tap sign-up from Telegram's "share contact" button. The contact must be the sender's
   * own (contact.user_id === sender id) so nobody can register with someone else's MoMo number.
   */
  async registerFromContact(telegramId: number, contact: TelegramContact, lang: Lang = 'fr'): Promise<User> {
    if (contact.user_id !== telegramId) throw forbidden('Please share your own contact using the button.');
    const phone = normalizeCameroonPhone(contact.phone_number);
    const fullName = clean(`${contact.first_name ?? ''} ${contact.last_name ?? ''}`, 80) || 'Vendeur';
    const now = new Date().toISOString();

    const existing = await this.store.getUserByTelegram(telegramId);
    if (existing) {
      return this.store.updateUser({ ...existing, phone, updatedAt: now });
    }
    const user: User = {
      id: newId(),
      version: 1,
      telegramId,
      phone,
      fullName,
      shopName: fullName,
      lang,
      kycStatus: 'NONE',
      createdAt: now,
      updatedAt: now
    };
    await this.store.insertUser(user);
    return user;
  }

  async updateProfile(telegramId: number, patch: UpdateProfilePatch): Promise<User> {
    const u = await this.require(telegramId);
    if (patch.shopName !== undefined) {
      const s = clean(patch.shopName, 60);
      if (s.length < 2) throw invalid('Shop name too short');
      u.shopName = s;
    }
    if (patch.city !== undefined) u.city = clean(patch.city, 40);
    if (patch.shopAddress !== undefined) u.shopAddress = clean(patch.shopAddress, 120);
    if (patch.shopLocation !== undefined) u.shopLocation = assertGeoPoint(patch.shopLocation);
    if (patch.shopPhotoFileId !== undefined) u.shopPhotoFileId = patch.shopPhotoFileId;
    if (patch.lang) u.lang = patch.lang;
    u.updatedAt = new Date().toISOString();
    return this.store.updateUser(u);
  }

  // ------------------------------------------------------------------ sign-up drafts

  /** Starts (or restarts) a sign-up and persists it, so a restart or a lost signal loses nothing. */
  async startDraft(telegramId: number, kind: OnboardingDraft['kind'], firstStep: string): Promise<User> {
    const u = await this.require(telegramId);
    u.draft = { kind, step: firstStep, data: {}, startedAt: new Date().toISOString() };
    u.updatedAt = new Date().toISOString();
    return this.store.updateUser(u);
  }

  /** Saves answers so far and moves the draft to its next step. */
  async saveDraft(telegramId: number, patch: OnboardingDraft['data'], nextStep: string): Promise<User> {
    const u = await this.require(telegramId);
    if (!u.draft) throw invalid('No sign-up in progress');
    u.draft = { ...u.draft, step: nextStep, data: { ...u.draft.data, ...patch } };
    u.updatedAt = new Date().toISOString();
    return this.store.updateUser(u);
  }

  async clearDraft(telegramId: number): Promise<User> {
    const u = await this.require(telegramId);
    u.draft = undefined;
    u.updatedAt = new Date().toISOString();
    return this.store.updateUser(u);
  }

  /**
   * Seller sign-up: shop, city, selfie, both sides of the ID card, ID number, shop photo and the
   * shop's exact GPS location. The seller can sell once submitted; the verified badge is only
   * shown after an admin has checked the documents.
   */
  async submitMerchantProfile(telegramId: number, p: MerchantProfileInput): Promise<User> {
    const u = await this.require(telegramId);
    if (u.kycStatus === 'VERIFIED') throw invalid('Your profile is already verified.');
    const shopName = clean(p.shopName ?? '', 60);
    if (shopName.length < 2) throw invalid('Shop name too short');
    const city = clean(p.city ?? '', 40);
    if (!city) throw invalid('City is required');
    const cni = normalizeIdNumber(p.cniNumber ?? '');
    for (const [key, label] of [['selfieFileId', 'selfie'], ['cniFrontFileId', 'ID card front'], ['cniBackFileId', 'ID card back'], ['shopPhotoFileId', 'shop photo']] as const) {
      if (!p[key]) throw invalid(`Missing ${label}`);
    }
    const now = new Date().toISOString();
    Object.assign(u, {
      shopName,
      city,
      cniNumber: cni,
      selfieFileId: p.selfieFileId,
      cniFrontFileId: p.cniFrontFileId,
      cniBackFileId: p.cniBackFileId,
      shopPhotoFileId: p.shopPhotoFileId,
      shopLocation: assertGeoPoint(p.shopLocation),
      kycStatus: 'PENDING',
      kycSubmittedAt: now,
      kycNote: undefined,
      draft: undefined,
      updatedAt: now
    } satisfies Partial<User>);
    const saved = await this.store.updateUser(u);
    this.events.emit({ type: 'kyc.submitted', user: saved });
    return saved;
  }

  async decideKyc(userId: string, approve: boolean, note?: string): Promise<User> {
    const u = await this.store.getUser(userId);
    if (!u) throw notFound('User');
    if (u.kycStatus !== 'PENDING') throw invalid(`KYC is ${u.kycStatus}, not PENDING`);
    if (!approve && !note?.trim()) throw invalid('Give the seller a reason so they can fix it');
    u.kycStatus = approve ? 'VERIFIED' : 'REJECTED';
    u.kycNote = approve ? undefined : clean(note!, 300);
    u.kycReviewedAt = new Date().toISOString();
    u.updatedAt = u.kycReviewedAt;
    const saved = await this.store.updateUser(u);
    this.events.emit({ type: 'kyc.decided', user: saved });
    return saved;
  }

  /** Sellers must have submitted their documents before they can create orders. */
  assertCanSell(u: User) {
    if (u.kycStatus === 'NONE') throw new AppError('PROFILE_INCOMPLETE', 'Complete your seller profile first (/start).', 403);
    if (u.kycStatus === 'REJECTED') throw new AppError('PROFILE_REJECTED', `Your seller profile was refused: ${u.kycNote ?? ''} Send /start to resubmit.`, 403);
  }

  pendingKyc() {
    return this.store.listUsersByKyc('PENDING');
  }

  async suspend(userId: string, note?: string): Promise<User> {
    const u = await this.store.getUser(userId);
    if (!u) throw notFound('User');
    const now = new Date().toISOString();
    u.suspendedAt = now;
    u.suspendNote = note?.trim() ? clean(note, 300) : undefined;
    u.updatedAt = now;
    return this.store.updateUser(u);
  }

  async unsuspend(userId: string): Promise<User> {
    const u = await this.store.getUser(userId);
    if (!u) throw notFound('User');
    u.suspendedAt = undefined;
    u.suspendNote = undefined;
    u.updatedAt = new Date().toISOString();
    return this.store.updateUser(u);
  }

  /** A seller or rider asks to be paid on another number; an admin approves it first. */
  async requestPayoutPhone(telegramId: number, phone: string): Promise<User> {
    const u = await this.require(telegramId);
    const normalized = normalizeCameroonPhone(phone);
    if (normalized === (u.payoutPhone ?? u.phone)) throw invalid('Ce numéro est déjà votre numéro de paiement.');
    u.pendingPayoutPhone = normalized;
    u.payoutPhoneEffectiveAt = undefined; // a new request must be approved again
    u.updatedAt = new Date().toISOString();
    const saved = await this.store.updateUser(u);
    this.events.emit({ type: 'payout_phone.requested', user: saved });
    return saved;
  }

  /**
   * Approving does not switch the number: it is scheduled for 24 h later, the user is told on Telegram,
   * and withdrawals pause meanwhile (see activatePayoutPhoneIfDue). Until then payouts use the old number.
   */
  async decidePayoutPhone(userId: string, approve: boolean, now = new Date(), expectedPhone?: string): Promise<User> {
    const u = await this.store.getUser(userId);
    if (!u) throw notFound('User');
    if (!u.pendingPayoutPhone) throw invalid('Aucun changement de numéro en attente.');
    // The admin must be deciding on the number they actually saw (the user may have re-requested meanwhile).
    if (expectedPhone !== undefined && expectedPhone !== u.pendingPayoutPhone) throw conflict('Le numéro demandé a changé entre-temps : rechargez la liste.');
    if (approve && u.payoutPhoneEffectiveAt) throw invalid('Ce changement est déjà approuvé : il sera actif à l’heure prévue.');
    if (approve) {
      u.payoutPhoneEffectiveAt = new Date(now.getTime() + PAYOUT_PHONE_DELAY_MS).toISOString();
    } else {
      u.pendingPayoutPhone = undefined;
      u.payoutPhoneEffectiveAt = undefined;
    }
    u.updatedAt = now.toISOString();
    const saved = await this.store.updateUser(u);
    this.events.emit({ type: 'payout_phone.decided', user: saved, approved: approve });
    return saved;
  }

  /** Applies an approved number change once its 24 h have passed. Returns the user if it was applied. */
  async activatePayoutPhoneIfDue(userId: string, now = new Date()): Promise<User | undefined> {
    const u0 = await this.store.getUser(userId);
    if (!u0?.pendingPayoutPhone || !u0.payoutPhoneEffectiveAt || Date.parse(u0.payoutPhoneEffectiveAt) > now.getTime()) return undefined;
    const at = now.toISOString();
    const saved = await this.store.tx(async (repo) => {
      const u = await repo.getUser(userId);
      if (!u?.pendingPayoutPhone || !u.payoutPhoneEffectiveAt || Date.parse(u.payoutPhoneEffectiveAt) > now.getTime()) return undefined;
      const rider = await repo.getRiderByTelegram(u.telegramId);
      if (rider) await repo.updateRider({ ...rider, phone: u.pendingPayoutPhone, updatedAt: at });
      u.payoutPhone = u.pendingPayoutPhone;
      u.pendingPayoutPhone = undefined;
      u.payoutPhoneEffectiveAt = undefined;
      u.payoutPhoneChangedAt = at;
      u.updatedAt = at;
      return repo.updateUser(u);
    });
    if (saved) this.events.emit({ type: 'payout_phone.activated', user: saved });
    return saved;
  }

  /** Background job: activates every approved change that is due. */
  async activateDuePayoutPhones(now = new Date()): Promise<number> {
    const due = (await this.listPendingPayoutPhones()).filter((u) => u.payoutPhoneEffectiveAt && Date.parse(u.payoutPhoneEffectiveAt) <= now.getTime());
    let n = 0;
    for (const u of due) {
      if (await this.activatePayoutPhoneIfDue(u.id, now).catch(() => undefined)) n++;
    }
    return n;
  }

  /**
   * Admin write-off of what a seller owes the platform (policy 11). Booked as a balanced journal
   * (receivable up, write-off expense) in the same transaction as the lower balance; the journal
   * key includes the user's version, so a replay of the same call cannot book it twice.
   */
  async writeOffDebt(userId: string, amountInput: number, noteInput: string): Promise<User> {
    const note = clean(String(noteInput ?? ''), 500);
    if (note.length < 3) throw invalid('Une note est obligatoire pour effacer une dette.');
    return this.store.tx(async (repo) => {
      const u = await repo.getUser(userId);
      if (!u) throw notFound('User');
      const owed = u.owedToPlatform ?? 0;
      if (!Number.isSafeInteger(amountInput) || amountInput < 1 || amountInput > owed) {
        throw invalid(`Le montant doit être un entier entre 1 et ${owed} FCFA (dette actuelle).`);
      }
      const now = new Date().toISOString();
      const added = await repo.addJournal({
        key: `debt-writeoff:${u.id}:v${u.version}`,
        description: `Debt write-off ${amountInput} FCFA for ${u.shopName}: ${note}`,
        createdAt: now,
        lines: [
          { account: 'MERCHANT_RECEIVABLE', refId: u.id, amount: amountInput },
          { account: 'PLATFORM_WRITE_OFF', refId: u.id, amount: -amountInput }
        ]
      });
      if (!added) throw conflict('Cette annulation de dette a déjà été enregistrée.');
      u.owedToPlatform = owed - amountInput;
      u.updatedAt = now;
      return repo.updateUser(u);
    });
  }

  async listPendingPayoutPhones(): Promise<User[]> {
    const all = await this.store.listUsers(1000);
    return all.filter((u) => !!u.pendingPayoutPhone);
  }
}
