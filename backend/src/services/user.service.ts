import { AppError, forbidden, invalid, notFound } from '../domain/errors.js';
import { assertGeoPoint } from '../domain/geo.js';
import { normalizeCameroonPhone } from '../domain/phone.js';
import { newId } from '../domain/secrets.js';
import { GeoPoint, Lang, OnboardingDraft, User } from '../domain/types.js';

export interface MerchantProfileInput {
  shopName?: string;
  city?: string;
  cniNumber?: string;
  selfieFileId?: string;
  cniFrontFileId?: string;
  cniBackFileId?: string;
  shopPhotoFileId?: string;
  shopLocation?: GeoPoint;
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

  async updateProfile(telegramId: number, patch: { shopName?: string; city?: string; lang?: Lang }): Promise<User> {
    const u = await this.require(telegramId);
    if (patch.shopName !== undefined) {
      const s = clean(patch.shopName, 60);
      if (s.length < 2) throw invalid('Shop name too short');
      u.shopName = s;
    }
    if (patch.city !== undefined) u.city = clean(patch.city, 40);
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
    u.updatedAt = new Date().toISOString();
    const saved = await this.store.updateUser(u);
    this.events.emit({ type: 'payout_phone.requested', user: saved });
    return saved;
  }

  async decidePayoutPhone(userId: string, approve: boolean): Promise<User> {
    const u = await this.store.getUser(userId);
    if (!u) throw notFound('User');
    if (!u.pendingPayoutPhone) throw invalid('Aucun changement de numéro en attente.');
    const pending = u.pendingPayoutPhone;
    if (approve) {
      u.payoutPhone = pending;
      const rider = await this.store.getRiderByTelegram(u.telegramId);
      if (rider) await this.store.updateRider({ ...rider, phone: pending, updatedAt: new Date().toISOString() });
    }
    u.pendingPayoutPhone = undefined;
    u.updatedAt = new Date().toISOString();
    const saved = await this.store.updateUser(u);
    this.events.emit({ type: 'payout_phone.decided', user: saved, approved: approve });
    return saved;
  }

  async listPendingPayoutPhones(): Promise<User[]> {
    const all = await this.store.listUsers(1000);
    return all.filter((u) => !!u.pendingPayoutPhone);
  }
}
