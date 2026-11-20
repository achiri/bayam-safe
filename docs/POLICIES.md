# BayamSafe policies

The rules the platform applies, in plain language, with the exact numbers. All amounts are in FCFA. These rules are enforced by the system (`backend/src/services/order.service.ts`, `backend/src/domain/money.ts`). The customer's decisions from 2026-11-20 are marked **(policy N)** and are listed in `sprints/backlog.md`.

For step-by-step instructions, see [USER-GUIDE.md](USER-GUIDE.md).

## 1. Money

### Fees and commission

| Item | Rule |
| --- | --- |
| Commission | **2.5 %** of the **item price**, rounded to the nearest FCFA. Paid by the seller, taken from the sale. The default is set by `PLATFORM_COMMISSION_PCT`. |
| Delivery fee | Set by the seller. Paid by the buyer. Goes entirely to the rider(s). No commission is taken on it. |
| Agency fee (inter-city) | Set by the seller. Paid by the buyer. Goes to the first-mile rider, who pays the bus agency at the counter. |
| What the buyer pays | Item price + delivery fee + agency fee. |
| Limits | Item price at least 100. Delivery fee and agency fee at most 100,000 each. Order total at most 2,000,000. |
| No sale, no commission | A cancelled, refunded or expired order costs the seller no commission. |

Example (same city): item 20,000, delivery 1,500. The buyer pays 21,500. The seller receives 19,500, the rider 1,500, BayamSafe 500.

### When the money is released

- **Prepaid (escrow) orders:** the buyer's money is held per order. It is released when the rider enters the buyer's 4-digit code, or when the buyer confirms receipt ("J'ai reçu mon colis", from the phone that paid). The seller's payout and the riders' payouts then go out automatically to their Mobile Money numbers.
- **Inter-city:** the delivery fee is split 50/50 between the first-mile and last-mile riders (the first-mile rider gets the rounded-down half). The first-mile rider is also reimbursed the agency fee.
- **Wrong code:** after 3 wrong codes the order is frozen and becomes a dispute.
- **Cash on delivery (same city only):** the rider collects the cash and keeps the delivery fee. The seller is paid from the rider's deposit (float), which covers the item price while the job runs.
- **Payment link:** a buyer link that is not paid expires after 48 hours (`ORDER_PAYMENT_TTL_HOURS`).
- **Pending payments** are re-checked every 2 minutes for 30 minutes after the buyer starts paying, in case a notification was lost.

### Sellers who owe money (debt recovery)

When BayamSafe has paid a rider for a seller's cancellation or return (sections 2 and 3), the seller owes that amount. It is **recovered from the seller's next payouts**: at the next delivered sale, the amount is deducted from the seller's share, up to what that share can cover. The seller is not asked to pay it separately.

### No payout hold for new sellers (policy 3)

A seller is paid on the same terms from the first order. BayamSafe does not hold the money of new sellers. The only exceptions are an admin suspension (section 9) and a payout flagged for review by the admin.

### Rider deposit

- **No deposit for prepaid orders, ever (policy 2).** Any approved rider can accept a prepaid job.
- A deposit applies **only to cash on delivery**. The rider's available deposit must cover the item price. That amount is reserved for the job, so one deposit cannot back two jobs.

## 2. Cancellations

Either the seller or the buyer can cancel until a rider has picked up the parcel. A paid order can only be cancelled by the buyer from the phone that paid.

| When | What happens |
| --- | --- |
| **Before payment** | The order is cancelled. Nothing to refund. If the buyer started paying less than 10 minutes ago, the seller must wait: the cancel is refused while a payment is in progress. |
| **After payment, before a rider accepts** | The order is refunded. The buyer gets the **full amount**. No fee. |
| **After a rider accepted, before pickup, cancelled by the buyer or an admin** | The buyer gets the **full amount**. The rider is not paid and the job ends. |
| **After a rider accepted, before pickup, cancelled by the seller (policy 1)** | The buyer gets the **full amount**. The rider receives **half of the delivery fee**, paid by the seller (rounded down; it is added to what the seller owes and recovered from future payouts, see section 1). |
| **After pickup** | The parcel cannot just be cancelled. It must first go back to the seller (section 3). |

Cash-on-delivery orders follow the same stages, but there is no buyer refund, because the buyer has not paid. The rider's reserved deposit is released.

## 3. Returns after pickup

### Seller asks to stop after pickup

The seller opens a return. When the parcel is back and the seller confirms it, the buyer gets **everything back** (full refund). The riders are paid for the legs they actually ran, **paid by the seller** and recovered from future payouts. On a cash-on-delivery order, the rider is paid the delivery fee, charged to the seller.

### Buyer absent (15-minute wait)

1. At the door, the rider presses "Client absent". The buyer is notified.
2. The rider waits **15 minutes**. Before that, "Retourner au vendeur" is refused.
3. After 15 minutes, the rider presses "Retourner au vendeur" and takes the parcel back.
4. When the seller confirms the parcel is back, the buyer is refunded **minus the legs the riders actually ran**.

### Buyer refuses the parcel

The rider presses "Client refuse". No waiting time. The parcel goes back to the seller, and the refund works as above: the buyer is refunded minus the legs the riders actually ran.

What a rider keeps for the legs run: same-city, the whole delivery fee once the parcel is picked up. Inter-city, half of the delivery fee for each leg actually run, plus the agency fee if the parcel really reached the agency.

### Cash on delivery: 2 refusals in 90 days (policy 4)

On a cash-on-delivery order, a buyer absence or refusal counts against the buyer's phone number. **After 2 in 90 days, that number can only use prepaid (escrow) orders.** The seller is told when creating a cash order for such a number.

## 4. Nobody found, nobody came

| Situation | What happens |
| --- | --- |
| **No rider found** | Reminders to the seller and buyer at **6 hours** and **24 hours**. At **48 hours**, a prepaid order is **refunded automatically in full**; a cash order is cancelled. Job offers are repeated every 10 minutes meanwhile. |
| **Rider accepted but does not pick up (no-show)** | After **45 minutes**, the rider is released, their no-show count goes up, and the job is offered again. If it was the seller's own rider, the job opens to everyone. |
| **Seller absent at pickup** | The rider reports it. The job returns to the pool, **the rider is not penalised**, and the seller's absence count goes up. The admin is alerted from 2 absences. |
| **Parcel waiting at the departure agency (inter-city)** | A reminder after 24 hours. The buyer can also confirm "L'agence m'a appelé" to say it reached the destination city. |
| **Rider job limit** | A rider can hold at most **3 active jobs**. |

## 5. Stray and duplicate payments

A payment that cannot be applied to an unpaid order (duplicate, late, or wrong amount) is **refunded automatically** to the number that paid. After a wrong-amount payment, the buyer can pay again. Nobody has to ask.

## 6. Agency fee claims (inter-city)

At drop-off, the rider can declare the fee the agency actually charged if it is higher than the amount on the order. The **seller approves or rejects** the claim. If approved, the **extra** is paid to the rider out of the seller's share (never more than the seller's share). If rejected, nothing changes.

## 7. Disputes

A dispute freezes the order and the money. It opens when the buyer or rider reports a problem, or after 3 wrong codes. The buyer can attach up to **5 photos**. The admin can:

- **Refund the buyer:** riders keep the legs they actually ran, the buyer gets the rest.
- **Release to the seller:** the order is settled as delivered.
- **Split (prepaid orders only):** riders keep the legs they ran, the admin sets the buyer's share between 0 and the remaining amount, and the seller gets the rest minus the commission on their part.
- **Resume:** unfreeze the order and carry on from where it stopped (for example, a false report or a code typo).

Every admin action is written to the audit journal.

## 8. Fallbacks for the buyer

- "J'ai reçu mon colis" releases the funds if the rider cannot enter the code. For prepaid orders it only works from the phone that paid.
- If the buyer loses the code, they can have it sent to their Telegram (after "Suivre ma commande sur Telegram"). If they never linked Telegram, support must help.

## 9. Admin controls

An admin can resume a frozen order, reassign or remove a rider, resend the code to the buyer's Telegram, decide a split, suspend or unsuspend a seller, and approve payout-number changes. A suspended seller cannot create orders and sees a clear message.

## 10. Notifications

Notifications go through **Telegram and the checkout page only (policy 5)**. SMS and WhatsApp notifications are planned for later. A buyer who wants messages follows the order on Telegram from the checkout page.
