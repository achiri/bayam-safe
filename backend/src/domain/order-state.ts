import { conflict } from './errors.js';
import { Order, OrderStatus } from './types.js';

/** Every legal status change. Anything not listed here is rejected. */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ['AWAITING_RIDER', 'CANCELLED', 'EXPIRED'],
  AWAITING_RIDER: ['RIDER_ASSIGNED', 'CANCELLED', 'REFUNDED'],
  RIDER_ASSIGNED: ['IN_TRANSIT', 'AWAITING_RIDER', 'CANCELLED', 'REFUNDED'],
  IN_TRANSIT: ['AT_AGENCY', 'DELIVERED', 'DISPUTED'],
  AT_AGENCY: ['AT_DESTINATION_HUB', 'LAST_MILE_ASSIGNED', 'DISPUTED'],
  AT_DESTINATION_HUB: ['LAST_MILE_ASSIGNED', 'DISPUTED'],
  LAST_MILE_ASSIGNED: ['OUT_FOR_DELIVERY', 'AT_DESTINATION_HUB', 'DISPUTED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'DISPUTED'],
  DELIVERED: ['SETTLED'],
  // An admin can also resume a frozen order where it stopped (e.g. a code typo lock-out).
  DISPUTED: ['REFUNDED', 'DELIVERED', 'IN_TRANSIT', 'AT_AGENCY', 'AT_DESTINATION_HUB', 'LAST_MILE_ASSIGNED', 'OUT_FOR_DELIVERY'],
  SETTLED: [],
  REFUNDED: [],
  CANCELLED: [],
  EXPIRED: []
};

export const TERMINAL_STATUSES: OrderStatus[] = ['SETTLED', 'REFUNDED', 'CANCELLED', 'EXPIRED'];

/** States in which a buyer or rider may report a problem with the parcel. */
export const DISPUTABLE_STATUSES: OrderStatus[] = [
  'IN_TRANSIT',
  'AT_AGENCY',
  'AT_DESTINATION_HUB',
  'LAST_MILE_ASSIGNED',
  'OUT_FOR_DELIVERY'
];

/** States in which the rider holding the parcel can ask the buyer for the release code. */
export function deliverableStatus(o: Pick<Order, 'type'>): OrderStatus {
  return o.type === 'INTER_CITY' ? 'OUT_FOR_DELIVERY' : 'IN_TRANSIT';
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Moves the order to a new status (mutates), recording history. Throws on illegal moves. */
export function transition(order: Order, to: OrderStatus, note?: string, now = new Date()): Order {
  if (!canTransition(order.status, to)) {
    throw conflict(`Cannot move order ${order.trackingCode} from ${order.status} to ${to}`);
  }
  const at = now.toISOString();
  order.status = to;
  order.updatedAt = at;
  order.history.push(note ? { status: to, at, note } : { status: to, at });
  return order;
}

export function isPaidStatus(s: OrderStatus): boolean {
  return !['PENDING_PAYMENT', 'CANCELLED', 'EXPIRED'].includes(s);
}
