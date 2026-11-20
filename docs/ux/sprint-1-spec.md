# Sprint 1 UX spec: buyer fallbacks, recipient, admin tools (BS-106, BS-107, BS-202, BS-302)

Existing look is kept (emerald header, slate cards, rounded-2xl, Star Lock brand). French is primary, English secondary,
through the `I18N` table in `web/checkout.html` (admin is French only, as today).
All new buyer controls: min height 44 px, visible focus ring, text contrast at least 4.5:1, status changes announced via
`role="status"` / `aria-live`, errors via `role="alert"`.

## A. Checkout (buyer)

Placement, top to bottom inside `#content`: absence banner (directly under the header, above everything), merchant,
summary, recipient line (inside summary), code, rider card, tracking, payment, delivery, timeline, then the action stack:
confirm received, confirm arrival, evidence form, report problem, cancel. Destructive/irreversible actions are last and
visually separated; the positive action (confirm received) is the only filled button in the stack.

| State / action | Shown when | Flow | FR copy | EN copy |
|---|---|---|---|---|
| Confirm received | `can.confirmReceived` | Tap, native confirm dialog, `POST confirm-received`, reload view, status line "Merci" | Button: "J'ai reçu mon colis". Dialog: "Confirmer la réception ? Le paiement sera remis au vendeur. Cette action est irréversible." Done: "Merci ! Le vendeur est payé." | "I received my parcel". "Confirm receipt? Payment will be released to the seller. This cannot be undone." "Thank you! The seller is being paid." |
| Confirm arrival | `can.confirmArrival` | Tap, `POST confirm-arrival`, reload | Button: "L'agence m'a appelé, mon colis est arrivé". Hint: "Dites-le-nous quand l'agence vous a appelé : nous prévenons le livreur local." Done: "Arrivée confirmée." | "The agency called me, my parcel has arrived". "Tell us once the agency has called you; we alert the local rider." "Arrival confirmed." |
| Absence banner | `absence.side === 'BUYER'` | Amber banner, countdown to `absence.at + 15 min` (mm:ss, updates every second, announced only at start and at 5 min / 1 min to avoid chatter), call button to rider phone | "Le livreur est devant chez vous. Vous avez 15 min, appelez-le." Countdown: "Temps restant : 12:34". Expired: "Le délai est écoulé : le livreur peut repartir avec le colis." Call: "Appeler le livreur (+237...)" | "The rider is at your door. You have 15 min, call them." "Time left: 12:34". "Time is up: the rider may leave with the parcel." "Call the rider" |
| Recipient | `recipient` set | Read-only line in the summary | "À remettre à : Nom · téléphone" | "Hand over to: Name · phone" |
| Dispute evidence | `status === 'DISPUTED'` and `can.addEvidence` | File input (multiple, accept jpeg/png/webp, camera allowed). Each picked file is downscaled client-side (max side 1600 px, JPEG 0.8) then uploaded one by one (raw body, `image/jpeg`). Thumbnail list with count "n/5". Input disabled at 5. | Title: "Ajouter des photos au litige". Hint: "Jusqu'à 5 photos du colis (état, contenu). Elles sont envoyées au support." Button: "Choisir des photos". Count: "3/5 photos envoyées". Errors: "Photo refusée : format non pris en charge (JPEG, PNG ou WebP).", "Limite de 5 photos atteinte.", server message otherwise | "Add photos to the dispute". "Up to 5 photos of the parcel (condition, contents). They go to support." "Choose photos". "3/5 photos sent". |
| Cancel 403 | cancel returns 403 | Show the API message in the error area (role="alert"), scroll it into view and move focus to it. No retry loop. | Message comes from the server (e.g. "Seul le téléphone qui a payé peut annuler"). Fallback: "Seul le téléphone qui a payé peut annuler cette commande." | Same, fallback in EN |

States: loading = disabled button + "…" text; success = brief `role="status"` message; error = `role="alert"` inline
(not `alert()` for new work). Offline/network: "Erreur réseau, réessayez." (existing).
Focus order follows DOM order = visual order. The countdown is not focusable; the call button is a real `<a href="tel:">`.

BS-302: no layout change. Tailwind is precompiled; Leaflet (CSS+JS) is injected the first time a map is shown (location
picker or tracking). Until it loads, the map box shows "Chargement de la carte…". If it fails, the address text fields
still work and a message says the map is unavailable.

## B. Admin (control room, French)

All inside the existing order drawer and sidebar. Every money-moving or irreversible action opens a `confirm()` that
states the effect and amount.

- Order drawer, DISPUTED: panel shows kind, "Retour exigé / reçu le ...", buyer evidence thumbnails (click opens full size
  in a new tab), absence ("Absence acheteur/vendeur depuis ..."), agency fee claim (amount, status), pickup photo and
  delivery photo present/absent. Actions: "Reprendre la commande" (note required), "Payer le vendeur", "Rembourser le
  client", "Partager" with buyer-amount input (0..item+delivery+agency; live line "Vendeur reçoit : X FCFA").
- Any order with a rider: "Réaffecter" with rider code input, plus "Remettre au pool". "Renvoyer le code" when paid
  and not finished (response never shows the code; toast says it was sent to Telegram).
- Sellers: drawer has "Suspendre" (note required) / "Réactiver"; badge "Suspendu" in list and drawer; column "Dû à la
  plateforme" (`owedToPlatform`). Riders table: column "Absences" (`noShows`).
- New sidebar item "Numéros de paiement" with count badge: table of users with a pending number, buttons Approuver / Refuser.
- New sidebar item "Journal": last 200 audit entries (date, acteur, action, cible, note), refresh button.
- Empty states: "Aucune demande en attente.", "Le journal est vide."
- A11y: buttons are real `<button>`, inputs have `aria-label`, toasts are `role="status"`, drawers keep `role="dialog"`.
