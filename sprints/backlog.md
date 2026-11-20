# Backlog

Format: `ID · title · priority · status`, then acceptance criteria (AC).
Status: `Todo` → `In sprint` → `In review` → `Done` (Done only after customer sign-off on a review packet).

## Customer policy decisions (2026-11-20)

These come from the customer. Don't change them without asking.

1. Seller cancels after a rider accepted (RIDER_ASSIGNED): the rider gets **half the delivery fee**. The seller pays it (it comes out of their future payouts), and the buyer still gets a full refund.
2. No rider deposit for prepaid orders, ever.
3. No payout hold for new sellers.
4. **2 cash-on-delivery refusals or no-shows in 90 days** → that buyer number can only use prepaid orders.
5. Notifications go by Telegram and the checkout page only. SMS and WhatsApp come later.

### Second round (2026-11-20, after the security and architecture reviews)

6. Seller grabbing the paying-phone session: accept the risk until SMS exists. Keep the 20-minute delay and the alerts.
7. When the seller's own rider reports "absent" or "refused", the buyer gets a full refund and the riders' legs are charged to the seller.
8. A payout number change takes effect 24 h after admin approval. The old number is notified, and withdrawals pause for those 24 h.
9. Buyer cancels after a rider accepted: the rider gets half the delivery fee, taken from the buyer's refund. An admin cancel pays the rider nothing.
10. COD buyer absent or refused: the rider gets the delivery fee, charged to the seller. The buyer still gets a refusal strike.
11. A seller who owes more than 10,000 FCFA can only create prepaid orders. An admin can write off debt, and the write-off is logged in the audit journal.
12. Rider phone is shown only to the paying device (any device for COD), and only once the parcel is on the way.
13. GPS rule for "absent" and "refused": within 250 m of the drop-off, location under 5 minutes old.

## Phase 1: nothing gets stuck, no money gets lost · P0 · In sprint

- **BS-101 Timeouts.**
  - AC: if no rider is found, the seller and buyer are reminded at 6 h and 24 h. At 48 h the buyer gets an automatic full refund (escrow), or the order is cancelled (cash on delivery).
  - AC: a rider who accepts but doesn't pick up within 45 min is released, their `noShows` count goes up, and the job is offered again.
  - AC: if a parcel sits at the departure agency for 24 h, a reminder goes out.
- **BS-102 Stray payments.**
  - AC: a duplicate or late payment, or one with the wrong amount, is refunded automatically to the number that paid.
  - AC: pending payments are re-checked every 2 min for 30 min, in case the webhook was lost.
- **BS-103 Buyer absent or refusing.**
  - AC: the rider presses "Client absent". The buyer is notified, and after 15 min the rider can bring the parcel back to the seller.
  - AC: a refusal at the door also sends the parcel back.
  - AC: when the seller confirms the return, the buyer is refunded minus the legs the riders actually ran.
  - AC: on cash-on-delivery orders, an absence or refusal counts toward the 2-in-90-days rule.
- **BS-104 Seller absent at pickup.**
  - AC: the job goes back to the pool and the rider is not penalised.
  - AC: the seller's absence count goes up, and the admin is alerted from 2 absences.
- **BS-105 Late seller cancel or return.**
  - AC: half the delivery fee goes to the rider, charged to the seller (policy 1).
  - AC: a return the seller asks for after pickup pays the riders' legs, charged to the seller.
  - AC: the amount owed is recovered from the seller's next payouts.
- **BS-106 Buyer fallbacks.**
  - AC: "J'ai reçu mon colis" releases the funds. For escrow it only works from the phone that paid.
  - AC: "L'agence m'a appelé" confirms the parcel reached the destination city.
  - AC: the buyer can attach up to 5 photos to a dispute.
- **BS-107 Admin tools.**
  - AC: the admin can resume a frozen order, reassign or remove a rider, resend the code to the buyer's Telegram, split a dispute, and suspend or unsuspend a seller.
  - AC: the admin approves changes to a payout number.
  - AC: every admin action is written to an audit journal.
- **BS-108 Bot sessions survive restarts.**
  - AC: sessions are stored in Postgres, so a half-finished wizard survives a Render restart.

## Phase 2: fewer mistakes · P1 · In sprint

- **BS-201 Edit before payment.**
  - AC: the seller can change the price, delivery fee, title or buyer number before anyone pays or a rider accepts.
  - AC: the seller can issue a new buyer link, and the old link stops working.
- **BS-202 Recipient other than the buyer.**
  - AC: the order can carry an optional recipient name and phone. The rider's job card shows the recipient.
- **BS-203 Photo proof.**
  - AC: the rider must send a photo at pickup. The handover photo is optional.
- **BS-204 Rider job limit.**
  - AC: a rider can hold at most 3 active jobs.
- **BS-205 Address changed.**
  - AC: if the buyer edits the address after a rider accepted, the rider is notified.
- **BS-206 Rider money.**
  - AC: `/earnings` shows the week, the month, all time, pending, and cash kept.
  - AC: `/retrait` withdraws free float.
- **BS-207 Payout number changes.**
  - AC: a seller or rider requests a change with `/payout`, and the admin approves it.
- **BS-208 Suspended seller.**
  - AC: a suspended seller can't create orders and sees a clear message.

## Phase 3: inter-city polish and speed · P2 · In sprint

- **BS-301 Agency fee claim.**
  - AC: at drop-off the rider can declare the fee the agency actually charged. The seller approves or rejects it, and if approved the extra is paid to the rider out of the seller's share.
- **BS-302 Lighter checkout.**
  - AC: the checkout uses precompiled CSS instead of the Tailwind CDN, and the map loads only when needed.
- **BS-303 Landing page and product docs.**
  - AC: the landing page explains cancel and refund rules, own rider, tracking, and the absent and refusal rules.
  - AC: `docs/USER-GUIDE.md` and `docs/POLICIES.md` exist and match the code.

## Sprint 2: customer decisions and withdrawal safety · P0 · In sprint

- **BS-401 Own-rider failed delivery charged to the seller (decision 7).**
- **BS-402 Payout number cool-down (decision 8).** 24 h delay after approval, old number notified, withdrawals paused for 24 h.
- **BS-403 Buyer late cancel pays the rider half the fee (decision 9).**
- **BS-404 COD failed delivery pays the rider, charged to the seller (decision 10).**
- **BS-405 Seller debt cap and admin write-off (decision 11).**
- **BS-406 Rider phone visibility (decision 12).**
- **BS-407 Withdrawal safety.**
  - AC: a background sweeper re-checks PENDING and SENDING withdrawals with the gateway.
  - AC: the admin can resolve a NEEDS_REVIEW withdrawal ("mark sent" or "reverse"), and the action is audited.

## Sprint 2 follow-ups (security, later)

- **BS-408 Payout number: let the user cancel a pending change** themselves (today only an admin can reject it).
- **BS-409 Withdrawal sweeper:** move the SENDING → NEEDS_REVIEW flag inside a transaction.
- **BS-410 COD buyer cancel after a rider accepted** pays the rider nothing, because there is no prepayment to take the fee from. Needs the customer's decision.

## Later

- SMS / WhatsApp notifications (policy 5).
