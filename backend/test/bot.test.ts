import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Update, UserFromGetMe } from 'grammy/types';
import { AddressInfo } from 'node:net';
import { createServer } from '../src/api/server.js';
import { createBot } from '../src/bot/bot.js';
import { telegramWebhook } from '../src/bot/webhook.js';
import { makeApp, makeRider, releaseCode, tick } from './helpers.js';

const botInfo = {
  id: 1, is_bot: true, first_name: 'BayamSafe', username: 'bayamsafe_test_bot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false
} as UserFromGetMe;

const ADMIN_TG = 42;

function harness() {
  const app = makeApp({ env: { ADMIN_TELEGRAM_IDS: String(ADMIN_TG) } });
  const bot = createBot(app, 'test-token', { botInfo });
  const sent: Array<{ method: string; payload: any }> = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload });
    const result = method.startsWith('send') && method !== 'sendMediaGroup' ? { message_id: sent.length, date: 0, chat: { id: 1, type: 'private' } } : true;
    return { ok: true, result: method === 'sendMediaGroup' ? [] : result } as any;
  });
  let updateId = 0;
  let messageId = 0;
  const from = (id: number, last?: string) => ({ id, is_bot: false, first_name: 'Awa', last_name: last, language_code: 'fr' });
  const chat = (id: number) => ({ id, type: 'private' as const, first_name: 'Awa' });
  const message = (id: number, extra: object, last?: string): Update =>
    ({ update_id: ++updateId, message: { message_id: ++messageId, date: 0, chat: chat(id), from: from(id, last), ...extra } }) as Update;

  return {
    app,
    sent,
    text: (id: number, text: string) =>
      bot.handleUpdate(
        message(id, text.startsWith('/') ? { text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : { text })
      ),
    contact: (id: number, contact: object) => bot.handleUpdate(message(id, { contact })),
    photo: (id: number, fileId: string) =>
      bot.handleUpdate(message(id, { photo: [{ file_id: `${fileId}-small`, file_unique_id: 'u1', width: 90, height: 90 }, { file_id: fileId, file_unique_id: 'u2', width: 1280, height: 960 }] })),
    location: (id: number, lat: number, lng: number) => bot.handleUpdate(message(id, { location: { latitude: lat, longitude: lng } })),
    press: (id: number, data: string, last?: string) =>
      bot.handleUpdate({
        update_id: ++updateId,
        callback_query: { id: String(updateId), from: from(id, last), chat_instance: 'x', data, message: { message_id: 1, date: 0, chat: chat(id) } }
      } as Update),
    lastText: () => [...sent].reverse().find((s) => s.method === 'sendMessage')?.payload.text as string,
    to: (chatId: number) => sent.filter((s) => s.payload.chat_id === chatId)
  };
}

async function signUpMerchant(h: ReturnType<typeof harness>, id: number) {
  await h.text(id, '/start merchant');
  await h.contact(id, { phone_number: '671234567', first_name: 'Awa', user_id: id });
  assert.match(h.lastText(), /Étape 1\/8/);
  await h.text(id, 'Chez Awa <b>Mode</b>');
  assert.match(h.lastText(), /Étape 2\/8/);
  await h.text(id, 'Douala');
  await h.text(id, 'this is not a photo');
  assert.match(h.lastText(), /envoyez une photo/);
  await h.photo(id, 'file-selfie-0001');
  await h.photo(id, 'file-cni-front-1');
  await h.photo(id, 'file-cni-back-01');
  await h.text(id, '12');
  assert.match(h.lastText(), /Numéro invalide/);
  await h.text(id, '1234 5678 9');
  await h.photo(id, 'file-shop-00001');
  assert.match(h.lastText(), /Étape 8\/8/);
  await h.location(id, 48.85, 2.35); // Paris: refused
  assert.match(h.lastText(), /Cameroon/);
  await h.location(id, 4.0511, 9.7085);
  assert.match(h.lastText(), /Vérifiez avant d’envoyer/);
  assert.match(h.lastText(), /&lt;b&gt;Mode&lt;\/b&gt;/); // user text is escaped
  await h.press(id, 'ob:submit');
}

describe('telegram webhook over HTTP', () => {
  it('parses the update, answers /start, rejects a wrong secret and survives a malformed update', async () => {
    const app = makeApp();
    const bot = createBot(app, 'test-token', { botInfo });
    const sent: Array<{ method: string; payload: any }> = [];
    bot.api.config.use(async (_prev, method, payload) => {
      sent.push({ method, payload });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } } as any;
    });
    const server = createServer(app, { mount: (http) => http.post('/api/webhooks/telegram', ...telegramWebhook(bot, 'hook-secret')) }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/telegram`;
    const post = (body: unknown, secret?: string) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) }, body: JSON.stringify(body) });
    try {
      const start = {
        update_id: 1,
        message: { message_id: 1, date: 0, chat: { id: 77, type: 'private' }, from: { id: 77, is_bot: false, first_name: 'Awa' }, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] }
      };
      assert.equal((await post(start, 'wrong')).status, 401);
      assert.equal((await post(start, 'hook-secret')).status, 200);
      assert.ok(sent.some((s) => s.method === 'sendMessage' && s.payload.chat_id === 77 && /Bienvenue/.test(s.payload.text)));

      assert.equal((await post({ nonsense: true }, 'hook-secret')).status, 200);
      assert.equal((await post({ ...start, update_id: 2 }, 'hook-secret')).status, 200); // still alive
    } finally {
      server.close();
    }
  });
});

describe('telegram bot', () => {
  it('seller sign-up collects every document in the bot, survives interruptions, then sells', async () => {
    const h = harness();
    const M = 501;

    await h.text(M, '/start');
    await h.contact(M, { phone_number: '671234567', first_name: 'Awa', user_id: 999 }); // someone else's contact
    assert.match(h.lastText(), /propre/);

    // Interrupted after step 3, resumes exactly there.
    await h.contact(M, { phone_number: '671234567', first_name: 'Awa', user_id: M });
    await h.text(M, 'Chez Awa');
    await h.text(M, 'Douala');
    await h.text(M, '/cancel');
    assert.match(h.lastText(), /pause/);
    await h.text(M, '/start');
    assert.ok(h.sent.slice(-2).some((s) => /reprend/.test(s.payload.text ?? '')));
    assert.match(h.lastText(), /Étape 3\/8/);

    // Start over from scratch and go through the whole flow.
    await h.app.users.clearDraft(M);
    await signUpMerchant(h, M);

    const merchant = (await h.app.store.getUserByTelegram(M))!;
    assert.equal(merchant.kycStatus, 'PENDING');
    assert.deepEqual(
      [merchant.selfieFileId, merchant.cniFrontFileId, merchant.cniBackFileId, merchant.shopPhotoFileId, merchant.cniNumber],
      ['file-selfie-0001', 'file-cni-front-1', 'file-cni-back-01', 'file-shop-00001', '123456789']
    );
    assert.deepEqual(merchant.shopLocation, { lat: 4.0511, lng: 9.7085 });
    await tick();
    const admin = h.to(ADMIN_TG);
    assert.ok(admin.some((s) => s.method === 'sendMediaGroup' && s.payload.media.length === 4));
    assert.ok(admin.some((s) => s.method === 'sendLocation'));
    const card = admin.find((s) => s.method === 'sendMessage' && /Seller to verify/.test(s.payload.text));
    assert.equal(card!.payload.reply_markup.inline_keyboard[0][0].callback_data, `adm:kyc:${merchant.id}:a`);

    // Only admins can decide; the seller is told why when refused.
    await h.press(M, `adm:kyc:${merchant.id}:a`);
    assert.equal((await h.app.store.getUser(merchant.id))!.kycStatus, 'PENDING');
    await h.press(ADMIN_TG, `adm:kyc:${merchant.id}:r:blur`);
    await tick();
    assert.ok(h.to(M).some((s) => /Photos floues/.test(s.payload.text ?? '')));

    // Resubmit, get approved, sell.
    await h.text(M, '/start');
    await signUpMerchant(h, M);
    await h.press(ADMIN_TG, `adm:kyc:${merchant.id}:a`);
    await tick();
    assert.ok(h.to(M).some((s) => /vendeur vérifié/.test(s.payload.text ?? '')));

    await h.press(M, 'menu:new_intra');
    await h.text(M, 'Sac à main cuir');
    await h.text(M, '15 000');
    await h.text(M, '1000');
    await h.text(M, '699 11 22 33');
    await h.text(M, 'Akwa, face Total');
    await h.press(M, 'ord:mode:ESCROW');
    await h.press(M, 'ord:confirm');
    assert.match(h.lastText(), /checkout\.html#o=/);
    const [order] = await h.app.orders.listForMerchant(merchant.id);
    assert.equal(order.merchantVerified, true);

    // Buyer pays; rider accepts and delivers with the code.
    const rider = await makeRider(h.app);
    const token = decodeURIComponent(h.lastText().match(/t=([A-Za-z0-9_-]+)/)![1]);
    await h.app.orders.initiatePayment(order.id, token, '677001122');
    const ref = (await h.app.store.getOrder(order.id))!.payment.reference!;
    h.app.sim.approve(ref);
    await h.app.handlePaymentReference(ref);
    await tick();
    await tick();
    assert.ok(h.to(rider.telegramId).some((s) => s.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `r:claim:${order.id}`));
    await h.press(rider.telegramId, `r:claim:${order.id}`);
    await h.press(rider.telegramId, `r:pickup:${order.id}`);
    await h.press(rider.telegramId, `r:deliver:${order.id}`);
    await h.text(rider.telegramId, releaseCode(h.app, order));
    assert.equal((await h.app.store.getOrder(order.id))!.status, 'SETTLED');
  });

  it('a new seller cannot start a sale before completing the profile', async () => {
    const h = harness();
    await h.contact(700, { phone_number: '671000700', first_name: 'Bob', user_id: 700 });
    await h.press(700, 'menu:new_intra');
    assert.match(h.lastText(), /complétez votre profil/);
  });

  it('rider sign-up from the landing-page link, approval, then anyone can /verify the badge', async () => {
    const h = harness();
    const R = 801;
    await h.text(R, '/start rider');
    await h.contact(R, { phone_number: '691234567', first_name: 'Moussa', user_id: R });
    assert.match(h.lastText(), /Étape 1\/9/);
    await h.press(R, 'ob:name', 'Njoya');
    await h.photo(R, 'rider-selfie-001');
    await h.photo(R, 'rider-front-0001');
    await h.photo(R, 'rider-back-00001');
    await h.text(R, '987654321');
    await h.press(R, 'ob:veh:MOTO');
    await h.text(R, 'not ok!');
    assert.match(h.lastText(), /Plaque invalide/);
    await h.text(R, 'LT 123 AB');
    await h.photo(R, 'rider-moto-0001');
    await h.text(R, 'Douala');
    assert.match(h.lastText(), /Awa Njoya/);
    await h.press(R, 'ob:submit');

    const rider = (await h.app.store.getRiderByTelegram(R))!;
    assert.equal(rider.status, 'PENDING');
    assert.equal(rider.fullName, 'Awa Njoya');
    assert.equal(rider.vehiclePhotoFileId, 'rider-moto-0001');

    await h.text(900, `/verify ${rider.riderCode}`);
    assert.match(h.lastText(), /ne correspond à aucun livreur vérifié/);

    await h.press(ADMIN_TG, `adm:rider:${rider.id}:a`);
    await tick();
    assert.ok(h.to(R).some((s) => (s.payload.text ?? '').includes(rider.riderCode)));

    await h.text(900, `/verify ${rider.riderCode.toLowerCase()}`);
    const photo = [...h.sent].reverse().find((s) => s.method === 'sendPhoto');
    assert.equal(photo!.payload.photo, 'rider-selfie-001');
    assert.match(photo!.payload.caption, /Livreur vérifié/);
  });

  it('a second rider pressing accept is told the job is taken', async () => {
    const h = harness();
    const merchant = (await h.app.store.getUserByTelegram(1)) ?? (await (async () => {
      await h.contact(601, { phone_number: '671000601', first_name: 'M', user_id: 601 });
      const u = (await h.app.store.getUserByTelegram(601))!;
      return h.app.store.updateUser({ ...u, kycStatus: 'VERIFIED' });
    })());
    const { order } = await h.app.orders.createOrder(merchant, {
      type: 'INTRA_CITY', paymentMode: 'COD', itemTitle: 'Chaussures', itemPrice: 5000, deliveryFee: 500,
      buyerPhone: '699000601', pickupAddress: 'Bonapriso'
    });
    const a = await makeRider(h.app, { floatBalance: 10000 });
    const b = await makeRider(h.app, { floatBalance: 10000 });
    await h.press(a.telegramId, `r:claim:${order.id}`);
    await h.press(b.telegramId, `r:claim:${order.id}`);
    const alert = [...h.sent].reverse().find((s) => s.method === 'answerCallbackQuery' && s.payload.show_alert);
    assert.match(alert!.payload.text, /déjà prise/);
  });
});
