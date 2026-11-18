import { Bot, InlineKeyboard, session, Context, SessionFlavor } from 'grammy';
import { EscrowService } from '../services/escrow.service.js';
import { SupportedLanguage } from '../domain/types.js';
import { t } from '../i18n/locales.js';

interface SessionData {
  language: SupportedLanguage;
  step?: 'IDLE' | 'SELLER_TITLE' | 'SELLER_PRICE' | 'SELLER_DELIVERY' | 'SELLER_BUYER_PHONE' | 'RIDER_ORDER_CODE' | 'RIDER_RELEASE_CODE';
  tempOrder?: {
    itemTitle?: string;
    itemPrice?: number;
    deliveryFee?: number;
    buyerPhone?: string;
  };
  riderSelectedOrderCode?: string;
}

export type BotContext = Context & SessionFlavor<SessionData>;

export function createTelegramBot(token: string, escrowService: EscrowService): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  // Session middleware
  bot.use(
    session({
      initial: (): SessionData => ({
        language: 'fr',
        step: 'IDLE'
      })
    })
  );

  // Helper keyboard generator
  const getMainMenuKeyboard = (lang: SupportedLanguage) => {
    const text = t(lang);
    return new InlineKeyboard()
      .text(text.btn_seller_new_order, 'act_new_order')
      .row()
      .text(text.btn_rider_mode, 'act_rider_mode')
      .row()
      .text(text.btn_my_orders, 'act_my_orders')
      .text(text.btn_change_lang, 'act_toggle_lang');
  };

  // /start command
  bot.command('start', async (ctx) => {
    const lang = ctx.session.language || 'fr';
    const text = t(lang);
    ctx.session.step = 'IDLE';

    // Check for deep link e.g. /start order_CM-ESC-12345
    const payload = ctx.match;
    if (payload && payload.startsWith('order_')) {
      const code = payload.replace('order_', '');
      const order = escrowService.getOrder(code);
      if (order) {
        await ctx.reply(
          `🤝 *Bayam-Sellam Escrow* - Commande: \`${order.orderCode}\`\n\n` +
          `📦 Article: *${order.itemTitle}*\n` +
          `💰 Montant: *${order.itemPrice.toLocaleString('fr-FR')} FCFA*\n` +
          `🛵 Livraison: *${order.deliveryFee.toLocaleString('fr-FR')} FCFA*\n` +
          `📊 Statut: *${order.status}*\n\n` +
          `👉 Pour payer ou débloquer, ouvrez le lien de paiement mobile : ${process.env.FRONTEND_URL}/checkout.html?code=${order.orderCode}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    await ctx.reply(
      `*${text.welcome_title}*\n\n${text.welcome_body}`,
      {
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(lang)
      }
    );
  });

  // Language toggle callback
  bot.callbackQuery('act_toggle_lang', async (ctx) => {
    ctx.session.language = ctx.session.language === 'fr' ? 'en' : 'fr';
    await ctx.answerCallbackQuery({ text: ctx.session.language === 'fr' ? 'Passé en Français' : 'Switched to English' });
    const text = t(ctx.session.language);
    await ctx.editMessageText(
      `*${text.welcome_title}*\n\n${text.welcome_body}`,
      {
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(ctx.session.language)
      }
    );
  });

  // Seller: Start New Order Flow
  bot.callbackQuery('act_new_order', async (ctx) => {
    const lang = ctx.session.language || 'fr';
    ctx.session.step = 'SELLER_TITLE';
    ctx.session.tempOrder = {};
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang).create_step_title);
  });

  // Rider Mode callback
  bot.callbackQuery('act_rider_mode', async (ctx) => {
    const lang = ctx.session.language || 'fr';
    ctx.session.step = 'RIDER_ORDER_CODE';
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang).rider_welcome);
  });

  // My Orders callback
  bot.callbackQuery('act_my_orders', async (ctx) => {
    await ctx.answerCallbackQuery();
    const orders = escrowService.getAllOrders();
    if (orders.length === 0) {
      await ctx.reply(ctx.session.language === 'fr' ? 'Aucune commande pour le moment.' : 'No orders yet.');
      return;
    }
    const summary = orders
      .slice(-5)
      .map((o) => `• \`${o.orderCode}\`: ${o.itemTitle} - *${o.status}* (${o.totalAmount} FCFA)`)
      .join('\n');

    await ctx.reply(`📋 *Dernières Transactions :*\n\n${summary}`, { parse_mode: 'Markdown' });
  });

  // Text message handler for conversational steps
  bot.on('message:text', async (ctx) => {
    const lang = ctx.session.language || 'fr';
    const text = t(lang);
    const step = ctx.session.step;

    // STEP 1: Item Name
    if (step === 'SELLER_TITLE') {
      ctx.session.tempOrder = ctx.session.tempOrder || {};
      ctx.session.tempOrder.itemTitle = ctx.message.text.trim();
      ctx.session.step = 'SELLER_PRICE';
      await ctx.reply(text.create_step_price);
      return;
    }

    // STEP 2: Item Price
    if (step === 'SELLER_PRICE') {
      const price = parseInt(ctx.message.text.replace(/[^0-9]/g, ''), 10);
      if (isNaN(price) || price < 500) {
        await ctx.reply(lang === 'fr' ? 'Veuillez entrer un montant valide en FCFA (min 500 FCFA) :' : 'Please enter a valid amount in FCFA (min 500 FCFA):');
        return;
      }
      ctx.session.tempOrder!.itemPrice = price;
      ctx.session.step = 'SELLER_DELIVERY';
      await ctx.reply(text.create_step_delivery);
      return;
    }

    // STEP 3: Delivery Fee
    if (step === 'SELLER_DELIVERY') {
      const delivery = parseInt(ctx.message.text.replace(/[^0-9]/g, ''), 10) || 0;
      ctx.session.tempOrder!.deliveryFee = delivery;
      ctx.session.step = 'SELLER_BUYER_PHONE';
      await ctx.reply(text.create_step_phone);
      return;
    }

    // STEP 4: Buyer Phone -> Create Order!
    if (step === 'SELLER_BUYER_PHONE') {
      const buyerPhone = ctx.message.text.trim();
      const temp = ctx.session.tempOrder!;
      
      const order = await escrowService.createOrder({
        sellerTelegramId: ctx.from.id,
        sellerName: ctx.from.first_name || 'Vendeur Social',
        sellerPhone: '237670000000', // Default seller wallet
        itemTitle: temp.itemTitle || 'Article',
        itemPrice: temp.itemPrice || 5000,
        deliveryFee: temp.deliveryFee || 0,
        buyerPhone
      });

      ctx.session.step = 'IDLE';

      const checkoutUrl = `${process.env.FRONTEND_URL || 'http://localhost:4000'}/checkout.html?code=${order.orderCode}`;
      const telegramLink = `https://t.me/${ctx.me?.username || 'BayamSellamBot'}?start=order_${order.orderCode}`;

      await ctx.reply(
        `*${text.order_created_title}*\n\n` +
        text.order_created_summary(order.orderCode, order.itemTitle, order.totalAmount, order.platformFee) +
        `\n\n🌐 *Lien Web Universel :*\n${checkoutUrl}\n\n` +
        `📱 *Lien Telegram Direct :*\n${telegramLink}`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .url('💳 Ouvrir Paiement', checkoutUrl)
            .row()
            .text('🏠 Menu Principal', 'act_start_menu')
        }
      );
      return;
    }

    // RIDER FLOW: Order Code Input
    if (step === 'RIDER_ORDER_CODE') {
      const code = ctx.message.text.trim().toUpperCase();
      const order = escrowService.getOrder(code);
      if (!order) {
        await ctx.reply(lang === 'fr' ? '❌ Code de commande introuvable. Réessayez :' : '❌ Order code not found. Try again:');
        return;
      }

      ctx.session.riderSelectedOrderCode = code;
      ctx.session.step = 'RIDER_RELEASE_CODE';

      await ctx.reply(
        `📦 *Commande Sélectionnée :* \`${order.orderCode}\`\n` +
        `Article: *${order.itemTitle}*\n` +
        `Course Moto à encaisser: *${order.deliveryFee.toLocaleString('fr-FR')} FCFA*\n` +
        `Statut: *${order.status}*\n\n` +
        text.rider_enter_release_code,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // RIDER FLOW: 4-digit Release Code verification
    if (step === 'RIDER_RELEASE_CODE') {
      const codeInput = ctx.message.text.trim();
      const orderCode = ctx.session.riderSelectedOrderCode;
      if (!orderCode) {
        ctx.session.step = 'IDLE';
        return;
      }

      try {
        const result = await escrowService.verifyReleaseCode(orderCode, codeInput);
        if (result.success) {
          ctx.session.step = 'IDLE';
          await ctx.reply(
            text.rider_success_payout(result.sellerPayout || 0, result.riderPayout || 0),
            { parse_mode: 'Markdown', reply_markup: getMainMenuKeyboard(lang) }
          );
        } else {
          await ctx.reply(result.message || text.error_invalid_code);
        }
      } catch (err: any) {
        await ctx.reply(`⚠️ ${err.message || 'Erreur lors de la validation.'}`);
      }
      return;
    }
  });

  return bot;
}
