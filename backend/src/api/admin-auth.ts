import crypto from 'node:crypto';
import { safeEqual } from '../domain/secrets.js';

/**
 * Admin password login.
 * - The password is never stored: only an scrypt hash (ADMIN_PASSWORD_HASH), made with
 *   `npm run admin:password`.
 * - A successful login returns a signed, expiring session token (no server-side state), sent
 *   as `Authorization: Bearer <token>` like the API key.
 */

const N = 16384;
const KEYLEN = 32;

export function hashPassword(password: string, salt = crypto.randomBytes(16)): string {
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, KEYLEN, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [scheme, n, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = crypto.scryptSync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, { N: Number(n), r: 8, p: 1 });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Generates a readable but strong password: 4 groups of 5 characters, about 100 bits. */
export function generatePassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groups = Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(''));
  return groups.join('-');
}

const SESSION_PREFIX = 'adm1';

export function createAdminSession(appSecret: string, username: string, ttlMs = 12 * 3600_000, now = Date.now()) {
  const expiresAt = now + ttlMs;
  const body = `${SESSION_PREFIX}.${Buffer.from(username).toString('base64url')}.${expiresAt}.${crypto.randomBytes(9).toString('base64url')}`;
  const sig = crypto.createHmac('sha256', `admin-session:${appSecret}`).update(body).digest('base64url');
  return { token: `${body}.${sig}`, expiresAt: new Date(expiresAt).toISOString() };
}

export function verifyAdminSession(appSecret: string, token: string, now = Date.now()): { username: string } | null {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== SESSION_PREFIX) return null;
  const body = parts.slice(0, 4).join('.');
  const sig = crypto.createHmac('sha256', `admin-session:${appSecret}`).update(body).digest('base64url');
  if (!safeEqual(sig, parts[4])) return null;
  if (!(Number(parts[2]) > now)) return null;
  return { username: Buffer.from(parts[1], 'base64url').toString('utf8') };
}
