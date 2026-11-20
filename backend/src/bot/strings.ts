import { esc } from '../i18n/locales.js';
import { formatFcfa } from '../domain/money.js';
import { Lang } from '../domain/types.js';

/**
 * Bot strings added with the Phase 1-3 policies (absence, returns, photos, agency fee, payouts...).
 * Same pattern as i18n/locales.ts: a French table, an English table with the same shape, and
 * `x(lang)` to pick one. Money is always formatted with the shared FCFA helper.
 */

const fr = {
  money: (n: number) => formatFcfa(n, 'fr'),

  // rider buttons
  btnAbsent: '🚪 Client absent',
  btnReturn: '↩️ Retourner au vendeur',
  btnRefused: '🙅 Client refuse',
  btnSellerAbsent: '🏪 Vendeur absent',
  btnYes: '✅ Oui, confirmer',
  btnNo: '✖️ Non',
  btnSkip: '⏭️ Passer',
  btnFeeSame: '✅ = montant prévu',
  btnFeeOther: '✏️ Autre montant',

  // rider messages
  absentSent: '🚪 Le client est prévenu. Attendez 15 minutes, puis appuyez sur « Retourner au vendeur ».',
  keepWaiting: (msg: string) => `⏳ ${esc(msg)}`,
  confirmRefused: 'Le client refuse le colis ? Il sera retourné au vendeur.',
  confirmSellerAbsent: 'Le vendeur est introuvable à l’adresse de ramassage ? La course sera remise à d’autres livreurs (sans pénalité pour vous).',
  returnOpened: (code: string) => `↩️ <code>${esc(code)}</code> : retour au vendeur enregistré. Rapportez le colis au vendeur ; il confirmera la réception.`,
  sellerAbsentDone: '🏪 Signalé. La course est remise à d’autres livreurs, sans pénalité pour vous.',
  cancelledAction: 'D’accord, rien n’a changé.',
  askPickupPhoto: '📸 Envoyez une photo du colis que vous récupérez (obligatoire).',
  needPickupPhoto: '📸 Il me faut une photo du colis pour continuer. Envoyez-la ici (ou /cancel).',
  askDeliveryPhoto: '📸 Voulez-vous envoyer une photo de la remise du colis ? (facultatif)',
  deliveryPhotoSaved: '✅ Photo enregistrée. Merci !',
  liveLocationReminder: '📍 Partagez votre position en direct (📎 → Position → « Partager ma position en direct ») pour que le client vous suive.',
  askAgencyFeePaid: (planned: number) => `💵 Frais d’agence payés ? Montant prévu : <b>${fr.money(planned)}</b>.`,
  askAgencyFeeAmount: '✏️ Montant réellement payé à l’agence (FCFA) :',
  agencyFeeClaimSent: (amount: number) => `🧾 Demande envoyée au vendeur : ${fr.money(amount)}. Vous serez payé si le vendeur accepte.`,
  agencyFeeApprovedRider: (code: string, amount: number) => `✅ <code>${esc(code)}</code> : le vendeur a accepté les frais d’agence (${fr.money(amount)}).`,
  agencyFeeRejectedRider: (code: string) => `❌ <code>${esc(code)}</code> : le vendeur a refusé les frais d’agence supplémentaires.`,
  recipientLine: (name: string | undefined, phone: string) => `${name ? `${esc(name)} · ` : ''}${esc(phone)} (destinataire)`,
  earnings: (e: { week: number; month: number; total: number; pending: number; cashKept: number; deliveries: number }) =>
    `💰 <b>Vos gains</b>\nCette semaine : <b>${fr.money(e.week)}</b>\nCe mois : <b>${fr.money(e.month)}</b>\nTotal : <b>${fr.money(e.total)}</b>\nEn attente : ${fr.money(e.pending)}\nCash gardé (livraisons cash) : ${fr.money(e.cashKept)}\nLivraisons : ${e.deliveries}`,
  withdrawUsage: 'Utilisation : <code>/retrait 5000</code> (montant en FCFA, pris sur votre caution disponible).',
  withdrawSent: (amount: number) => `📤 Retrait de ${fr.money(amount)} demandé. Vous recevrez l’argent sur votre Mobile Money.`,
  payoutUsage: 'Utilisation : <code>/payout 6XXXXXXXX</code> : le numéro Mobile Money qui doit recevoir vos paiements. L’admin devra valider.',
  payoutRequested: 'Demande envoyée à l’admin. Vous serez prévenu dès qu’elle est traitée.',

  // seller
  btnReturnReceived: '📦 Colis retourné reçu',
  btnFeeApprove: '✅ Accepter',
  btnFeeReject: '❌ Refuser',
  btnNewLink: '🔗 Nouveau lien',
  btnEdit: '✏️ Modifier',
  btnEditTitle: 'Article',
  btnEditPrice: 'Prix',
  btnEditFee: 'Frais de livraison',
  btnEditBuyer: 'N° du client',
  btnShop: '📍 Ma boutique',
  btnRepeat: '🔁 Refaire la dernière vente',
  btnRecipient: '👤 Autre destinataire',
  btnRecipientSame: 'Oui, le client',
  btnRecipientOther: 'Autre personne',
  returnConfirmed: (code: string) => `✅ <code>${esc(code)}</code> : retour confirmé. Le client est remboursé.`,
  returnNeeded: (code: string, reason: string) => `↩️ <code>${esc(code)}</code> : le colis revient vers vous (« ${esc(reason)} »). Quand vous l’avez en main, confirmez ci-dessous.`,
  feeClaim: (code: string, planned: number, claimed: number) =>
    `🧾 <code>${esc(code)}</code> : l’agence a facturé <b>${fr.money(claimed)}</b> au lieu de ${fr.money(planned)} prévus. La différence (${fr.money(claimed - planned)}) serait prélevée sur votre part. Acceptez-vous ?`,
  feeDecided: (approved: boolean): string => (approved ? '✅ Frais d’agence acceptés.' : '❌ Frais d’agence refusés.'),
  newLink: (url: string) => `🔗 Nouveau lien client (l’ancien ne marche plus) :\n${esc(url)}`,
  editWhich: 'Que voulez-vous modifier ?',
  editAskTitle: '✏️ Nouvel article (titre) :',
  editAskPrice: '✏️ Nouveau prix de l’article (FCFA) :',
  editAskFee: '✏️ Nouveaux frais de livraison (FCFA) :',
  editAskBuyer: '✏️ Nouveau numéro du client :',
  editDone: (code: string) => `✅ <code>${esc(code)}</code> modifiée.`,
  askRecipientQ: 'Le destinataire est-il le client ?',
  askRecipientName: '👤 Nom du destinataire :',
  askRecipientPhone: '📞 Numéro du destinataire (le livreur l’appellera) :',
  codBlocked: '⚠️ Ce client a refusé 2 livraisons en cash ces 90 derniers jours : seul le paiement à l’avance (séquestre) est possible pour lui.',
  suspended: (note?: string) => `⛔ Votre compte vendeur est suspendu${note ? ` : ${esc(note)}` : ''}. Vous ne pouvez pas créer de vente. Contactez le support.`,
  noLastOrder: 'Vous n’avez pas encore de vente à refaire.',
  repeatReady: (title: string) => `🔁 Vente « ${esc(title)} » reprise avec le même prix et les mêmes frais.`,
  shopPickupSet: '📍 Ramassage à votre boutique.',

  // notifications
  sStalled: (code: string, hours: number) => `⏳ <code>${esc(code)}</code> : toujours aucun livreur après ${hours} h. Nous continuons. Sans livreur à 48 h, la commande est annulée et le client remboursé automatiquement.`,
  bStalled: (code: string, hours: number) => `⏳ <code>${esc(code)}</code> : nous cherchons toujours un livreur (${hours} h). Sans livreur à 48 h, vous êtes remboursé automatiquement.`,
  riderNoShow: (code: string) => `⛔ <code>${esc(code)}</code> : vous n’avez pas récupéré le colis à temps. La course a été retirée.`,
  sellerNoShow: (code: string) => `🏍️ <code>${esc(code)}</code> : le livreur n’est pas venu. Nous cherchons un autre livreur.`,
  bAbsent: '🚪 Le livreur est devant chez vous et ne vous trouve pas ! Répondez-lui vite : il attend 15 minutes.',
  sBuyerAbsent: (code: string) => `🚪 <code>${esc(code)}</code> : le livreur est chez le client et personne ne répond. Il attend 15 minutes. Essayez d’appeler le client.`,
  sSellerAbsent: (code: string) => `🏪 <code>${esc(code)}</code> : le livreur ne vous a pas trouvé à l’adresse de ramassage. La course est remise à d’autres livreurs. Soyez joignable.`,
  adminSellerAbsent: (shop: string, n: number, code: string) => `🏪 Seller absent ${n}× at pickup: ${esc(shop)} (last: <code>${esc(code)}</code>)`,
  newJobForYou: '🔁 Une course vous a été attribuée :',
  oldRiderOff: (code: string) => `ℹ️ <code>${esc(code)}</code> : la course ne vous est plus attribuée.`,
  addressChanged: (code: string, addr: string, landmark?: string) => `📍 <code>${esc(code)}</code> : le client a changé l’adresse de livraison.\n🏠 ${esc(addr)}${landmark ? `\n🧭 ${esc(landmark)}` : ''}`,
  payoutDelayed: (code: string) => `⏳ <code>${esc(code)}</code> : votre paiement Mobile Money est retardé. Nous réessayons automatiquement.`,
  payoutPhoneRequested: (name: string, phone: string, id: string) => `📱 Payout number change requested by ${esc(name)}: <code>${esc(phone)}</code>\nUser id: <code>${esc(id)}</code>`,
  payoutPhoneDecided: (approved: boolean, phone?: string) =>
    approved ? `✅ Votre numéro de paiement est maintenant ${esc(phone)}.` : '❌ Votre demande de changement de numéro de paiement a été refusée.',

  helpExtra:
    '\n\n<b>Paiements</b>\n/payout 6XXXXXXXX — changer mon numéro de paiement\n/earnings — mes gains (livreurs)\n/retrait 5000 — retirer ma caution libre (livreurs)'
};

type Strings = typeof fr;

const en: Strings = {
  money: (n) => formatFcfa(n, 'en'),

  btnAbsent: '🚪 Client absent',
  btnReturn: '↩️ Return to seller',
  btnRefused: '🙅 Client refuses',
  btnSellerAbsent: '🏪 Seller absent',
  btnYes: '✅ Yes, confirm',
  btnNo: '✖️ No',
  btnSkip: '⏭️ Skip',
  btnFeeSame: '✅ = planned amount',
  btnFeeOther: '✏️ Other amount',

  absentSent: '🚪 The buyer has been notified. Wait 15 minutes, then press "Return to seller".',
  keepWaiting: (msg) => `⏳ ${esc(msg)}`,
  confirmRefused: 'The buyer refuses the parcel? It will go back to the seller.',
  confirmSellerAbsent: 'The seller can’t be found at the pickup address? The job goes back to other riders (no penalty for you).',
  returnOpened: (code) => `↩️ <code>${esc(code)}</code>: return to seller recorded. Bring the parcel back; the seller will confirm receipt.`,
  sellerAbsentDone: '🏪 Reported. The job goes back to other riders, no penalty for you.',
  cancelledAction: 'OK, nothing changed.',
  askPickupPhoto: '📸 Send a photo of the parcel you are collecting (required).',
  needPickupPhoto: '📸 I need a photo of the parcel to continue. Send it here (or /cancel).',
  askDeliveryPhoto: '📸 Want to send a photo of the handover? (optional)',
  deliveryPhotoSaved: '✅ Photo saved. Thank you!',
  liveLocationReminder: '📍 Share your live location (📎 → Location → "Share live location") so the buyer can follow you.',
  askAgencyFeePaid: (planned) => `💵 Agency fee paid? Planned amount: <b>${en.money(planned)}</b>.`,
  askAgencyFeeAmount: '✏️ Amount you actually paid the agency (FCFA):',
  agencyFeeClaimSent: (amount) => `🧾 Request sent to the seller: ${en.money(amount)}. You are paid if the seller approves.`,
  agencyFeeApprovedRider: (code, amount) => `✅ <code>${esc(code)}</code>: the seller approved the agency fee (${en.money(amount)}).`,
  agencyFeeRejectedRider: (code) => `❌ <code>${esc(code)}</code>: the seller rejected the extra agency fee.`,
  recipientLine: (name, phone) => `${name ? `${esc(name)} · ` : ''}${esc(phone)} (recipient)`,
  earnings: (e) =>
    `💰 <b>Your earnings</b>\nThis week: <b>${en.money(e.week)}</b>\nThis month: <b>${en.money(e.month)}</b>\nAll time: <b>${en.money(e.total)}</b>\nPending: ${en.money(e.pending)}\nCash kept (cash deliveries): ${en.money(e.cashKept)}\nDeliveries: ${e.deliveries}`,
  withdrawUsage: 'Usage: <code>/retrait 5000</code> (amount in FCFA, taken from your free float).',
  withdrawSent: (amount) => `📤 Withdrawal of ${en.money(amount)} requested. The money goes to your Mobile Money.`,
  payoutUsage: 'Usage: <code>/payout 6XXXXXXXX</code>: the Mobile Money number that should receive your payments. An admin must approve.',
  payoutRequested: 'Request sent to the admin. You will be told once it is handled.',

  btnReturnReceived: '📦 Returned parcel received',
  btnFeeApprove: '✅ Approve',
  btnFeeReject: '❌ Reject',
  btnNewLink: '🔗 New link',
  btnEdit: '✏️ Edit',
  btnEditTitle: 'Item',
  btnEditPrice: 'Price',
  btnEditFee: 'Delivery fee',
  btnEditBuyer: 'Buyer number',
  btnShop: '📍 My shop',
  btnRepeat: '🔁 Repeat last sale',
  btnRecipient: '👤 Different recipient',
  btnRecipientSame: 'Yes, the buyer',
  btnRecipientOther: 'Someone else',
  returnConfirmed: (code) => `✅ <code>${esc(code)}</code>: return confirmed. The buyer is refunded.`,
  returnNeeded: (code, reason) => `↩️ <code>${esc(code)}</code>: the parcel is coming back to you ("${esc(reason)}"). Confirm below once you have it.`,
  feeClaim: (code, planned, claimed) =>
    `🧾 <code>${esc(code)}</code>: the agency charged <b>${en.money(claimed)}</b> instead of the planned ${en.money(planned)}. The difference (${en.money(claimed - planned)}) would come out of your share. Approve?`,
  feeDecided: (approved) => (approved ? '✅ Agency fee approved.' : '❌ Agency fee rejected.'),
  newLink: (url) => `🔗 New buyer link (the old one no longer works):\n${esc(url)}`,
  editWhich: 'What do you want to change?',
  editAskTitle: '✏️ New item title:',
  editAskPrice: '✏️ New item price (FCFA):',
  editAskFee: '✏️ New delivery fee (FCFA):',
  editAskBuyer: '✏️ New buyer number:',
  editDone: (code) => `✅ <code>${esc(code)}</code> updated.`,
  askRecipientQ: 'Is the recipient the buyer?',
  askRecipientName: '👤 Recipient name:',
  askRecipientPhone: '📞 Recipient phone number (the rider will call it):',
  codBlocked: '⚠️ This buyer refused 2 cash deliveries in the last 90 days: only prepaid (escrow) orders are possible for them.',
  suspended: (note) => `⛔ Your seller account is suspended${note ? `: ${esc(note)}` : ''}. You can’t create sales. Contact support.`,
  noLastOrder: 'You have no previous sale to repeat yet.',
  repeatReady: (title) => `🔁 Sale "${esc(title)}" reused with the same price and fees.`,
  shopPickupSet: '📍 Pickup at your shop.',

  sStalled: (code, hours) => `⏳ <code>${esc(code)}</code>: still no rider after ${hours} h. We keep trying. With no rider at 48 h the order is cancelled and the buyer refunded automatically.`,
  bStalled: (code, hours) => `⏳ <code>${esc(code)}</code>: we are still looking for a rider (${hours} h). With no rider at 48 h you are refunded automatically.`,
  riderNoShow: (code) => `⛔ <code>${esc(code)}</code>: you did not pick up the parcel in time. The job was taken away.`,
  sellerNoShow: (code) => `🏍️ <code>${esc(code)}</code>: the rider did not show up. We are finding another rider.`,
  bAbsent: '🚪 The rider is at your door and can’t find you! Answer quickly: they wait 15 minutes.',
  sBuyerAbsent: (code) => `🚪 <code>${esc(code)}</code>: the rider is at the buyer’s and nobody answers. They wait 15 minutes. Try calling the buyer.`,
  sSellerAbsent: (code) => `🏪 <code>${esc(code)}</code>: the rider could not find you at the pickup address. The job goes back to other riders. Please be reachable.`,
  adminSellerAbsent: (shop, n, code) => `🏪 Seller absent ${n}× at pickup: ${esc(shop)} (last: <code>${esc(code)}</code>)`,
  newJobForYou: '🔁 A job was assigned to you:',
  oldRiderOff: (code) => `ℹ️ <code>${esc(code)}</code>: this job is no longer assigned to you.`,
  addressChanged: (code, addr, landmark) => `📍 <code>${esc(code)}</code>: the buyer changed the delivery address.\n🏠 ${esc(addr)}${landmark ? `\n🧭 ${esc(landmark)}` : ''}`,
  payoutDelayed: (code) => `⏳ <code>${esc(code)}</code>: your Mobile Money payout is delayed. We retry automatically.`,
  payoutPhoneRequested: (name, phone, id) => `📱 Payout number change requested by ${esc(name)}: <code>${esc(phone)}</code>\nUser id: <code>${esc(id)}</code>`,
  payoutPhoneDecided: (approved, phone) =>
    approved ? `✅ Your payout number is now ${esc(phone)}.` : '❌ Your payout number change request was refused.',

  helpExtra:
    '\n\n<b>Payments</b>\n/payout 6XXXXXXXX — change my payout number\n/earnings — my earnings (riders)\n/retrait 5000 — withdraw free float (riders)'
};

export function x(lang: Lang = 'fr'): Strings {
  return lang === 'en' ? en : fr;
}
