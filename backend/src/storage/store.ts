import { FloatTopup, Journal, LedgerAccount, Media, Order, OrderStatus, Rider, RiderStatus, User } from '../domain/types.js';

export interface OrderQuery {
  merchantId?: string;
  riderId?: string; // first- or last-mile
  statuses?: OrderStatus[];
  limit?: number;
}

/**
 * Persistence operations. Updates of versioned entities (orders, riders, users) are
 * optimistic: they succeed only if `entity.version` still matches the stored version,
 * then increment it. A mismatch throws VersionConflictError.
 */
export interface Repo {
  insertOrder(o: Order): Promise<void>;
  getOrder(id: string): Promise<Order | undefined>;
  getOrderByTracking(code: string): Promise<Order | undefined>;
  getOrderByPaymentRef(ref: string): Promise<Order | undefined>;
  updateOrder(o: Order): Promise<Order>;
  listOrders(q: OrderQuery): Promise<Order[]>;
  listPendingExpired(now: string): Promise<Order[]>;
  listOrdersWithPendingPayouts(): Promise<Order[]>;

  insertUser(u: User): Promise<void>;
  getUser(id: string): Promise<User | undefined>;
  getUserByTelegram(telegramId: number): Promise<User | undefined>;
  updateUser(u: User): Promise<User>;
  listUsersByKyc(status: User['kycStatus']): Promise<User[]>;
  listUsers(limit?: number): Promise<User[]>;

  insertRider(r: Rider): Promise<void>;
  getRider(id: string): Promise<Rider | undefined>;
  getRiderByTelegram(telegramId: number): Promise<Rider | undefined>;
  getRiderByCode(code: string): Promise<Rider | undefined>;
  updateRider(r: Rider): Promise<Rider>;
  listRiders(filter: { status?: RiderStatus; onDuty?: boolean }): Promise<Rider[]>;

  /** Appends a balanced journal. Returns false (and writes nothing) if the key already exists. */
  addJournal(j: Journal): Promise<boolean>;
  ledgerBalance(account: LedgerAccount, refId?: string): Promise<number>;
  listJournals(refId: string): Promise<Journal[]>;

  /** Records a processed external event; returns false if it was already processed. */
  markEventProcessed(key: string): Promise<boolean>;

  insertTopup(t: FloatTopup): Promise<void>;
  getTopup(id: string): Promise<FloatTopup | undefined>;
  getTopupByRef(ref: string): Promise<FloatTopup | undefined>;
  updateTopup(t: FloatTopup): Promise<void>;

  putMedia(m: Media): Promise<void>;
  getMedia(id: string): Promise<Media | undefined>;
}

export interface Store extends Repo {
  /** Runs fn atomically: all writes commit together or none do. */
  tx<T>(fn: (repo: Repo) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  close(): Promise<void>;
  readonly kind: 'memory' | 'postgres';
}

export function assertBalanced(j: Journal): void {
  const sum = j.lines.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0 || j.lines.some((l) => !Number.isSafeInteger(l.amount))) {
    throw new Error(`Unbalanced journal ${j.key}: sum=${sum}`);
  }
}
