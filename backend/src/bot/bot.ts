import { Bot, BotConfig, Context, InlineKeyboard, InputFile, Keyboard, SessionFlavor, session } from 'grammy';
import { App } from '../app.js';
import { AGENCIES, CITIES, getAgency } from '../domain/agencies.js';
import { AppError } from '../domain/errors.js';
import { googleMapsRoute } from '../domain/geo.js';
import { isValidContactPhone, normalizeContactPhone } from '../domain/phone.js';
import { Lang, Order, OrderType, PaymentMode, Rider, User, GeoPoint } from '../domain/types.js';
import { DomainEvent } from '../services/events.js';
import { esc, t } from '../i18n/locales.js';
import { registerOnboarding } from './onboarding.js';
import { CANCELLABLE } from '../services/order.service.js';
import { DISPUTABLE_STATUSES } from '../domain/order-state.js';

type Strings = ReturnType<typeof t>;

interface Draft {
  type: OrderType;
  title?: string;
  price?: number;
  fee?: number;
  agencyId?: string;
  dest?: string;
  agencyFee?: number;
  buyer?: string;
  pickup?: string;
  pickupLocation?: GeoPoint;
  mode?: PaymentMode;
  /** Set when the seller is correcting one answer from the summary. */
  backToSummary?: boolean;
  /** The seller's own rider for this sale. */
  riderCode?: string;
  riderName?: string;
}

type Flow =
  | { kind: 'order'; step: 'title' | 'price' | 'fee' | 'agency' | 'dest' | 'agencyFee' | 'buyer' | 'pickup' | 'mode' | 'courier' | 'riderCode' | 'confirm'; d: Draft }
  | { kind: 'assignRider'; orderId: string }
  | { kind: 'waybill'; orderId: string; step: 'number' | 'photo'; number?: string }
  | { kind: 'code'; orderId: string }
  | { kind: 'problem'; orderId: string };

interface SessionData {
  lang?: Lang;
  flow?: Flow;
  /** What the person came for (landing-page deep link), remembered until they share their contact. */
  intent?: 'merchant' | 'rider';
}

export type BotContext = Context &
  SessionFlavor<SessionData> & {
    lang: Lang;
    s: Strings;
    user?: User;
  };

const parseAmount = (text: string): number | undefined => {
  const digits = text.replace(/[\s.,]/g, '');
  return /^\d{1,7}$/.test(digits) ? Number(digits) : undefined;
};

/** What a rider earns on a leg, mirroring settlementPlan. */
function riderEarning(o: Order, leg: 'FIRST' | 'LAST'): number {
  if (o.type === 'INTER_CITY') {
    const half = Math.floor(o.deliveryFee / 2);
    return leg === 'FIRST' ? half : o.deliveryFee - half;
  }
  return o.deliveryFee;
}

/** Preset refusal reasons for the admin's one-tap buttons (the dashboard allows free text). */
export const REJECT_REASONS: Record<string, string> = {
  blur: 'Photos floues ou illisibles. Reprenez-les à la lumière, sans reflet.',
  match: 'Le selfie ne correspond pas à la pièce d’identité.',
  info: 'Informations incomplètes ou incohérentes avec les documents.'
};

const destinationTerminal = (o: Order) => {
  const origin = getAgency(o.originAgencyId ?? '');
  return AGENCIES.find((a) => a.name === origin?.name && a.city === o.destinationCity);
};

export function createBot(app: App, token: string, botConfig?: BotConfig<BotContext>): Bot<BotContext> {
  const bot = new Bot<BotContext>(token, botConfig);
  const { users, riders, orders, store, config } = app;
  const isAdmin = (id?: number) => !!id && config.ADMIN_TELEGRAM_IDS.includes(id);

  bot.use(session({ initial: (): SessionData => ({}) }));

  // Resolve user + language for every update.
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      ctx.user = await users.getByTelegram(ctx.from.id);
      ctx.lang = ctx.user?.lang ?? ctx.session.lang ?? (ctx.from.language_code?.startsWith('en') ? 'en' : 'fr');
    } else {
      ctx.lang = 'fr';
    }
    ctx.s = t(ctx.lang);
    await next();
  });

  const html = (ctx: BotContext, text: string, extra: Record<string, unknown> = {}) =>
    ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

  /** Runs a handler and turns domain errors into a friendly reply. */
  const guard =
    <C extends BotContext>(fn: (ctx: C) => Promise<unknown>) =>
    async (ctx: C) => {
      try {
        await fn(ctx);
      } catch (e) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
        if (e instanceof AppError || (e as { code?: string })?.code === 'NOT_REGISTERED') {
          await html(ctx, `⚠️ ${esc((e as Error).message)}`);
        } else {
          console.error('[bot] handler error:', e);
          await html(ctx, ctx.s.genericError);
        }
      }
    };

  const requireUser = async (ctx: BotContext): Promise<User | undefined> => {
    if (!ctx.user) {
      await html(ctx, ctx.s.notRegistered);
      return undefined;
    }
    return ctx.user;
  };

  const mainMenu = (s: Strings) =>
    new InlineKeyboard()
      .text(s.btnNewIntra, 'menu:new_intra').row()
      .text(s.btnNewInter, 'menu:new_inter').row()
      .text(s.btnMyOrders, 'menu:orders').text(s.btnKyc, 'menu:kyc').row()
      .text(s.btnRider, 'menu:rider').text(s.btnLeaderboard, 'menu:leaderboard').row()
      .text(s.btnLang, 'menu:lang');

  const showMenu = async (ctx: BotContext) => {
    const u = ctx.user!;
    await html(ctx, ctx.s.menuTitle(u.shopName, u.kycStatus === 'VERIFIED'), { reply_markup: mainMenu(ctx.s) });
  };

  // ------------------------------------------------------------------ sign-up

  const onboarding = registerOnboarding(bot, app, html, guard, async (ctx, kind) => {
    if (kind === 'merchant') await showMenu(ctx);
  });

  /** Where a known user lands: their unfinished sign-up, the seller profile, or the menu. */
  const route = async (ctx: BotContext, intent?: 'merchant' | 'rider') => {
    const u = ctx.user!;
    if (u.draft && (!intent || intent === u.draft.kind)) return onboarding.ask(ctx, u, true);
    if (intent === 'rider') {
      const r = await riders.getByTelegram(ctx.from!.id);
      if (!r || r.status === 'REJECTED') return onboarding.start(ctx, 'rider');
      return riderMenu(ctx);
    }
    if (u.kycStatus === 'NONE' || u.kycStatus === 'REJECTED') {
      if (u.kycStatus === 'REJECTED') await html(ctx, ctx.s.kycRejected(u.kycNote ?? ''));
      const r = await riders.getByTelegram(ctx.from!.id);
      if (!r || intent === 'merchant') return onboarding.start(ctx, 'merchant');
      return riderMenu(ctx);
    }
    await showMenu(ctx);
  };

  bot.command('start', guard(async (ctx) => {
    ctx.session.flow = undefined;
    const payload = String(ctx.match ?? '');
    if (payload.startsWith('f_')) {
      const o = await orders.linkBuyerTelegram(payload, ctx.from!.id, ctx.lang);
      await html(ctx, ctx.s.bLinked(o.trackingCode) + `\n${ctx.s.status(o.status)}`, { reply_markup: { remove_keyboard: true } });
      const code = orders.releaseCodeForTelegram(o);
      if (code) await html(ctx, ctx.s.bCode(code));
      else if (o.paymentMode === 'ESCROW' && o.payment.confirmedAt) await html(ctx, ctx.s.bCodeOtherDevice);
      return;
    }
    const intent = payload === 'rider' ? 'rider' : payload === 'merchant' ? 'merchant' : undefined;
    if (!ctx.user) {
      ctx.session.intent = intent;
      const kb = new Keyboard().requestContact(ctx.s.shareContactBtn).resized().oneTime();
      await html(ctx, ctx.s.welcomeNew, { reply_markup: kb });
      return;
    }
    await route(ctx, intent);
  }));

  bot.on('message:contact', guard(async (ctx) => {
    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) {
      await html(ctx, ctx.s.shareOwnContact);
      return;
    }
    const isNew = !ctx.user;
    const user = await users.registerFromContact(ctx.from.id, c, ctx.lang);
    ctx.user = user;
    await html(ctx, ctx.s.registered(user.fullName, user.phone), { reply_markup: { remove_keyboard: true } });
    if (isNew) await onboarding.start(ctx, ctx.session.intent === 'rider' ? 'rider' : 'merchant');
    else await route(ctx);
  }));

  bot.command('menu', guard(async (ctx) => {
    if (await requireUser(ctx)) await route(ctx);
  }));

  bot.command('help', guard(async (ctx) => html(ctx, ctx.s.help)));

  bot.command('cancel', guard(async (ctx) => {
    ctx.session.flow = undefined;
    await html(ctx, ctx.user?.draft ? ctx.s.onboardingPaused : ctx.s.cancelled, { reply_markup: { remove_keyboard: true } });
  }));

  bot.command('verify', guard(async (ctx) => {
    const code = String(ctx.match ?? '').trim().toUpperCase();
    if (!code) return html(ctx, ctx.s.verifyUsage);
    const card = await riders.verifyCode(code);
    if (!card?.verified) return html(ctx, ctx.s.verifyBad(code));
    const caption = ctx.s.verifyOk({ name: card.firstName, plate: card.plateNumber, city: card.city, n: card.completedDeliveries, code: card.riderCode });
    if (card.selfieFileId) await ctx.replyWithPhoto(card.selfieFileId, { caption, parse_mode: 'HTML' });
    else await html(ctx, caption);
  }));

  const toggleLang = async (ctx: BotContext) => {
    const next: Lang = ctx.lang === 'fr' ? 'en' : 'fr';
    ctx.session.lang = next;
    if (ctx.user) ctx.user = await users.updateProfile(ctx.from!.id, { lang: next });
    ctx.lang = next;
    ctx.s = t(next);
    await html(ctx, ctx.s.langSet);
  };
  bot.command('lang', guard(toggleLang));

  // ------------------------------------------------------------------ menu buttons

  bot.callbackQuery('menu:lang', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    await toggleLang(ctx);
  }));

  const startOrder = (type: OrderType) =>
    guard(async (ctx: BotContext) => {
      await ctx.answerCallbackQuery?.().catch(() => undefined);
      const u = await requireUser(ctx);
      if (!u) return;
      if (u.kycStatus === 'NONE' || u.kycStatus === 'REJECTED') {
        await html(ctx, ctx.s.mustCompleteProfile, { reply_markup: new InlineKeyboard().text(ctx.s.btnCompleteProfile, 'menu:profile_start') });
        return;
      }
      ctx.session.flow = { kind: 'order', step: 'title', d: { type } };
      await html(ctx, ctx.s.askTitle);
    });
  bot.callbackQuery('menu:new_intra', startOrder('INTRA_CITY'));
  bot.callbackQuery('menu:new_inter', startOrder('INTER_CITY'));

  const listOrders = async (ctx: BotContext) => {
    const u = await requireUser(ctx);
    if (!u) return;
    const list = await orders.listForMerchant(u.id, 10);
    if (!list.length) return html(ctx, ctx.s.noOrders);
    const kb = new InlineKeyboard();
    list.forEach((o) => kb.text(`${o.trackingCode} · ${o.itemTitle.slice(0, 20)}`, `m:view:${o.id}`).row());
    await html(ctx, list.map((o) => ctx.s.orderLine(o.trackingCode, o.itemTitle, ctx.s.status(o.status))).join('\n\n'), { reply_markup: kb });
  };
  bot.command('orders', guard(listOrders));
  bot.callbackQuery('menu:orders', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    await listOrders(ctx);
  }));

  const showProfile = async (ctx: BotContext) => {
    const u = await requireUser(ctx);
    if (!u) return;
    const kb = new InlineKeyboard();
    if (u.kycStatus === 'NONE' || u.kycStatus === 'REJECTED') kb.text(ctx.s.btnCompleteProfile, 'menu:profile_start');
    await html(ctx, ctx.s.profileStatus(u.kycStatus, u.kycNote), { reply_markup: kb });
  };
  bot.command(['profile', 'kyc'], guard(showProfile));
  bot.callbackQuery('menu:kyc', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    await showProfile(ctx);
  }));
  bot.callbackQuery('menu:profile_start', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await requireUser(ctx))) return;
    if (ctx.user!.draft?.kind === 'merchant') return onboarding.ask(ctx, ctx.user!, true);
    await onboarding.start(ctx, 'merchant');
  }));

  async function riderMenu(ctx: BotContext) {
    const r = await riders.getByTelegram(ctx.from!.id);
    const kb = new InlineKeyboard();
    if (!r || r.status === 'REJECTED') kb.text(ctx.s.btnBecomeRider, 'menu:rider_start');
    await html(ctx, ctx.s.riderMenu(r?.status, r?.onDuty, r?.floatBalance, r?.floatReserved, r?.status === 'APPROVED' ? r.riderCode : undefined), { reply_markup: kb });
  }
  bot.callbackQuery('menu:rider', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    await riderMenu(ctx);
  }));
  const startRider = async (ctx: BotContext) => {
    if (!(await requireUser(ctx))) return;
    if (ctx.user!.draft?.kind === 'rider') return onboarding.ask(ctx, ctx.user!, true);
    const r = await riders.getByTelegram(ctx.from!.id);
    if (r && r.status !== 'REJECTED') return riderMenu(ctx);
    await onboarding.start(ctx, 'rider');
  };
  bot.callbackQuery('menu:rider_start', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    await startRider(ctx);
  }));
  bot.command(['rider', 'register_rider'], guard(startRider));

  const leaderboard = async (ctx: BotContext) => {
    const top = await riders.leaderboard(5);
    const rows = top.map((r, i) => `${i + 1}. ${esc(r.fullName)} — ${r.completedDeliveries}`).join('\n');
    await html(ctx, ctx.s.leaderboard(rows));
  };
  bot.command('leaderboard', guard(leaderboard));
  bot.callbackQuery('menu:leaderboard', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    await leaderboard(ctx);
  }));

  // ------------------------------------------------------------------ merchant order actions

  const merchantOrderKeyboard = (s: Strings, o: Order) => {
    const kb = new InlineKeyboard();
    if (CANCELLABLE.includes(o.status)) kb.text(s.btnCancelOrder, `m:cancel:${o.id}`).row();
    else if (DISPUTABLE_STATUSES.includes(o.status)) kb.text(s.btnCancelReturn, `m:cancel:${o.id}`).row();
    if (o.status === 'AT_AGENCY') kb.text(s.btnArrived, `m:arrived:${o.id}`).row();
    if (['PENDING_PAYMENT', 'AWAITING_RIDER'].includes(o.status)) {
      kb.text(s.btnAssignOwn, `m:own:${o.id}`);
      if (o.preferredRiderId) kb.text(s.btnOpenAll, `m:open:${o.id}`);
      kb.row();
    }
    return kb;
  };

  const riderSignupLink = () => (bot.isInited() ? `https://t.me/${bot.botInfo.username}?start=rider` : '/rider');

  bot.callbackQuery(/^m:own:(.+)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await requireUser(ctx))) return;
    ctx.session.flow = { kind: 'assignRider', orderId: ctx.match[1] };
    await html(ctx, ctx.s.askRiderCode(riderSignupLink()));
  }));

  bot.callbackQuery(/^m:open:(.+)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await requireUser(ctx);
    if (!u) return;
    await orders.setPreferredRider(ctx.match[1], u.id, null);
    await html(ctx, ctx.s.openedToAll);
  }));

  bot.callbackQuery(/^m:view:(.+)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await requireUser(ctx);
    if (!u) return;
    const o = await orders.getForMerchant(ctx.match[1], u.id);
    const lines = [
      `<b>${esc(o.trackingCode)}</b> — ${ctx.s.status(o.status)}`,
      `📦 ${esc(o.itemTitle)}`,
      `💰 ${ctx.s.money(o.total)} (${o.paymentMode === 'COD' ? 'cash' : 'escrow'})`,
      o.waybillNumber ? `🧾 ${esc(o.waybillNumber)}` : '',
      ...o.payouts.filter((p) => p.kind === 'MERCHANT').map((p) => `💸 ${ctx.s.money(p.amount)} → ${p.status}`)
    ].filter(Boolean);
    await html(ctx, lines.join('\n'), { reply_markup: merchantOrderKeyboard(ctx.s, o) });
  }));

  bot.callbackQuery(/^m:cancel:(.+)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await requireUser(ctx);
    if (!u) return;
    const { order: o, kind } = await orders.sellerCancel(ctx.match[1], u.id);
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await html(ctx, kind === 'return_opened' ? ctx.s.mReturnOpened(o.trackingCode) : ctx.s.orderCancelledMsg(o.trackingCode));
  }));

  bot.callbackQuery(/^m:arrived:(.+)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await requireUser(ctx);
    if (!u) return;
    const o = await orders.markArrivedAtHub(ctx.match[1], { merchantId: u.id });
    await html(ctx, ctx.s.mStatus(o.trackingCode, ctx.s.status(o.status)));
  }));

  // ------------------------------------------------------------------ order wizard callbacks

  bot.callbackQuery(/^ord:agency:(.+)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const f = ctx.session.flow;
    if (f?.kind !== 'order' || f.step !== 'agency') return;
    const agency = getAgency(ctx.match[1]);
    if (!agency) return;
    f.d.agencyId = agency.id;
    f.step = 'dest';
    const kb = new InlineKeyboard();
    AGENCIES.filter((a) => a.name === agency.name && a.city !== agency.city).forEach((a) => kb.text(a.city, `ord:dest:${a.city}`).row());
    await html(ctx, ctx.s.askDestination, { reply_markup: kb });
  }));

  bot.callbackQuery(/^ord:dest:(.+)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const f = ctx.session.flow;
    if (f?.kind !== 'order' || f.step !== 'dest') return;
    if (!CITIES.includes(ctx.match[1] as (typeof CITIES)[number])) return;
    f.d.dest = ctx.match[1];
    f.step = 'agencyFee';
    await html(ctx, ctx.s.askAgencyFee);
  }));

  bot.callbackQuery(/^ord:mode:(ESCROW|COD)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const f = ctx.session.flow;
    if (f?.kind !== 'order' || f.step !== 'mode') return;
    f.d.mode = ctx.match[1] as PaymentMode;
    await askCourier(ctx);
  }));

  const askCourier = async (ctx: BotContext) => {
    const f = ctx.session.flow;
    if (f?.kind !== 'order') return;
    f.step = 'courier';
    await html(ctx, ctx.s.askCourier, {
      reply_markup: new InlineKeyboard().text(ctx.s.btnCourierAny, 'ord:courier:any').row().text(ctx.s.btnCourierOwn, 'ord:courier:own')
    });
  };

  bot.callbackQuery(/^ord:courier:(any|own)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const f = ctx.session.flow;
    if (f?.kind !== 'order' || f.step !== 'courier') return;
    if (ctx.match[1] === 'any') {
      f.d.riderCode = undefined;
      f.d.riderName = undefined;
      return showSummary(ctx, f.d);
    }
    f.step = 'riderCode';
    await html(ctx, ctx.s.askRiderCode(riderSignupLink()));
  }));

  const showSummary = async (ctx: BotContext, d: Draft) => {
    const f = ctx.session.flow;
    if (f?.kind !== 'order') return;
    f.step = 'confirm';
    const agency = getAgency(d.agencyId ?? '');
    const agencyFee = d.type === 'INTER_CITY' ? d.agencyFee ?? 0 : 0;
    await html(
      ctx,
      ctx.s.summary({
        title: d.title!,
        price: d.price!,
        fee: d.fee!,
        agencyFee,
        total: d.price! + d.fee! + agencyFee,
        buyer: d.buyer!,
        mode: d.mode === 'COD' ? ctx.s.btnCod : ctx.s.btnEscrow,
        route: agency ? `${agency.name} ${agency.city} (${agency.terminalName}) → ${d.dest}` : undefined,
        rider: d.riderCode ? `${d.riderName} (${d.riderCode})` : undefined
      }),
      { reply_markup: new InlineKeyboard().text(ctx.s.btnConfirm, 'ord:confirm').text(ctx.s.btnAbort, 'ord:abort').row().text(ctx.s.btnEditBuyer, 'ord:edit_buyer') }
    );
  };

  bot.callbackQuery('ord:edit_buyer', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const f = ctx.session.flow;
    if (f?.kind !== 'order' || f.step !== 'confirm') return;
    f.d.backToSummary = true;
    f.step = 'buyer';
    await html(ctx, ctx.s.askBuyerPhone);
  }));

  bot.callbackQuery('ord:abort', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.flow = undefined;
    await html(ctx, ctx.s.cancelled);
  }));

  bot.callbackQuery('ord:confirm', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const f = ctx.session.flow;
    const u = await requireUser(ctx);
    if (!u || f?.kind !== 'order' || f.step !== 'confirm') return;
    const d = f.d;
    const { order, checkoutUrl } = await orders.createOrder(u, {
      type: d.type,
      paymentMode: d.mode ?? 'ESCROW',
      itemTitle: d.title!,
      itemPrice: d.price!,
      deliveryFee: d.fee!,
      agencyFee: d.agencyFee,
      buyerPhone: d.buyer!,
      pickupAddress: d.pickup!,
      pickupLocation: d.pickupLocation,
      originAgencyId: d.agencyId,
      destinationCity: d.dest,
      preferredRiderCode: d.riderCode
    });
    ctx.session.flow = undefined;
    const pitch = ctx.s.whatsappPitch(order.itemTitle, order.total, checkoutUrl);
    await html(ctx, ctx.s.orderCreated(order.trackingCode, checkoutUrl, order.paymentMode === 'COD'), {
      reply_markup: new InlineKeyboard()
        .url(ctx.s.btnShareWhatsapp, `https://wa.me/?text=${encodeURIComponent(pitch)}`).row()
        .text(ctx.s.btnAssignOwn, `m:own:${order.id}`).text(ctx.s.btnCancelOrder, `m:cancel:${order.id}`)
    });
  }));

  // ------------------------------------------------------------------ rider commands

  bot.command('on_duty', guard(async (ctx) => {
    await riders.setDuty(ctx.from!.id, true);
    await html(ctx, ctx.s.onDuty);
  }));

  bot.command('off_duty', guard(async (ctx) => {
    await riders.setDuty(ctx.from!.id, false);
    await html(ctx, ctx.s.offDuty);
  }));

  bot.command('float', guard(async (ctx) => {
    const r = await riders.requireApproved(ctx.from!.id);
    await html(ctx, ctx.s.floatInfo(r.floatBalance, r.floatReserved));
  }));

  bot.command('topup', guard(async (ctx) => {
    const amount = parseAmount(String(ctx.match ?? ''));
    if (!amount) return html(ctx, ctx.s.invalidNumber);
    const { topup, ussdCode } = await riders.requestTopup(ctx.from!.id, amount);
    await html(ctx, ctx.s.topupSent(topup.amount, ussdCode));
    if (app.gateway.name === 'simulated') await html(ctx, `🧪 Test mode reference: <code>${esc(topup.reference)}</code>`);
  }));

  bot.command('jobs', guard(async (ctx) => {
    const r = await riders.requireApproved(ctx.from!.id);
    const active = (await orders.listForRider(r.id, 20)).filter((o) =>
      ['RIDER_ASSIGNED', 'IN_TRANSIT', 'LAST_MILE_ASSIGNED', 'OUT_FOR_DELIVERY'].includes(o.status)
    );
    if (!active.length) return html(ctx, ctx.s.noJobs);
    for (const o of active) await sendJobCard(ctx.from!.id, o, r, ctx.lang);
  }));

  // Live location updates arrive as edited messages.
  const onLocation = async (ctx: BotContext, loc?: { latitude: number; longitude: number }) => {
    if (!loc || !ctx.from) return;
    if (ctx.message && (await onboarding.handleLocation(ctx, { lat: loc.latitude, lng: loc.longitude }))) return;
    const f = ctx.session.flow;
    if (f?.kind === 'order' && f.step === 'pickup') {
      f.d.pickupLocation = { lat: loc.latitude, lng: loc.longitude };
      await html(ctx, ctx.s.pickupLocationSaved);
      return;
    }
    const moved = await riders.updateLocation(ctx.from.id, { lat: loc.latitude, lng: loc.longitude }).catch(() => undefined);
    if (moved) await orders.onRiderMoved(moved).catch((e) => console.warn('[bot] proximity check failed:', e));
  };
  bot.on('message:location', guard((ctx) => onLocation(ctx, ctx.message.location)));
  bot.on('edited_message:location', async (ctx) => {
    await onLocation(ctx, ctx.editedMessage.location).catch(() => undefined);
  });

  // ------------------------------------------------------------------ rider job actions

  const jobKeyboard = (s: Strings, o: Order, rider: Rider) => {
    const kb = new InlineKeyboard();
    const first = o.firstMileRiderId === rider.id;
    const last = o.lastMileRiderId === rider.id;
    const dropoffRoute = o.dropoffLocation ? googleMapsRoute(o.dropoffLocation) : undefined;
    if (o.status === 'RIDER_ASSIGNED' && first) {
      kb.text(s.btnPickedUp, `r:pickup:${o.id}`).text(s.btnRelease, `r:release:${o.id}`).row();
      if (o.pickupLocation) kb.url(s.btnMapsPickup, googleMapsRoute(o.pickupLocation)).row();
    } else if (o.status === 'IN_TRANSIT' && first) {
      if (o.type === 'INTER_CITY') {
        kb.text(s.btnAgencyDrop, `r:agency:${o.id}`).row();
        const ag = getAgency(o.originAgencyId ?? '');
        if (ag) kb.url(s.btnMapsPickup, googleMapsRoute(ag.location)).row();
      } else {
        kb.text(s.btnDeliver, `r:deliver:${o.id}`).row();
        if (dropoffRoute) kb.url(s.btnMapsDropoff, dropoffRoute).row();
      }
      kb.text(s.btnProblem, `r:problem:${o.id}`);
    } else if (o.status === 'LAST_MILE_ASSIGNED' && last) {
      kb.text(s.btnPickedUp, `r:pickup:${o.id}`).text(s.btnRelease, `r:release:${o.id}`).row();
      const term = destinationTerminal(o);
      if (term) kb.url(s.btnMapsPickup, googleMapsRoute(term.location)).row();
    } else if (o.status === 'OUT_FOR_DELIVERY' && last) {
      kb.text(s.btnDeliver, `r:deliver:${o.id}`).row();
      if (dropoffRoute) kb.url(s.btnMapsDropoff, dropoffRoute).row();
      kb.text(s.btnProblem, `r:problem:${o.id}`);
    }
    return kb;
  };

  async function sendJobCard(chatId: number, o: Order, rider: Rider, lang: Lang) {
    const s = t(lang);
    const delivering = o.type === 'INTER_CITY' ? o.lastMileRiderId === rider.id : o.firstMileRiderId === rider.id;
    const deliveryPhase = o.type === 'INTER_CITY' ? ['LAST_MILE_ASSIGNED', 'OUT_FOR_DELIVERY'].includes(o.status) : ['RIDER_ASSIGNED', 'IN_TRANSIT'].includes(o.status);
    const showBuyer = delivering && deliveryPhase;
    const agency = getAgency(o.originAgencyId ?? '');
    const term = destinationTerminal(o);
    const pickup = o.lastMileRiderId === rider.id && term ? `${term.name} ${term.city} (${term.terminalName})` : o.pickupAddress;
    await bot.api.sendMessage(
      chatId,
      s.jobCard({
        code: o.trackingCode,
        status: s.status(o.status),
        item: o.itemTitle,
        pickup,
        merchant: o.merchantName,
        merchantPhone: o.merchantPhone,
        buyerPhone: showBuyer ? o.buyerPhone : undefined,
        dropoff: showBuyer ? o.dropoffAddress : undefined,
        landmark: showBuyer ? o.landmark : undefined,
        collect: showBuyer && o.paymentMode === 'COD' ? o.total : undefined,
        agency: agency ? `${agency.name} (${agency.terminalName})` : undefined,
        dest: o.destinationCity,
        waybill: o.waybillNumber
      }),
      { parse_mode: 'HTML', reply_markup: jobKeyboard(s, o, rider), link_preview_options: { is_disabled: true } }
    );
    if (showBuyer && o.voiceNoteId && ['RIDER_ASSIGNED', 'LAST_MILE_ASSIGNED'].includes(o.status)) {
      const media = await orders.getVoiceNote(o);
      if (media) {
        const ext = media.mime.includes('ogg') ? 'ogg' : media.mime.includes('mp4') ? 'm4a' : 'webm';
        await bot.api.sendDocument(chatId, new InputFile(media.data, `directions-${o.trackingCode}.${ext}`), { caption: s.voiceNoteCaption });
      }
    }
  }

  const riderAction =
    (fn: (ctx: BotContext, orderId: string) => Promise<void>) =>
    guard(async (ctx: BotContext) => {
      await ctx.answerCallbackQuery();
      const id = Array.isArray(ctx.match) ? ctx.match[1] : undefined;
      if (id) await fn(ctx, id);
    });

  bot.callbackQuery(/^r:claim:(.+)$/, guard(async (ctx) => {
    try {
      const o = await orders.claim(ctx.from.id, ctx.match[1]);
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup().catch(() => undefined);
      const r = await riders.requireApproved(ctx.from.id);
      await sendJobCard(ctx.from.id, o, r, ctx.lang);
    } catch (e) {
      if (e instanceof AppError && e.code === 'CONFLICT') {
        await ctx.answerCallbackQuery({ text: ctx.s.jobTaken, show_alert: true });
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        return;
      }
      throw e;
    }
  }));

  bot.callbackQuery(/^r:release:(.+)$/, riderAction(async (ctx, id) => {
    const o = await orders.unassign(ctx.from!.id, id);
    await html(ctx, ctx.s.mStatus(o.trackingCode, ctx.s.status(o.status)));
  }));

  bot.callbackQuery(/^r:pickup:(.+)$/, riderAction(async (ctx, id) => {
    const o = await orders.confirmPickup(ctx.from!.id, id);
    const r = await riders.requireApproved(ctx.from!.id);
    await sendJobCard(ctx.from!.id, o, r, ctx.lang);
  }));

  bot.callbackQuery(/^r:agency:(.+)$/, riderAction(async (ctx, id) => {
    ctx.session.flow = { kind: 'waybill', orderId: id, step: 'number' };
    await html(ctx, ctx.s.askWaybillNumber);
  }));

  bot.callbackQuery(/^r:deliver:(.+)$/, riderAction(async (ctx, id) => {
    ctx.session.flow = { kind: 'code', orderId: id };
    await html(ctx, ctx.s.askCode);
  }));

  bot.callbackQuery(/^r:problem:(.+)$/, riderAction(async (ctx, id) => {
    ctx.session.flow = { kind: 'problem', orderId: id };
    await html(ctx, ctx.s.askProblem);
  }));

  // ------------------------------------------------------------------ buyer: where is my rider?

  bot.callbackQuery(/^b:where:(.+)$/, guard(async (ctx) => {
    const o = await orders.get(ctx.match[1]);
    if (!o || o.buyerTelegramId !== ctx.from.id) return ctx.answerCallbackQuery({ text: 'Not your order', show_alert: true });
    await ctx.answerCallbackQuery();
    const r = await orders.activeRider(o);
    if (!r || !['IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(o.status) || (o.type === 'INTER_CITY' && o.status === 'IN_TRANSIT')) {
      return html(ctx, ctx.s.whereNotYet);
    }
    const tr = orders.trackingFor(o, r);
    const name = r.fullName.split(' ')[0];
    if (!tr) return html(ctx, ctx.s.whereNone(r.phone));
    await ctx.replyWithLocation(tr.lat, tr.lng);
    await html(ctx, ctx.s.whereInfo(name, Math.max(0, Math.round((Date.now() - Date.parse(tr.at)) / 60000)), tr.distanceKm, tr.etaMin), {
      reply_markup: new InlineKeyboard().text(ctx.s.btnWhere, `b:where:${o.id}`)
    });
  }));

  bot.callbackQuery(/^b:cancel:(.+)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    await orders.buyerCancelFromTelegram(ctx.match[1], ctx.from.id);
    await ctx.editMessageReplyMarkup().catch(() => undefined);
  }));

  // ------------------------------------------------------------------ admin buttons

  bot.callbackQuery(/^adm:rider:(.+):(a|r:(\w+))$/, guard(async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Admins only', show_alert: true });
    const approve = ctx.match[2] === 'a';
    const r = await riders.decide(ctx.match[1], approve ? 'APPROVED' : 'REJECTED', approve ? undefined : REJECT_REASONS[ctx.match[3]] ?? REJECT_REASONS.info);
    await ctx.answerCallbackQuery({ text: `${r.fullName}: ${r.status}` });
    await ctx.editMessageReplyMarkup().catch(() => undefined);
  }));

  bot.callbackQuery(/^adm:kyc:(.+):(a|r:(\w+))$/, guard(async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Admins only', show_alert: true });
    const approve = ctx.match[2] === 'a';
    const u = await users.decideKyc(ctx.match[1], approve, approve ? undefined : REJECT_REASONS[ctx.match[3]] ?? REJECT_REASONS.info);
    await ctx.answerCallbackQuery({ text: `${u.shopName}: ${u.kycStatus}` });
    await ctx.editMessageReplyMarkup().catch(() => undefined);
  }));

  // ------------------------------------------------------------------ photos (sign-up, waybill)

  const onPhoto = async (ctx: BotContext, fileId: string) => {
    const f = ctx.session.flow;
    if (f?.kind === 'waybill' && f.step === 'photo' && f.number) {
      const o = await orders.recordAgencyDropoff(ctx.from!.id, f.orderId, f.number, fileId);
      ctx.session.flow = undefined;
      await html(ctx, ctx.s.mStatus(o.trackingCode, ctx.s.status(o.status)));
      return;
    }
    await onboarding.handlePhoto(ctx, fileId);
  };
  bot.on('message:photo', guard((ctx) => onPhoto(ctx, ctx.message.photo.at(-1)!.file_id)));
  // People often send ID photos "as a file" to keep quality: accept image documents too.
  bot.on('message:document', guard(async (ctx) => {
    if (ctx.message.document.mime_type?.startsWith('image/')) await onPhoto(ctx, ctx.message.document.file_id);
  }));

  // ------------------------------------------------------------------ free-text steps

  bot.on('message:text', guard(async (ctx) => {
    const text = ctx.message.text.trim();
    const f = ctx.session.flow;
    const s = ctx.s;
    if (text.startsWith('/')) return;
    if (!f) {
      await onboarding.handleText(ctx, text);
      return;
    }

    switch (f.kind) {
      case 'order': {
        const d = f.d;
        if (f.step === 'title') {
          if (text.length < 2 || text.length > 120) return html(ctx, s.askTitle);
          d.title = text;
          f.step = 'price';
          return html(ctx, s.askPrice);
        }
        if (f.step === 'price') {
          const n = parseAmount(text);
          if (!n || n < 100) return html(ctx, s.invalidNumber);
          d.price = n;
          f.step = 'fee';
          return html(ctx, s.askDeliveryFee);
        }
        if (f.step === 'fee') {
          const n = parseAmount(text);
          if (n === undefined) return html(ctx, s.invalidNumber);
          d.fee = n;
          if (d.type === 'INTER_CITY') {
            f.step = 'agency';
            const kb = new InlineKeyboard();
            AGENCIES.forEach((a) => kb.text(`${a.name} · ${a.city} (${a.terminalName})`, `ord:agency:${a.id}`).row());
            return html(ctx, s.askAgency, { reply_markup: kb });
          }
          f.step = 'buyer';
          return html(ctx, s.askBuyerPhone);
        }
        if (f.step === 'agencyFee') {
          const n = parseAmount(text);
          if (n === undefined) return html(ctx, s.invalidNumber);
          d.agencyFee = n;
          f.step = 'buyer';
          return html(ctx, s.askBuyerPhone);
        }
        if (f.step === 'buyer') {
          if (!isValidContactPhone(text)) return html(ctx, s.askBuyerPhone);
          // The seller can't be their own buyer: say so now, not after the whole form.
          if (ctx.user && normalizeContactPhone(text) === ctx.user.phone) return html(ctx, s.buyerIsYou);
          d.buyer = text;
          if (d.backToSummary) {
            d.backToSummary = false;
            return showSummary(ctx, d);
          }
          f.step = 'pickup';
          return html(ctx, s.askPickup);
        }
        if (f.step === 'riderCode') {
          const card = await riders.verifyCode(text);
          if (!card?.verified) return html(ctx, s.verifyBad(text.trim().toUpperCase()) + '\n\n' + s.askRiderCode(riderSignupLink()));
          d.riderCode = card.riderCode;
          d.riderName = card.firstName;
          return showSummary(ctx, d);
        }
        if (f.step === 'pickup') {
          d.pickup = text;
          if (d.type === 'INTRA_CITY') {
            f.step = 'mode';
            return html(ctx, s.askPaymentMode, {
              reply_markup: new InlineKeyboard().text(s.btnEscrow, 'ord:mode:ESCROW').row().text(s.btnCod, 'ord:mode:COD')
            });
          }
          d.mode = 'ESCROW';
          return askCourier(ctx);
        }
        return;
      }
      case 'waybill': {
        if (f.step === 'number') {
          f.number = text;
          f.step = 'photo';
          return html(ctx, s.askWaybillPhoto);
        }
        return html(ctx, s.askWaybillPhoto);
      }
      case 'code': {
        const res = await orders.deliver(ctx.from.id, f.orderId, text);
        if (res.ok) {
          ctx.session.flow = undefined;
          return html(ctx, s.delivered);
        }
        if (res.order.status === 'DISPUTED') {
          ctx.session.flow = undefined;
          return html(ctx, s.codeLocked);
        }
        return html(ctx, s.codeWrong(res.attemptsLeft));
      }
      case 'assignRider': {
        const u = await requireUser(ctx);
        if (!u) return;
        const { rider } = await orders.setPreferredRider(f.orderId, u.id, text);
        ctx.session.flow = undefined;
        return html(ctx, s.ownRiderSet(rider!.fullName.split(' ')[0], rider!.riderCode));
      }
      case 'problem': {
        await orders.riderOpenDispute(ctx.from.id, f.orderId, text);
        ctx.session.flow = undefined;
        return html(ctx, s.problemSent);
      }
    }
  }));

  bot.catch((err) => console.error('[bot] unhandled error:', err.error));

  // ------------------------------------------------------------------ notifications

  const send = async (chatId: number | undefined, text: string, extra: Record<string, unknown> = {}) => {
    if (!chatId) return;
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
    } catch (e) {
      console.warn(`[bot] could not message ${chatId}:`, (e as Error).message);
    }
  };
  const toAdmins = (text: string, extra: Record<string, unknown> = {}) =>
    Promise.all(config.ADMIN_TELEGRAM_IDS.map((id) => send(id, text, extra)));
  const merchantOf = async (o: Order) => store.getUser(o.merchantId);

  /** Message to the buyer's Telegram, if they follow the order. */
  const toBuyer = async (o: Order, build: (s: Strings) => string, where = false) => {
    if (!o.buyerTelegramId) return;
    const s = t(o.buyerLang ?? 'fr');
    const kb = new InlineKeyboard();
    if (where) kb.text(s.btnWhere, `b:where:${o.id}`);
    if (CANCELLABLE.includes(o.status)) kb.text(s.btnBuyerCancel, `b:cancel:${o.id}`);
    await send(o.buyerTelegramId, build(s), kb.inline_keyboard.flat().length ? { reply_markup: kb } : {});
  };
  const cancelledBy = (o: Order) => (/cancelled by (\w+)/.exec(o.history.at(-1)?.note ?? '')?.[1] ?? 'seller');

  async function notifyBuyerOfStatus(o: Order) {
    const riderFor = async (id?: string) => (id ? store.getRider(id) : undefined);
    switch (o.status) {
      case 'RIDER_ASSIGNED':
      case 'LAST_MILE_ASSIGNED': {
        const r = await riderFor(o.status === 'RIDER_ASSIGNED' ? o.firstMileRiderId : o.lastMileRiderId);
        if (r) await toBuyer(o, (s) => s.bRider(r.fullName.split(' ')[0], r.plateNumber, r.riderCode, r.phone));
        return;
      }
      case 'IN_TRANSIT': {
        const r = await riderFor(o.firstMileRiderId);
        if (o.type === 'INTER_CITY') return toBuyer(o, (s) => s.mStatus(o.trackingCode, s.status(o.status)));
        return toBuyer(o, (s) => s.bPickedUp(r?.fullName.split(' ')[0] ?? ''), true);
      }
      case 'AT_AGENCY': {
        const ag = getAgency(o.originAgencyId ?? '');
        return toBuyer(o, (s) => s.bAtAgency(ag ? `${ag.name} ${ag.city}` : '', o.waybillNumber ?? ''));
      }
      case 'AT_DESTINATION_HUB':
        return toBuyer(o, (s) => s.bHub(o.destinationCity ?? ''));
      case 'OUT_FOR_DELIVERY': {
        const r = await riderFor(o.lastMileRiderId);
        return toBuyer(o, (s) => s.bOut(r?.fullName.split(' ')[0] ?? ''), true);
      }
      case 'DELIVERED':
        return toBuyer(o, (s) => s.bDelivered);
      case 'REFUNDED':
        return toBuyer(o, (s) => s.bRefunded);
      case 'CANCELLED':
        return toBuyer(o, (s) => (cancelledBy(o) === 'buyer' ? s.bCancelledByYou : s.bCancelled));
    }
  }

  /** Sends admins the documents as one album, the location pin, then the decision buttons. */
  async function sendReviewCard(
    photos: Array<[string | undefined, string]>,
    text: string,
    location: GeoPoint | undefined,
    kind: 'kyc' | 'rider',
    id: string
  ) {
    const media = photos.filter(([f]) => !!f).map(([f, label]) => ({ type: 'photo' as const, media: f!, caption: label }));
    const kb = new InlineKeyboard()
      .text('✅ Approve', `adm:${kind}:${id}:a`).row()
      .text('❌ Blurry', `adm:${kind}:${id}:r:blur`)
      .text('❌ Face ≠ ID', `adm:${kind}:${id}:r:match`)
      .text('❌ Info', `adm:${kind}:${id}:r:info`);
    for (const chat of config.ADMIN_TELEGRAM_IDS) {
      try {
        if (media.length) await bot.api.sendMediaGroup(chat, media);
        if (location) await bot.api.sendLocation(chat, location.lat, location.lng);
        await bot.api.sendMessage(chat, text, { parse_mode: 'HTML', reply_markup: kb });
      } catch (err) {
        console.warn('[bot] review card failed:', (err as Error).message);
      }
    }
  }

  app.events.on(async (e: DomainEvent) => {
    switch (e.type) {
      case 'order.rider_near':
        await toBuyer(e.order, (s) => s.bNear(e.rider.fullName.split(' ')[0], Math.max(50, Math.round((e.distanceKm * 1000) / 50) * 50)), true);
        return;
      case 'order.buyer_linked':
        return;
      case 'order.paid': {
        await toBuyer(e.order, (s) => s.bPaid);
        const code = orders.releaseCodeForTelegram(e.order);
        if (code) await toBuyer(e.order, (s) => s.bCode(code));
        const m = await merchantOf(e.order);
        if (m) await send(m.telegramId, t(m.lang).mPaid(e.order.trackingCode, e.order.itemTitle, e.order.total));
        return;
      }
      case 'order.offer': {
        for (const { rider, distanceKm } of e.offers) {
          const u = await store.getUser(rider.userId);
          const s = t(u?.lang ?? 'fr');
          const term = destinationTerminal(e.order);
          await send(
            rider.telegramId,
            (e.order.preferredRiderId === rider.id ? s.offerChosen(e.order.merchantName) : '') +
            s.offer({
              item: e.order.itemTitle,
              pickup: e.leg === 'LAST' && term ? `${term.name} (${term.terminalName})` : e.order.pickupAddress,
              earn: riderEarning(e.order, e.leg),
              dist: distanceKm,
              cod: e.order.paymentMode === 'COD' ? e.order.itemPrice : undefined,
              leg: e.leg,
              city: e.order.destinationCity
            }),
            { reply_markup: new InlineKeyboard().text(s.btnAccept, `r:claim:${e.order.id}`) }
          );
        }
        return;
      }
      case 'order.no_riders': {
        const m = await merchantOf(e.order);
        if (m) await send(m.telegramId, t(m.lang).mNoRiders(e.order.trackingCode), { reply_markup: merchantOrderKeyboard(t(m.lang), e.order) });
        await toBuyer(e.order, (s) => s.bNoRiders);
        await toAdmins(`🚨 No rider for <code>${esc(e.order.trackingCode)}</code> (${e.leg} leg)`);
        return;
      }
      case 'order.status': {
        await notifyBuyerOfStatus(e.order);
        const m = await merchantOf(e.order);
        if (!m) return;
        const s = t(m.lang);
        const o = e.order;
        if (o.status === 'RIDER_ASSIGNED' || o.status === 'LAST_MILE_ASSIGNED') {
          const r = await store.getRider((o.status === 'RIDER_ASSIGNED' ? o.firstMileRiderId : o.lastMileRiderId) ?? '');
          if (r) await send(m.telegramId, s.mRider(o.trackingCode, `${r.fullName} · ${r.plateNumber}`, r.phone));
          return;
        }
        if (o.status === 'SETTLED') {
          const p = o.payouts.find((x) => x.kind === 'MERCHANT');
          if (p) await send(m.telegramId, s.mSettled(o.trackingCode, p.amount));
          return;
        }
        if ((o.status === 'CANCELLED' || o.status === 'REFUNDED') && cancelledBy(o) === 'buyer') {
          await send(m.telegramId, s.mCancelledByBuyer(o.trackingCode, o.itemTitle));
          return;
        }
        await send(m.telegramId, s.mStatus(o.trackingCode, s.status(o.status)), { reply_markup: merchantOrderKeyboard(s, o) });
        return;
      }
      case 'order.disputed': {
        await toBuyer(e.order, (s) => s.bDisputed(e.order.dispute?.reason ?? ''));
        const o = e.order;
        const reason = o.dispute?.reason ?? '';
        const m = await merchantOf(o);
        if (m) await send(m.telegramId, t(m.lang).mDisputed(o.trackingCode, reason));
        await toAdmins(`⚠️ Dispute on <code>${esc(o.trackingCode)}</code> by ${esc(o.dispute?.openedBy)}: ${esc(reason)}\nOrder id: <code>${o.id}</code>`);
        return;
      }
      case 'order.payment_mismatch':
        await toAdmins(
          `💸 Unmatched payment of ${e.paidAmount} FCFA on <code>${esc(e.order.trackingCode)}</code> (status ${e.order.status}, expected ${e.order.total}). Refund manually.`
        );
        return;
      case 'payout.attention':
        await toAdmins(
          `🧾 Payout needs review on <code>${esc(e.order.trackingCode)}</code>: ${e.payout.kind} ${e.payout.amount} FCFA → ${esc(e.payout.phone)}\n${esc(e.payout.lastError)}\n` +
            `Order <code>${e.order.id}</code> · payout <code>${e.payout.id}</code>`
        );
        return;
      case 'kyc.submitted': {
        const u = e.user;
        await sendReviewCard(
          [
            [u.selfieFileId, 'Selfie'], [u.cniFrontFileId, 'ID front'], [u.cniBackFileId, 'ID back'], [u.shopPhotoFileId, 'Shop']
          ],
          `🏪 <b>Seller to verify</b>: ${esc(u.shopName)}\n${esc(u.fullName)} · ${esc(u.phone)}\n${esc(u.city)} · CNI <code>${esc(u.cniNumber)}</code>`,
          u.shopLocation,
          'kyc',
          u.id
        );
        return;
      }
      case 'kyc.decided': {
        const s = t(e.user.lang);
        await send(e.user.telegramId, e.user.kycStatus === 'VERIFIED' ? s.kycApproved : s.kycRejected(e.user.kycNote ?? ''));
        return;
      }
      case 'rider.applied': {
        const r = e.rider;
        await sendReviewCard(
          [
            [r.selfieFileId, 'Selfie'], [r.cniFrontFileId, 'ID front'], [r.cniBackFileId, 'ID back'], [r.vehiclePhotoFileId, 'Vehicle']
          ],
          `🛵 <b>Rider to verify</b>: ${esc(r.fullName)}\n${esc(r.phone)} · ${esc(r.city)}\nCNI <code>${esc(r.cniNumber)}</code> · ${esc(r.vehicleType)} <code>${esc(r.plateNumber)}</code>`,
          undefined,
          'rider',
          r.id
        );
        return;
      }
      case 'rider.decided': {
        const u = await store.getUser(e.rider.userId);
        const s = t(u?.lang ?? 'fr');
        const r = e.rider;
        const text = r.status === 'APPROVED' ? s.riderApproved(r.riderCode) : r.status === 'REJECTED' ? s.riderRejected(r.reviewNote ?? '') : s.riderSuspended(r.reviewNote ?? '');
        await send(r.telegramId, text);
        return;
      }
      case 'topup.confirmed': {
        const u = await store.getUser(e.rider.userId);
        await send(e.rider.telegramId, t(u?.lang ?? 'fr').topupConfirmed(e.topup.amount, e.rider.floatBalance));
        return;
      }
    }
  });

  return bot;
}
