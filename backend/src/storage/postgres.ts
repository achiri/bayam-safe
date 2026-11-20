import pg from 'pg';
import { VersionConflictError } from '../domain/errors.js';
import { AuditEntry, FloatTopup, Journal, LedgerAccount, Media, Order, OrderStatus, Rider, RiderStatus, User } from '../domain/types.js';
import { SCHEMA_SQL } from './schema.js';
import { assertBalanced, OldestFirstCursor, OrderQuery, Repo, Store } from './store.js';

/** Minimal SQL client so both node-postgres and PGlite (used in tests) fit. */
export interface Sql {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface SqlDriver extends Sql {
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export function nodePostgresDriver(connectionString: string): SqlDriver {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // BIGINT -> number (all our amounts are far below 2^53)
  pg.types.setTypeParser(20, (v) => Number(v));
  return {
    query: (text, params) => pool.query(text, params as any[]) as any,
    exec: async (sql) => {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (t, p) => client.query(t, p as any[]) as any });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end()
  };
}

const json = (v: unknown) => JSON.stringify(v);

class PgRepo implements Repo {
  constructor(private readonly sql: Sql) {}

  private async one<T>(text: string, params: unknown[]): Promise<T | undefined> {
    const { rows } = await this.sql.query<{ data: T }>(text, params);
    return rows[0]?.data;
  }
  private async many<T>(text: string, params: unknown[]): Promise<T[]> {
    const { rows } = await this.sql.query<{ data: T }>(text, params);
    return rows.map((r) => r.data);
  }

  // ---- orders
  async insertOrder(o: Order) {
    await this.sql.query(
      `INSERT INTO orders (id, tracking_code, status, merchant_id, first_mile_rider_id, last_mile_rider_id,
         payment_reference, expires_at, has_open_payouts, version, data, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
      [o.id, o.trackingCode, o.status, o.merchantId, o.firstMileRiderId ?? null, o.lastMileRiderId ?? null,
        o.payment.reference ?? null, o.expiresAt ?? null, o.payouts.some((p) => p.status !== 'SENT'), o.version,
        json(o), o.createdAt, o.updatedAt]
    );
  }
  getOrder(id: string) {
    return this.one<Order>('SELECT data FROM orders WHERE id = $1', [id]);
  }
  getOrderByTracking(code: string) {
    return this.one<Order>('SELECT data FROM orders WHERE tracking_code = $1', [code]);
  }
  getOrderByPaymentRef(ref: string) {
    return this.one<Order>('SELECT data FROM orders WHERE payment_reference = $1', [ref]);
  }
  async updateOrder(o: Order) {
    const next = { ...o, version: o.version + 1 };
    const { rows } = await this.sql.query(
      `UPDATE orders SET status=$3, first_mile_rider_id=$4, last_mile_rider_id=$5, payment_reference=$6,
         expires_at=$7, has_open_payouts=$8, version=$9, data=$10::jsonb, updated_at=$11
       WHERE id=$1 AND version=$2 RETURNING id`,
      [o.id, o.version, o.status, o.firstMileRiderId ?? null, o.lastMileRiderId ?? null, o.payment.reference ?? null,
        o.expiresAt ?? null, o.payouts.some((p) => p.status !== 'SENT'), next.version, json(next), o.updatedAt]
    );
    if (!rows.length) throw new VersionConflictError('Order');
    return next;
  }
  listOrders(q: OrderQuery) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.merchantId) {
      params.push(q.merchantId);
      where.push(`merchant_id = $${params.length}`);
    }
    if (q.riderId) {
      params.push(q.riderId);
      where.push(`(first_mile_rider_id = $${params.length} OR last_mile_rider_id = $${params.length})`);
    }
    if (q.statuses?.length) {
      params.push(q.statuses);
      where.push(`status = ANY($${params.length}::text[])`);
    }
    params.push(Math.min(q.limit ?? 50, 500));
    return this.many<Order>(
      `SELECT data FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
  }
  listOrdersByStatusOldestFirst(statuses: OrderStatus[], limit: number, after?: OldestFirstCursor, opts: { withPaymentReference?: boolean } = {}) {
    const params: unknown[] = [statuses];
    const where = ['status = ANY($1::text[])'];
    if (opts.withPaymentReference) where.push('payment_reference IS NOT NULL');
    if (after) {
      params.push(after.updatedAt, after.id);
      where.push(`(updated_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
    }
    params.push(Math.min(limit, 1000));
    return this.many<Order>(
      `SELECT data FROM orders WHERE ${where.join(' AND ')} ORDER BY updated_at ASC, id ASC LIMIT $${params.length}`,
      params
    );
  }
  listPendingExpired(now: string) {
    return this.many<Order>(`SELECT data FROM orders WHERE status = 'PENDING_PAYMENT' AND expires_at <= $1`, [now]);
  }
  listOrdersWithPendingPayouts() {
    return this.many<Order>('SELECT data FROM orders WHERE has_open_payouts', []);
  }

  // ---- users
  async insertUser(u: User) {
    await this.sql.query(
      'INSERT INTO users (id, telegram_id, kyc_status, version, data, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [u.id, u.telegramId, u.kycStatus, u.version, json(u), u.createdAt]
    );
  }
  getUser(id: string) {
    return this.one<User>('SELECT data FROM users WHERE id = $1', [id]);
  }
  getUserByTelegram(telegramId: number) {
    return this.one<User>('SELECT data FROM users WHERE telegram_id = $1', [telegramId]);
  }
  async updateUser(u: User) {
    const next = { ...u, version: u.version + 1 };
    const { rows } = await this.sql.query(
      'UPDATE users SET kyc_status=$3, version=$4, data=$5::jsonb WHERE id=$1 AND version=$2 RETURNING id',
      [u.id, u.version, u.kycStatus, next.version, json(next)]
    );
    if (!rows.length) throw new VersionConflictError('User');
    return next;
  }
  listUsersByKyc(status: User['kycStatus']) {
    return this.many<User>('SELECT data FROM users WHERE kyc_status = $1 ORDER BY created_at', [status]);
  }
  listUsers(limit = 200) {
    return this.many<User>('SELECT data FROM users ORDER BY created_at DESC LIMIT $1', [Math.min(limit, 1000)]);
  }

  // ---- riders
  async insertRider(r: Rider) {
    await this.sql.query(
      `INSERT INTO riders (id, telegram_id, user_id, rider_code, status, on_duty, version, data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [r.id, r.telegramId, r.userId, r.riderCode, r.status, r.onDuty, r.version, json(r), r.createdAt]
    );
  }
  getRiderByCode(code: string) {
    return this.one<Rider>('SELECT data FROM riders WHERE rider_code = $1', [code]);
  }
  getRider(id: string) {
    return this.one<Rider>('SELECT data FROM riders WHERE id = $1', [id]);
  }
  getRiderByTelegram(telegramId: number) {
    return this.one<Rider>('SELECT data FROM riders WHERE telegram_id = $1', [telegramId]);
  }
  async updateRider(r: Rider) {
    const next = { ...r, version: r.version + 1 };
    const { rows } = await this.sql.query(
      'UPDATE riders SET status=$3, on_duty=$4, version=$5, data=$6::jsonb WHERE id=$1 AND version=$2 RETURNING id',
      [r.id, r.version, r.status, r.onDuty, next.version, json(next)]
    );
    if (!rows.length) throw new VersionConflictError('Rider');
    return next;
  }
  listRiders(f: { status?: RiderStatus; onDuty?: boolean }) {
    return this.many<Rider>(
      `SELECT data FROM riders WHERE ($1::text IS NULL OR status = $1) AND ($2::boolean IS NULL OR on_duty = $2)`,
      [f.status ?? null, f.onDuty ?? null]
    );
  }

  // ---- ledger
  async addJournal(j: Journal) {
    assertBalanced(j);
    const { rows } = await this.sql.query(
      'INSERT INTO journals (key, description, created_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING RETURNING key',
      [j.key, j.description, j.createdAt]
    );
    if (!rows.length) return false;
    for (const l of j.lines) {
      await this.sql.query('INSERT INTO ledger_lines (journal_key, account, ref_id, amount) VALUES ($1,$2,$3,$4)', [
        j.key, l.account, l.refId, l.amount
      ]);
    }
    return true;
  }
  async ledgerBalance(account: LedgerAccount, refId?: string) {
    const { rows } = await this.sql.query<{ s: string | number }>(
      'SELECT COALESCE(SUM(amount), 0)::bigint AS s FROM ledger_lines WHERE account = $1 AND ($2::text IS NULL OR ref_id = $2)',
      [account, refId ?? null]
    );
    return Number(rows[0].s);
  }
  async listJournals(refId: string) {
    const { rows } = await this.sql.query<{ key: string; description: string; created_at: Date | string; account: LedgerAccount; ref_id: string; amount: number }>(
      `SELECT j.key, j.description, j.created_at, l.account, l.ref_id, l.amount
       FROM journals j JOIN ledger_lines l ON l.journal_key = j.key
       WHERE j.key IN (SELECT journal_key FROM ledger_lines WHERE ref_id = $1)
       ORDER BY j.created_at, l.id`,
      [refId]
    );
    const map = new Map<string, Journal>();
    for (const r of rows) {
      const j = map.get(r.key) ?? { key: r.key, description: r.description, createdAt: new Date(r.created_at).toISOString(), lines: [] };
      j.lines.push({ account: r.account, refId: r.ref_id, amount: Number(r.amount) });
      map.set(r.key, j);
    }
    return [...map.values()];
  }

  async markEventProcessed(key: string) {
    const { rows } = await this.sql.query(
      'INSERT INTO processed_events (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key',
      [key]
    );
    return rows.length > 0;
  }

  // ---- float top-ups
  async insertTopup(t: FloatTopup) {
    await this.sql.query('INSERT INTO float_topups (id, rider_id, reference, status, data) VALUES ($1,$2,$3,$4,$5::jsonb)', [
      t.id, t.riderId, t.reference ?? null, t.status, json(t)
    ]);
  }
  getTopup(id: string) {
    return this.one<FloatTopup>('SELECT data FROM float_topups WHERE id = $1', [id]);
  }
  getTopupByRef(ref: string) {
    return this.one<FloatTopup>('SELECT data FROM float_topups WHERE reference = $1', [ref]);
  }
  async updateTopup(t: FloatTopup) {
    await this.sql.query('UPDATE float_topups SET reference=$2, status=$3, data=$4::jsonb WHERE id=$1', [
      t.id, t.reference ?? null, t.status, json(t)
    ]);
  }

  // ---- media
  async putMedia(m: Media) {
    await this.sql.query('INSERT INTO media (id, order_id, mime, data, created_at) VALUES ($1,$2,$3,$4,$5)', [
      m.id, m.orderId, m.mime, m.data, m.createdAt
    ]);
  }
  async getMedia(id: string) {
    const { rows } = await this.sql.query<{ id: string; order_id: string; mime: string; data: Uint8Array; created_at: Date | string }>(
      'SELECT id, order_id, mime, data, created_at FROM media WHERE id = $1',
      [id]
    );
    const r = rows[0];
    return r && { id: r.id, orderId: r.order_id, mime: r.mime, data: Buffer.from(r.data), createdAt: new Date(r.created_at).toISOString() };
  }

  async deleteMedia(id: string) {
    await this.sql.query('DELETE FROM media WHERE id = $1', [id]);
  }

  async countBuyerRefusals(phone: string, sinceIso: string) {
    const { rows } = await this.sql.query<{ n: string | number }>(
      `SELECT COUNT(*)::int AS n FROM orders WHERE data->>'buyerPhone' = $1 AND data ? 'buyerRefusalAt' AND data->>'buyerRefusalAt' >= $2`,
      [phone, sinceIso]
    );
    return Number(rows[0].n);
  }

  async addAudit(e: AuditEntry) {
    await this.sql.query('INSERT INTO admin_audit (id, at, data) VALUES ($1,$2,$3::jsonb)', [e.id, e.at, json(e)]);
  }
  listAudit(limit = 200) {
    return this.many<AuditEntry>('SELECT data FROM admin_audit ORDER BY at DESC LIMIT $1', [Math.min(limit, 1000)]);
  }

  async getBotSession(key: string) {
    const { rows } = await this.sql.query<{ data: unknown }>('SELECT data FROM bot_sessions WHERE key = $1', [key]);
    return rows[0]?.data;
  }
  async setBotSession(key: string, value: unknown) {
    await this.sql.query(
      `INSERT INTO bot_sessions (key, data, updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [key, json(value)]
    );
  }
  async deleteBotSession(key: string) {
    await this.sql.query('DELETE FROM bot_sessions WHERE key = $1', [key]);
  }
  async purgeBotSessions(olderThanIso: string) {
    const { rows } = await this.sql.query('DELETE FROM bot_sessions WHERE updated_at < $1 RETURNING key', [olderThanIso]);
    return rows.length;
  }
}

export class PostgresStore extends PgRepo implements Store {
  readonly kind = 'postgres' as const;
  constructor(private readonly driver: SqlDriver) {
    super(driver);
  }
  tx<T>(fn: (repo: Repo) => Promise<T>): Promise<T> {
    return this.driver.transaction((tx) => fn(new PgRepo(tx)));
  }
  migrate() {
    return this.driver.exec(SCHEMA_SQL);
  }
  close() {
    return this.driver.end();
  }
}
