import { PGlite } from '@electric-sql/pglite';
import { PostgresStore, SqlDriver } from '../src/storage/postgres.js';
import { orderFlowSuite } from './order-flows.js';

/** Real Postgres (compiled to WASM) so the SQL in PostgresStore is exercised without a server. */
function pgliteDriver(db: PGlite): SqlDriver {
  return {
    query: (text, params) => db.query(text, params as any[]) as any,
    exec: async (sql) => {
      await db.exec(sql);
    },
    transaction: (fn) => db.transaction((tx) => fn({ query: (t, p) => tx.query(t, p as any[]) as any })),
    end: () => db.close()
  };
}

orderFlowSuite('postgres store (PGlite)', async () => {
  const store = new PostgresStore(pgliteDriver(new PGlite()));
  await store.migrate();
  await store.migrate(); // migrations must be idempotent
  return store;
});
