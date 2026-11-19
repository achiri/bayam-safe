import crypto from 'node:crypto';

/**
 * Crypto helpers bound to the app secret.
 * - Access tokens (buyer links, buyer sessions) are random and stored only as HMAC hashes.
 * - Release codes are stored AES-256-GCM encrypted so the paying buyer can see them again,
 *   but a database leak alone does not reveal them.
 */
export class Secrets {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(appSecret: string) {
    this.encKey = crypto.createHash('sha256').update(`enc:${appSecret}`).digest();
    this.macKey = crypto.createHash('sha256').update(`mac:${appSecret}`).digest();
  }

  /** URL-safe random token (default 24 bytes = 192 bits). */
  static token(bytes = 24): string {
    return crypto.randomBytes(bytes).toString('base64url');
  }

  hashToken(token: string): string {
    return crypto.createHmac('sha256', this.macKey).update(token).digest('base64url');
  }

  /** Constant-time check of a presented token against a stored hash. */
  verifyToken(token: string | undefined, storedHash: string | undefined): boolean {
    if (!token || !storedHash) return false;
    return safeEqual(this.hashToken(token), storedHash);
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
  }

  decrypt(payload: string): string {
    const [iv, tag, ct] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export const newId = () => crypto.randomUUID();

/** 4-digit release code, uniformly random. */
export const newReleaseCode = () => crypto.randomInt(0, 10_000).toString().padStart(4, '0');

// Crockford-style alphabet without 0/O/1/I/L to avoid confusion when read aloud or typed.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function randomChars(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return s;
}

/** e.g. BS-7KQ4-M2XD (~40 bits). Public: lets anyone see coarse status only. */
export const newTrackingCode = () => `BS-${randomChars(4)}-${randomChars(4)}`;
