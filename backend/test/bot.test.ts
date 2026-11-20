import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Update, UserFromGetMe } from 'grammy/types';
import { AddressInfo } from 'node:net';
import { createServer } from '../src/api/server.js';
import { assertGeoPoint } from '../src/domain/geo.js';
import { createBot } from '../src/bot/bot.js';
import { telegramWebhook } from '../src/bot/webhook.js';
import { makeApp, makeMerchant, makeRider, releaseCode, tick, intraInput, TestApp } from './helpers.js';

const botInfo = {
  id: 1, is_bot: true, first_name: 'BayamSafe', username: 'bayamsafe_test_bot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false
} as UserFromGetMe;

const ADMIN_TG = 42;

function harness(existing?: TestApp) {
  const app = existing ?? makeApp({ env: { ADMIN_TELEGRAM_IDS: String(ADMIN_TG) } });
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
  await h.location(id, 48.85, 2.35); // Paris: refused with a clear French message
  assert.match(h.lastText(), /48\.8500, 2\.3500.*hors du Cameroun/s);
  await h.text(id, 'somewhere near the market'); // not a location: asked again, with the alternatives
  assert.match(h.lastText(), /lien Google Maps/);
  await h.text(id, 'https://www.google.com/maps/place/Akwa/@4.0511,9.7085,17z'); // pasted link works (computer users)
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
  it('accepts plain typed coordinates for the shop location, and any location when the Cameroon check is off', async () => {
    const h = harness();
    await h.contact(910, { phone_number: '671000910', first_name: 'Awa', user_id: 910 });
    for (const t of ['Chez Awa', 'Douala']) await h.text(910, t);
    for (const f of ['s-0000000001', 'f-0000000001', 'b-0000000001']) await h.photo(910, f);
    await h.text(910, '123456789');
    await h.photo(910, 'shop-00000001');
    await h.text(910, '4.0511, 9.7085');
    assert.match(h.lastText(), /Vérifiez avant d’envoyer/);
    assert.deepEqual((await h.app.store.getUserByTelegram(910))!.draft!.data.shopLocation, { lat: 4.0511, lng: 9.7085 });

    const abroad = makeApp({ env: { RESTRICT_TO_CAMEROON: 'false' } });
    try {
      const u = await abroad.users.registerFromContact(911, { phone_number: '671000911', first_name: 'B', user_id: 911 });
      await abroad.users.startDraft(911, 'merchant', 'shopLocation');
      assert.equal(u.telegramId, 911);
      assert.deepEqual(assertGeoPoint({ lat: 48.85, lng: 2.35 }), { lat: 48.85, lng: 2.35 });
    } finally {
      makeApp(); // restore the default Cameroon-only check for other tests
    }
    assert.throws(() => assertGeoPoint({ lat: 48.85, lng: 2.35 }));
  });

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
    await h.text(M, '671 23 45 67'); // the seller's own number: refused right away
    assert.match(h.lastText(), /votre propre numéro/);
    await h.text(M, '699 11 22 33');
    await h.text(M, 'Akwa, face Total');
    await h.press(M, 'ord:mode:ESCROW');
    await h.press(M, 'ord:courier:any');
    await h.press(M, 'ord:edit_buyer'); // fix the buyer number from the summary
    await h.text(M, '06 12 34 56 78'); // a foreign number without its country code is refused
    assert.match(h.lastText(), /indicatif/);
    await h.text(M, '+33 6 12 34 56 78'); // a buyer abroad on WhatsApp
    assert.match(h.lastText(), /\+33 6 12 34 56 78/);
    await h.press(M, 'ord:confirm');
    assert.match(h.lastText(), /checkout\.html#o=/);
    const [order] = await h.app.orders.listForMerchant(merchant.id);
    assert.equal(order.merchantVerified, true);
    assert.equal(order.buyerPhone, '+33612345678');

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
    await h.photo(rider.telegramId, 'parcel-photo-0001');
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

  async function codOrderWithRider(h: ReturnType<typeof harness>) {
    const merchant = await makeMerchant(h.app, { kycStatus: 'VERIFIED' });
    const rider = await makeRider(h.app, { floatBalance: 10000 });
    const { order } = await h.app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD', itemPrice: 5000, deliveryFee: 500 }));
    await h.press(rider.telegramId, `r:claim:${order.id}`);
    return { merchant, rider, order };
  }

  it('keeps the wizard session across a new bot instance on the same store', async () => {
    const h1 = harness();
    const merchant = await makeMerchant(h1.app, { kycStatus: 'VERIFIED' });
    await h1.press(merchant.telegramId, 'menu:new_intra');
    await h1.text(merchant.telegramId, 'Sac en cuir');
    assert.ok(await h1.app.store.getBotSession(`tg:${merchant.telegramId}`));

    const h2 = harness(h1.app); // "restart": fresh bot, same store
    await h2.text(merchant.telegramId, '15 000');
    assert.match(h2.lastText(), /livraison/i);
    await h2.text(merchant.telegramId, '1000');
    assert.match(h2.lastText(), /num/i); // asks for the buyer number: the flow carried on
  });

  it('buyer absent: 15 min wait, then the parcel goes back and the seller confirms the return', async () => {
    const h = harness();
    const { merchant, rider, order } = await codOrderWithRider(h);
    await h.press(rider.telegramId, `r:pickup:${order.id}`);
    await h.photo(rider.telegramId, 'parcel-photo-0002');
    assert.equal((await h.app.store.getOrder(order.id))!.status, 'IN_TRANSIT');
    assert.ok(h.to(rider.telegramId).some((s) => /position en direct/.test(s.payload.text ?? '')));

    await h.press(rider.telegramId, `r:absent:${order.id}`);
    await tick();
    assert.ok(h.to(merchant.telegramId).some((s) => /personne ne répond/.test(s.payload.text ?? '')));
    await h.press(rider.telegramId, `r:retabs:${order.id}`);
    assert.match(h.lastText(), /Attendez encore/);

    const o = (await h.app.store.getOrder(order.id))!;
    await h.app.store.updateOrder({ ...o, absence: { ...o.absence!, at: new Date(Date.now() - 16 * 60_000).toISOString() } });
    await h.press(rider.telegramId, `r:retabs:${order.id}`);
    const disputed = (await h.app.store.getOrder(order.id))!;
    assert.equal(disputed.status, 'DISPUTED');
    assert.equal(disputed.dispute!.returnRequired, true);
    await tick();
    const ask = h.to(merchant.telegramId).find((s) => s.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `m:retok:${order.id}`);
    assert.ok(ask);

    await h.press(merchant.telegramId, `m:retok:${order.id}`);
    assert.ok((await h.app.store.getOrder(order.id))!.dispute!.returnReceivedAt);
    assert.match(h.lastText(), /retour confirmé/);
  });

  it('pickup needs a photo; the handover photo is optional after the code', async () => {
    const h = harness();
    const { rider, order } = await codOrderWithRider(h);
    await h.press(rider.telegramId, `r:pickup:${order.id}`);
    assert.match(h.lastText(), /photo du colis/);
    await h.text(rider.telegramId, 'ok je suis là');
    assert.match(h.lastText(), /photo du colis/);
    assert.equal((await h.app.store.getOrder(order.id))!.status, 'RIDER_ASSIGNED');
    await h.photo(rider.telegramId, 'parcel-photo-0003');
    const picked = (await h.app.store.getOrder(order.id))!;
    assert.equal(picked.status, 'IN_TRANSIT');
    assert.equal(picked.pickupPhotoFileId, 'parcel-photo-0003');

    await h.press(rider.telegramId, `r:deliver:${order.id}`);
    await h.text(rider.telegramId, releaseCode(h.app, picked));
    assert.match(h.lastText(), /photo de la remise/);
    await h.photo(rider.telegramId, 'handover-0001');
    assert.equal((await h.app.store.getOrder(order.id))!.deliveryPhotoFileId, 'handover-0001');
  });

  it('/payout asks the admin, /earnings shows FCFA amounts', async () => {
    const h = harness();
    const merchant = await makeMerchant(h.app, { kycStatus: 'VERIFIED' });
    await h.text(merchant.telegramId, '/payout');
    assert.match(h.lastText(), /Utilisation/);
    await h.text(merchant.telegramId, '/payout 699001122');
    assert.match(h.lastText(), /Demande envoyée à l’admin/);
    assert.ok((await h.app.store.getUser(merchant.id))!.pendingPayoutPhone);
    await tick();
    assert.ok(h.to(ADMIN_TG).some((s) => /Payout number change/.test(s.payload.text ?? '')));

    const rider = await makeRider(h.app);
    await h.text(rider.telegramId, '/earnings');
    assert.match(h.lastText(), /Vos gains[\s\S]*FCFA/);
    await h.text(rider.telegramId, '/gains');
    assert.match(h.lastText(), /Cette semaine/);
  });

  it('cash on delivery is refused in the wizard for a prepaid-only buyer', async () => {
    const h = harness();
    const merchant = await makeMerchant(h.app, { kycStatus: 'VERIFIED' });
    for (const n of [1, 2]) {
      const { order } = await h.app.orders.createOrder(merchant, intraInput({ buyerPhone: '699555000', itemTitle: `Vieux ${n}` }));
      await h.app.store.updateOrder({ ...order, buyerRefusalAt: new Date().toISOString() });
    }
    const M = merchant.telegramId;
    await h.press(M, 'menu:new_intra');
    await h.text(M, 'Montre');
    await h.text(M, '9000');
    await h.text(M, '1000');
    await h.text(M, '699 55 50 00');
    await h.text(M, 'Bonapriso');
    await h.press(M, 'ord:mode:COD');
    assert.match(h.lastText(), /2 livraisons en cash/);
    await h.press(M, 'ord:mode:ESCROW');
    assert.doesNotMatch(h.lastText(), /2 livraisons en cash/);
  });

  it('a suspended seller is told so, and a reassigned job card reaches the new rider', async () => {
    const h = harness();
    const sus = await makeMerchant(h.app, { kycStatus: 'VERIFIED', suspendedAt: new Date().toISOString(), suspendNote: 'fraude' });
    await h.press(sus.telegramId, 'menu:new_intra');
    assert.match(h.lastText(), /suspendu.*fraude/);

    const { order } = await codOrderWithRider(h);
    const next = await makeRider(h.app, { floatBalance: 10000 });
    await h.app.orders.adminReassign(order.id, next.riderCode);
    await tick();
    const card = h.to(next.telegramId).find((s) => /Course/.test(s.payload.text ?? ''));
    assert.ok(card);
    assert.equal(card!.payload.reply_markup.inline_keyboard[0][0].callback_data, `r:pickup:${order.id}`);
  });
});
