# ADR 0002: Bot sessions in Postgres and an admin audit journal

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Delivery Lead, Software Architect
- **Relates to:** BS-107 (admin tools, audit journal), BS-108 (bot sessions survive restarts)

## Context

- **Bot sessions.** The Telegram bot (grammY) keeps each chat's wizard state (a half-finished sale,
  onboarding steps, the language) in `ctx.session`. This used to be grammY's default in-memory
  storage, so every Render restart or deploy wiped any conversation in progress. Sellers lost
  half-typed orders.
- **Admin accountability.** The sprint gives admins powerful tools: resume a frozen order,
  reassign a rider, resend the release code, split a dispute, suspend sellers, approve payout-number
  changes, mark payouts sent. Several of these move money or reveal secrets. There was no record of
  who did what.

The only durable store is Postgres. `Store`/`Repo` (`backend/src/storage/store.ts`) abstracts
Postgres and an in-memory implementation used by tests.

## Decision

1. **New table `bot_sessions (key TEXT PK, data JSONB, updated_at TIMESTAMPTZ)`**, reached through
   `Repo.getBotSession / setBotSession / deleteBotSession`. The bot plugs these into grammY's
   `StorageAdapter`, using the key `tg:<session key>`. Writes are upserts (`ON CONFLICT DO UPDATE`),
   last write wins.
2. **New table `admin_audit (id TEXT PK, at TIMESTAMPTZ, data JSONB)`** with an index on `at DESC`.
   It is append-only through `Repo.addAudit` and read through `listAudit(limit ≤ 1000)`. Every
   state-changing admin route in `api/server.ts` writes an entry
   `{ actor, action, target, note≤500 chars }` after the action succeeds.
3. Both are added to `SCHEMA_SQL` with `CREATE TABLE IF NOT EXISTS`, the same as every other table
   so far (no separate migration tool).

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Redis / Upstash for sessions** (official grammY adapters exist) | New service, cost and secret for a few KB per chat. Postgres is already there. |
| **grammY's `@grammyjs/storage-psql` adapter** | Would work, but it owns its own table and connection handling, bypassing our `Store` abstraction. The memory store used in tests would then need a second path. |
| **Keep sessions in memory, rebuild state from orders/users** | Wizards hold data not yet saved anywhere (draft order fields), so there is nothing to rebuild from. |
| **Audit inside each business transaction** | Stronger (no action without its audit row), but it would put `admin` concerns into `OrderService`/`UserService` signatures. Revisit if the audit becomes a compliance requirement. |
| **Log-based audit (stdout → Render logs)** | Not queryable from the admin dashboard, and log retention is limited. |

## Consequences

**Positive**

- A deploy no longer wipes conversations in progress. Several instances could share sessions.
- Admin actions can be traced from the dashboard.
- Tests keep working against `MemoryStore`, which implements the same methods.

**Negative / risks the team accepts, and follow-ups**

- **Session write races.** In webhook mode Telegram can deliver several updates from the same chat at
  once (for example a double-tap on a button). With a DB round-trip per update, two handlers can read
  the same session and the last write overwrites the other's change. *Follow-up:* add grammY's
  `sequentialize` (from `@grammyjs/runner`), keyed by chat, before `session()`, or at least
  document that wizard steps must tolerate it.
- **Growth and PII retention.** `bot_sessions` has no expiry. Session data can contain buyer phone
  numbers and addresses from draft orders. *Follow-up:* add an index on `updated_at` and a daily purge
  of rows older than 30 days, and record this in the privacy notes.
- **Latency.** Each bot update now costs two extra DB round-trips (read + write). This is acceptable
  on Supabase from Render in the same region. Watch p95 bot response time.
- **The audit is not transactional with the action.** If the action succeeds and the audit insert
  then fails, the action goes unrecorded. Failed or refused admin attempts are not recorded at all.
  Acceptable for now. *Follow-up:* also log refused attempts, so brute-forcing admin login shows up.
- **The audit must never contain secrets.** `order.send_code` deliberately logs only the order id,
  never the release code. Any new audited action must keep to this rule. Note text is capped at
  500 characters.
- **No migration tool.** `CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL` can't change existing
  tables. The first ALTER we need will force adopting a migration runner. That deserves its own ADR
  when it happens.
