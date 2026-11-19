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
