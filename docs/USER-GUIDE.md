# BayamSafe user guide

Task-oriented instructions for sellers, buyers, riders and admins. This guide is written in English. Button and command names are quoted exactly as the French interface shows them, because French is the product's primary language (the bot also has an English mode: send `/lang`).

For the exact rules and numbers behind each case, see [POLICIES.md](POLICIES.md).

Features marked **(new this sprint)** arrive with the Sprint 1 release.

---

## Seller (vendeur)

You use the Telegram bot. Your buyers only need a web link.

### Sign up
1. Open the bot from the landing page ("Créer mon compte vendeur") or send `/start`.
2. Share your Telegram contact, then answer the 8 steps: shop name, city, selfie, ID front and back, ID number, shop photo, exact shop GPS pin.
3. You can sell as soon as you submit. The verified badge appears after admin approval.
4. Set or change your payout number with `/payout` (see "Change your payout number" below).

You are paid from your first order. There is no payout hold for new sellers.

### Create a sale
1. In the menu, press "Nouvelle vente (même ville)" or "Nouvelle vente (autre ville)".
2. Enter the item, the price, the delivery fee, and the buyer's phone number (it must differ from yours; foreign WhatsApp numbers are accepted for contact).
3. For an inter-city sale, choose the agency route and the agency fee. Cash on delivery is not available between cities.
4. At the pickup step you can press "Ma boutique" to use your shop location. To repeat a recent sale, press "Refaire la dernière vente" in the main menu.
5. Choose the payment: "Séquestre MoMo/OM (recommandé)" or "Cash à la livraison".
6. Choose the courier: "Un livreur BayamSafe proche" or "Mon propre livreur" (see below).
7. Optional: on the order summary, press "Autre destinataire" if the parcel goes to someone other than the buyer (answer "Oui, le client" or "Autre personne", then enter their name and phone). The rider's job card shows them.
8. Press "Créer la commande", then "Envoyer sur WhatsApp" to share the buyer link.

If you pick cash on delivery for a buyer who refused 2 cash deliveries in the last 90 days, the bot refuses it and asks for a prepaid order.

### Use your own rider
1. At the courier step, press "Mon propre livreur" and enter the rider's number (BSR-XXXX, on their badge). They must be an approved BayamSafe rider.
2. Only that rider gets the job, wherever they are. They do not need to be on duty.
3. On an existing order, use "Assigner mon livreur" to set it, or "Ouvrir à tous les livreurs" to go back to everyone.
4. If your rider accepts but does not pick up within 45 minutes, the job opens to all riders.

### Edit an order before payment (new this sprint)
Until the buyer has started paying (prepaid) or a rider has accepted (cash), open the order and press "Modifier", then choose "Article", "Prix", "Frais de livraison" or "N° du client". Press "Nouveau lien" to issue a **new buyer link**: the old link stops working. Neither is possible once the buyer has paid or the parcel is on its way.

### Follow an order
- `/orders` or "Mes commandes" lists your orders. Open one to see its status and actions.
- You get a Telegram message at each step (paid, rider accepted, picked up, delivered).

### Cancel an order
Use "Annuler la commande" on the order.
- **Before payment:** cancelled. If the buyer is paying right now, wait a few minutes and retry.
- **After payment, before a rider accepted:** the buyer is refunded in full.
- **After a rider accepted:** the buyer is refunded in full, and **the rider receives half of the delivery fee, which you pay** (deducted from your next payouts).
- **After pickup:** use "Annuler et faire revenir le colis". The rider brings the parcel back. When it is in your hands, confirm the return. The buyer is then refunded in full and the riders' trips are charged to you.

### Parcel returned after the buyer was absent or refused
1. The rider brings the parcel back to you.
2. Press "Colis retourné reçu" in the bot when you have it.
3. The buyer is refunded automatically, minus the legs the riders ran. You are not paid for that order.

### Rider arrives and you are not there
The rider presses "Vendeur absent". The job goes back to the pool and your absence count goes up. At 2 absences the admin is alerted. Be at the pickup point when you have an active order.

### Inter-city: bus arrived
When the agency tells you the parcel arrived, press "Le bus est arrivé" so a rider can be offered the last leg. The buyer can also confirm it ("L'agence m'a appelé").

### Agency fee claim (new this sprint)
If the rider says the agency charged more than the fee on the order, you get a request. Press "Accepter" or "Refuser". If you approve, the extra is paid to the rider from your share of the sale.

### Change your payout number (new this sprint)
Send `/payout` and enter the new number. An admin must approve it in the dashboard ("Numéros de paiement") before it is used.

### If your account is suspended
You can't create orders and the bot tells you so. Contact support.

---

## Buyer (acheteur)

You use the link the seller sent you. No app or account is needed.

### Pay (prepaid)
1. Open the link. Check the seller's name, the item and the total.
2. Drop a GPS pin, add a landmark, and optionally a voice note of up to 15 seconds.
3. Enter your MTN MoMo or Orange Money number and press the pay button ("Payer ... en séquestre"). Confirm with your PIN on the USSD prompt.
4. Your money is held. The seller and a rider are notified.
5. Your **release code** (4 digits) appears on **the phone that paid**. Keep it private.

You can edit the address, the landmark and the voice note after paying. If a rider has already accepted, they are told about the change.

### Follow your order
- Press "Suivre ma commande sur Telegram" on the checkout page. You then get the steps and your code in Telegram, and you can cancel from there.
- While the rider heads to you, the page shows their photo, plate, rider number, live position, distance and an estimated arrival time. Check the rider's number with `/verify` in the bot if you want.

### Receive the parcel
1. Check the parcel in front of the rider.
2. If it is right, tell the rider your 4-digit code. They enter it, and the seller and riders are paid.
3. If it is wrong, do not give the code. Press "Signaler un problème" instead.

### Cancel
Press "Annuler la commande" on the checkout page, until the rider picks the parcel up.
- Before paying: nothing is charged.
- After paying: full refund. A paid order can only be cancelled from the phone that paid.
- After pickup: you can't cancel; ask for a return by reporting a problem.

### If you are not there when the rider arrives
The rider presses "Client absent" and you are notified. You have 15 minutes. Answer, or the rider takes the parcel back to the seller and you are refunded minus the trips already made.

### If you refuse the parcel
Tell the rider. The parcel goes back to the seller. After the seller confirms it, you are refunded minus the trips the riders ran. For cash on delivery, 2 refusals or absences in 90 days mean you must pay upfront next time.

### If the rider can't enter the code
Press "J'ai reçu mon colis". This releases the money. For prepaid orders it only works from the phone that paid.

### If you lose your code
Open the link on the phone that paid, or ask to have it sent to your Telegram (follow the order first). If neither works, contact support: they can resend it to your Telegram after checking.

### Inter-city: parcel at the agency
If the agency calls you, press "L'agence m'a appelé" to confirm the parcel reached your city.

### Report a problem
Press "Signaler un problème" while the parcel is on its way. The order freezes and the money stays locked. You can attach up to **5 photos**. An admin decides.

### If no rider is found
You and the seller get reminders at 6 and 24 hours. After 48 hours with no rider, you are refunded automatically in full.

### If you paid twice or the wrong amount
It is refunded automatically to the number that paid.

---

## Rider (livreur)

You use the Telegram bot.

### Sign up
Send `/rider` and follow the 9 steps: legal name, selfie, ID front and back, ID number, vehicle type, plate, vehicle photo, city. After admin approval you get a public number (BSR-XXXX).

### Work
1. `/on_duty` and share your live location. `/off_duty` to stop.
2. The bot offers you nearby jobs. Press "Accepter". The first rider to accept gets the job. `/jobs` lists your jobs.
3. You can hold at most **3 active jobs**.
4. Prepaid jobs need **no deposit**. A cash-on-delivery job needs a deposit that covers the item price; top it up with `/topup` and check it with `/float`.
5. Go to the seller. Press "Colis récupéré" and send the required **pickup photo** of the parcel. The handover photo at delivery is optional.
6. Inter-city: drop the parcel at the agency, press "Déposé à l'agence", send the waybill number and photo. If the agency charged more than declared, the bot asks for the agency fee: press "= montant prévu" if it matches, or "Autre montant" and type the real fee. The seller approves or rejects it.
7. At the buyer, ask them to inspect the parcel, press "Saisir le code client", and enter the 4-digit code. You are paid straight to your Mobile Money.

You have 45 minutes after accepting to pick the parcel up, or the job is released and counts as a no-show on your record. If you can't do it, press "Rendre la course" before pickup.

### If the seller isn't there
Press "Vendeur absent" (button "🏪"). The job returns to the pool and you are **not penalised**.

### If the buyer isn't there
1. Press "Client absent" (button "🚪"). The buyer is notified.
2. Wait 15 minutes. "Retourner au vendeur" is refused before that.
3. Press "Retourner au vendeur" and bring the parcel back to the seller.

### If the buyer refuses
Press "Client refuse" (button "🙅"), then bring the parcel back to the seller. For prepaid orders, the trips you ran are paid.

### If the seller cancels after you accepted
You receive **half of the delivery fee**, paid by the seller.

### Report a problem
Press "Signaler un problème" and describe it (damaged parcel, wrong address). The order freezes until an admin decides.

### Earnings and withdrawals (new this sprint)
- `/earnings` (also `/gains`) shows this week, this month, all time, pending, and the cash you kept on cash-on-delivery jobs.
- `/retrait` withdraws your free (unreserved) deposit.
- `/payout` requests a change of your payout number; an admin approves it.

### Check another rider
`/verify` checks a rider number.

---

## Admin

Admins use the `/admin` dashboard (login with the admin key or username and password) and Telegram alerts.

### Daily checks
- **Verification queue:** approve or refuse riders, sellers and verified badges, with the selfie-over-ID face-match slider. Approvals also work from the Telegram review cards.
- **Orders:** filter by status. Open an order for its history and ledger entries.
- **Stuck payouts:** payouts that failed 5 times or crashed mid-send are in `NEEDS_REVIEW`. Check the Campay dashboard, then mark them sent or retry.

### Resolve a dispute
Open the disputed order, read both sides and the buyer's photos (up to 5), then choose:
- **Refund the buyer** (riders keep the legs they ran).
- **Release to the seller.**
- **Split** ("Partager", prepaid only): set the buyer's amount; riders keep the legs they ran; the seller gets the rest minus commission.
- **Resume** ("Reprendre") an order that was frozen by mistake (a false report, a code typo).

### Other order tools (new this sprint)
- **Reassign or "Retirer le livreur".** Remove sends the job back to the pool (before pickup). After pickup, name the rider who takes over.
- **Resend the code ("Renvoyer le code"):** after checking the buyer's identity by phone, send the release code to their Telegram. The buyer must be following the order on Telegram.
- **Suspend ("Suspendre") or unsuspend a seller.** A suspended seller can't create orders.
- **Approve payout-number changes** requested with `/payout`, in the "Numéros de paiement" tab.
- **Audit journal ("Journal" tab):** every admin action is recorded with who, when and what.

### Alerts to act on
- A seller with 2 or more "absent at pickup" counts.
- Orders stalled with no rider (reminders go out at 6 h and 24 h; the system refunds at 48 h by itself).
- A rider with repeated no-shows.
