import 'dotenv/config';
import { PostgresStore, nodePostgresDriver } from '../storage/postgres.js';

/** Applies the (idempotent) schema to DATABASE_URL. The server also does this on start. */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const store = new PostgresStore(nodePostgresDriver(url));
  await store.migrate();
  await store.close();
  console.log('Schema is up to date.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
