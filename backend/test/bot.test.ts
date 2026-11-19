import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createBot } from '../src/bot/bot.js';
import { makeApp, makeRider, releaseCode, tick } from './helpers.js';

const botInfo: UserFromGetMe = {
  id: 1, is_bot: true, first_name: 'BayamSafe', username: 'bayamsafe_test_bot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false
} as UserFromGetMe;

function harness() {
  const app = makeApp();
  const bot = createBot(app, 'test-token', { botInfo });
  const sent: Array<{ method: string; payload: any }> = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: method === 'sendMessage' ? { message_id: sent.length, date: 0, chat: { id: 1, type: 'private' } } : true } as any;
  });
  let updateId = 0;
  let messageId = 0;
  const from = (id: number) => ({ id, is_bot: false, first_name: 'Awa', language_code: 'fr' });
  const chat = (id: number) => ({ id, type: 'private' as const, first_name: 'Awa' });
  const message = (id: number, extra: object): Update =>
    ({ update_id: ++updateId, message: { message_id: ++messageId, date: 0, chat: chat(id), from: from(id), ...extra } }) as Update;

  return {
    app,
    bot,
    sent,
    text: (id: number, text: string) =>
      bot.handleUpdate(
        message(id, text.startsWith('/') ? { text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : { text })
      ),
    contact: (id: number, contact: object) => bot.handleUpdate(message(id, { contact })),
    press: (id: number, data: string) =>
      bot.handleUpdate({
        update_id: ++updateId,
        callback_query: { id: String(updateId), from: from(id), chat_instance: 'x', data, message: { message_id: 1, date: 0, chat: chat(id) } }
      } as Update),
    lastText: () => [...sent].reverse().find((s) => s.method === 'sendMessage')?.payload.text as string
  };
}

describe('telegram bot', () => {
  it('signs up a merchant, runs the order wizard and lets a rider deliver', async () => {
    const h = harness();
    const M = 501;

    await h.text(M, '/start');
    assert.match(h.lastText(), /Bienvenue/);

    await h.contact(M, { phone_number: '671234567', first_name: 'Awa', user_id: 999 }); // someone else's contact
    assert.match(h.lastText(), /propre/);
    await h.contact(M, { phone_number: '671234567', first_name: 'Awa', user_id: M });
    const merchant = await h.app.store.getUserByTelegram(M);
    assert.equal(merchant?.phone, '+237671234567');

    await h.press(M, 'menu:new_intra');
    await h.text(M, 'Sac à main <b>cuir</b>'); // HTML must be escaped later
    await h.text(M, 'quinze mille');
    assert.match(h.lastText(), /chiffres/);
    await h.text(M, '15 000');
    await h.text(M, '1000');
    await h.text(M, '699 11 22 33');
    await h.text(M, 'Akwa, face Total');
    await h.press(M, 'ord:mode:ESCROW');
    assert.match(h.lastText(), /16.000 FCFA/);
    assert.match(h.lastText(), /&lt;b&gt;cuir&lt;\/b&gt;/);
    await h.press(M, 'ord:confirm');
    assert.match(h.lastText(), /checkout\.html#o=/);

    const [order] = await h.app.orders.listForMerchant(merchant!.id);
    assert.equal(order.total, 16000);
    assert.equal(order.buyerPhone, '+237699112233');

    // Buyer pays; an on-duty rider gets the offer and accepts.
    const rider = await makeRider(h.app);
    const token = decodeURIComponent(h.lastText().match(/t=([A-Za-z0-9_-]+)/)![1]);
    await h.app.orders.initiatePayment(order.id, token, '677001122');
    const ref = (await h.app.store.getOrder(order.id))!.payment.reference!;
    h.app.sim.approve(ref);
    await h.app.handlePaymentReference(ref);
    await tick();
    await tick();
    const offer = h.sent.find((s) => s.method === 'sendMessage' && s.payload.chat_id === rider.telegramId);
    assert.ok(offer, 'rider received an offer');
    assert.equal(offer.payload.reply_markup.inline_keyboard[0][0].callback_data, `r:claim:${order.id}`);
    assert.ok(h.sent.some((s) => s.method === 'sendMessage' && s.payload.chat_id === M && /Paiement reçu/.test(s.payload.text)));

    await h.press(rider.telegramId, `r:claim:${order.id}`);
    await h.press(rider.telegramId, `r:pickup:${order.id}`);
    await h.press(rider.telegramId, `r:deliver:${order.id}`);
    await h.text(rider.telegramId, '99999');
    assert.match(h.lastText(), /incorrect/);
    await h.text(rider.telegramId, releaseCode(h.app, order));
    assert.ok(h.sent.some((s) => s.payload.chat_id === rider.telegramId && /Livraison confirmée/.test(s.payload.text ?? '')));
    assert.equal((await h.app.store.getOrder(order.id))!.status, 'SETTLED');
    await tick();
    assert.ok(h.sent.some((s) => s.payload.chat_id === M && /14.625 FCFA envoyés/.test(s.payload.text ?? '')));
  });

  it('a second rider pressing accept is told the job is taken', async () => {
    const h = harness();
    await h.contact(601, { phone_number: '671000601', first_name: 'M', user_id: 601 });
    const merchant = (await h.app.store.getUserByTelegram(601))!;
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
