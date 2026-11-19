import { invalid } from './errors.js';
import { Order, PayoutKind } from './types.js';

export const MAX_ORDER_TOTAL = 2_000_000; // FCFA, sane cap for an MVP; mobile money wallets cap lower anyway
export const MIN_ITEM_PRICE = 100;

export function assertAmount(name: string, value: number, { min = 0, max = MAX_ORDER_TOTAL } = {}): number {
  if (!Number.isSafeInteger(value)) throw invalid(`${name} must be a whole number of FCFA`);
  if (value < min || value > max) throw invalid(`${name} must be between ${min} and ${max} FCFA`);
  return value;
}

export interface Pricing {
  itemPrice: number;
  deliveryFee: number;
  agencyFee: number;
  commission: number;
  total: number;
}

/** The merchant pays the commission out of the item price; the buyer pays item + delivery + agency fee. */
export function computePricing(itemPrice: number, deliveryFee: number, agencyFee: number, commissionPct: number): Pricing {
  assertAmount('itemPrice', itemPrice, { min: MIN_ITEM_PRICE });
  assertAmount('deliveryFee', deliveryFee, { max: 100_000 });
  assertAmount('agencyFee', agencyFee, { max: 100_000 });
  const total = itemPrice + deliveryFee + agencyFee;
  assertAmount('total', total, { min: MIN_ITEM_PRICE });
  const commission = Math.round((itemPrice * commissionPct) / 100);
  return { itemPrice, deliveryFee, agencyFee, commission, total };
}

export interface PayoutPlanLine {
  kind: PayoutKind;
  amount: number;
}

/**
 * How an escrow order's money is split once the buyer confirms delivery.
 * Inter-city: delivery fee split 50/50 between first- and last-mile riders;
 * the first-mile rider is reimbursed the agency fee they paid at the counter.
 */
export function settlementPlan(o: Pick<Order, 'type' | 'itemPrice' | 'commission' | 'deliveryFee' | 'agencyFee'>): PayoutPlanLine[] {
  const lines: PayoutPlanLine[] = [{ kind: 'MERCHANT', amount: o.itemPrice - o.commission }];
  if (o.type === 'INTER_CITY') {
    const first = Math.floor(o.deliveryFee / 2);
    lines.push({ kind: 'FIRST_MILE_RIDER', amount: first + o.agencyFee });
    lines.push({ kind: 'LAST_MILE_RIDER', amount: o.deliveryFee - first });
  } else {
    lines.push({ kind: 'FIRST_MILE_RIDER', amount: o.deliveryFee });
  }
  return lines.filter((l) => l.amount > 0);
}

/**
 * Refund split after a dispute is resolved for the buyer.
 * Riders keep the delivery fee only for legs they actually ran; the agency fee is
 * kept only if the parcel was really handed to the agency.
 */
export function refundPlan(
  o: Pick<Order, 'type' | 'total' | 'deliveryFee' | 'agencyFee'>,
  progress: { pickedUp: boolean; reachedAgency: boolean; lastMileRan: boolean }
): PayoutPlanLine[] {
  const lines: PayoutPlanLine[] = [];
  let riderFirst = 0;
  let riderLast = 0;
  if (o.type === 'INTER_CITY') {
    const half = Math.floor(o.deliveryFee / 2);
    if (progress.pickedUp) riderFirst += half;
    if (progress.reachedAgency) riderFirst += o.agencyFee;
    if (progress.lastMileRan) riderLast += o.deliveryFee - half;
  } else if (progress.pickedUp) {
    riderFirst = o.deliveryFee;
  }
  const buyer = o.total - riderFirst - riderLast;
  if (buyer > 0) lines.push({ kind: 'BUYER_REFUND', amount: buyer });
  if (riderFirst > 0) lines.push({ kind: 'FIRST_MILE_RIDER', amount: riderFirst });
  if (riderLast > 0) lines.push({ kind: 'LAST_MILE_RIDER', amount: riderLast });
  return lines;
}

export const formatFcfa = (n: number, lang: 'fr' | 'en' = 'fr') =>
  `${n.toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-US')} FCFA`;
