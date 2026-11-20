import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Update, UserFromGetMe } from 'grammy/types';
import { AddressInfo } from 'node:net';
import { createBot } from '../src/bot/bot.js';
import { createServer, redactOrder } from '../src/api/server.js';
import { AppError } from '../src/domain/errors.js';
import { Order } from '../src/domain/types.js';
import { MemoryStore } from '../src/storage/memory.js';
import { TestApp, intraInput, makeApp, makeMerchant, makeRider, paidOrder, tick } from './helpers.js';

const MIN = 60_000;

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof AppError && e.code === code, `expected ${code}`);
}
const getOrder = async (app: TestApp, id: string) => (await app.store.getOrder(id))!;
async function patchOrder(app: TestApp, id: string, fn: (o: Order) => void) {
  await app.store.tx(async (repo) => {
    const o = (await repo.getOrder(id))!;
    fn(o);
    await repo.updateOrder(o);
  });
}
const backdate = (app: TestApp, id: string, ms: number) =>
  patchOrder(app, id, (o) => { for (const h of o.history) h.at = new Date(Date.parse(h.at) - ms).toISOString(); });
const jpeg = (n = 600) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, 1)]);

async function pickedUp(app: TestApp, input = intraInput()) {
  const merchant = await makeMerchant(app);
  const rider = await makeRider(app, { floatBalance: 50000 });
  const p = await paidOrder(app, merchant, input);
  await app.orders.claim(rider.telegramId, p.order.id);
  await app.orders.confirmPickup(rider.telegramId, p.order.id);
  return { ...p, merchant, rider };
}

describe('security fixes (backend)', () => {
  it('1. COD: the buyer cannot confirm receipt, and the UI says so', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app, { floatBalance: 50000 });
    const cod = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
    await app.orders.claim(rider.telegramId, cod.order.id);
    await app.orders.confirmPickup(rider.telegramId, cod.order.id);
    await backdate(app, cod.order.id, 60 * MIN);
    await rejects(app.orders.buyerConfirmReceived(cod.order.id, cod.buyerToken), 'COD_CONFIRM_BY_RIDER');
    assert.equal((await app.orders.buyerView(cod.order.id, cod.buyerToken)).can.confirmReceived, false);
    assert.equal((await getOrder(app, cod.order.id)).status, 'IN_TRANSIT');
  });

  it('2a. the seller cannot pay their own order (own or payout number)', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app, { phone: '+237677001122', payoutPhone: '+237699887766' });
    const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
    await rejects(app.orders.initiatePayment(order.id, buyerToken, '677001122'), 'PAYER_IS_SELLER');
    await rejects(app.orders.initiatePayment(order.id, buyerToken, '699 88 77 66'), 'PAYER_IS_SELLER');
    const ok = await app.orders.initiatePayment(order.id, buyerToken, '655443322');
    assert.ok(ok.sessionToken);
  });

  it('2b. Telegram link: no overwrite of a different account; once paid, only the paying device may mint a link', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const { order, buyerToken, sessionToken } = await paidOrder(app, merchant);
    await rejects(app.orders.createFollowLink(order.id, buyerToken), 'FORBIDDEN');
    await rejects(app.orders.createFollowLink(order.id, buyerToken, 'x'.repeat(30)), 'FORBIDDEN');

    const a = await app.orders.createFollowLink(order.id, buyerToken, sessionToken);
    await app.orders.linkBuyerTelegram(a.payload, 111, 'fr');
    const b = await app.orders.createFollowLink(order.id, buyerToken, sessionToken);
    await rejects(app.orders.linkBuyerTelegram(b.payload, 222, 'fr'), 'ALREADY_LINKED');
    assert.equal((await getOrder(app, order.id)).buyerTelegramId, 111);
    const again = await app.orders.linkBuyerTelegram(b.payload, 111, 'fr'); // same account: idempotent
    assert.equal(again.buyerTelegramId, 111);
  });

  it('2c. buyer "I received it" needs 20 min after pickup, then tells seller, rider and admins', async () => {
    const app = makeApp();
    const { order, buyerToken, sessionToken } = await pickedUp(app);
    await assert.rejects(app.orders.buyerConfirmReceived(order.id, buyerToken, sessionToken), (e: any) => e.code === 'TOO_EARLY' && /\d+ min/.test(e.message));
    await backdate(app, order.id, 19 * MIN);
    await rejects(app.orders.buyerConfirmReceived(order.id, buyerToken, sessionToken), 'TOO_EARLY');
    await backdate(app, order.id, 2 * MIN);
    const v = await app.orders.buyerConfirmReceived(order.id, buyerToken, sessionToken);
    assert.equal(v.status, 'SETTLED');
    await tick();
    assert.equal(app.events.history.filter((e) => e.type === 'order.buyer_confirmed').length, 1);
  });

  it('2d. paid escrow: dispute, evidence and arrival need the paying device; can.* follows', async () => {
    const app = makeApp();
    const { order, buyerToken, sessionToken } = await pickedUp(app);
    const other = await app.orders.buyerView(order.id, buyerToken);
    assert.equal(other.can.dispute, false);
    assert.equal(other.can.confirmReceived, false);
    assert.equal((await app.orders.buyerView(order.id, buyerToken, sessionToken)).can.dispute, true);
    await rejects(app.orders.buyerOpenDispute(order.id, buyerToken, 'Not what I ordered'), 'FORBIDDEN');
    await rejects(app.orders.buyerOpenDispute(order.id, buyerToken, 'Not what I ordered', 'y'.repeat(30)), 'FORBIDDEN');
    await app.orders.buyerOpenDispute(order.id, buyerToken, 'Not what I ordered', sessionToken);
    await rejects(app.orders.buyerAddEvidence(order.id, buyerToken, 'image/jpeg', jpeg()), 'FORBIDDEN');
    assert.equal((await app.orders.buyerView(order.id, buyerToken)).can.addEvidence, false);
    await app.orders.buyerAddEvidence(order.id, buyerToken, 'image/jpeg', jpeg(), sessionToken);

  });

  it('3a. withdrawal: a thrown gateway error keeps the float debited, flags NEEDS_REVIEW and alerts admins', async () => {
    const app = makeApp();
    const rider = await makeRider(app, { floatBalance: 30000 });
    app.sim.throwingPayoutPhones.add(rider.phone);
    const res = await app.riders.withdrawFloat(rider.telegramId, 10000);
    assert.equal(res.topup.status, 'NEEDS_REVIEW');
    assert.match(res.message!, /vérification/i);
    assert.equal((await app.store.getRider(rider.id))!.floatBalance, 20000);
    assert.equal((await app.store.getTopup(res.topup.id))!.status, 'NEEDS_REVIEW');
    await tick();
    assert.equal(app.events.history.filter((e) => e.type === 'topup.attention').length, 1);
    assert.equal(await app.store.ledgerBalance('RIDER_FLOAT', rider.id), -10000); // journal not reversed
  });

  it('3b. withdrawal: explicit provider FAILED reverses; PENDING stays pending and resolves via the webhook path', async () => {
    const app = makeApp();
    const rider = await makeRider(app, { floatBalance: 30000 });
    app.sim.failingPayoutPhones.add(rider.phone);
    await rejects(app.riders.withdrawFloat(rider.telegramId, 5000), 'WITHDRAW_FAILED');
    assert.equal((await app.store.getRider(rider.id))!.floatBalance, 30000);
    app.sim.failingPayoutPhones.clear();

    app.sim.pendingPayoutPhones.add(rider.phone);
    const ok = await app.riders.withdrawFloat(rider.telegramId, 10000);
    assert.equal(ok.topup.status, 'PENDING');
    assert.ok(ok.topup.reference);
    assert.equal((await app.store.getRider(rider.id))!.floatBalance, 20000);
    app.sim.approve(ok.topup.reference!);
    await app.handlePaymentReference(ok.topup.reference!);
    assert.equal((await app.store.getTopup(ok.topup.id))!.status, 'CONFIRMED');
    assert.equal((await app.store.getRider(rider.id))!.floatBalance, 20000); // a withdrawal never credits the float
    await app.handlePaymentReference(ok.topup.reference!); // idempotent
    assert.equal((await app.store.getRider(rider.id))!.floatBalance, 20000);

    const bad = await app.riders.withdrawFloat(rider.telegramId, 4000);
    assert.equal((await app.store.getRider(rider.id))!.floatBalance, 16000);
    app.sim.fail(bad.topup.reference!);
    await app.handlePaymentReference(bad.topup.reference!);
    assert.equal((await app.store.getTopup(bad.topup.id))!.status, 'FAILED');
    assert.equal((await app.store.getRider(rider.id))!.floatBalance, 20000);
    await app.handlePaymentReference(bad.topup.reference!);
    assert.equal((await app.store.getRider(rider.id))!.floatBalance, 20000); // reversed once only
    assert.equal(await app.store.ledgerBalance('RIDER_FLOAT', rider.id), -10000); // only the confirmed withdrawal is still booked
  });

  it('3c. payout: a thrown gateway error goes to NEEDS_REVIEW (no retry); an explicit FAILED keeps the retry path', async () => {
    const app = makeApp();
    const p = await pickedUp(app);
    app.sim.throwingPayoutPhones.add(p.merchant.phone);
    app.sim.failingPayoutPhones.add(p.rider.phone);
    const code = app.secrets.decrypt((await getOrder(app, p.order.id)).releaseCodeEnc);
    await app.orders.deliver(p.rider.telegramId, p.order.id, code);
    const o = await getOrder(app, p.order.id);
    const merchantPayout = o.payouts.find((x) => x.kind === 'MERCHANT')!;
    const riderPayout = o.payouts.find((x) => x.kind === 'FIRST_MILE_RIDER')!;
    assert.equal(merchantPayout.status, 'NEEDS_REVIEW');
    assert.equal(merchantPayout.attempts, 1);
    assert.equal(riderPayout.status, 'FAILED');
    await tick();
    assert.ok(app.events.history.some((e) => e.type === 'payout.attention'));
    // The scheduler must not touch the ambiguous one again.
    await app.orders.processPayouts(p.order.id, Date.now() + 3600_000);
    assert.equal((await getOrder(app, p.order.id)).payouts.find((x) => x.kind === 'MERCHANT')!.attempts, 1);
  });

  it('4. absence needs a fresh live location within 250 m of the drop-off', async () => {
    const app = makeApp();
    const { order, buyerToken, rider } = await pickedUp(app);
    await app.orders.updateDeliveryDetails(order.id, buyerToken, { dropoffLocation: { lat: 4.0511, lng: 9.7085 } });
    const stale = new Date(Date.now() - 10 * MIN).toISOString();
    const r = (await app.store.getRider(rider.id))!;
    await app.store.updateRider({ ...r, locationUpdatedAt: stale });
    await rejects(app.orders.riderReportBuyerAbsent(rider.telegramId, order.id), 'LOCATION_STALE');

    await app.riders.updateLocation(rider.telegramId, { lat: 4.0611, lng: 9.7085 }); // ~1.1 km away
    await assert.rejects(app.orders.riderReportBuyerAbsent(rider.telegramId, order.id), (e: any) => e.code === 'TOO_FAR' && /\d+ m/.test(e.message));
    await rejects(app.orders.riderReturnParcel(rider.telegramId, order.id, 'ABSENT'), 'TOO_FAR');

    await app.riders.updateLocation(rider.telegramId, { lat: 4.0512, lng: 9.7086 });
    const absent = await app.orders.riderReportBuyerAbsent(rider.telegramId, order.id);
    assert.equal(absent.absence?.side, 'BUYER');

    // No drop-off pin: still allowed, position recorded.
    const app2 = makeApp();
    const q = await pickedUp(app2);
    const a2 = await app2.orders.riderReportBuyerAbsent(q.rider.telegramId, q.order.id);
    assert.ok(a2.absence?.location);
  });

  it('5. bot ignores group chats: one polite reply, callbacks answered, no session created', async () => {
    const app = makeApp();
    const botInfo = { id: 1, is_bot: true, first_name: 'B', username: 'b_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as UserFromGetMe;
    const bot = createBot(app, 'test-token', { botInfo });
    const sent: Array<{ method: string; payload: any }> = [];
    bot.api.config.use(async (_prev, method, payload) => {
      sent.push({ method, payload });
      return { ok: true, result: true } as any;
    });
    const grp = { id: -100123, type: 'supergroup' as const, title: 'G' };
    const from = { id: 7, is_bot: false, first_name: 'X' };
    const msg = (id: number): Update => ({ update_id: id, message: { message_id: id, date: 0, chat: grp, from, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } }) as Update;
    await bot.handleUpdate(msg(1));
    await bot.handleUpdate(msg(2));
    const replies = sent.filter((s) => s.method === 'sendMessage');
    assert.equal(replies.length, 1);
    assert.match(replies[0].payload.text, /message privé/);
    await bot.handleUpdate({ update_id: 3, callback_query: { id: '3', from, chat_instance: 'x', data: 'menu:orders', message: { message_id: 1, date: 0, chat: grp } } } as Update);
    assert.equal(sent.filter((s) => s.method === 'answerCallbackQuery').length, 1);
    assert.equal(sent.filter((s) => s.method === 'sendMessage').length, 1);
    assert.equal(await app.store.getBotSession(`tg:${grp.id}`), undefined);
  });

  it('7. bot sessions older than the cut-off are purged; fresh ones stay', async () => {
    const store = new MemoryStore();
    await store.setBotSession('tg:1', { a: 1 });
    assert.equal(await store.purgeBotSessions(new Date(Date.now() - 7 * 86_400_000).toISOString()), 0);
    assert.deepEqual(await store.getBotSession('tg:1'), { a: 1 });
    assert.equal(await store.purgeBotSessions(new Date(Date.now() + 1000).toISOString()), 1);
    assert.equal(await store.getBotSession('tg:1'), undefined);
  });

  it('8. evidence is sniffed by magic bytes; voice notes tolerate mime params and replace the old media', async () => {
    const app = makeApp();
    const { order, buyerToken, sessionToken } = await pickedUp(app);
    await app.orders.buyerOpenDispute(order.id, buyerToken, 'Wrong item', sessionToken);
    await rejects(app.orders.buyerAddEvidence(order.id, buyerToken, 'image/jpeg', Buffer.alloc(800, 1), sessionToken), 'INVALID'); // not an image
    await rejects(app.orders.buyerAddEvidence(order.id, buyerToken, 'text/html', jpeg(), sessionToken), 'INVALID');
    await rejects(app.orders.buyerAddEvidence(order.id, buyerToken, 'image/heic', jpeg(), sessionToken), 'INVALID');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(800, 2)]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(800, 3)]);
    // declared jpeg, actually png: stored as png
    await app.orders.buyerAddEvidence(order.id, buyerToken, 'image/jpeg', png, sessionToken);
    await app.orders.buyerAddEvidence(order.id, buyerToken, 'image/webp', webp, sessionToken);
    await app.orders.buyerAddEvidence(order.id, buyerToken, 'image/png', jpeg(), sessionToken);
    const ev = (await getOrder(app, order.id)).dispute!.evidence!;
    assert.deepEqual(await Promise.all(ev.map(async (id) => (await app.store.getMedia(id))!.mime)), ['image/png', 'image/webp', 'image/jpeg']);

    const m2 = await makeMerchant(app);
    const o2 = await app.orders.createOrder(m2, intraInput());
    await app.orders.attachVoiceNote(o2.order.id, o2.buyerToken, 'Audio/WebM; codecs=opus', Buffer.alloc(500, 1));
    const first = (await getOrder(app, o2.order.id)).voiceNoteId!;
    assert.equal((await app.store.getMedia(first))!.mime, 'audio/webm');
    await app.orders.attachVoiceNote(o2.order.id, o2.buyerToken, 'audio/ogg', Buffer.alloc(500, 1));
    assert.equal(await app.store.getMedia(first), undefined);
    assert.ok(await app.store.getMedia((await getOrder(app, o2.order.id)).voiceNoteId!));
  });

  it('9/10. headers, CSP, limit clamp and redaction over HTTP', async () => {
    const app = makeApp();
    const server = createServer(app, { webDir: process.cwd() }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const merchant = await makeMerchant(app);
      const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
      const co = await fetch(`${base}/api/checkout/${order.id}`, { headers: { 'x-buyer-token': buyerToken } });
      assert.equal(co.headers.get('cache-control'), 'no-store');
      const adm = await fetch(`${base}/api/admin/orders`, { headers: { authorization: 'Bearer admin-key-admin-key-admin-key' } });
      assert.equal(adm.headers.get('cache-control'), 'no-store');
      const unauth = await fetch(`${base}/api/admin/orders`);
      assert.equal(unauth.status, 401);
      assert.equal((await unauth.json()).error, 'ADMIN_AUTH_REQUIRED');

      const big = await fetch(`${base}/api/admin/orders?limit=99999999`, { headers: { authorization: 'Bearer admin-key-admin-key-admin-key' } });
      assert.equal(big.status, 200);
      const neg = await fetch(`${base}/api/admin/users?limit=-5`, { headers: { authorization: 'Bearer admin-key-admin-key-admin-key' } });
      assert.equal(neg.status, 200);

      const csp = (await fetch(`${base}/package.json`)).headers.get('content-security-policy') ?? '';
      assert.match(csp, /script-src 'self' 'unsafe-inline'(;|$)/);
      assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
      assert.doesNotMatch(csp, /unpkg|tailwindcss/);
      for (const d of ["base-uri 'self'", "form-action 'self'", "object-src 'none'", 'tile.openstreetmap.org']) assert.ok(csp.includes(d), d);
      const redacted = redactOrder({
        ...(await getOrder(app, order.id)), followTokenHash: 'h', followSessionHash: 'h', followTokenExpiresAt: 'x', payment: { pendingSessionHash: 'h' } as any
      } as Order) as Record<string, any>;
      for (const k of ['followTokenHash', 'followSessionHash', 'followTokenExpiresAt', 'buyerTokenHash', 'releaseCodeEnc']) assert.equal(k in redacted, false, k);
      assert.equal('pendingSessionHash' in redacted.payment, false);
    } finally {
      server.close();
    }
  });
});
