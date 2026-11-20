# ADR 0001: Seller debt ledger and time-based order rules

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Delivery Lead, Software Architect (customer policy decisions of 2026-11-20 as input)
- **Relates to:** BS-101 (timeouts), BS-105 (late seller cancel / return), customer policies 1 and 4 in `sprints/backlog.md`

## Context

The edge-case sprint adds two kinds of rule the escrow core could not express before:

1. **Money the seller owes the platform.** Policy 1 says that when a seller cancels after a rider
   accepted (`RIDER_ASSIGNED`), the rider gets half the delivery fee and the seller pays for it. BS-105
   adds the same for a return the seller asks for after pickup: the riders keep the legs they ran
   and the seller pays. The rider has to be paid **now**. The seller often has no money held at that
   moment: cash-on-delivery orders never hold any, and on escrow orders the buyer's money goes back
   to the buyer. Up to now the ledger could only move escrowed funds. It had no way to say "this
   seller owes us X".
2. **Rules triggered by time passing rather than by a user action.** BS-101 asks for reminders when
   no rider is found (6 h and 24 h), an automatic refund or cancel at 48 h, releasing a rider who
   accepted but did not pick up within 45 min, and a reminder when a parcel sits at the departure
   agency for 24 h. Nothing in the system acted without a request before, apart from expiring unpaid
   links, retrying payouts and re-offering jobs, which were all simple `setInterval` jobs in
   `backend/src/app.ts`.

Constraints: a single Node process on Render with Postgres (Supabase) as the only infrastructure.
There is no queue or scheduler service, and the owner wants low cost and low operational weight at
launch. `Order` is stored as one JSONB document with optimistic versioning (`version` column). The
ledger (`journals` + `ledger_lines`) uses idempotency keys and checks balance (sum of lines = 0).

## Decision

### A. Seller debt is a ledger account, mirrored on the user

- A new ledger account **`MERCHANT_RECEIVABLE`** is added. Its lines use **`refId = merchantId`**.
  Every other account uses `orderId`, so this is a deliberate exception. Under the ledger's
  zero-sum sign convention, a **negative balance means the seller owes the platform**.
- **Creating a debt** (`chargeSellerForRiders`, `order.service.ts`) books one journal per order,
  `order:<id>:seller-charge`. It credits the rider payable(s) (+) and debits `MERCHANT_RECEIVABLE`
  (−). It queues the rider payouts right away, so the platform fronts the cash. In the same
  transaction it adds the total to the denormalized **`User.owedToPlatform`**.
  - Late seller cancel: `floor(deliveryFee / 2)` to the first-mile rider (escrow and COD).
  - Seller-requested return (`SELLER_RETURN` dispute): the legs from `refundPlan` (escrow), or the
    full delivery fee to the first-mile rider (COD). On escrow the buyer gets the full `total` back.
- **Recovering a debt** (`recoverSellerDebt`) runs inside settlement (`settle`) for both escrow and COD.
  It takes `min(owedToPlatform, merchant share)` off the seller's payout line, books it as a
  `MERCHANT_RECEIVABLE` (+) line in the settlement journal, and lowers `owedToPlatform` in the same
  transaction.
- **Source of truth is the ledger.** `owedToPlatform` is a read-optimised cache. The bot and the
  admin dashboard use it to show the balance without a ledger query, and settlement uses it to
  decide how much to take. It must always equal `-ledgerBalance('MERCHANT_RECEIVABLE', merchantId)`.

### B. Time-based rules run in one polling job

- A new job **`enforceTimeouts`** runs every 5 min, next to the existing jobs in `startJobs`.
- **Time in status** is taken from the order's own `history[]`: the `at` of the latest entry
  whose status matches the current one (`statusSince`). No new column or scheduler table is needed.
- **Each reminder is sent at most once** using `Order.reminders: string[]` (for example
  `stalled-6h`, `stalled-24h`, `agency-24h`), written through `mutate` before the event is
  emitted. A 24 h reminder also marks `stalled-6h`, so a late run doesn't send both.
- **Actions** (auto refund or cancel at 48 h, no-show release at 45 min) go through the normal
  `mutate` → `transition` path. They get the same optimistic-version and state-machine guarantees
  as user actions.
- A companion job, **`syncPendingPayments`** (every 2 min), re-reads payment attempts started in
  the last 30 min, in case the provider's webhook was lost.

## Alternatives considered

### For seller debt

| Option | Why not chosen |
|---|---|
| **Pay the rider out of the seller's next payout only, nothing on the ledger in between** | The rider waits an unknown time, perhaps forever, for money the policy says they earned. The debt is also invisible to accounting. |
| **Make the seller pay right away (USSD collect)** | Adds friction and a failure mode at the moment of cancellation. The owner chose low friction for sellers at launch. Can be added later for large debts. |
| **Take it from a seller deposit or float** | The owner ruled out holds and deposits for sellers (policies 2 and 3). |
| **Ledger only, no `owedToPlatform` field** | Correct by construction, but every settlement and every bot screen would need a `SUM()` over `ledger_lines` keyed by merchant. That is acceptable now, but `ledger_lines` has no index on `(account, ref_id)` yet. Kept as the target end-state (see Consequences). |
| **Field only, no ledger account** | The books would no longer balance. A platform-fronted rider payout would have no matching asset, so reconciliation becomes impossible. |
| **Per-order receivable (`refId = orderId`)** | Recovery happens on a *different* order, so the debt and its recovery would never net to zero on any one ref. A per-merchant ref makes "what does this seller owe" a single balance query. |

### For time-based rules

| Option | Why not chosen |
|---|---|
| **Per-order timers (`setTimeout`) in process** | Lost on every restart or deploy, and Render restarts often. |
| **External scheduler / queue (pg-boss, BullMQ + Redis, Cloudflare Queues, Supabase cron)** | More infrastructure and cost for a volume that a 5-minute scan handles easily. pg-boss is the natural upgrade path because it runs on the Postgres we already have. |
| **`next_action_at` column + index, query only what is due** | Better at scale, but needs a schema change and must be kept in sync on every transition. Deferred until the scan becomes costly or starves (see Consequences). |
| **Postgres `pg_cron` calling SQL** | Puts business rules (refund plans, payouts, notifications) in SQL, away from the TypeScript domain and its tests. |

## Consequences

**Positive**

- Riders are paid immediately on late cancels and seller returns, as the policy requires.
- Seller debt is fully double-entry and auditable. Platform exposure is a single number:
  `ledgerBalance('MERCHANT_RECEIVABLE')`.
- Time-based rules reuse the state machine, optimistic versioning and event bus, so they cannot put an
  order in a state a user action couldn't.
- No new infrastructure.

**Negative / risks the team accepts**

- **Credit risk:** the platform fronts rider fees. A seller who never sells again leaves a bad
  debt. There is no write-off flow and no cap on debt yet. That is a product decision for the customer.
- **Two copies of one number** (`owedToPlatform` and the ledger) can drift if any future code path
  updates one without the other. Today both are always written in the same transaction.
- **Settlement now writes the seller's `users` row** when they owe money. Concurrent writes to that
  row (another order settling, a profile edit, an admin suspend) make the settlement transaction fail
  with `VERSION_CONFLICT`. Nothing is lost, but the rider or buyer has to retry.
- **At-most-once notifications:** a reminder key is stored before the event is emitted. A crash in
  between loses that reminder. Accepted for reminders, not for money movements, which are always
  in-transaction.
- **The polling scan is bounded** (`listOrders(..., limit 500)`, newest first). Above that volume the
  oldest orders, which are the ones most likely to be overdue, are skipped. This must be fixed before
  real volume (see follow-ups).
- **The 48 h no-rider clock restarts** whenever the order re-enters `AWAITING_RIDER` (a rider
  releases the job, a no-show, seller absent). This is deliberate (the buyer saw progress), but it
  means 48 h is measured from "last time nobody had it", not from payment.

**Required follow-ups (from the architecture review of this change)**

1. Re-check inside the transaction, in `releaseNoShow` and `autoRefundUnpicked`, that the order is still
   overdue and still held by the same rider. The decision is currently made on the pre-loop snapshot.
2. Replace newest-first `LIMIT 500` scans with an oldest-first query, or a due-date column, plus
   pagination.
3. Add a reconciliation check that alerts when
   `owedToPlatform != -ledgerBalance('MERCHANT_RECEIVABLE', merchantId)`, and an index on
   `ledger_lines (account, ref_id)`.
4. Make the seller-charge journal key reason-specific (`order:<id>:seller-charge:<reason>`), so a
   future second legitimate charge on the same order isn't silently dropped.
5. Customer decisions to request: a cap on debt (block new sales above X FCFA?), and a write-off procedure.
