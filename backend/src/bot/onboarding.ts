import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { App } from '../app.js';
import { CITIES } from '../domain/agencies.js';
import { assertGeoPoint } from '../domain/geo.js';
import { GeoPoint, OnboardingDraft, User, VehicleType } from '../domain/types.js';
import { normalizeIdNumber } from '../services/user.service.js';
import type { BotContext } from './bot.js';

/**
 * Seller and rider sign-up, entirely inside Telegram. Telegram already gives us a camera, a
 * "share my contact" button that proves the phone number, and a "send location" button, so no
 * web form is needed. Every answer is saved on the user record right away: a seller who loses
 * network on step 6 picks up at step 6, even after a server restart.
 */

type Kind = OnboardingDraft['kind'];
type Input = 'text' | 'photo' | 'location' | 'choice' | 'review';

export const MERCHANT_STEPS = ['shopName', 'city', 'selfie', 'cniFront', 'cniBack', 'cniNumber', 'shopPhoto', 'shopLocation', 'review'];
export const RIDER_STEPS = ['legalName', 'selfie', 'cniFront', 'cniBack', 'cniNumber', 'vehicleType', 'plate', 'vehiclePhoto', 'city', 'review'];

const INPUT: Record<string, Input> = {
  shopName: 'text', city: 'text', selfie: 'photo', cniFront: 'photo', cniBack: 'photo', cniNumber: 'text',
  shopPhoto: 'photo', shopLocation: 'location', legalName: 'text', vehicleType: 'choice', plate: 'text',
  vehiclePhoto: 'photo', review: 'review'
};

/** Where each step's answer is stored in the draft. */
const DATA_KEY: Record<string, string> = {
  selfie: 'selfieFileId', cniFront: 'cniFrontFileId', cniBack: 'cniBackFileId', shopPhoto: 'shopPhotoFileId',
  plate: 'plateNumber', vehiclePhoto: 'vehiclePhotoFileId'
};

const stepsFor = (kind: Kind) => (kind === 'merchant' ? MERCHANT_STEPS : RIDER_STEPS);
const keyFor = (step: string) => DATA_KEY[step] ?? step;

export interface Onboarding {
  start(ctx: BotContext, kind: Kind): Promise<void>;
  ask(ctx: BotContext, user: User, resumed?: boolean): Promise<void>;
  handleText(ctx: BotContext, text: string): Promise<boolean>;
  handlePhoto(ctx: BotContext, fileId: string): Promise<boolean>;
  handleLocation(ctx: BotContext, loc: GeoPoint): Promise<boolean>;
}

export function registerOnboarding(
  bot: Bot<BotContext>,
  app: App,
  html: (ctx: BotContext, text: string, extra?: Record<string, unknown>) => Promise<unknown>,
  guard: <C extends BotContext>(fn: (ctx: C) => Promise<unknown>) => (ctx: C) => Promise<void>,
  afterSubmit: (ctx: BotContext, kind: Kind) => Promise<void>
): Onboarding {
  const { users, riders } = app;

  async function ask(ctx: BotContext, user: User, resumed = false) {
    const d = user.draft;
    if (!d) return;
    const s = ctx.s;
    const steps = stepsFor(d.kind);
    const idx = steps.indexOf(d.step);
    if (resumed) await html(ctx, s.resume);

    if (d.step === 'review') {
      const data = d.data as Record<string, string>;
      const text =
        d.kind === 'merchant'
          ? s.reviewMerchant({ shop: data.shopName, city: data.city, cni: data.cniNumber })
          : s.reviewRider({
              name: data.legalName, city: data.city, cni: data.cniNumber, plate: data.plateNumber,
              vehicle: data.vehicleType === 'CAR' ? s.btnCar : data.vehicleType === 'VAN' ? s.btnVan : s.btnMoto
            });
      await html(ctx, text, { reply_markup: new InlineKeyboard().text(s.btnSubmit, 'ob:submit').row().text(s.btnRestart, 'ob:restart') });
      return;
    }

    const header = s.progress(idx + 1, steps.length - 1);
    const prompts: Record<string, string> = {
      shopName: s.ask_shopName, city: d.kind === 'rider' ? s.ask_riderCity : s.ask_city, selfie: s.ask_selfie,
      cniFront: s.ask_cniFront, cniBack: s.ask_cniBack, cniNumber: s.ask_cniNumber, shopPhoto: s.ask_shopPhoto,
      shopLocation: s.ask_shopLocation, legalName: s.ask_legalName, vehicleType: s.ask_vehicleType,
      plate: s.ask_plate, vehiclePhoto: s.ask_vehiclePhoto
    };
    let markup: unknown = { remove_keyboard: true };
    if (d.step === 'city') {
      const kb = new Keyboard();
      CITIES.forEach((c, i) => {
        kb.text(c);
        if (i % 2 === 1) kb.row();
      });
      markup = kb.resized().oneTime();
    } else if (d.step === 'shopLocation') {
      markup = new Keyboard().requestLocation(s.btnSendLocation).resized().oneTime();
    } else if (d.step === 'vehicleType') {
      markup = new InlineKeyboard().text(s.btnMoto, 'ob:veh:MOTO').text(s.btnCar, 'ob:veh:CAR').row().text(s.btnVan, 'ob:veh:VAN');
    } else if (d.step === 'legalName') {
      const tgName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ').trim();
      if (tgName.includes(' ')) markup = new InlineKeyboard().text(s.btnUseName(tgName), 'ob:name');
    }
    await html(ctx, `${header}\n\n${prompts[d.step]}`, { reply_markup: markup });
  }

  async function start(ctx: BotContext, kind: Kind) {
    const user = await users.startDraft(ctx.from!.id, kind, stepsFor(kind)[0]);
    ctx.user = user;
    await html(ctx, kind === 'merchant' ? ctx.s.mIntro : ctx.s.rIntro);
    await ask(ctx, user);
  }

  async function advance(ctx: BotContext, value: string | GeoPoint) {
    const d = ctx.user!.draft!;
    const steps = stepsFor(d.kind);
    const next = steps[steps.indexOf(d.step) + 1] ?? 'review';
    const user = await users.saveDraft(ctx.from!.id, { [keyFor(d.step)]: value }, next);
    ctx.user = user;
    await ask(ctx, user);
  }

  /** Returns an error message for bad text answers, or the cleaned value. */
  function validateText(ctx: BotContext, step: string, raw: string): { ok: true; value: string } | { ok: false; error: string } {
    const s = ctx.s;
    const v = raw.replace(/\s+/g, ' ').trim();
    switch (step) {
      case 'shopName':
        return v.length >= 2 && v.length <= 60 ? { ok: true, value: v } : { ok: false, error: s.badShopName };
      case 'city':
        return v.length >= 2 && v.length <= 40 ? { ok: true, value: v } : { ok: false, error: s.ask_city };
      case 'legalName':
        return v.length >= 4 && v.length <= 80 && v.includes(' ') ? { ok: true, value: v } : { ok: false, error: s.badName };
      case 'cniNumber':
        try {
          return { ok: true, value: normalizeIdNumber(v) };
        } catch {
          return { ok: false, error: s.badId };
        }
      case 'plate': {
        const p = v.replace(/\s/g, '').toUpperCase();
        return /^[A-Z0-9-]{4,12}$/.test(p) ? { ok: true, value: p } : { ok: false, error: s.badPlate };
      }
      default:
        return { ok: true, value: v };
    }
  }

  async function handleText(ctx: BotContext, text: string): Promise<boolean> {
    const d = ctx.user?.draft;
    if (!d) return false;
    const input = INPUT[d.step];
    if (input === 'text') {
      const r = validateText(ctx, d.step, text);
      if (!r.ok) await html(ctx, r.error);
      else await advance(ctx, r.value);
    } else if (input === 'photo') {
      await html(ctx, ctx.s.needPhoto);
    } else if (input === 'location') {
      await html(ctx, ctx.s.needLocation, { reply_markup: new Keyboard().requestLocation(ctx.s.btnSendLocation).resized().oneTime() });
    } else {
      await ask(ctx, ctx.user!);
    }
    return true;
  }

  async function handlePhoto(ctx: BotContext, fileId: string): Promise<boolean> {
    const d = ctx.user?.draft;
    if (!d) return false;
    if (INPUT[d.step] === 'photo') await advance(ctx, fileId);
    else await ask(ctx, ctx.user!);
    return true;
  }

  async function handleLocation(ctx: BotContext, loc: GeoPoint): Promise<boolean> {
    const d = ctx.user?.draft;
    if (!d) return false;
    if (INPUT[d.step] !== 'location') {
      await ask(ctx, ctx.user!);
      return true;
    }
    try {
      await advance(ctx, assertGeoPoint(loc));
    } catch (e) {
      await html(ctx, `⚠️ ${(e as Error).message}`);
    }
    return true;
  }

  // ---- buttons
  bot.callbackQuery(/^ob:veh:(MOTO|CAR|VAN)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.user?.draft?.step !== 'vehicleType') return;
    await advance(ctx, ctx.match[1] as VehicleType);
  }));

  bot.callbackQuery('ob:name', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.user?.draft?.step !== 'legalName') return;
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim();
    const r = validateText(ctx, 'legalName', name);
    if (r.ok) await advance(ctx, r.value);
    else await html(ctx, r.error);
  }));

  bot.callbackQuery('ob:restart', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const kind = ctx.user?.draft?.kind;
    if (kind) await start(ctx, kind);
  }));

  bot.callbackQuery('ob:submit', guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const d = ctx.user?.draft;
    if (!d || d.step !== 'review') return;
    const data = d.data as Record<string, string> & { shopLocation?: GeoPoint };
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    if (d.kind === 'merchant') {
      ctx.user = await users.submitMerchantProfile(ctx.from.id, {
        shopName: data.shopName, city: data.city, cniNumber: data.cniNumber, selfieFileId: data.selfieFileId,
        cniFrontFileId: data.cniFrontFileId, cniBackFileId: data.cniBackFileId, shopPhotoFileId: data.shopPhotoFileId,
        shopLocation: data.shopLocation
      });
      await html(ctx, ctx.s.mSubmitted, { reply_markup: { remove_keyboard: true } });
    } else {
      await riders.submitApplication(ctx.from.id, {
        legalName: data.legalName, cniNumber: data.cniNumber, selfieFileId: data.selfieFileId,
        cniFrontFileId: data.cniFrontFileId, cniBackFileId: data.cniBackFileId, vehicleType: data.vehicleType as VehicleType,
        plateNumber: data.plateNumber, vehiclePhotoFileId: data.vehiclePhotoFileId, city: data.city
      });
      ctx.user = await users.getByTelegram(ctx.from.id);
      await html(ctx, ctx.s.rSubmitted, { reply_markup: { remove_keyboard: true } });
    }
    await afterSubmit(ctx, d.kind);
  }));

  return { start, ask, handleText, handlePhoto, handleLocation };
}
