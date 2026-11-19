import { Operator } from './types.js';
import { invalid } from './errors.js';

/**
 * Normalises a Cameroon mobile number to E.164 (+2376XXXXXXXX).
 * Accepts "671234567", "6 71 23 45 67", "237671234567", "+237 671 234 567", "00237...".
 */
export function normalizeCameroonPhone(input: string): string {
  let digits = String(input ?? '').replace(/\D/g, '');
  if (digits.startsWith('00237')) digits = digits.slice(5);
  else if (digits.startsWith('237') && digits.length === 12) digits = digits.slice(3);
  if (!/^6\d{8}$/.test(digits)) {
    throw invalid('Numéro invalide : un numéro mobile camerounais a 9 chiffres et commence par 6 (ex: 671234567).');
  }
  return `+237${digits}`;
}

/**
 * A contact number (the buyer's WhatsApp/Telegram/calls), which may be foreign.
 * - 9 local digits starting with 6, or a +237 number → normalised as a Cameroon mobile.
 * - Anything else must be written internationally ("+33 6 12 34 56 78" or "0033…"),
 *   giving an E.164 number of 8 to 15 digits.
 * Mobile Money numbers (payers, sellers, riders) must still use normalizeCameroonPhone.
 */
export function normalizeContactPhone(input: string): string {
  const raw = String(input ?? '').trim();
  if (isValidCameroonPhone(raw)) return normalizeCameroonPhone(raw);
  const intl = raw.startsWith('+') || raw.replace(/[\s().-]/g, '').startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!intl || !/^[1-9]\d{7,14}$/.test(digits)) {
    throw invalid(
      'Numéro invalide. Numéro camerounais : 671234567. Numéro étranger : avec l’indicatif, ex : +33 6 12 34 56 78.'
    );
  }
  if (digits.startsWith('237')) return normalizeCameroonPhone(digits); // +237 numbers must be valid CM mobiles
  return `+${digits}`;
}

export function isValidContactPhone(input: string): boolean {
  try {
    normalizeContactPhone(input);
    return true;
  } catch {
    return false;
  }
}

export function isValidCameroonPhone(input: string): boolean {
  try {
    normalizeCameroonPhone(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort operator detection from the number prefix.
 * MTN: 67x, 650-654, 680-684. Orange: 69x, 655-659.
 * Returns undefined when unsure (number portability and new ranges exist),
 * in which case the buyer picks the operator and the gateway decides.
 */
export function detectOperator(phone: string): Operator | undefined {
  const n = normalizeCameroonPhone(phone).slice(4); // 9 national digits
  if (/^67/.test(n) || /^65[0-4]/.test(n) || /^68[0-4]/.test(n)) return 'MTN';
  if (/^69/.test(n) || /^65[5-9]/.test(n)) return 'ORANGE';
  return undefined;
}

/** "+237671234567" -> "237671234567" (format expected by Campay). */
export function toGatewayMsisdn(phone: string): string {
  return normalizeCameroonPhone(phone).slice(1);
}

/** Masks a phone for display to third parties: +237 6•• ••• 567 */
export function maskPhone(phone: string): string {
  const n = normalizeCameroonPhone(phone).slice(4);
  return `+237 ${n[0]}•• ••• ${n.slice(6)}`;
}
