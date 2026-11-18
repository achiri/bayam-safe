import { SupportedLanguage } from '../domain/types.js';

export const messages = {
  fr: {
    welcome_title: "🤝 Bienvenue sur Bayam-Sellam Escrow (Cameroun)",
    welcome_body: "Achetez et vendez en toute sécurité sur TikTok, WhatsApp & Instagram avec MTN MoMo et Orange Money.\n\nFini les arnaques et les courses de moto payées pour rien !",
    btn_seller_new_order: "➕ Créer un lien Escrow (Vendeur)",
    btn_my_orders: "📦 Mes Transactions",
    btn_rider_mode: "🏍️ Mode Livreur Moto",
    btn_change_lang: "🌐 English",
    
    // Order creation
    create_step_title: "📝 Quel est le nom de l'article ?",
    create_step_price: "💰 Quel est le prix de l'article (en FCFA) ?",
    create_step_delivery: "🛵 Frais de livraison moto (en FCFA) ? (Mettez 0 si gratuit)",
    create_step_phone: "📱 Numéro WhatsApp / Téléphone de l'acheteur (ex: 670000000) :",
    order_created_title: "✅ Lien Escrow Sécurisé Généré !",
    order_created_summary: (code: string, item: string, total: number, fee: number) =>
      `📦 Article: *${item}*\n` +
      `💳 Montant Total Sécurisé: *${total.toLocaleString('fr-FR')} FCFA*\n` +
      `🛡️ Commission de confiance (2.5%): *${fee.toLocaleString('fr-FR')} FCFA*\n` +
      `🔖 Référence: \`${code}\`\n\n` +
      `👉 Partagez ce lien à votre acheteur sur WhatsApp / TikTok / Instagram :`,

    // Buyer notifications
    funds_locked_buyer: (item: string, code: string, releaseCode: string) =>
      `🔒 *Paiement Sécurisé en Escrow !*\n\n` +
      `Votre paiement pour *${item}* est bloqué en sécurité.\n` +
      `Le vendeur ne touchera PAS l'argent tant que vous n'aurez pas reçu et inspecté le colis.\n\n` +
      `🔑 *Votre Code Secret de Libération :* \`${releaseCode}\`\n\n` +
      `⚠️ *ATTENTION* : Ne donnez JAMAIS ce code au livreur tant que vous n'avez pas ouvert et vérifié le colis devant lui !`,

    funds_locked_seller: (item: string, code: string) =>
      `💰 *Fonds Sécurisés ! Vous pouvez expédier le colis.*\n\n` +
      `L'acheteur a payé pour *${item}* (\`${code}\`).\n` +
      `L'argent est bloqué en sécurité dans le compte séquestre.\n` +
      `Vous pouvez remettre le colis au livreur moto en toute sérénité.`,

    // Rider mode
    rider_welcome: "🏍️ *Mode Livreur Moto*\n\nEntrez le code de commande ou scannez pour vérifier et encaisser votre course :",
    rider_enter_release_code: "🔑 Entrez le code à 4 chiffres donné par le client après inspection :",
    rider_success_payout: (amount: number, deliveryFee: number) =>
      `🎉 *Livraison Validée !*\n\n` +
      `Les fonds ont été débloqués instantanément :\n` +
      `- Frais de livraison versés au livreur: *${deliveryFee.toLocaleString('fr-FR')} FCFA*\n` +
      `- Montant versé au vendeur: *${amount.toLocaleString('fr-FR')} FCFA* via Mobile Money.`,

    // Dispute
    dispute_initiated: "⚠️ *Litige Déclaré !*\n\nLe colis a été refusé. Le livreur ramène le colis au vendeur. Vos fonds d'achat restent protégés.",
    error_invalid_code: "❌ Code de libération erroné. Veuillez réessayer.",
    error_too_many_attempts: "⛔ Nombre maximum de tentatives dépassé. Transaction bloquée pour vérification manuelle."
  },
  en: {
    welcome_title: "🤝 Welcome to Bayam-Sellam Escrow (Cameroon)",
    welcome_body: "Zero-fraud social commerce on TikTok, WhatsApp & Instagram using MTN MoMo & Orange Money.\n\nNo more upfront payment scams, no more wasted bike delivery fees!",
    btn_seller_new_order: "➕ Create Escrow Link (Seller)",
    btn_my_orders: "📦 My Transactions",
    btn_rider_mode: "🏍️ Moto Rider Mode",
    btn_change_lang: "🌐 Français",

    // Order creation
    create_step_title: "📝 What is the item name?",
    create_step_price: "💰 What is the item price (in FCFA)?",
    create_step_delivery: "🛵 Bike delivery fee (in FCFA)? (Enter 0 if free delivery)",
    create_step_phone: "📱 Buyer's WhatsApp / Phone number (e.g. 670000000):",
    order_created_title: "✅ Secure Escrow Link Created!",
    order_created_summary: (code: string, item: string, total: number, fee: number) =>
      `📦 Item: *${item}*\n` +
      `💳 Total Locked Amount: *${total.toLocaleString('en-US')} FCFA*\n` +
      `🛡️ Trust Fee (2.5%): *${fee.toLocaleString('en-US')} FCFA*\n` +
      `🔖 Reference: \`${code}\`\n\n` +
      `👉 Share this link with your buyer on WhatsApp / TikTok / Instagram:`,

    // Buyer notifications
    funds_locked_buyer: (item: string, code: string, releaseCode: string) =>
      `🔒 *Payment Locked in Escrow!*\n\n` +
      `Your payment for *${item}* is safely locked.\n` +
      `The seller will NOT receive the funds until you inspect and accept the package.\n\n` +
      `🔑 *Your Secret 4-Digit Release Code:* \`${releaseCode}\`\n\n` +
      `⚠️ *IMPORTANT*: NEVER disclose this code to the delivery rider until you have opened and inspected the item!`,

    funds_locked_seller: (item: string, code: string) =>
      `💰 *Funds Secured! Safe to Dispatch.*\n\n` +
      `The buyer has paid for *${item}* (\`${code}\`).\n` +
      `Funds are held in custodial escrow.\n` +
      `You can now hand the package over to your moto rider with zero risk.`,

    // Rider mode
    rider_welcome: "🏍️ *Moto Rider Mode*\n\nEnter the order code to confirm delivery and collect your fee:",
    rider_enter_release_code: "🔑 Enter the 4-digit code provided by the customer after package inspection:",
    rider_success_payout: (amount: number, deliveryFee: number) =>
      `🎉 *Delivery Confirmed!*\n\n` +
      `Funds have been instantly disbursed:\n` +
      `- Delivery fee paid to Rider: *${deliveryFee.toLocaleString('en-US')} FCFA*\n` +
      `- Item amount paid to Seller: *${amount.toLocaleString('en-US')} FCFA* via Mobile Money.`,

    // Dispute
    dispute_initiated: "⚠️ *Dispute Opened!*\n\nThe package was rejected. The rider is returning it to the seller. Your escrow deposit remains protected.",
    error_invalid_code: "❌ Invalid release code. Please double-check with the customer.",
    error_too_many_attempts: "⛔ Maximum attempts exceeded. Transaction locked for manual arbitration."
  }
};

export function t(lang: SupportedLanguage = 'fr') {
  return messages[lang] || messages['fr'];
}
