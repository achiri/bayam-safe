import { AppError, forbidden, invalid, notFound } from '../domain/errors.js';
import { normalizeCameroonPhone } from '../domain/phone.js';
import { newId } from '../domain/secrets.js';
import { Lang, User } from '../domain/types.js';
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

  /** Merchant submits ID for the verified badge. The badge is only granted after admin review. */
  async submitKyc(telegramId: number, cniNumber: string, cniPhotoFileId: string): Promise<User> {
    const u = await this.require(telegramId);
    const cni = cniNumber.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z0-9]{6,20}$/.test(cni)) throw invalid('Invalid ID number');
    if (!cniPhotoFileId) throw invalid('A photo of the ID card is required');
    if (u.kycStatus === 'VERIFIED') throw invalid('Already verified');
    Object.assign(u, { cniNumber: cni, cniPhotoFileId, kycStatus: 'PENDING', updatedAt: new Date().toISOString() });
    const saved = await this.store.updateUser(u);
    this.events.emit({ type: 'kyc.submitted', user: saved });
    return saved;
  }

  async decideKyc(userId: string, approve: boolean): Promise<User> {
    const u = await this.store.getUser(userId);
    if (!u) throw notFound('User');
    if (u.kycStatus !== 'PENDING') throw invalid(`KYC is ${u.kycStatus}, not PENDING`);
    u.kycStatus = approve ? 'VERIFIED' : 'REJECTED';
    u.updatedAt = new Date().toISOString();
    const saved = await this.store.updateUser(u);
    this.events.emit({ type: 'kyc.decided', user: saved });
    return saved;
  }

  pendingKyc() {
    return this.store.listUsersByKyc('PENDING');
  }
}
