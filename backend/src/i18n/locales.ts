import { SupportedLanguage } from '../domain/types.js';

export const messages = {
  fr: {
    welcome_title: "🤝 BayamSafe - Séquestre & Micro-Logistique (Cameroun 🇨🇲)",
    welcome_body: "La plateforme unifiée pour le commerce social et la livraison :\n\n" +
      "1. 🔒 *Séquestre MoMo / Orange Money* : Zéro arnaque vendeur/acheteur.\n" +
      "2. 🏍️ *Livraison Moto Intra-Ville* : Douala, Yaoundé avec suivi en direct.\n" +
      "3. 🚌 *Expédition Inter-Villes (Agences)* : Dépôt sécurisé chez Moghamo, Guarantee, Buca avec photo du bordereau.",
    
    btn_new_intra_order: "🏍️ Livraison Intra-Ville (Moto Direct)",
    btn_new_agency_order: "🚌 Expédition Inter-Villes (Agences Bus)",
    btn_my_orders: "📦 Mes Expéditions",
    btn_rider_mode: "🛵 Espace Livreur Moto",
    btn_change_lang: "🌐 English",
    
    rider_on_duty: "🟢 Vous êtes maintenant EN SERVICE (/off_duty pour arrêter). Vous recevrez les courses à proximité.",
    rider_off_duty: "🔴 Vous êtes HORS SERVICE. Aucune course ne vous sera envoyée.",

    agency_select_prompt: "🚌 Choisissez votre agence de voyage partenaire pour le transport :",
    agency_waybill_prompt: "📸 Livreur: Prenez une photo nette du reçu/bordereau d'expédition de l'agence :",
    agency_waybill_success: (agency: string, num: string) => `✅ Colis enregistré chez *${agency}* ! N° Bordereau: \`${num}\``,

    order_created_summary: (code: string, type: string, item: string, total: number, fee: number) =>
      `📦 Expédition: *${item}* (${type})\n` +
      `💳 Montant Total: *${total.toLocaleString('fr-FR')} FCFA*\n` +
      `🛡️ Commission Séquestre: *${fee.toLocaleString('fr-FR')} FCFA*\n` +
      `🔖 Code Suivi: \`${code}\`\n\n` +
      `👉 Partagez ce lien avec le client sur WhatsApp / TikTok :`,

    funds_locked_buyer: (item: string, code: string, releaseCode: string) =>
      `🔒 *Paiement Sécurisé en Escrow !*\n\n` +
      `Votre paiement pour *${item}* est bloqué en toute sécurité.\n\n` +
      `🔑 *Votre Code Secret de Libération :* \`${releaseCode}\`\n\n` +
      `⚠️ Ne donnez ce code au livreur qu'après avoir inspecté le colis !`,

    delivery_settled: (merchant: number, rider: number) =>
      `🎉 *Course Terminée & Fonds Débloqués !*\n\n` +
      `- Vendeur crédité: *${merchant.toLocaleString('fr-FR')} FCFA*\n` +
      `- Livreur crédité: *${rider.toLocaleString('fr-FR')} FCFA*`
  },
  en: {
    welcome_title: "🤝 BayamSafe - Escrow & Micro-Logistics (Cameroon 🇨🇲)",
    welcome_body: "The unified social commerce escrow and dispatch platform:\n\n" +
      "1. 🔒 *MoMo & Orange Money Escrow*: Zero-scam buyer/seller guarantee.\n" +
      "2. 🏍️ *Intra-City Moto Courier*: Douala, Yaoundé on-demand with live tracking.\n" +
      "3. 🚌 *Inter-City Bus Agency Concierge*: Drop-off at Moghamo, Guarantee, Buca with waybill receipt photo.",

    btn_new_intra_order: "🏍️ Intra-City Direct (Moto)",
    btn_new_agency_order: "🚌 Inter-City Agency (Bus Line)",
    btn_my_orders: "📦 My Orders",
    btn_rider_mode: "🛵 Rider Portal",
    btn_change_lang: "🌐 Français",

    rider_on_duty: "🟢 You are now ON DUTY (/off_duty to pause). You will receive nearby delivery gigs.",
    rider_off_duty: "🔴 You are OFF DUTY. You will not receive delivery gigs.",

    agency_select_prompt: "🚌 Select your partner travel agency for inter-city transit:",
    agency_waybill_prompt: "📸 Rider: Take a clear photo of the agency waybill receipt:",
    agency_waybill_success: (agency: string, num: string) => `✅ Parcel dropped at *${agency}*! Waybill: \`${num}\``,

    order_created_summary: (code: string, type: string, item: string, total: number, fee: number) =>
      `📦 Shipment: *${item}* (${type})\n` +
      `💳 Total Amount: *${total.toLocaleString('en-US')} FCFA*\n` +
      `🛡️ Escrow Fee: *${fee.toLocaleString('en-US')} FCFA*\n` +
      `🔖 Tracking Code: \`${code}\`\n\n` +
      `👉 Share this link with your buyer on WhatsApp / TikTok:`,

    funds_locked_buyer: (item: string, code: string, releaseCode: string) =>
      `🔒 *Payment Locked in Escrow!*\n\n` +
      `Your payment for *${item}* is safely secured in escrow.\n\n` +
      `🔑 *Your Secret 4-Digit Release Code:* \`${releaseCode}\`\n\n` +
      `⚠️ Never share this code with the rider until you inspect the parcel!`,

    delivery_settled: (merchant: number, rider: number) =>
      `🎉 *Delivery Completed & Funds Settled!*\n\n` +
      `- Merchant credited: *${merchant.toLocaleString('en-US')} FCFA*\n` +
      `- Rider credited: *${rider.toLocaleString('en-US')} FCFA*`
  }
};

export function t(lang: SupportedLanguage = 'fr') {
  return messages[lang] || messages['fr'];
}
