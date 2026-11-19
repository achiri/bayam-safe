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
  btnKyc: '🏪 Mon profil vendeur',
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

  // ---- sign-up (merchant & rider)
  progress: (n: number, total: number) => `<b>Étape ${n}/${total}</b>  ${'▰'.repeat(n)}${'▱'.repeat(total - n)}`,
  mIntro:
    '🏪 <b>Profil vendeur</b> : 8 étapes, environ 3 minutes.\n' +
    'Vos documents ne sont vus que par l’équipe de vérification BayamSafe. Vous pouvez vous arrêter à tout moment (/cancel) : on reprendra exactement où vous en étiez.',
  rIntro:
    '🛵 <b>Devenir livreur BayamSafe</b> : 9 étapes, environ 3 minutes.\n' +
    'Ayez votre CNI et votre moto à portée de main. Vous pouvez vous arrêter à tout moment (/cancel) : on reprendra où vous en étiez.',
  resume: '👋 On reprend où vous vous étiez arrêté :',
  ask_shopName: '🏪 Nom de votre boutique, celui que vos clients connaissent ?',
  ask_city: '🏙️ Dans quelle ville se trouve votre boutique ?',
  ask_selfie: '🤳 Un <b>selfie</b> : visage bien éclairé, sans lunettes de soleil ni casquette.\n📎 → Caméra',
  ask_cniFront: '🪪 Photo du <b>recto</b> de votre CNI (ou passeport) : posée à plat, les 4 coins visibles, sans reflet.',
  ask_cniBack: '🪪 Maintenant le <b>verso</b> de la carte.',
  ask_cniNumber: '🔢 Numéro de la CNI, tel qu’il est écrit sur la carte ?',
  ask_shopPhoto: '🏬 Une photo de votre <b>boutique ou de votre stock</b> : devanture, étal, ou l’endroit où vous préparez les colis.',
  ask_shopLocation:
    '📍 <b>Position exacte de la boutique.</b>\n' +
    '• Sur le téléphone, à la boutique : appuyez sur le bouton ci-dessous.\n' +
    '• Ailleurs : 📎 → Position, puis déplacez l’épingle sur la boutique.\n' +
    '• Sur ordinateur : collez un lien Google Maps de la boutique, ou ses coordonnées (ex : <code>4.0511, 9.7085</code>).',
  btnSendLocation: '📍 Envoyer ma position actuelle',
  badLocation: (lat: number, lng: number) =>
    `⚠️ La position reçue (<code>${lat.toFixed(4)}, ${lng.toFixed(4)}</code>) est hors du Cameroun.\n` +
    'Envoyez la position de la boutique : 📎 → Position et déplacez l’épingle, ou collez un lien Google Maps, ou des coordonnées comme <code>4.0511, 9.7085</code>.',
  ask_legalName: '🪪 Vos <b>prénom et nom</b>, exactement comme sur votre CNI ?',
  btnUseName: (n: string) => `Utiliser « ${n} »`,
  ask_vehicleType: '🏍️ Avec quoi livrez-vous ?',
  btnMoto: '🏍️ Moto',
  btnCar: '🚗 Voiture',
  btnVan: '🚐 Camionnette',
  ask_plate: '🔢 Numéro d’immatriculation ? (ex : LT 123 AB)',
  ask_vehiclePhoto: '📸 Photo de votre véhicule, <b>plaque bien lisible</b>.',
  ask_riderCity: '🏙️ Dans quelle ville livrez-vous ?',
  needPhoto: '📸 Pour cette étape, envoyez une photo (📎 → Caméra ou Galerie).',
  needLocation: '📍 Pour cette étape, envoyez une position (bouton ci-dessous, ou 📎 → Position), ou collez un lien Google Maps / des coordonnées comme <code>4.0511, 9.7085</code>.',
  needText: '✍️ Pour cette étape, répondez par un message texte.',
  badShopName: '⚠️ Nom trop court.',
  badName: '⚠️ Entrez prénom ET nom, comme sur la CNI.',
  badPlate: '⚠️ Plaque invalide. Exemple : LT 123 AB',
  badId: '⚠️ Numéro invalide : 6 à 20 chiffres ou lettres.',
  reviewMerchant: (d: { shop: string; city: string; cni: string }) =>
    `<b>Vérifiez avant d’envoyer</b>\n🏪 ${esc(d.shop)} · ${esc(d.city)}\n🔢 CNI ${esc(d.cni)}\n✅ Selfie · ✅ CNI recto et verso · ✅ Photo boutique · ✅ Position GPS`,
  reviewRider: (d: { name: string; city: string; cni: string; vehicle: string; plate: string }) =>
    `<b>Vérifiez avant d’envoyer</b>\n👤 ${esc(d.name)} · ${esc(d.city)}\n🔢 CNI ${esc(d.cni)}\n${esc(d.vehicle)} · ${esc(d.plate)}\n✅ Selfie · ✅ CNI recto et verso · ✅ Photo véhicule`,
  btnSubmit: '✅ Envoyer pour vérification',
  btnRestart: '🔁 Recommencer',
  mSubmitted:
    '✅ <b>Profil envoyé !</b>\nVous pouvez déjà créer des ventes. Le badge 🏅 Vendeur vérifié apparaîtra sur vos liens dès que notre équipe aura vérifié vos documents.',
  rSubmitted: '✅ <b>Candidature envoyée !</b>\nNotre équipe compare votre selfie et votre CNI. Vous recevrez ici votre numéro de livreur dès l’approbation.',
  onboardingPaused: '⏸️ Inscription en pause. Envoyez /start pour reprendre.',
  mustCompleteProfile: '🏪 Avant votre première vente, complétez votre profil vendeur (3 minutes). C’est ce qui rassure vos clients.',
  btnCompleteProfile: '🏪 Compléter mon profil vendeur',
  profileStatus: (status: string, note?: string) =>
    ({
      NONE: '🏪 Profil vendeur : <b>à compléter</b>.',
      PENDING: '⏳ Profil vendeur : <b>en cours de vérification</b>. Vous pouvez déjà vendre.',
      VERIFIED: '🏅 Profil vendeur : <b>vérifié</b>. Le badge est visible sur vos liens.',
      REJECTED: `❌ Profil vendeur : <b>refusé</b>${note ? ` (${esc(note)})` : ''}. Corrigez et renvoyez-le.`
    })[status] ?? status,
  kycApproved: '🏅 <b>Félicitations, vous êtes vendeur vérifié !</b>\nVos clients voient maintenant le badge sur chaque lien de paiement.',
  kycRejected: (note: string) => `❌ <b>Profil vendeur refusé</b>\nMotif : ${esc(note)}\n\nEnvoyez /start pour corriger et renvoyer vos documents.`,

  riderMenu: (status?: string, onDuty?: boolean, float?: number, reserved?: number, code?: string) =>
    status
      ? `🛵 <b>Espace livreur</b>${code ? ` · <code>${esc(code)}</code>` : ''}\nStatut : <b>${esc(status)}</b>${onDuty ? ' · 🟢 En service' : ' · 🔴 Hors service'}\n` +
        `💼 Caution : ${fr.money(float ?? 0)} (bloqué : ${fr.money(reserved ?? 0)})\n\n` +
        '/on_duty · /off_duty · /jobs · /float\nPartagez votre position en direct (📎 → Position → en direct) pour recevoir les courses proches.'
      : '🛵 Pas encore livreur ? Inscrivez-vous en 3 minutes.',
  btnBecomeRider: '🛵 Devenir livreur',
  riderApproved: (code: string) =>
    `✅ <b>Bienvenue chez les livreurs BayamSafe !</b>\nVotre numéro : <code>${esc(code)}</code>. Les clients peuvent le vérifier avec /verify.\n\nEnvoyez /on_duty puis partagez votre position en direct pour recevoir des courses.`,
  riderRejected: (note: string) => `❌ <b>Candidature refusée</b>\nMotif : ${esc(note)}\n\nEnvoyez /start pour corriger et renvoyer.`,
  riderSuspended: (note: string) => `⛔ Votre compte livreur est suspendu. Motif : ${esc(note)}`,
  verifyUsage: 'Envoyez /verify suivi du numéro inscrit sur le badge, par exemple : <code>/verify BSR-7K4Q</code>',
  verifyOk: (c: { name: string; plate: string; city?: string; n: number; code: string }) =>
    `✅ <b>Livreur vérifié BayamSafe</b>\n${esc(c.name)} · ${esc(c.plate)}\n${esc(c.city ?? '')} · ${c.n} livraison(s)\nNuméro : <code>${esc(c.code)}</code>\n\nComparez le visage sur la photo avec la personne devant vous.`,
  verifyBad: (code: string) => `❌ Le numéro <code>${esc(code)}</code> ne correspond à aucun livreur vérifié. Ne remettez ni colis ni argent.`,
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
    '<b>Commandes</b>\n/menu — menu principal\n/orders — mes commandes\n/profile — mon profil vendeur\n/verify — vérifier un livreur\n/lang — langue\n/cancel — mettre en pause\n\n' +
    '<b>Livreurs</b>\n/rider · /on_duty · /off_duty · /jobs · /float · /topup'
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
  btnKyc: '🏪 My seller profile',
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

  progress: (n, total) => `<b>Step ${n}/${total}</b>  ${'▰'.repeat(n)}${'▱'.repeat(total - n)}`,
  mIntro:
    '🏪 <b>Seller profile</b>: 8 steps, about 3 minutes.\n' +
    'Your documents are only seen by the BayamSafe verification team. You can stop at any time (/cancel): we’ll pick up exactly where you left off.',
  rIntro:
    '🛵 <b>Become a BayamSafe rider</b>: 9 steps, about 3 minutes.\n' +
    'Have your ID card and vehicle at hand. You can stop at any time (/cancel): we’ll pick up where you left off.',
  resume: '👋 Picking up where you left off:',
  ask_shopName: '🏪 Your shop’s name, the one your buyers know?',
  ask_city: '🏙️ Which city is your shop in?',
  ask_selfie: '🤳 A <b>selfie</b>: face well lit, no sunglasses or cap.\n📎 → Camera',
  ask_cniFront: '🪪 Photo of the <b>front</b> of your ID card (or passport): flat, all 4 corners visible, no glare.',
  ask_cniBack: '🪪 Now the <b>back</b> of the card.',
  ask_cniNumber: '🔢 ID card number, as written on the card?',
  ask_shopPhoto: '🏬 A photo of your <b>shop or stock</b>: shopfront, stall, or where you pack parcels.',
  ask_shopLocation:
    '📍 <b>Exact shop location.</b>\n' +
    '• On your phone, at the shop: tap the button below.\n' +
    '• Elsewhere: 📎 → Location, then drag the pin onto the shop.\n' +
    '• On a computer: paste a Google Maps link to the shop, or its coordinates (e.g. <code>4.0511, 9.7085</code>).',
  btnSendLocation: '📍 Send my current location',
  badLocation: (lat, lng) =>
    `⚠️ The location received (<code>${lat.toFixed(4)}, ${lng.toFixed(4)}</code>) is outside Cameroon.\n` +
    'Send the shop’s location: 📎 → Location and drag the pin, or paste a Google Maps link, or coordinates like <code>4.0511, 9.7085</code>.',
  ask_legalName: '🪪 Your <b>first and last name</b>, exactly as on your ID card?',
  btnUseName: (n) => `Use “${n}”`,
  ask_vehicleType: '🏍️ What do you deliver with?',
  btnMoto: '🏍️ Motorbike',
  btnCar: '🚗 Car',
  btnVan: '🚐 Van',
  ask_plate: '🔢 Plate number? (e.g. LT 123 AB)',
  ask_vehiclePhoto: '📸 Photo of your vehicle with the <b>plate clearly readable</b>.',
  ask_riderCity: '🏙️ Which city do you deliver in?',
  needPhoto: '📸 For this step, send a photo (📎 → Camera or Gallery).',
  needLocation: '📍 For this step, send a location (button below, or 📎 → Location), or paste a Google Maps link / coordinates like <code>4.0511, 9.7085</code>.',
  needText: '✍️ For this step, reply with a text message.',
  badShopName: '⚠️ Name too short.',
  badName: '⚠️ Enter first AND last name, as on the ID card.',
  badPlate: '⚠️ Invalid plate. Example: LT 123 AB',
  badId: '⚠️ Invalid number: 6 to 20 digits or letters.',
  reviewMerchant: (d) =>
    `<b>Check before sending</b>\n🏪 ${esc(d.shop)} · ${esc(d.city)}\n🔢 ID ${esc(d.cni)}\n✅ Selfie · ✅ ID front and back · ✅ Shop photo · ✅ GPS location`,
  reviewRider: (d) =>
    `<b>Check before sending</b>\n👤 ${esc(d.name)} · ${esc(d.city)}\n🔢 ID ${esc(d.cni)}\n${esc(d.vehicle)} · ${esc(d.plate)}\n✅ Selfie · ✅ ID front and back · ✅ Vehicle photo`,
  btnSubmit: '✅ Send for verification',
  btnRestart: '🔁 Start over',
  mSubmitted: '✅ <b>Profile sent!</b>\nYou can already create sales. The 🏅 Verified seller badge will appear on your links once our team has checked your documents.',
  rSubmitted: '✅ <b>Application sent!</b>\nOur team compares your selfie and ID. You will get your rider number here once approved.',
  onboardingPaused: '⏸️ Sign-up paused. Send /start to continue.',
  mustCompleteProfile: '🏪 Before your first sale, complete your seller profile (3 minutes). It’s what reassures your buyers.',
  btnCompleteProfile: '🏪 Complete my seller profile',
  profileStatus: (status, note) =>
    ({
      NONE: '🏪 Seller profile: <b>to complete</b>.',
      PENDING: '⏳ Seller profile: <b>being verified</b>. You can already sell.',
      VERIFIED: '🏅 Seller profile: <b>verified</b>. The badge shows on your links.',
      REJECTED: `❌ Seller profile: <b>refused</b>${note ? ` (${esc(note)})` : ''}. Fix it and resubmit.`
    })[status] ?? status,
  kycApproved: '🏅 <b>Congratulations, you are a verified seller!</b>\nBuyers now see the badge on every payment link.',
  kycRejected: (note) => `❌ <b>Seller profile refused</b>\nReason: ${esc(note)}\n\nSend /start to fix and resubmit your documents.`,

  riderMenu: (status, onDuty, float, reserved, code) =>
    status
      ? `🛵 <b>Rider area</b>${code ? ` · <code>${esc(code)}</code>` : ''}\nStatus: <b>${esc(status)}</b>${onDuty ? ' · 🟢 On duty' : ' · 🔴 Off duty'}\n` +
        `💼 Float: ${en.money(float ?? 0)} (locked: ${en.money(reserved ?? 0)})\n\n` +
        '/on_duty · /off_duty · /jobs · /float\nShare your live location (📎 → Location → live) to get nearby jobs.'
      : '🛵 Not a rider yet? Sign up in 3 minutes.',
  btnBecomeRider: '🛵 Become a rider',
  riderApproved: (code) =>
    `✅ <b>Welcome to BayamSafe riders!</b>\nYour number: <code>${esc(code)}</code>. Buyers can check it with /verify.\n\nSend /on_duty then share your live location to receive jobs.`,
  riderRejected: (note) => `❌ <b>Application refused</b>\nReason: ${esc(note)}\n\nSend /start to fix and resubmit.`,
  riderSuspended: (note) => `⛔ Your rider account is suspended. Reason: ${esc(note)}`,
  verifyUsage: 'Send /verify followed by the number on the badge, for example: <code>/verify BSR-7K4Q</code>',
  verifyOk: (c) =>
    `✅ <b>Verified BayamSafe rider</b>\n${esc(c.name)} · ${esc(c.plate)}\n${esc(c.city ?? '')} · ${c.n} deliver${c.n === 1 ? 'y' : 'ies'}\nNumber: <code>${esc(c.code)}</code>\n\nCompare the face in the photo with the person in front of you.`,
  verifyBad: (code) => `❌ Number <code>${esc(code)}</code> does not match any verified rider. Don’t hand over a parcel or money.`,
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
    '<b>Commands</b>\n/menu — main menu\n/orders — my orders\n/profile — my seller profile\n/verify — check a rider\n/lang — language\n/cancel — pause current step\n\n' +
    '<b>Riders</b>\n/rider · /on_duty · /off_duty · /jobs · /float · /topup'
};

const dictionaries: Record<Lang, Strings> = { fr, en };

export function t(lang: Lang = 'fr'): Strings {
  return dictionaries[lang] ?? fr;
}
