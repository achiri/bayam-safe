import crypto from 'node:crypto';
import { safeEqual } from '../domain/secrets.js';

/**
 * Verifies an HS256 JWT and returns its payload, or null if the signature, algorithm or
 * expiry is invalid. Small on purpose: we only need HS256 for Campay webhook signatures.
 */
export function verifyHs256(token: string, key: string, nowSec = Math.floor(Date.now() / 1000)): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') return null;
    const expected = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
    if (!safeEqual(expected, s)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number' && payload.exp < nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Test helper: signs an HS256 JWT. */
export function signHs256(payload: Record<string, unknown>, key: string): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
