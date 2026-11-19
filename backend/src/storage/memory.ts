import { VersionConflictError } from '../domain/errors.js';
import { FloatTopup, Journal, LedgerAccount, Media, Order, Rider, RiderStatus, User } from '../domain/types.js';
import { assertBalanced, OrderQuery, Repo, Store } from './store.js';

const clone = <T>(v: T): T => structuredClone(v);

interface State {
  orders: Map<string, Order>;
  users: Map<string, User>;
  riders: Map<string, Rider>;
  journals: Map<string, Journal>;
  events: Set<string>;
  topups: Map<string, FloatTopup>;
}

const emptyState = (): State => ({
  orders: new Map(),
  users: new Map(),
  riders: new Map(),
  journals: new Map(),
  events: new Set(),
  topups: new Map()
});

function cloneState(s: State): State {
  return {
    orders: new Map([...s.orders].map(([k, v]) => [k, clone(v)])),
    users: new Map([...s.users].map(([k, v]) => [k, clone(v)])),
    riders: new Map([...s.riders].map(([k, v]) => [k, clone(v)])),
    journals: new Map(s.journals),
    events: new Set(s.events),
    topups: new Map([...s.topups].map(([k, v]) => [k, clone(v)]))
  };
}

const byNewest = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt);

/** Unlocked operations on a state object. */
class MemoryRepo implements Repo {
  constructor(
    public state: State,
    private readonly media: Map<string, Media>
  ) {}

  private bump<T extends { version: number }>(map: Map<string, T>, id: string, next: T, entity: string): T {
    const cur = map.get(id);
    if (!cur) throw new VersionConflictError(entity);
    if (cur.version !== next.version) throw new VersionConflictError(entity);
    const saved = clone({ ...next, version: next.version + 1 });
    map.set(id, saved);
    return clone(saved);
  }

  async insertOrder(o: Order) {
    if ([...this.state.orders.values()].some((x) => x.trackingCode === o.trackingCode)) throw new Error('duplicate tracking code');
    this.state.orders.set(o.id, clone(o));
  }
  async getOrder(id: string) {
    const o = this.state.orders.get(id);
    return o && clone(o);
  }
  async getOrderByTracking(code: string) {
    const o = [...this.state.orders.values()].find((x) => x.trackingCode === code);
    return o && clone(o);
  }
  async getOrderByPaymentRef(ref: string) {
    const o = [...this.state.orders.values()].find((x) => x.payment.reference === ref);
    return o && clone(o);
  }
  async updateOrder(o: Order) {
    return this.bump(this.state.orders, o.id, o, 'Order');
  }
  async listOrders(q: OrderQuery) {
    return [...this.state.orders.values()]
      .filter((o) => !q.merchantId || o.merchantId === q.merchantId)
      .filter((o) => !q.riderId || o.firstMileRiderId === q.riderId || o.lastMileRiderId === q.riderId)
      .filter((o) => !q.statuses || q.statuses.includes(o.status))
      .sort(byNewest)
      .slice(0, q.limit ?? 50)
      .map(clone);
  }
  async listPendingExpired(now: string) {
    return [...this.state.orders.values()]
      .filter((o) => o.status === 'PENDING_PAYMENT' && o.expiresAt && o.expiresAt <= now)
      .map(clone);
  }
  async listOrdersWithPendingPayouts() {
    return [...this.state.orders.values()].filter((o) => o.payouts.some((p) => p.status !== 'SENT')).map(clone);
  }

  async insertUser(u: User) {
    if (await this.getUserByTelegram(u.telegramId)) throw new Error('duplicate telegram user');
    this.state.users.set(u.id, clone(u));
  }
  async getUser(id: string) {
    const u = this.state.users.get(id);
    return u && clone(u);
  }
  async getUserByTelegram(telegramId: number) {
    const u = [...this.state.users.values()].find((x) => x.telegramId === telegramId);
    return u && clone(u);
  }
  async updateUser(u: User) {
    return this.bump(this.state.users, u.id, u, 'User');
  }
  async listUsersByKyc(status: User['kycStatus']) {
    return [...this.state.users.values()].filter((u) => u.kycStatus === status).map(clone);
  }

  async insertRider(r: Rider) {
    if (await this.getRiderByTelegram(r.telegramId)) throw new Error('duplicate rider');
    this.state.riders.set(r.id, clone(r));
  }
  async getRider(id: string) {
    const r = this.state.riders.get(id);
    return r && clone(r);
  }
  async getRiderByTelegram(telegramId: number) {
    const r = [...this.state.riders.values()].find((x) => x.telegramId === telegramId);
    return r && clone(r);
  }
  async updateRider(r: Rider) {
    return this.bump(this.state.riders, r.id, r, 'Rider');
  }
  async listRiders(f: { status?: RiderStatus; onDuty?: boolean }) {
    return [...this.state.riders.values()]
      .filter((r) => !f.status || r.status === f.status)
      .filter((r) => f.onDuty === undefined || r.onDuty === f.onDuty)
      .map(clone);
  }

  async addJournal(j: Journal) {
    assertBalanced(j);
    if (this.state.journals.has(j.key)) return false;
    this.state.journals.set(j.key, clone(j));
    return true;
  }
  async ledgerBalance(account: LedgerAccount, refId?: string) {
    let sum = 0;
    for (const j of this.state.journals.values())
      for (const l of j.lines) if (l.account === account && (!refId || l.refId === refId)) sum += l.amount;
    return sum;
  }
  async listJournals(refId: string) {
    return [...this.state.journals.values()].filter((j) => j.lines.some((l) => l.refId === refId)).map(clone);
  }

  async markEventProcessed(key: string) {
    if (this.state.events.has(key)) return false;
    this.state.events.add(key);
    return true;
  }

  async insertTopup(t: FloatTopup) {
    this.state.topups.set(t.id, clone(t));
  }
  async getTopup(id: string) {
    const t = this.state.topups.get(id);
    return t && clone(t);
  }
  async getTopupByRef(ref: string) {
    const t = [...this.state.topups.values()].find((x) => x.reference === ref);
    return t && clone(t);
  }
  async updateTopup(t: FloatTopup) {
    this.state.topups.set(t.id, clone(t));
  }

  async putMedia(m: Media) {
    this.media.set(m.id, m);
  }
  async getMedia(id: string) {
    return this.media.get(id);
  }
}

/**
 * In-memory store for development and tests. Every write is serialised through a mutex and
 * transactions roll back on error, so it behaves like the Postgres store (minus durability).
 */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private state = emptyState();
  private readonly media = new Map<string, Media>();
  private queue: Promise<unknown> = Promise.resolve();

  private get repo() {
    return new MemoryRepo(this.state, this.media);
  }

  async tx<T>(fn: (repo: Repo) => Promise<T>): Promise<T> {
    const run = async () => {
      const working = cloneState(this.state);
      const result = await fn(new MemoryRepo(working, this.media));
      this.state = working; // commit
      return result;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async migrate() {}
  async close() {}

  // Reads go straight to committed state; writes go through tx for serialisation.
  getOrder = (id: string) => this.repo.getOrder(id);
  getOrderByTracking = (c: string) => this.repo.getOrderByTracking(c);
  getOrderByPaymentRef = (r: string) => this.repo.getOrderByPaymentRef(r);
  listOrders = (q: OrderQuery) => this.repo.listOrders(q);
  listPendingExpired = (now: string) => this.repo.listPendingExpired(now);
  listOrdersWithPendingPayouts = () => this.repo.listOrdersWithPendingPayouts();
  getUser = (id: string) => this.repo.getUser(id);
  getUserByTelegram = (t: number) => this.repo.getUserByTelegram(t);
  listUsersByKyc = (s: User['kycStatus']) => this.repo.listUsersByKyc(s);
  getRider = (id: string) => this.repo.getRider(id);
  getRiderByTelegram = (t: number) => this.repo.getRiderByTelegram(t);
  listRiders = (f: { status?: RiderStatus; onDuty?: boolean }) => this.repo.listRiders(f);
  ledgerBalance = (a: LedgerAccount, r?: string) => this.repo.ledgerBalance(a, r);
  listJournals = (r: string) => this.repo.listJournals(r);
  getTopup = (id: string) => this.repo.getTopup(id);
  getTopupByRef = (r: string) => this.repo.getTopupByRef(r);
  getMedia = (id: string) => this.repo.getMedia(id);

  insertOrder = (o: Order) => this.tx((r) => r.insertOrder(o));
  updateOrder = (o: Order) => this.tx((r) => r.updateOrder(o));
  insertUser = (u: User) => this.tx((r) => r.insertUser(u));
  updateUser = (u: User) => this.tx((r) => r.updateUser(u));
  insertRider = (x: Rider) => this.tx((r) => r.insertRider(x));
  updateRider = (x: Rider) => this.tx((r) => r.updateRider(x));
  addJournal = (j: Journal) => this.tx((r) => r.addJournal(j));
  markEventProcessed = (k: string) => this.tx((r) => r.markEventProcessed(k));
  insertTopup = (t: FloatTopup) => this.tx((r) => r.insertTopup(t));
  updateTopup = (t: FloatTopup) => this.tx((r) => r.updateTopup(t));
  putMedia = (m: Media) => this.tx((r) => r.putMedia(m));
}
