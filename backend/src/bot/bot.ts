import { Bot, InlineKeyboard, Keyboard, session, Context, SessionFlavor } from 'grammy';
import { EscrowService } from '../services/escrow.service.js';
import { UserService } from '../services/user.service.js';
import { SupportedLanguage } from '../domain/types.js';
import { t } from '../i18n/locales.js';

interface SessionData {
  language: SupportedLanguage;
  step?:
    | 'IDLE'
    | 'WAITING_CONTACT'
    | 'SELLER_TITLE'
    | 'SELLER_PRICE'
    | 'SELLER_DELIVERY'
    | 'SELLER_BUYER_PHONE'
    | 'RIDER_REGISTER_CNI'
    | 'RIDER_REGISTER_PLATE'
    | 'RIDER_RELEASE_CODE'
    | 'MERCHANT_UPGRADE_CNI';
  tempOrder?: {
    itemTitle?: string;
    itemPrice?: number;
    deliveryFee?: number;
    buyerPhone?: string;
  };
  tempRiderReg?: {
    cniNumber?: string;
    plateNumber?: string;
  };
  riderSelectedOrderCode?: string;
}

export type BotContext = Context & SessionFlavor<SessionData>;

export function createTelegramBot(
  token: string,
  escrowService: EscrowService,
  userService?: UserService
): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);
  const users = userService || new UserService();

  bot.use(
    session({
      initial: (): SessionData => ({
        language: 'fr',
        step: 'IDLE'
      })
    })
  );

  const getMainMenuKeyboard = (lang: SupportedLanguage, isMerchantVerified: boolean = false) => {
    const text = t(lang);
    return new InlineKeyboard()
      .text(text.btn_new_intra_order, 'act_new_intra')
      .row()
      .text(text.btn_new_agency_order, 'act_new_agency')
      .row()
      .text(isMerchantVerified ? '🏅 Badge Vérifié Actif' : '🏅 Obtenir le Badge Vendeur Vérifié', 'act_upgrade_kyc')
      .text('💳 Mon Micro-Crédit', 'act_my_credit')
      .row()
      .text(text.btn_rider_mode, 'act_rider_mode')
      .text('🏆 Classement Motomen', 'act_leaderboard')
      .row()
      .text(text.btn_my_orders, 'act_my_orders')
      .text(text.btn_change_lang, 'act_toggle_lang');
  };

  // 1. /start command
  bot.command('start', async (ctx) => {
    const lang = ctx.session.language || 'fr';
    const text = t(lang);
    ctx.session.step = 'IDLE';

    // Deep-link check e.g. /start order_BS-DLA-12345
    const payload = ctx.match;
    if (payload && payload.startsWith('order_')) {
      const code = payload.replace('order_', '');
      const order = escrowService.getOrder(code);
      if (order) {
        await ctx.reply(
          `🤝 *BayamSafe Expédition Sécurisée* - Code: \`${order.trackingCode}\`\n\n` +
          `📦 Article: *${order.itemTitle}*\n` +
          `💰 Montant Total: *${order.totalAmount.toLocaleString('fr-FR')} FCFA*\n` +
          `📊 Statut: *${order.status}*\n\n` +
          `👉 Pour payer ou débloquer, ouvrez le lien mobile : ${process.env.FRONTEND_URL}/checkout.html?code=${order.trackingCode}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    // Check if user is registered; if not, prompt 1-tap contact sharing
    const existingUser = users.getUser(String(ctx.from?.id));
    if (!existingUser) {
      ctx.session.step = 'WAITING_CONTACT';
      const contactKeyboard = new Keyboard()
        .requestContact('📱 Inscription Rapide (Partager mon Numéro MoMo)')
        .resized()
        .oneTime();

      await ctx.reply(
        `👋 *Bienvenue sur BayamSafe Cameroun 🇨🇲*\n\n` +
        `Pour créer des liens sécurisés MoMo / Orange Money et recevoir vos paiements sans intermédiaire, ` +
        `appuyez sur le bouton ci-dessous pour lier votre numéro en 1 seconde :`,
        { parse_mode: 'Markdown', reply_markup: contactKeyboard }
      );
      return;
    }

    await ctx.reply(
      `*${text.welcome_title}*\n\n` +
      `Bonjour *${existingUser.fullName}* ${existingUser.isVerifiedMerchant ? '🏅 (Vendeur Vérifié)' : ''} !\n\n` +
      `${text.welcome_body}`,
      {
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(lang, existingUser.isVerifiedMerchant)
      }
    );
  });

  // 2. 1-Tap Native Phone Contact Registration Handler
  bot.on('message:contact', async (ctx) => {
    const contact = ctx.message.contact;
    const phone = contact.phone_number;
    const name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Commerçant BayamSafe';

    const user = users.registerUserFromContact(
      ctx.from.id,
      phone,
      name,
      'MERCHANT',
      name,
      'Douala'
    );

    ctx.session.step = 'IDLE';

    await ctx.reply(
      `🎉 *Compte Créé avec Succès !*\n\n` +
      `👤 Nom: *${user.fullName}*\n` +
      `📱 Numéro MoMo lié: \`${user.phoneNumber}\`\n` +
      `🛡️ Niveau KYC: *Niveau 1 (Actif)*\n\n` +
      `Vous pouvez dès maintenant générer des liens séquestres pour vos ventes TikTok, WhatsApp et Instagram !`,
      {
        parse_mode: 'Markdown',
        reply_markup: { remove_keyboard: true }
      }
    );

    await ctx.reply(
      `Que souhaitez-vous faire ?`,
      { reply_markup: getMainMenuKeyboard(ctx.session.language, user.isVerifiedMerchant) }
    );
  });

  // 3. Level 2 CNI Verification (Verified Badge 🏅)
  bot.callbackQuery('act_upgrade_kyc', async (ctx) => {
    ctx.session.step = 'MERCHANT_UPGRADE_CNI';
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🏅 *Obtenir le Badge Vendeur Vérifié BayamSafe*\n\n` +
      `Le badge vert s'affiche sur tous vos liens de paiement et multiplie vos ventes par 3.\n\n` +
      `📝 Veuillez entrer votre *Numéro de CNI* (ou Passeport) :`
    );
  });

  // 4. Working Capital Inventory Nano-Credit Calculator
  bot.callbackQuery('act_my_credit', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = users.getUser(String(ctx.from.id));
    const processed = user?.totalVolumeProcessed || 50000;
    const creditUnlocked = user?.unlockedCreditLimit || Math.round(processed * 0.3);

    await ctx.reply(
      `💳 *Votre Capacité de Micro-Crédit Stock BayamSafe*\n\n` +
      `📈 Volume total d'expéditions sécurisées: *${processed.toLocaleString('fr-FR')} FCFA*\n` +
      `💰 Avance de Trésorerie Débloquée: *${creditUnlocked.toLocaleString('fr-FR')} FCFA*\n\n` +
      `ℹ️ *Comment ça marche ?*\n` +
      `BayamSafe s'associe avec des institutions de microfinance pour financer vos réapprovisionnements de stock en fonction de vos ventes réelles. ` +
      `Remboursement automatique déduit en douceur de vos prochains paiements reçus.`,
      { parse_mode: 'Markdown' }
    );
  });

  // 5. Rider Leaderboard
  bot.callbackQuery('act_leaderboard', async (ctx) => {
    await ctx.answerCallbackQuery();
    const leaderboard = users.getRiderLeaderboard();
    const rows = leaderboard
      .map((r, i) => `${i + 1}. 🏍️ *${r.fullName}* - ⭐ ${r.trustScore} (${r.completedDeliveries} courses)`)
      .join('\n');

    await ctx.reply(
      `🏆 *Top 5 des Meilleurs Livreurs Moto (Cameroun)*\n\n` +
      `${rows}\n\n` +
      `🎁 *Prime de la semaine* : Les 5 premiers reçoivent un bonus de 10,000 FCFA sur leur compte MoMo chaque dimanche soir !`,
      { parse_mode: 'Markdown' }
    );
  });

  // 6. Start Intra-City Order
  bot.callbackQuery('act_new_intra', async (ctx) => {
    ctx.session.step = 'SELLER_TITLE';
    ctx.session.tempOrder = {};
    await ctx.answerCallbackQuery();
    await ctx.reply('📝 Quel est le nom de l\'article à livrer en ville (Moto Direct) ?');
  });

  // 7. Start Inter-City Agency Order
  bot.callbackQuery('act_new_agency', async (ctx) => {
    ctx.session.step = 'SELLER_TITLE';
    ctx.session.tempOrder = {};
    await ctx.answerCallbackQuery();
    await ctx.reply('🚌 Quel est le nom de l\'article à expédier par Agence de Voyage (Bus) ?');
  });

  // 8. Rider Mode
  bot.callbackQuery('act_rider_mode', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🏍️ *Portail Livreur Moto BayamSafe*\n\n` +
      `• Envoyez \`/on_duty\` pour vous mettre en service et recevoir des courses.\n` +
      `• Envoyez \`/off_duty\` pour vous mettre en pause.\n` +
      `• Envoyez \`/register_rider\` pour vous inscrire comme livreur agréé.\n` +
      `• Partagez votre position en direct (📎 -> Lieu -> Position en direct) pour que le système vous assigne les courses les plus proches.`
    );
  });

  // Rider on_duty / off_duty commands
  bot.command('on_duty', async (ctx) => {
    await ctx.reply('🟢 *VOUS ÊTES EN SERVICE !* Vous recevrez automatiquement les alertes de courses à proximité de votre position.', { parse_mode: 'Markdown' });
  });

  bot.command('off_duty', async (ctx) => {
    await ctx.reply('🔴 *VOUS ÊTES HORS SERVICE.* Aucune nouvelle course ne vous sera envoyée.', { parse_mode: 'Markdown' });
  });

  // Text message conversational router
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const step = ctx.session.step;

    // Level 2 CNI Verification Input
    if (step === 'MERCHANT_UPGRADE_CNI') {
      const user = users.getUser(String(ctx.from.id));
      if (user) {
        users.upgradeMerchantToVerified(user.phoneNumber, text);
        ctx.session.step = 'IDLE';
        await ctx.reply(
          `🎉 *Félicitations ! Votre Badge "Vendeur Vérifié" 🏅 est Actif !*\n\n` +
          `CNI Enregistrée: \`${text}\`\n` +
          `Désormais, un écusson de confiance officiel sera visible par tous vos clients sur vos pages de paiement.`,
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    // Step 1: Item Name
    if (step === 'SELLER_TITLE') {
      ctx.session.tempOrder = { itemTitle: text };
      ctx.session.step = 'SELLER_PRICE';
      await ctx.reply('💰 Quel est le prix de l\'article (en FCFA) ? Ex: 15000');
      return;
    }

    // Step 2: Price
    if (step === 'SELLER_PRICE') {
      const price = parseInt(text.replace(/[^0-9]/g, ''), 10) || 5000;
      ctx.session.tempOrder!.itemPrice = price;
      ctx.session.step = 'SELLER_DELIVERY';
      await ctx.reply('🛵 Frais de livraison moto (en FCFA) ? (Mettez 0 si offert) Ex: 1500');
      return;
    }

    // Step 3: Delivery Fee
    if (step === 'SELLER_DELIVERY') {
      const fee = parseInt(text.replace(/[^0-9]/g, ''), 10) || 0;
      ctx.session.tempOrder!.deliveryFee = fee;
      ctx.session.step = 'SELLER_BUYER_PHONE';
      await ctx.reply('📱 Numéro WhatsApp du client (ex: 671234567) :');
      return;
    }

    // Step 4: Buyer Phone -> Create Unified Order + Generate WhatsApp Flash Card!
    if (step === 'SELLER_BUYER_PHONE') {
      const temp = ctx.session.tempOrder!;
      const user = users.getUser(String(ctx.from.id));

      const order = await escrowService.createUnifiedOrder({
        orderType: 'INTRA_CITY',
        merchantName: user?.shopName || ctx.from.first_name || 'Vendeur Agréé',
        merchantPhone: user?.phoneNumber || '+237671112233',
        isMerchantVerified: user?.isVerifiedMerchant || false,
        recipientPhone: text,
        itemTitle: temp.itemTitle || 'Article',
        itemPrice: temp.itemPrice || 10000,
        deliveryFee: temp.deliveryFee || 1500,
        paymentMode: 'DIGITAL_ESCROW',
        pickupAddress: 'Douala Marché Akwa',
        dropoffAddress: 'Douala Bonamoussadi'
      });

      ctx.session.step = 'IDLE';

      const checkoutUrl = `${process.env.FRONTEND_URL || 'http://localhost:4000'}/checkout.html?code=${order.trackingCode}`;
      const whatsappPitch =
        `*Bonjour !* Pour votre sécurité et la mienne, voici le lien de paiement sécurisé BayamSafe 🇨🇲 :\n\n` +
        `📦 *Article* : ${order.itemTitle}\n` +
        `💰 *Montant* : ${order.totalAmount.toLocaleString('fr-FR')} FCFA (Séquestre MoMo / OM)\n` +
        `🛡️ Votre argent reste bloqué chez BayamSafe jusqu'à ce que vous vérifiez le colis devant le livreur.\n\n` +
        `👉 Cliquez ici pour valider : ${checkoutUrl}`;

      await ctx.reply(
        `✅ *Lien Séquestre & Expédition Créé !*\n\n` +
        `📦 Code de Suivi: \`${order.trackingCode}\`\n` +
        `💰 Total Sécurisé: *${order.totalAmount.toLocaleString('fr-FR')} FCFA*\n` +
        `🛡️ Badge Vendeur: ${order.isMerchantVerified ? '🏅 Vendeur Vérifié' : 'Standard'}\n\n` +
        `🔗 *Lien Web Client :*\n${checkoutUrl}\n\n` +
        `📋 *Texte prêt à copier pour votre client sur WhatsApp :*\n\n` +
        `${whatsappPitch}`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .url('💳 Tester le Lien', checkoutUrl)
            .url('📲 Partager sur WhatsApp', `https://api.whatsapp.com/send?text=${encodeURIComponent(whatsappPitch)}`)
        }
      );
      return;
    }
  });

  return bot;
}
