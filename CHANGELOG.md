# Changelog

All notable changes to BayamSafe are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Sprint 2: customer decisions and withdrawal safety

The customer made eight more policy decisions on 2026-11-20 (decisions 6 to 13). They are listed here as the team builds them; the matching rules are in `docs/POLICIES.md`.

#### Added
- **Own-rider failed delivery.** If the seller's own rider reports the buyer absent or refusing, the buyer is refunded in full and the riders' legs are charged to the seller.
- **Payout number cool-down.** A new payout number becomes active 24 hours after admin approval. The old contact is told on Telegram, and withdrawals are paused for those 24 hours.
- **Buyer late cancel.** A buyer who cancels after a rider accepted pays the rider half the delivery fee, taken from the refund and shown before confirming. An admin cancel pays the rider nothing.
- **Cash delivery that fails.** When a cash-on-delivery buyer is absent or refuses, the rider is paid the delivery fee, charged to the seller. The buyer still gets a refusal strike.
- **Seller debt cap.** A seller who owes more than 10,000 FCFA can only create prepaid orders. Admins can write off debt, and each write-off is logged in the audit journal.
- **Rider phone privacy.** The rider's phone is shown to the buyer only after pickup, and only on the phone that paid (any device for cash on delivery).
- **GPS check for absent and refused.** The rider must be within 250 m of the drop-off, with a location under 5 minutes old.
- **Withdrawal safety.** A payout or withdrawal with an unclear gateway result is never resent automatically; it goes to admin review ("Retraits à vérifier") where the admin presses "Marquer envoyé" or "Annuler et recréditer". A background check re-asks the gateway about pending withdrawals.

#### Changed
- Buyer cancel after a rider accepted: previously a full refund with the rider unpaid; now the rider gets half the delivery fee from the refund.
- Cash-on-delivery failed deliveries previously paid the rider nothing; they now pay the delivery fee, charged to the seller.

#### Policy decisions (2026-11-20, second round)
- Paying-phone risk (a seller grabbing the buyer's paid session) is accepted until SMS exists. The 20-minute delay and alerts on "J'ai reçu mon colis" stay.

### Sprint 1

Sprint 1: every buyer, seller and rider exception now has a defined outcome. Nothing waits forever and no money is stranded. Items marked are being finished by the team this sprint.

### Added
- **Cancel rules.** The seller or the buyer can cancel until the parcel is picked up. Paid orders are refunded in full. If the seller cancels after a rider accepted, the rider gets half the delivery fee, charged to the seller and recovered from their future payouts. After pickup, the parcel first goes back to the seller.
- **Timeouts.** With no rider found, the seller and buyer are reminded at 6 h and 24 h, and at 48 h the buyer is refunded automatically (a cash order is cancelled). A rider who accepts but doesn't pick up within 45 minutes is released and the job is offered again. A parcel waiting at the departure agency for 24 h triggers a reminder.
- **Stray payments.** Duplicate, late or wrong-amount payments are refunded automatically to the number that paid. Pending payments are re-checked every 2 minutes for 30 minutes.
- **Buyer absent or refusing.** The rider presses "Client absent" (the buyer is notified and has 15 minutes), then "Retourner au vendeur"; "Client refuse" sends the parcel back at once. When the seller confirms the return, the buyer is refunded minus the legs the riders ran.
- **Cash-on-delivery protection.** 2 refusals or absences in 90 days make that buyer number prepaid-only.
- **Seller absent at pickup.** The job returns to the pool without penalising the rider. The seller's absence count goes up, and the admin is alerted from 2.
- **Seller's own rider.** A seller can give the job to their own rider by rider number (`BSR-XXXX`).
- **Buyer Telegram tracking.** The buyer can follow the order on Telegram, see the rider's live position and estimated arrival on the checkout page, and receive the code on Telegram.
- **Buyer fallbacks.** "J'ai reçu mon colis" releases the funds (prepaid: only from the phone that paid). "L'agence m'a appelé" confirms the parcel reached the destination city. Up to 5 photos can be attached to a dispute.
- **Admin tools.** Resume a frozen order, reassign or remove a rider, resend the code to the buyer's Telegram, split a dispute, suspend or unsuspend a seller, approve payout-number changes, and an audit journal of every admin action.
- **Sessions survive restarts.** The bot's step-by-step flows are stored in Postgres.
- **Seller order tools.** Edit price, delivery fee, title or buyer number before payment; issue a new buyer link; add a recipient who is not the buyer; approve or reject an agency-fee claim; suspended sellers see a clear message.
- **Rider tools.** Required pickup photo and optional handover photo, a limit of 3 active jobs, `/earnings` (`/gains`), `/retrait`, `/payout`, and a notice to the rider when the buyer changes the address.
- **Lighter checkout.** Precompiled CSS instead of the Tailwind CDN, and the map loads only when needed.
- **Documentation.** New `docs/POLICIES.md` and `docs/USER-GUIDE.md`. The landing page gains a "Protection pour tous" block, rider perks and FAQ entries on cancel and refund, own rider, tracking, absence and no-rider cases. README updated with the job schedule.

### Changed
- Disputes can now end in a split decision for prepaid orders, in addition to refund and release.
- Notifications go through Telegram and the checkout page only; SMS and WhatsApp are planned.
- Late, duplicate or wrong-amount payments are now refunded automatically instead of only alerting admins.

### Policy decisions (2026-11-20)
- Late seller cancel: the rider gets half the delivery fee, paid by the seller.
- No rider deposit for prepaid orders. No payout hold for new sellers.
- 2 cash-on-delivery refusals in 90 days make a buyer prepaid-only.

## [0.1.0] - History before this sprint

Built before the changelog existed. In order:
- First version: escrow for social-commerce sellers, GPS micro-logistics, inter-city delivery through bus agencies, and a first documentation set.
- Added onboarding by contact share, the verified seller badge, the 15-second voice note, a rider leaderboard and rider loans.
- Rebuilt the escrow core with persistence, real Campay payments, concurrency safety and a security model.
- Added the brand, the landing page, bot sign-up flows for sellers and riders, and the admin dashboard.
- Fixed the Telegram webhook crash and added admin username and password login.
- Fixed shop-location input and trusted the Render proxy.
- Bot: caught the seller's own number at the buyer step and let sellers edit it.
- Accepted foreign buyer contact numbers.
- Seller's own rider, buyer Telegram tracking and code by Telegram (backend).
- Buyer and seller cancel, quieter no-rider notices, checkout tracking interface.
