import { FloatTopup, Order, Payout, Rider, User } from '../domain/types.js';

export interface RiderOffer {
  rider: Rider;
  distanceKm?: number;
}

/** Things that happened, for notifications (Telegram today, SMS/WhatsApp later). */
export type DomainEvent =
  | { type: 'order.created'; order: Order }
  | { type: 'order.paid'; order: Order }
  | { type: 'order.offer'; order: Order; leg: 'FIRST' | 'LAST'; offers: RiderOffer[] }
  | { type: 'order.no_riders'; order: Order; leg: 'FIRST' | 'LAST' }
  | { type: 'order.status'; order: Order }
  | { type: 'order.rider_near'; order: Order; rider: Rider; distanceKm: number }
  | { type: 'order.buyer_linked'; order: Order }
  | { type: 'order.disputed'; order: Order }
  | { type: 'order.payment_mismatch'; order: Order; paidAmount: number }
  | { type: 'payout.attention'; order: Order; payout: Payout }
  | { type: 'kyc.submitted'; user: User }
  | { type: 'kyc.decided'; user: User }
  | { type: 'rider.applied'; rider: Rider }
  | { type: 'rider.decided'; rider: Rider }
  | { type: 'topup.confirmed'; rider: Rider; topup: FloatTopup };

type Handler = (e: DomainEvent) => void | Promise<void>;

export class EventBus {
  private handlers: Handler[] = [];
  readonly history: DomainEvent[] = []; // last events, handy for tests and debugging

  on(h: Handler) {
    this.handlers.push(h);
  }

  emit(e: DomainEvent) {
    this.history.push(e);
    if (this.history.length > 200) this.history.shift();
    for (const h of this.handlers) {
      Promise.resolve()
        .then(() => h(e))
        .catch((err) => console.error(`[events] handler failed for ${e.type}:`, err));
    }
  }
}
