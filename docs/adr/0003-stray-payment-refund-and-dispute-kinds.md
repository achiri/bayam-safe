# ADR 0003: Automatic refund of stray payments; typed disputes with return, resume and split

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Delivery Lead, Software Architect
- **Relates to:** BS-102 (stray payments), BS-103 (buyer absent or refusing), BS-107 (admin resume and split)

## Context

- **Stray payments.** A buyer can approve an old USSD prompt after starting a new one, pay twice,
  pay the wrong amount, or pay after the link expired. Before this change such money was only
  flagged to admins (`order.payment_mismatch`) and sat unbooked in the provider account.
- **Disputes.** All disputes were the same: an admin chose `REFUND_BUYER` or `RELEASE_TO_MERCHANT`.
  Common, predictable cases now need their own handling. Buyer absent or refusing at the door, and a
  return the seller asks for, all mean "parcel goes back, then refund". A release-code lock-out is
  usually a typo and should continue the delivery. Some cases deserve a partial refund.

## Decision

### Stray payments

- Every payment attempt is recorded in `order.payment.attempts[] { reference, payerPhone, at }`
  (last 10 kept).
- A `SUCCESSFUL` transaction that doesn't cleanly match the order is treated as stray. That is:
  the order is not `PENDING_PAYMENT`, or it's not the current attempt, or the amount differs. A stray
  payment is refunded automatically to the number that paid that attempt (`refundStrayPayment`). The
  journal `stray:<reference>` moves `GATEWAY_CLEARING → BUYER_REFUND_PAYABLE`, and a `BUYER_REFUND`
  payout is queued on the order. A wrong amount on the current attempt also clears the attempt, so the
  buyer can pay again.

### Typed disputes

- `Dispute.kind ∈ { BUYER_ABSENT, BUYER_REFUSED, SELLER_RETURN, CODE_LOCK, OTHER }`.
- For `BUYER_ABSENT`, `BUYER_REFUSED` and `SELLER_RETURN`, `returnRequired = true`. When the seller
  confirms the parcel is back (`sellerConfirmReturn`), the system resolves `REFUND_BUYER` without an
  admin:
  - buyer absent or refused, escrow: buyer refunded minus the legs the riders ran (`refundPlan`);
  - seller return, escrow: buyer refunded in full, riders' legs charged to the seller (ADR 0001);
  - COD: the rider's float reservation is released. On a seller return the seller is charged the
    delivery fee for the rider.
- On COD, `BUYER_ABSENT`/`BUYER_REFUSED` set `order.buyerRefusalAt`. The prepaid-only rule
  (policy 4) counts these per buyer phone over 90 days.
- **Resume:** an admin can return a `DISPUTED` order to `dispute.fromStatus`
  (resolution `RESUMED`, code attempts reset). The state machine gains
  `DISPUTED → {IN_TRANSIT, AT_AGENCY, AT_DESTINATION_HUB, LAST_MILE_ASSIGNED, OUT_FOR_DELIVERY}`.
- **Split (escrow only):** riders keep the legs they ran, the admin sets the buyer's amount
  (0..total − rider legs), and the seller receives the rest minus commission on that rest. The order
  then moves to `DELIVERED` → `SETTLED` through the normal payout path.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Keep flagging stray money for manual refund** | Doesn't scale. The buyer's money is stuck for an unknown time, and it erodes trust in an escrow product. |
| **Apply a late older attempt as the payment instead of refunding it** | Friendlier to the buyer, but needs care so a second success isn't also applied. Recommended as a refinement (see Consequences). |
| **A separate `Return` entity with its own state machine** | Cleaner model, but much more code. A dispute with `returnRequired` covers today's flows. |
| **New order statuses (`RETURNING`, `RETURNED`)** | Would touch every status-dependent screen and notification. `DISPUTED` + `kind` keeps the change local. |
| **Split as "refund + separate merchant release" in two journals** | Two journals can half-apply. One balanced `order:<id>:split` journal is atomic. |

## Consequences

**Positive**

- Stray money goes back automatically and is booked. The ledger explains every franc in
  `GATEWAY_CLEARING`.
- The most common return cases close without an admin.
- Typo lock-outs no longer end deals.

**Negative / follow-ups**

- If the paying number is unknown (attempt older than the last 10, or found only by
  `externalReference`), the refund is silently skipped. The `mismatch:<ref>` marker is written before
  the refund is tried, so a failed refund is never retried. *Follow-up:* drop the pre-marker, rely on
  the `stray:<ref>` journal key for idempotency, and when no phone is known, book the money and raise
  a `NEEDS_REVIEW` refund for an admin.
- `buyerRefusalAt` is set when the dispute **opens**, so a false report that an admin later resumes
  or releases still counts towards the prepaid-only rule. *Follow-up:* set it on resolution, or
  clear it on `RESUMED`/`RELEASE_TO_MERCHANT`.
- A split reuses `DELIVERED`, so buyers and sellers receive a "delivered" notification for a split
  decision. Notifications should check `dispute.resolution === 'SPLIT'`.
- COD orders resolved after a dispute end in `REFUNDED` although no money was taken. This is a
  cosmetic mismatch that reports should be aware of.
- Product question for the customer: on a COD buyer refusal or absence, nobody pays the rider for
  the round trip (escrow orders pay the riders' legs from the buyer's money). Is that intended?
