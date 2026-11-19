import { formatFcfa } from '../domain/money.js';
import { Lang, OrderStatus } from '../domain/types.js';

/** Escapes text for Telegram HTML parse mode. Always wrap user-provided text with this. */
export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const STATUS: Record<Lang, Record<OrderStatus, string>> = {
  fr: {
    PENDING_PAYMENT: '⏳ En attente de paiement',
    AWAITING_RIDER: '🔎 Recherche de livreur',
    RIDER_ASSIGNED: '🏍️ Livreur en route vers le vendeur',
    IN_TRANSIT: '📦 Colis récupéré, en route',
    AT_AGENCY: '🚌 Déposé à l’agence de voyage',
    AT_DESTINATION_HUB: '🏁 Arrivé dans la ville de destination',
    LAST_MILE_ASSIGNED: '🏍️ Livreur local assigné',
    OUT_FOR_DELIVERY: '🛵 En cours de livraison',
    DELIVERED: '✅ Livré, paiements en cours',
    SETTLED: '💰 Terminé, fonds versés',
    DISPUTED: '⚠️ Litige en cours',
    REFUNDED: '↩️ Remboursé',
    CANCELLED: '✖️ Annulé',
    EXPIRED: '⌛ Lien expiré'
  },
  en: {
    PENDING_PAYMENT: '⏳ Waiting for payment',
    AWAITING_RIDER: '🔎 Finding a rider',
    RIDER_ASSIGNED: '🏍️ Rider heading to seller',
    IN_TRANSIT: '📦 Picked up, on the way',
    AT_AGENCY: '🚌 Dropped at travel agency',
    AT_DESTINATION_HUB: '🏁 Arrived in destination city',
    LAST_MILE_ASSIGNED: '🏍️ Local rider assigned',
    OUT_FOR_DELIVERY: '🛵 Out for delivery',
    DELIVERED: '✅ Delivered, payouts in progress',
    SETTLED: '💰 Completed, funds paid out',
    DISPUTED: '⚠️ Under dispute',
    REFUNDED: '↩️ Refunded',
    CANCELLED: '✖️ Cancelled',
    EXPIRED: '⌛ Link expired'
  }
};

const fr = {
  status: (s: OrderStatus) => STATUS.fr[s],
  money: (n: number) => formatFcfa(n, 'fr'),

  welcomeNew:
    '👋 <b>Bienvenue sur BayamSafe</b> 🇨🇲\n\nPaiement sécurisé (MoMo / Orange Money) + livraison moto et inter-villes.\n\n' +
    'Appuyez sur le bouton ci-dessous pour lier votre numéro Mobile Money. C’est sur ce numéro que vous serez payé.',
  shareContactBtn: '📱 Partager mon numéro',
  shareOwnContact: '⚠️ Utilisez le bouton « Partager mon numéro » pour envoyer <b>votre propre</b> contact.',
  registered: (name: string, phone: string) => `🎉 Compte créé : <b>${esc(name)}</b>\n📱 Paiements vers : <code>${esc(phone)}</code>`,
  menuTitle: (name: string, verified: boolean) => `Bonjour <b>${esc(name)}</b>${verified ? ' 🏅' : ''}. Que voulez-vous faire ?`,
  btnNewIntra: '🏍️ Nouvelle vente (même ville)',
  btnNewInter: '🚌 Nouvelle vente (autre ville)',
  btnMyOrders: '📦 Mes commandes',
  btnKyc: '🏅 Badge vendeur vérifié',
  btnRider: '🛵 Espace livreur',
  btnLeaderboard: '🏆 Classement livreurs',
  btnLang: '🌐 English',
  langSet: '✅ Langue : Français',
  cancelled: 'Opération annulée.',
  notRegistered: 'Envoyez /start pour créer votre compte d’abord.',
  genericError: '❌ Une erreur est survenue. Réessayez.',

  askTitle: '📝 Nom de l’article ? (ex : Robe wax taille M)\n\n<i>/cancel pour annuler</i>',
  askPrice: '💰 Prix de l’article en FCFA ? (ex : 15000)',
  askDeliveryFee: '🛵 Frais de livraison en FCFA payés par le client ? (0 si offert)',
  askAgency: '🚌 Depuis quelle agence partira le colis ?',
  askDestination: '🏁 Ville de destination ?',
  askAgencyFee: '🧾 Frais d’expédition de l’agence en FCFA (payés au guichet par le livreur, remboursés à la livraison) ?',
  askBuyerPhone: '📱 Numéro du client (ex : 671234567) ?',
  askPickup: '📍 Adresse de ramassage (quartier, repère).\nVous pouvez aussi d’abord partager votre position 📎 → Position.',
  pickupLocationSaved: '📍 Position enregistrée. Décrivez maintenant l’adresse en quelques mots (quartier, repère).',
  askPaymentMode: '💳 Comment le client paie-t-il ?',
  btnEscrow: '🔒 Séquestre MoMo/OM (recommandé)',
  btnCod: '💵 Cash à la livraison',
  invalidNumber: '⚠️ Entrez un montant en chiffres, ex : 15000',
  summary: (d: { title: string; price: number; fee: number; agencyFee: number; total: number; buyer: string; mode: string; route?: string }) =>
    `<b>Récapitulatif</b>\n📦 ${esc(d.title)}\n💰 Article : ${fr.money(d.price)}\n🛵 Livraison : ${fr.money(d.fee)}` +
    (d.agencyFee ? `\n🧾 Agence : ${fr.money(d.agencyFee)}` : '') +
    `\n<b>Total client : ${fr.money(d.total)}</b>\n📱 Client : ${esc(d.buyer)}\n💳 ${esc(d.mode)}` +
    (d.route ? `\n🚌 ${esc(d.route)}` : ''),
  btnConfirm: '✅ Créer la commande',
  btnAbort: '✖️ Annuler',
  orderCreated: (code: string, url: string, cod: boolean) =>
    `✅ <b>Commande créée</b> — <code>${esc(code)}</code>\n\n` +
    (cod
      ? 'Paiement cash à la livraison. Nous cherchons un livreur. Envoyez ce lien au client pour qu’il indique son point GPS :\n'
      : 'Envoyez ce lien privé au client pour qu’il paie en séquestre et indique son point GPS :\n') +
    `${esc(url)}\n\n<i>Ne partagez ce lien qu’avec le client.</i>`,
  whatsappPitch: (item: string, total: number, url: string) =>
    `Bonjour ! Voici le lien de paiement sécurisé BayamSafe pour "${item}" (${fr.money(total)}). ` +
    `Votre argent reste bloqué jusqu’à ce que vous vérifiiez le colis devant le livreur : ${url}`,
  btnShareWhatsapp: '📲 Envoyer sur WhatsApp',

  noOrders: 'Aucune commande pour le moment.',
  orderLine: (code: string, title: string, status: string) => `<code>${esc(code)}</code> · ${esc(title)}\n   ${status}`,
  btnCancelOrder: '✖️ Annuler la commande',
  btnArrived: '🏁 Le bus est arrivé',
  orderCancelledMsg: (code: string) => `✖️ Commande ${esc(code)} annulée.`,

  kycIntro: '🏅 <b>Badge vendeur vérifié</b>\nNous vérifions votre pièce d’identité avant d’afficher le badge à vos clients.\n\nEntrez votre numéro de CNI :',
  kycAskPhoto: '📸 Envoyez maintenant une photo nette de votre CNI (recto).',
  kycSubmitted: '✅ Merci ! Votre demande est en cours de vérification. Vous serez notifié.',
  kycAlready: (s: string) => `Statut de votre badge : <b>${esc(s)}</b>`,
  kycApproved: '🏅 Votre badge vendeur vérifié est actif !',
  kycRejected: '❌ Votre demande de badge a été refusée. Contactez le support.',

  riderMenu: (status?: string, onDuty?: boolean, float?: number, reserved?: number) =>
    status
      ? `🛵 <b>Espace livreur</b>\nStatut : <b>${esc(status)}</b>${onDuty ? ' · 🟢 En service' : ' · 🔴 Hors service'}\n` +
        `💼 Caution : ${fr.money(float ?? 0)} (bloqué : ${fr.money(reserved ?? 0)})\n\n` +
        '/on_duty · /off_duty · /jobs · /float\nPartagez votre position en direct (📎 → Position → en direct) pour recevoir les courses proches.'
      : '🛵 Pas encore livreur ? Envoyez /register_rider.',
  riderAskCni: '🪪 Inscription livreur. Numéro de CNI ?',
  riderAskPlate: '🏍️ Numéro d’immatriculation ?',
  riderAskCity: '🏙️ Votre ville ?',
  riderApplied: '✅ Demande envoyée. Un responsable vous contactera pour vérifier vos documents.',
  riderApproved: '✅ Votre compte livreur est approuvé ! Envoyez /on_duty puis partagez votre position en direct.',
  riderSuspended: '⛔ Votre compte livreur est suspendu. Contactez le support.',
  onDuty: '🟢 En service. Partagez votre position en direct pour recevoir les courses proches.',
  offDuty: '🔴 Hors service.',
  floatInfo: (bal: number, res: number) =>
    `💼 Caution : <b>${fr.money(bal)}</b>\n🔒 Bloquée sur des courses cash : ${fr.money(res)}\n\n` +
    'Pour recharger : <code>/topup 10000</code>',
  topupSent: (amount: number, ussd?: string) => `📲 Validez le paiement de ${fr.money(amount)} sur votre téléphone${ussd ? ` (${esc(ussd)})` : ''}.`,
  topupConfirmed: (amount: number, bal: number) => `✅ Caution rechargée de ${fr.money(amount)}. Solde : ${fr.money(bal)}`,
  noJobs: 'Aucune course en cours.',

  offer: (o: { item: string; pickup: string; earn: number; dist?: number; cod?: number; leg: 'FIRST' | 'LAST'; city?: string }) =>
    `🆕 <b>Nouvelle course</b>${o.leg === 'LAST' ? ` (livraison finale, ${esc(o.city)})` : ''}\n📦 ${esc(o.item)}\n📍 ${esc(o.pickup)}` +
    (o.dist !== undefined ? ` · ${o.dist} km` : '') +
    `\n💵 Vous gagnez : <b>${fr.money(o.earn)}</b>` +
    (o.cod ? `\n💳 Cash à encaisser : ${fr.money(o.cod)} (caution bloquée : ${fr.money(o.cod)})` : ''),
  btnAccept: '✅ Accepter',
  jobTaken: '❌ Course déjà prise par un autre livreur.',
  jobCard: (o: { code: string; status: string; item: string; pickup: string; merchant: string; merchantPhone: string; buyerPhone?: string; dropoff?: string; landmark?: string; collect?: number; agency?: string; dest?: string; waybill?: string }) =>
    `🏍️ <b>Course ${esc(o.code)}</b> — ${o.status}\n📦 ${esc(o.item)}\n🏪 ${esc(o.merchant)} · ${esc(o.merchantPhone)}\n📍 Ramassage : ${esc(o.pickup)}` +
    (o.agency ? `\n🚌 Agence : ${esc(o.agency)} → ${esc(o.dest)}` : '') +
    (o.waybill ? `\n🧾 Bordereau : ${esc(o.waybill)}` : '') +
    (o.buyerPhone ? `\n👤 Client : ${esc(o.buyerPhone)}` : '') +
    (o.dropoff ? `\n🏠 Livraison : ${esc(o.dropoff)}` : '') +
    (o.landmark ? `\n🧭 Repère : ${esc(o.landmark)}` : '') +
    (o.collect ? `\n💵 À encaisser en cash : <b>${fr.money(o.collect)}</b>` : ''),
  btnRelease: '↩️ Rendre la course',
  btnPickedUp: '📦 Colis récupéré',
  btnAgencyDrop: '🚌 Déposé à l’agence',
  btnDeliver: '🔑 Saisir le code client',
  btnProblem: '⚠️ Signaler un problème',
  btnMapsPickup: '🗺️ Itinéraire ramassage',
  btnMapsDropoff: '🗺️ Itinéraire client',
  askWaybillNumber: '🧾 Numéro du bordereau d’expédition ?',
  askWaybillPhoto: '📸 Photo nette du bordereau :',
  askCode: '🔑 Demandez au client d’inspecter le colis, puis tapez le code à 4 chiffres qu’il vous donne :',
  codeWrong: (left: number) => `❌ Code incorrect. ${left} essai(s) restant(s).`,
  codeLocked: '⛔ Trop d’essais. La commande est bloquée et un responsable va intervenir.',
  delivered: '🎉 Livraison confirmée ! Vos gains sont envoyés sur votre Mobile Money.',
  askProblem: '⚠️ Décrivez le problème (client absent, colis refusé, colis endommagé…) :',
  problemSent: '✅ Problème signalé. Un responsable va vous contacter.',
  voiceNoteCaption: '🎙️ Indications vocales du client',

  mPaid: (code: string, item: string, total: number) => `💳 <b>Paiement reçu</b> pour ${esc(item)} (${fr.money(total)}) — <code>${esc(code)}</code>.\nL’argent est en séquestre. Nous cherchons un livreur.`,
  mStatus: (code: string, status: string) => `📦 <code>${esc(code)}</code> : ${status}`,
  mRider: (code: string, name: string, phone: string) => `🏍️ <code>${esc(code)}</code> : le livreur <b>${esc(name)}</b> (${esc(phone)}) arrive.`,
  mSettled: (code: string, amount: number) => `💰 <code>${esc(code)}</code> : ${fr.money(amount)} envoyés sur votre Mobile Money.`,
  mNoRiders: (code: string) => `⏳ <code>${esc(code)}</code> : aucun livreur disponible pour l’instant. Nous réessayons automatiquement.`,
  mDisputed: (code: string, reason: string) => `⚠️ <code>${esc(code)}</code> : litige ouvert (« ${esc(reason)} »). L’argent reste bloqué jusqu’à décision.`,
  leaderboard: (rows: string) => `🏆 <b>Meilleurs livreurs</b>\n\n${rows || '—'}`,
  help:
    '<b>Commandes</b>\n/menu — menu principal\n/orders — mes commandes\n/kyc — badge vérifié\n/lang — langue\n/cancel — annuler l’opération\n\n' +
    '<b>Livreurs</b>\n/register_rider · /on_duty · /off_duty · /jobs · /float · /topup'
};

type Strings = typeof fr;

const en: Strings = {
  status: (s) => STATUS.en[s],
  money: (n) => formatFcfa(n, 'en'),

  welcomeNew:
    '👋 <b>Welcome to BayamSafe</b> 🇨🇲\n\nSecure payments (MoMo / Orange Money) + moto and inter-city delivery.\n\n' +
    'Tap the button below to link your Mobile Money number. This is where you will be paid.',
  shareContactBtn: '📱 Share my number',
  shareOwnContact: '⚠️ Use the “Share my number” button to send <b>your own</b> contact.',
  registered: (name, phone) => `🎉 Account created: <b>${esc(name)}</b>\n📱 Payouts to: <code>${esc(phone)}</code>`,
  menuTitle: (name, verified) => `Hello <b>${esc(name)}</b>${verified ? ' 🏅' : ''}. What would you like to do?`,
  btnNewIntra: '🏍️ New sale (same city)',
  btnNewInter: '🚌 New sale (other city)',
  btnMyOrders: '📦 My orders',
  btnKyc: '🏅 Verified seller badge',
  btnRider: '🛵 Rider area',
  btnLeaderboard: '🏆 Rider leaderboard',
  btnLang: '🌐 Français',
  langSet: '✅ Language: English',
  cancelled: 'Cancelled.',
  notRegistered: 'Send /start to create your account first.',
  genericError: '❌ Something went wrong. Please try again.',

  askTitle: '📝 Item name? (e.g. Wax dress size M)\n\n<i>/cancel to stop</i>',
  askPrice: '💰 Item price in FCFA? (e.g. 15000)',
  askDeliveryFee: '🛵 Delivery fee in FCFA paid by the buyer? (0 if free)',
  askAgency: '🚌 Which agency will the parcel leave from?',
  askDestination: '🏁 Destination city?',
  askAgencyFee: '🧾 Agency shipping fee in FCFA (paid at the counter by the rider, reimbursed on delivery)?',
  askBuyerPhone: '📱 Buyer phone number (e.g. 671234567)?',
  askPickup: '📍 Pickup address (neighbourhood, landmark).\nYou can also share your location first 📎 → Location.',
  pickupLocationSaved: '📍 Location saved. Now describe the address in a few words (neighbourhood, landmark).',
  askPaymentMode: '💳 How will the buyer pay?',
  btnEscrow: '🔒 MoMo/OM escrow (recommended)',
  btnCod: '💵 Cash on delivery',
  invalidNumber: '⚠️ Enter an amount in digits, e.g. 15000',
  summary: (d) =>
    `<b>Summary</b>\n📦 ${esc(d.title)}\n💰 Item: ${en.money(d.price)}\n🛵 Delivery: ${en.money(d.fee)}` +
    (d.agencyFee ? `\n🧾 Agency: ${en.money(d.agencyFee)}` : '') +
    `\n<b>Buyer total: ${en.money(d.total)}</b>\n📱 Buyer: ${esc(d.buyer)}\n💳 ${esc(d.mode)}` +
    (d.route ? `\n🚌 ${esc(d.route)}` : ''),
  btnConfirm: '✅ Create order',
  btnAbort: '✖️ Cancel',
  orderCreated: (code, url, cod) =>
    `✅ <b>Order created</b> — <code>${esc(code)}</code>\n\n` +
    (cod
      ? 'Cash on delivery. We are finding a rider. Send this link to the buyer so they can drop their GPS pin:\n'
      : 'Send this private link to the buyer to pay into escrow and drop their GPS pin:\n') +
    `${esc(url)}\n\n<i>Only share this link with the buyer.</i>`,
  whatsappPitch: (item, total, url) =>
    `Hello! Here is the BayamSafe secure payment link for "${item}" (${en.money(total)}). ` +
    `Your money stays locked until you check the parcel in front of the rider: ${url}`,
  btnShareWhatsapp: '📲 Send on WhatsApp',

  noOrders: 'No orders yet.',
  orderLine: (code, title, status) => `<code>${esc(code)}</code> · ${esc(title)}\n   ${status}`,
  btnCancelOrder: '✖️ Cancel order',
  btnArrived: '🏁 Bus has arrived',
  orderCancelledMsg: (code) => `✖️ Order ${esc(code)} cancelled.`,

  kycIntro: '🏅 <b>Verified seller badge</b>\nWe check your ID before showing the badge to your buyers.\n\nEnter your national ID (CNI) number:',
  kycAskPhoto: '📸 Now send a clear photo of the front of your ID card.',
  kycSubmitted: '✅ Thanks! Your request is being reviewed. We will notify you.',
  kycAlready: (s) => `Your badge status: <b>${esc(s)}</b>`,
  kycApproved: '🏅 Your verified seller badge is active!',
  kycRejected: '❌ Your badge request was declined. Please contact support.',

  riderMenu: (status, onDuty, float, reserved) =>
    status
      ? `🛵 <b>Rider area</b>\nStatus: <b>${esc(status)}</b>${onDuty ? ' · 🟢 On duty' : ' · 🔴 Off duty'}\n` +
        `💼 Float: ${en.money(float ?? 0)} (locked: ${en.money(reserved ?? 0)})\n\n` +
        '/on_duty · /off_duty · /jobs · /float\nShare your live location (📎 → Location → live) to get nearby jobs.'
      : '🛵 Not a rider yet? Send /register_rider.',
  riderAskCni: '🪪 Rider sign-up. National ID (CNI) number?',
  riderAskPlate: '🏍️ Plate number?',
  riderAskCity: '🏙️ Your city?',
  riderApplied: '✅ Application sent. Someone will contact you to check your documents.',
  riderApproved: '✅ Your rider account is approved! Send /on_duty then share your live location.',
  riderSuspended: '⛔ Your rider account is suspended. Please contact support.',
  onDuty: '🟢 On duty. Share your live location to receive nearby jobs.',
  offDuty: '🔴 Off duty.',
  floatInfo: (bal, res) => `💼 Float: <b>${en.money(bal)}</b>\n🔒 Locked on cash jobs: ${en.money(res)}\n\nTo top up: <code>/topup 10000</code>`,
  topupSent: (amount, ussd) => `📲 Approve the ${en.money(amount)} payment on your phone${ussd ? ` (${esc(ussd)})` : ''}.`,
  topupConfirmed: (amount, bal) => `✅ Float topped up by ${en.money(amount)}. Balance: ${en.money(bal)}`,
  noJobs: 'No active jobs.',

  offer: (o) =>
    `🆕 <b>New job</b>${o.leg === 'LAST' ? ` (final delivery, ${esc(o.city)})` : ''}\n📦 ${esc(o.item)}\n📍 ${esc(o.pickup)}` +
    (o.dist !== undefined ? ` · ${o.dist} km` : '') +
    `\n💵 You earn: <b>${en.money(o.earn)}</b>` +
    (o.cod ? `\n💳 Cash to collect: ${en.money(o.cod)} (float locked: ${en.money(o.cod)})` : ''),
  btnAccept: '✅ Accept',
  jobTaken: '❌ Another rider already took this job.',
  jobCard: (o) =>
    `🏍️ <b>Job ${esc(o.code)}</b> — ${o.status}\n📦 ${esc(o.item)}\n🏪 ${esc(o.merchant)} · ${esc(o.merchantPhone)}\n📍 Pickup: ${esc(o.pickup)}` +
    (o.agency ? `\n🚌 Agency: ${esc(o.agency)} → ${esc(o.dest)}` : '') +
    (o.waybill ? `\n🧾 Waybill: ${esc(o.waybill)}` : '') +
    (o.buyerPhone ? `\n👤 Buyer: ${esc(o.buyerPhone)}` : '') +
    (o.dropoff ? `\n🏠 Drop-off: ${esc(o.dropoff)}` : '') +
    (o.landmark ? `\n🧭 Landmark: ${esc(o.landmark)}` : '') +
    (o.collect ? `\n💵 Collect in cash: <b>${en.money(o.collect)}</b>` : ''),
  btnRelease: '↩️ Give job back',
  btnPickedUp: '📦 Picked up',
  btnAgencyDrop: '🚌 Dropped at agency',
  btnDeliver: '🔑 Enter buyer code',
  btnProblem: '⚠️ Report a problem',
  btnMapsPickup: '🗺️ Route to pickup',
  btnMapsDropoff: '🗺️ Route to buyer',
  askWaybillNumber: '🧾 Waybill number?',
  askWaybillPhoto: '📸 Clear photo of the waybill:',
  askCode: '🔑 Let the buyer inspect the parcel, then type the 4-digit code they give you:',
  codeWrong: (left) => `❌ Wrong code. ${left} attempt(s) left.`,
  codeLocked: '⛔ Too many attempts. The order is frozen and an admin will step in.',
  delivered: '🎉 Delivery confirmed! Your earnings are being sent to your Mobile Money.',
  askProblem: '⚠️ Describe the problem (buyer absent, parcel refused, damaged…):',
  problemSent: '✅ Problem reported. An admin will contact you.',
  voiceNoteCaption: '🎙️ Buyer voice directions',

  mPaid: (code, item, total) => `💳 <b>Payment received</b> for ${esc(item)} (${en.money(total)}) — <code>${esc(code)}</code>.\nThe money is in escrow. Finding a rider now.`,
  mStatus: (code, status) => `📦 <code>${esc(code)}</code>: ${status}`,
  mRider: (code, name, phone) => `🏍️ <code>${esc(code)}</code>: rider <b>${esc(name)}</b> (${esc(phone)}) is on the way.`,
  mSettled: (code, amount) => `💰 <code>${esc(code)}</code>: ${en.money(amount)} sent to your Mobile Money.`,
  mNoRiders: (code) => `⏳ <code>${esc(code)}</code>: no rider available right now. We retry automatically.`,
  mDisputed: (code, reason) => `⚠️ <code>${esc(code)}</code>: dispute opened (“${esc(reason)}”). Funds stay locked until a decision.`,
  leaderboard: (rows) => `🏆 <b>Top riders</b>\n\n${rows || '—'}`,
  help:
    '<b>Commands</b>\n/menu — main menu\n/orders — my orders\n/kyc — verified badge\n/lang — language\n/cancel — stop current step\n\n' +
    '<b>Riders</b>\n/register_rider · /on_duty · /off_duty · /jobs · /float · /topup'
};

const dictionaries: Record<Lang, Strings> = { fr, en };

export function t(lang: Lang = 'fr'): Strings {
  return dictionaries[lang] ?? fr;
}
