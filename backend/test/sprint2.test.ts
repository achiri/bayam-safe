import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createServer } from '../src/api/server.js';
import { AppError } from '../src/domain/errors.js';
import { newId } from '../src/domain/secrets.js';
import { FloatTopup, Order, User } from '../src/domain/types.js';
import { SELLER_DEBT_COD_LIMIT } from '../src/domain/money.js';
import { TestApp, intraInput, makeApp, makeMerchant, makeRider, paidOrder, releaseCode, tick } from './helpers.js';

const MIN = 60_000;
const HOUR = 3_600_000;

const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof AppError && e.code === code, `expected ${code}`);
const getOrder = async (app: TestApp, id: string) => (await app.store.getOrder(id))!;
const getUser = async (app: TestApp, id: string) => (await app.store.getUser(id))!;
const getRider = async (app: TestApp, id: string) => (await app.store.getRider(id))!;
const kp = (o: Order) => o.payouts.map((p) => [p.kind, p.amount] as [string, number]);

async function patchUser(app: TestApp, id: string, fn: (u: User) => void) {
  await app.store.tx(async (repo) => {
    const u = (await repo.getUser(id))!;
    fn(u);
    await repo.updateUser(u);
  });
}
async function patchOrder(app: TestApp, id: string, fn: (o: Order) => void) {
  await app.store.tx(async (repo) => {
    const o = (await repo.getOrder(id))!;
    fn(o);
    await repo.updateOrder(o);
  });
}

/** Every journal touching this order or seller sums to zero (the store enforces it) and the global ledger nets to zero. */
async function assertLedgerNetsToZero(app: TestApp) {
  const accounts = ['GATEWAY_CLEARING', 'ESCROW', 'MERCHANT_PAYABLE', 'RIDER_PAYABLE', 'BUYER_REFUND_PAYABLE', 'PLATFORM_REVENUE', 'RIDER_FLOAT', 'MERCHANT_RECEIVABLE', 'PLATFORM_WRITE_OFF'] as const;
  let sum = 0;
  for (const a of accounts) sum += await app.store.ledgerBalance(a);
  assert.equal(sum, 0);
}

/** An escrow order the seller's own rider (when `preferred`) has picked up. */
async function pickedUpOrder(app: TestApp, merchant: User, rider: { telegramId: number; riderCode: string }, opts: { preferred?: boolean; cod?: boolean } = {}) {
  const input = intraInput({ ...(opts.preferred ? { preferredRiderCode: rider.riderCode } : {}), ...(opts.cod ? { paymentMode: 'COD' as const } : {}) });
  let created: { order: Order; buyerToken: string; sessionToken?: string };
  if (opts.cod) created = await app.orders.createOrder(merchant, input);
  else created = await paidOrder(app, merchant, input);
  await app.orders.claim(rider.telegramId, created.order.id);
  await app.orders.confirmPickup(rider.telegramId, created.order.id);
  return { ...created, order: await getOrder(app, created.order.id) };
}

describe('Sprint 2 (memory store)', () => {
  // ------------------------------------------------------------------ BS-401
  it('BS-401: failed delivery by the seller own rider -> buyer refunded in full, riders charged to the seller', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app);
    const { order } = await pickedUpOrder(app, merchant, rider, { preferred: true });
    assert.equal(order.sellerChoseRider, true);
    await app.orders.riderReturnParcel(rider.telegramId, order.id, 'REFUSED');
    const done = await app.orders.sellerConfirmReturn(order.id, merchant.id);
    assert.equal(done.status, 'REFUNDED');
    assert.deepEqual(kp(done), [['BUYER_REFUND', 21500], ['FIRST_MILE_RIDER', 1500]]);
    assert.equal((await getUser(app, merchant.id)).owedToPlatform, 1500);
    assert.equal(await app.store.ledgerBalance('MERCHANT_RECEIVABLE', merchant.id), -1500);
    assert.equal(await app.store.ledgerBalance('ESCROW', order.id), 0);
    await assertLedgerNetsToZero(app);
  });

  it('BS-401: absent buyer after the seller own rider waited: same rule, also through the admin', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app);
    const { order } = await pickedUpOrder(app, merchant, rider, { preferred: true });
    await app.orders.riderReportBuyerAbsent(rider.telegramId, order.id);
    await patchOrder(app, order.id, (o) => { o.absence!.at = new Date(Date.now() - 16 * MIN).toISOString(); });
    await app.orders.riderReturnParcel(rider.telegramId, order.id, 'ABSENT');
    const done = await app.orders.resolveDispute(order.id, 'REFUND_BUYER', 'admin check', { markReturnReceived: true });
    assert.deepEqual(kp(done), [['BUYER_REFUND', 21500], ['FIRST_MILE_RIDER', 1500]]);
    assert.equal((await getUser(app, merchant.id)).owedToPlatform, 1500);
  });

  it('BS-401: an ordinary rider (not the seller choice) still has the legs deducted from the buyer refund', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app);
    const { order } = await pickedUpOrder(app, merchant, rider);
    assert.ok(!order.sellerChoseRider);
    await app.orders.riderReturnParcel(rider.telegramId, order.id, 'REFUSED');
    const done = await app.orders.sellerConfirmReturn(order.id, merchant.id);
    assert.deepEqual(kp(done), [['BUYER_REFUND', 20000], ['FIRST_MILE_RIDER', 1500]]);
    assert.ok(!(await getUser(app, merchant.id)).owedToPlatform);
  });

  it('BS-401: if the chosen rider releases the job, the next rider is not the seller choice', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const chosen = await makeRider(app);
    const other = await makeRider(app);
    const created = await paidOrder(app, merchant, intraInput({ preferredRiderCode: chosen.riderCode }));
    await app.orders.claim(chosen.telegramId, created.order.id);
    assert.equal((await getOrder(app, created.order.id)).sellerChoseRider, true);
    await app.orders.unassign(chosen.telegramId, created.order.id);
    const released = await getOrder(app, created.order.id);
    assert.ok(!released.sellerChoseRider);
    assert.equal(released.preferredRiderId, undefined);
    await app.orders.claim(other.telegramId, created.order.id);
    assert.ok(!(await getOrder(app, created.order.id)).sellerChoseRider);
  });

  // ------------------------------------------------------------------ BS-403
  it('BS-403: buyer cancel at RIDER_ASSIGNED pays the rider half the fee out of the refund; cancelFee is exposed', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app);
    const { order, buyerToken, sessionToken } = await paidOrder(app, merchant, intraInput({ deliveryFee: 1501 }));
    const before = await app.orders.buyerView(order.id, buyerToken, sessionToken);
    assert.equal(before.can.cancel, true);
    assert.equal(before.cancelFee, undefined); // no rider yet: free
    await app.orders.claim(rider.telegramId, order.id);
    const view = await app.orders.buyerView(order.id, buyerToken, sessionToken);
    assert.equal(view.cancelFee, 750); // floor(1501 / 2)
    const after = await app.orders.buyerCancel(order.id, buyerToken, sessionToken);
    assert.equal(after.status, 'REFUNDED');
    assert.equal(after.cancelFee, undefined);
    const o = await getOrder(app, order.id);
    assert.deepEqual(kp(o), [['BUYER_REFUND', 21501 - 750], ['FIRST_MILE_RIDER', 750]]);
    assert.ok(!(await getUser(app, merchant.id)).owedToPlatform); // the seller pays nothing
    assert.equal(await app.store.ledgerBalance('ESCROW', order.id), 0);
    assert.deepEqual(o.payouts.map((p) => p.status), ['SENT', 'SENT']);
    assert.equal(await app.store.ledgerBalance('RIDER_PAYABLE', order.id), 0); // paid out
    await assertLedgerNetsToZero(app);
  });

  it('BS-403: buyer cancel from Telegram has the same fee; admin cancel pays nothing; COD buyer cancel changes nothing', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app, { floatBalance: 100_000 });

    const a = await paidOrder(app, merchant);
    const link = await app.orders.createFollowLink(a.order.id, a.buyerToken, a.sessionToken);
    await app.orders.linkBuyerTelegram(link.payload, 555, 'fr');
    await app.orders.claim(rider.telegramId, a.order.id);
    const tgCancel = await app.orders.buyerCancelFromTelegram(a.order.id, 555);
    assert.deepEqual(kp(tgCancel), [['BUYER_REFUND', 20750], ['FIRST_MILE_RIDER', 750]]);

    const b = await paidOrder(app, merchant);
    await app.orders.claim(rider.telegramId, b.order.id);
    const adminCancel = await app.orders.cancel(b.order.id, { admin: true });
    assert.deepEqual(kp(adminCancel), [['BUYER_REFUND', 21500]]);

    const c = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
    await app.orders.claim(rider.telegramId, c.order.id);
    const v = await app.orders.buyerView(c.order.id, c.buyerToken);
    assert.equal(v.cancelFee, 0);
    const codCancel = await app.orders.buyerCancel(c.order.id, c.buyerToken);
    assert.equal(codCancel.status, 'CANCELLED');
    const co = await getOrder(app, c.order.id);
    assert.deepEqual(co.payouts, []);
    assert.equal((await getRider(app, rider.id)).floatReserved, 0);
    assert.ok(!(await getUser(app, merchant.id)).owedToPlatform);
    await assertLedgerNetsToZero(app);
  });

  // ------------------------------------------------------------------ BS-404
  it('BS-404: COD buyer absent or refused -> rider gets the delivery fee, charged to the seller; refusal strike stays', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app, { floatBalance: 100_000 });
    const { order } = await pickedUpOrder(app, merchant, rider, { cod: true });
    const refused = await app.orders.riderReturnParcel(rider.telegramId, order.id, 'REFUSED');
    assert.ok(refused.buyerRefusalAt);
    const done = await app.orders.sellerConfirmReturn(order.id, merchant.id);
    assert.equal(done.status, 'REFUNDED');
    assert.deepEqual(done.payouts.map((p) => [p.kind, p.amount, p.status, p.phone]), [['FIRST_MILE_RIDER', 1500, 'SENT', rider.phone]]);
    assert.ok(done.buyerRefusalAt);
    assert.equal((await getUser(app, merchant.id)).owedToPlatform, 1500);
    assert.equal((await getRider(app, rider.id)).floatReserved, 0);
    await assertLedgerNetsToZero(app);

    // through the admin as well
    const second = await pickedUpOrder(app, merchant, rider, { cod: true });
    await app.orders.riderReportBuyerAbsent(rider.telegramId, second.order.id);
    await patchOrder(app, second.order.id, (o) => { o.absence!.at = new Date(Date.now() - 16 * MIN).toISOString(); });
    await app.orders.riderReturnParcel(rider.telegramId, second.order.id, 'ABSENT');
    const viaAdmin = await app.orders.resolveDispute(second.order.id, 'REFUND_BUYER', 'ok', { markReturnReceived: true });
    assert.deepEqual(kp(viaAdmin), [['FIRST_MILE_RIDER', 1500]]);
    assert.equal((await getUser(app, merchant.id)).owedToPlatform, 3000);
  });

  // ------------------------------------------------------------------ BS-405
  it('BS-405: a seller over the limit cannot create COD orders (prepaid still fine); at the limit is allowed', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app, { owedToPlatform: SELLER_DEBT_COD_LIMIT });
    const ok = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
    assert.equal(ok.order.status, 'AWAITING_RIDER');
    await patchUser(app, merchant.id, (u) => { u.owedToPlatform = SELLER_DEBT_COD_LIMIT + 1; });
    const over = await getUser(app, merchant.id);
    await assert.rejects(app.orders.createOrder(over, intraInput({ paymentMode: 'COD' })), (e: unknown) => {
      return e instanceof AppError && e.code === 'SELLER_DEBT_PREPAID_ONLY' && e.httpStatus === 409 && /10[\s  ]001/.test(e.message);
    });
    const escrow = await app.orders.createOrder(over, intraInput());
    assert.equal(escrow.order.status, 'PENDING_PAYMENT');
  });

  it('BS-405: write-off lowers the debt with a balanced journal; validates amount and note', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app, { owedToPlatform: 5000 });
    await rejects(app.users.writeOffDebt(merchant.id, 0, 'goodwill'), 'INVALID');
    await rejects(app.users.writeOffDebt(merchant.id, 5001, 'goodwill'), 'INVALID');
    await rejects(app.users.writeOffDebt(merchant.id, 1.5, 'goodwill'), 'INVALID');
    await rejects(app.users.writeOffDebt(merchant.id, 100, ''), 'INVALID');
    await rejects(app.users.writeOffDebt('nope', 100, 'goodwill'), 'NOT_FOUND');
    assert.equal((await getUser(app, merchant.id)).owedToPlatform, 5000);

    const u = await app.users.writeOffDebt(merchant.id, 2000, 'customer goodwill');
    assert.equal(u.owedToPlatform, 3000);
    assert.equal(await app.store.ledgerBalance('PLATFORM_WRITE_OFF', merchant.id), -2000);
    assert.equal(await app.store.ledgerBalance('MERCHANT_RECEIVABLE', merchant.id), 2000);
    const journals = await app.store.listJournals(merchant.id);
    assert.equal(journals.length, 1);
    assert.equal(journals[0].lines.reduce((s, l) => s + l.amount, 0), 0);
    await assertLedgerNetsToZero(app);

    // a second write-off books its own journal (new key), and can clear the debt completely
    const cleared = await app.users.writeOffDebt(merchant.id, 3000, 'rest');
    assert.equal(cleared.owedToPlatform, 0);
    assert.equal((await app.store.listJournals(merchant.id)).length, 2);
    await rejects(app.users.writeOffDebt(merchant.id, 1, 'again'), 'INVALID');
  });

  // ------------------------------------------------------------------ BS-402
  it('BS-402: approval is bound to the number the admin saw (re-request in between -> CONFLICT)', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    await app.users.requestPayoutPhone(merchant.telegramId, '677 55 44 33');
    await app.users.requestPayoutPhone(merchant.telegramId, '699 11 22 33'); // changed after the admin loaded the list
    await rejects(app.users.decidePayoutPhone(merchant.id, true, new Date(), '+237677554433'), 'CONFLICT');
    const ok = await app.users.decidePayoutPhone(merchant.id, true, new Date(), '+237699112233');
    assert.ok(ok.payoutPhoneEffectiveAt);
  });

  it('BS-402: approval schedules the change 24 h out; payouts keep going to the old number; activation notifies', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app);
    await app.users.requestPayoutPhone(merchant.telegramId, '677 55 44 33');
    const approved = await app.users.decidePayoutPhone(merchant.id, true);
    assert.equal(approved.payoutPhone, undefined);
    assert.equal(approved.pendingPayoutPhone, '+237677554433');
    const eta = Date.parse(approved.payoutPhoneEffectiveAt!);
    assert.ok(Math.abs(eta - (Date.now() + 24 * HOUR)) < 5_000);
    await rejects(app.users.decidePayoutPhone(merchant.id, true), 'INVALID'); // already approved
    await tick();
    assert.equal(app.events.history.filter((e) => e.type === 'payout_phone.decided').length, 1);

    // a sale settling during the 24 h still pays the old number
    const { order, buyerToken } = await paidOrder(app, merchant);
    await app.orders.claim(rider.telegramId, order.id);
    await app.orders.confirmPickup(rider.telegramId, order.id);
    await app.orders.deliver(rider.telegramId, order.id, releaseCode(app, order));
    const settled = await getOrder(app, order.id);
    assert.equal(settled.payouts.find((p) => p.kind === 'MERCHANT')!.phone, merchant.phone);
    void buyerToken;

    // too early: nothing happens
    assert.equal(await app.users.activateDuePayoutPhones(new Date(Date.now() + 23 * HOUR)), 0);
    assert.equal((await getUser(app, merchant.id)).payoutPhone, undefined);
    // 24 h later the job applies it
    assert.equal(await app.users.activateDuePayoutPhones(new Date(Date.now() + 25 * HOUR)), 1);
    const after = await getUser(app, merchant.id);
    assert.equal(after.payoutPhone, '+237677554433');
    assert.equal(after.pendingPayoutPhone, undefined);
    assert.equal(after.payoutPhoneEffectiveAt, undefined);
    assert.ok(after.payoutPhoneChangedAt);
    await tick();
    assert.equal(app.events.history.filter((e) => e.type === 'payout_phone.activated').length, 1);
    assert.equal(await app.users.activateDuePayoutPhones(new Date(Date.now() + 26 * HOUR)), 0); // once only
  });

  it('BS-402: a rejected request is dropped at once; a new request resets a scheduled one', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    await app.users.requestPayoutPhone(merchant.telegramId, '677554433');
    const rejected = await app.users.decidePayoutPhone(merchant.id, false);
    assert.equal(rejected.pendingPayoutPhone, undefined);
    await app.users.requestPayoutPhone(merchant.telegramId, '677554433');
    await app.users.decidePayoutPhone(merchant.id, true);
    const again = await app.users.requestPayoutPhone(merchant.telegramId, '699887766');
    assert.equal(again.pendingPayoutPhone, '+237699887766');
    assert.equal(again.payoutPhoneEffectiveAt, undefined);
  });

  it('BS-402: rider withdrawals pause while a change is pending and for 24 h after activation; rider phone follows activation', async () => {
    const app = makeApp();
    const rider = await makeRider(app, { floatBalance: 30_000 });
    await app.riders.withdrawFloat(rider.telegramId, 1_000); // fine before any change
    await app.users.requestPayoutPhone(rider.telegramId, '677 55 44 33');
    await rejects(app.riders.withdrawFloat(rider.telegramId, 1_000), 'PAYOUT_CHANGE_HOLD'); // awaiting approval
    await app.users.decidePayoutPhone(rider.userId, true);
    await rejects(app.riders.withdrawFloat(rider.telegramId, 1_000), 'PAYOUT_CHANGE_HOLD'); // scheduled
    assert.equal((await getRider(app, rider.id)).phone, rider.phone); // old number until activation

    await app.users.activateDuePayoutPhones(new Date(Date.now() + 25 * HOUR));
    assert.equal((await getRider(app, rider.id)).phone, '+237677554433');
    await rejects(app.riders.withdrawFloat(rider.telegramId, 1_000), 'PAYOUT_CHANGE_HOLD'); // 24 h hold after activation
    await patchUser(app, rider.userId, (u) => { u.payoutPhoneChangedAt = new Date(Date.now() - 25 * HOUR).toISOString(); });
    const w = await app.riders.withdrawFloat(rider.telegramId, 1_000);
    assert.equal(w.topup.phone, '+237677554433');
    assert.equal(app.sim.withdrawals.at(-1)!.phone, '+237677554433');
  });

  it('BS-402: withdrawFloat applies a due change lazily (no job needed)', async () => {
    const app = makeApp();
    const rider = await makeRider(app, { floatBalance: 30_000 });
    await app.users.requestPayoutPhone(rider.telegramId, '677554433');
    await app.users.decidePayoutPhone(rider.userId, true);
    await patchUser(app, rider.userId, (u) => {
      u.payoutPhoneEffectiveAt = new Date(Date.now() - 1 * MIN).toISOString();
    });
    await rejects(app.riders.withdrawFloat(rider.telegramId, 1_000), 'PAYOUT_CHANGE_HOLD'); // just activated: hold starts now
    assert.equal((await getUser(app, rider.userId)).payoutPhone, '+237677554433');
  });

  // ------------------------------------------------------------------ BS-406
  it('BS-406: rider phone only after pickup, and for escrow only on the paying device (COD: any device)', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app, { floatBalance: 100_000 });

    const e = await paidOrder(app, merchant);
    await app.orders.claim(rider.telegramId, e.order.id);
    assert.equal((await app.orders.buyerView(e.order.id, e.buyerToken, e.sessionToken)).rider!.phone, undefined);
    await app.orders.confirmPickup(rider.telegramId, e.order.id);
    assert.equal((await app.orders.buyerView(e.order.id, e.buyerToken, e.sessionToken)).rider!.phone, rider.phone);
    assert.equal((await app.orders.buyerView(e.order.id, e.buyerToken)).rider!.phone, undefined);
    assert.equal((await app.orders.buyerView(e.order.id, e.buyerToken, 'z'.repeat(30))).rider!.phone, undefined);
    assert.ok((await app.orders.buyerView(e.order.id, e.buyerToken)).rider!.riderCode); // name, plate, code stay visible

    const c = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
    await app.orders.claim(rider.telegramId, c.order.id);
    assert.equal((await app.orders.buyerView(c.order.id, c.buyerToken)).rider!.phone, undefined);
    await app.orders.confirmPickup(rider.telegramId, c.order.id);
    assert.equal((await app.orders.buyerView(c.order.id, c.buyerToken)).rider!.phone, rider.phone);
  });

  // ------------------------------------------------------------------ BS-407
  const withdrawal = async (app: TestApp, riderId: string, patch: Partial<FloatTopup>) => {
    const now = new Date().toISOString();
    const t: FloatTopup = { id: newId(), kind: 'WITHDRAWAL', riderId, amount: 4000, phone: '+237690000001', status: 'SENDING', createdAt: now, updatedAt: now, ...patch };
    await app.store.insertTopup(t);
    return t;
  };

  it('BS-407: sweeper confirms a PENDING withdrawal the provider finished, reverses one it failed, leaves the rest', async () => {
    const app = makeApp();
    const rider = await makeRider(app, { floatBalance: 30_000 });
    app.sim.pendingPayoutPhones.add(rider.phone);
    const ok = await app.riders.withdrawFloat(rider.telegramId, 4_000);
    const bad = await app.riders.withdrawFloat(rider.telegramId, 3_000);
    const waiting = await app.riders.withdrawFloat(rider.telegramId, 2_000);
    assert.equal(ok.topup.status, 'PENDING');
    assert.equal((await getRider(app, rider.id)).floatBalance, 21_000);
    app.sim.approve(ok.topup.reference!);
    app.sim.fail(bad.topup.reference!);

    const res = await app.riders.sweepWithdrawals();
    assert.equal(res.checked, 3);
    assert.equal((await app.store.getTopup(ok.topup.id))!.status, 'CONFIRMED');
    assert.equal((await app.store.getTopup(bad.topup.id))!.status, 'FAILED');
    assert.equal((await app.store.getTopup(waiting.topup.id))!.status, 'PENDING');
    assert.equal((await getRider(app, rider.id)).floatBalance, 21_000 + 3_000);
    await app.riders.sweepWithdrawals(); // idempotent
    assert.equal((await getRider(app, rider.id)).floatBalance, 24_000);
  });

  it('BS-407: sweeper flags a SENDING withdrawal older than 10 min as NEEDS_REVIEW and alerts admins once', async () => {
    const app = makeApp();
    const rider = await makeRider(app, { floatBalance: 30_000 });
    const stuck = await withdrawal(app, rider.id, { updatedAt: new Date(Date.now() - 11 * MIN).toISOString() });
    const fresh = await withdrawal(app, rider.id, { updatedAt: new Date(Date.now() - 2 * MIN).toISOString() });
    const res = await app.riders.sweepWithdrawals();
    assert.equal(res.flagged, 1);
    assert.equal((await app.store.getTopup(stuck.id))!.status, 'NEEDS_REVIEW');
    assert.equal((await app.store.getTopup(fresh.id))!.status, 'SENDING');
    await tick();
    assert.equal(app.events.history.filter((e) => e.type === 'topup.attention').length, 1);
    await app.riders.sweepWithdrawals();
    await tick();
    assert.equal(app.events.history.filter((e) => e.type === 'topup.attention').length, 1);
  });

  it('BS-407: resolve MARK_SENT keeps the float debited; REVERSE credits it back once; only NEEDS_REVIEW withdrawals', async () => {
    const app = makeApp();
    const rider = await makeRider(app, { floatBalance: 30_000 });
    app.sim.throwingPayoutPhones.add(rider.phone);
    const a = (await app.riders.withdrawFloat(rider.telegramId, 4_000)).topup;
    const b = (await app.riders.withdrawFloat(rider.telegramId, 6_000)).topup;
    assert.equal(a.status, 'NEEDS_REVIEW');
    assert.equal((await getRider(app, rider.id)).floatBalance, 20_000);

    await rejects(app.riders.resolveWithdrawal(a.id, 'MARK_SENT', ''), 'INVALID');
    const sent = await app.riders.resolveWithdrawal(a.id, 'MARK_SENT', 'seen in Campay', 'CP-123');
    assert.equal(sent.status, 'CONFIRMED');
    assert.equal(sent.reference, 'CP-123');
    assert.equal((await getRider(app, rider.id)).floatBalance, 20_000);
    await rejects(app.riders.resolveWithdrawal(a.id, 'REVERSE', 'oops'), 'CONFLICT');

    const rev = await app.riders.resolveWithdrawal(b.id, 'REVERSE', 'not in Campay');
    assert.equal(rev.status, 'FAILED');
    assert.equal((await getRider(app, rider.id)).floatBalance, 26_000);
    await rejects(app.riders.resolveWithdrawal(b.id, 'REVERSE', 'again'), 'CONFLICT');
    assert.equal((await getRider(app, rider.id)).floatBalance, 26_000);
    assert.equal(await app.store.ledgerBalance('RIDER_FLOAT', rider.id), -4_000);
    await assertLedgerNetsToZero(app);

    const plainTopup = await app.riders.requestTopup(rider.telegramId, 5_000);
    await rejects(app.riders.resolveWithdrawal(plainTopup.topup.id, 'MARK_SENT', 'x y z'), 'NOT_FOUND');
  });
});

// ==================================================================== HTTP: write-off and topup resolve
describe('Sprint 2 admin API', () => {
  let app: TestApp;
  let server: Server;
  let base: string;
  const auth = { authorization: 'Bearer admin-key-admin-key-admin-key' };

  before(async () => {
    app = makeApp();
    server = createServer(app, { webDir: path.resolve(__dirname, '../../web') }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const call = async (method: string, p: string, opts: { headers?: Record<string, string>; json?: unknown } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  it('write-off: needs admin auth, a whole amount within the debt and a note; audited with amount and note', async () => {
    const merchant = await makeMerchant(app, { owedToPlatform: 4000 });
    const url = `/api/admin/users/${merchant.id}/write-off`;
    assert.equal((await call('POST', url, { json: { amount: 100, note: 'x y z' } })).status, 401);
    assert.equal((await call('POST', url, { headers: auth, json: { amount: 100 } })).status, 400); // note required
    assert.equal((await call('POST', url, { headers: auth, json: { amount: 100, note: '  ' } })).status, 400);
    assert.equal((await call('POST', url, { headers: auth, json: { amount: '100', note: 'goodwill' } })).status, 400);
    assert.equal((await call('POST', url, { headers: auth, json: { amount: 0, note: 'goodwill' } })).status, 400);
    assert.equal((await call('POST', url, { headers: auth, json: { amount: 4001, note: 'goodwill' } })).status, 400);
    assert.equal((await call('POST', `/api/admin/users/nope/write-off`, { headers: auth, json: { amount: 1, note: 'goodwill' } })).status, 404);

    const ok = await call('POST', url, { headers: auth, json: { amount: 1500, note: 'goodwill after a dispute' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.owedToPlatform, 2500);
    assert.equal(ok.body.draft, undefined); // redacted user
    const audit = (await app.store.listAudit(20)).find((a) => a.action === 'debt.write_off' && a.target === merchant.id);
    assert.ok(audit);
    assert.match(audit!.note!, /1500 FCFA/);
    assert.match(audit!.note!, /goodwill after a dispute/);
    assert.equal(await app.store.ledgerBalance('PLATFORM_WRITE_OFF', merchant.id), -1500);
    const ledger = await call('GET', '/api/admin/ledger', { headers: auth });
    assert.equal(ledger.body.sum, 0);
    assert.equal(ledger.body.balances.PLATFORM_WRITE_OFF, -1500);
  });

  it('topups: lists NEEDS_REVIEW withdrawals with rider details; resolve validates, applies and audits', async () => {
    const rider = await makeRider(app, { floatBalance: 20_000 });
    app.sim.throwingPayoutPhones.add(rider.phone);
    const a = (await app.riders.withdrawFloat(rider.telegramId, 4_000)).topup;
    const b = (await app.riders.withdrawFloat(rider.telegramId, 5_000)).topup;
    app.sim.throwingPayoutPhones.delete(rider.phone);

    assert.equal((await call('GET', '/api/admin/topups')).status, 401);
    assert.equal((await call('GET', '/api/admin/topups?status=BOGUS', { headers: auth })).status, 400);
    const list = await call('GET', '/api/admin/topups', { headers: auth });
    assert.equal(list.status, 200);
    const row = list.body.find((t: any) => t.id === a.id);
    assert.equal(row.status, 'NEEDS_REVIEW');
    assert.equal(row.amount, 4000);
    assert.deepEqual(row.rider, { id: rider.id, name: rider.fullName, code: rider.riderCode, phone: rider.phone });

    const url = (id: string) => `/api/admin/topups/${id}/resolve`;
    assert.equal((await call('POST', url(a.id), { json: { action: 'REVERSE', note: 'x y z' } })).status, 401);
    assert.equal((await call('POST', url(a.id), { headers: auth, json: { action: 'NOPE', note: 'checked' } })).status, 400);
    assert.equal((await call('POST', url(a.id), { headers: auth, json: { action: 'REVERSE' } })).status, 400); // note required
    assert.equal((await call('POST', url(a.id), { headers: auth, json: { action: 'MARK_SENT', note: 'checked', reference: 5 } })).status, 400);
    assert.equal((await call('POST', url('nope'), { headers: auth, json: { action: 'REVERSE', note: 'checked' } })).status, 404);

    const sent = await call('POST', url(a.id), { headers: auth, json: { action: 'MARK_SENT', note: 'seen in dashboard', reference: 'CP-777' } });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.status, 'CONFIRMED');
    assert.equal(sent.body.reference, 'CP-777');
    const reversed = await call('POST', url(b.id), { headers: auth, json: { action: 'REVERSE', note: 'never left' } });
    assert.equal(reversed.body.status, 'FAILED');
    assert.equal((await getRider(app, rider.id)).floatBalance, 20_000 - 4_000);
    assert.equal((await call('POST', url(b.id), { headers: auth, json: { action: 'REVERSE', note: 'again please' } })).status, 409);

    const audits = await app.store.listAudit(50);
    const sa = audits.find((x) => x.action === 'withdrawal.mark_sent' && x.target === a.id);
    const ra = audits.find((x) => x.action === 'withdrawal.reverse' && x.target === b.id);
    assert.match(sa!.note!, /4000 FCFA.*seen in dashboard.*CP-777/);
    assert.match(ra!.note!, /5000 FCFA.*never left/);
    assert.equal((await call('GET', '/api/admin/topups', { headers: auth })).body.some((t: any) => t.id === a.id || t.id === b.id), false);
    assert.equal((await call('GET', '/api/admin/topups?status=CONFIRMED', { headers: auth })).body.some((t: any) => t.id === a.id), true);
  });

  it('payout-phones: awaiting-decision requests and scheduled ones (flagged) are both listed', async () => {
    const m1 = await makeMerchant(app);
    const m2 = await makeMerchant(app);
    await app.users.requestPayoutPhone(m1.telegramId, '677 11 22 33');
    await app.users.requestPayoutPhone(m2.telegramId, '677 44 55 66');
    await app.users.decidePayoutPhone(m2.id, true);
    const list = (await call('GET', '/api/admin/payout-phones', { headers: auth })).body;
    const r1 = list.find((u: any) => u.id === m1.id);
    const r2 = list.find((u: any) => u.id === m2.id);
    assert.equal(r1.scheduled, false);
    assert.equal(r1.payoutPhoneEffectiveAt, undefined);
    assert.equal(r2.scheduled, true);
    assert.ok(r2.payoutPhoneEffectiveAt);
  });
});

// ==================================================================== QA additions
describe('Sprint 2 QA additions (memory store)', () => {
  const interInput = (patch: Parameters<typeof intraInput>[0] = {}) =>
    intraInput({ type: 'INTER_CITY', originAgencyId: 'buca-dla-mboppi', destinationCity: 'Yaoundé', deliveryFee: 3000, agencyFee: 2000, ...patch });

  it('BS-401: inter-city order whose first leg was the seller own rider: refusal reported by the destination rider (not the seller own) -> normal refund minus legs, seller not charged', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const first = await makeRider(app);
    const last = await makeRider(app, { city: 'Yaoundé', location: { lat: 3.85, lng: 11.5 } });
    const p = await paidOrder(app, merchant, interInput({ preferredRiderCode: first.riderCode }));
    await app.orders.claim(first.telegramId, p.order.id);
    assert.equal((await getOrder(app, p.order.id)).sellerChoseRider, true);
    await app.orders.confirmPickup(first.telegramId, p.order.id);
    await app.orders.recordAgencyDropoff(first.telegramId, p.order.id, 'BUCA-778812', 'photo-file-id');
    await app.orders.markArrivedAtHub(p.order.id, { merchantId: merchant.id });
    await app.orders.claim(last.telegramId, p.order.id);
    await app.orders.confirmPickup(last.telegramId, p.order.id);
    await app.orders.riderReturnParcel(last.telegramId, p.order.id, 'REFUSED');
    const done = await app.orders.sellerConfirmReturn(p.order.id, merchant.id);
    assert.equal(done.status, 'REFUNDED');
    const total = done.total;
    assert.deepEqual(kp(done).sort(), [['BUYER_REFUND', total - 5000], ['FIRST_MILE_RIDER', 3500], ['LAST_MILE_RIDER', 1500]].sort());
    assert.ok(!(await getUser(app, merchant.id)).owedToPlatform);
    assert.equal(await app.store.ledgerBalance('MERCHANT_RECEIVABLE', merchant.id), 0);
    assert.equal(await app.store.ledgerBalance('ESCROW', p.order.id), 0);
    await assertLedgerNetsToZero(app);
  });

  it('BS-403: buyer cancel when the rider is the seller preferred one pays the same half fee, seller owes nothing', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app);
    const { order, buyerToken, sessionToken } = await paidOrder(app, merchant, intraInput({ preferredRiderCode: rider.riderCode }));
    await app.orders.claim(rider.telegramId, order.id);
    assert.equal((await app.orders.buyerView(order.id, buyerToken, sessionToken)).cancelFee, 750);
    await app.orders.buyerCancel(order.id, buyerToken, sessionToken);
    const o = await getOrder(app, order.id);
    assert.deepEqual(kp(o), [['BUYER_REFUND', 20750], ['FIRST_MILE_RIDER', 750]]);
    assert.ok(!(await getUser(app, merchant.id)).owedToPlatform);
    await assertLedgerNetsToZero(app);
  });

  it('BS-405: concurrent write-offs cannot take the debt below zero; journals balance; ledger matches the debt', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app, { owedToPlatform: 5000 });
    const results = await Promise.allSettled([
      app.users.writeOffDebt(merchant.id, 5000, 'race one'),
      app.users.writeOffDebt(merchant.id, 5000, 'race two')
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await getUser(app, merchant.id)).owedToPlatform, 0);
    assert.equal(await app.store.ledgerBalance('PLATFORM_WRITE_OFF', merchant.id), -5000);
    const js = await app.store.listJournals(merchant.id);
    assert.equal(js.length, 1);
    for (const j of js) assert.equal(j.lines.reduce((s, l) => s + l.amount, 0), 0);
    await assertLedgerNetsToZero(app);
  });

  it('BS-402: requesting yet another number during the 24 h keeps payouts on the old number and withdrawals paused', async () => {
    const app = makeApp();
    const rider = await makeRider(app, { floatBalance: 30_000 });
    await app.users.requestPayoutPhone(rider.telegramId, '677554433');
    await app.users.decidePayoutPhone(rider.userId, true);
    await app.users.requestPayoutPhone(rider.telegramId, '699887766');
    // the earlier approval must not carry over to the new number
    assert.equal(await app.users.activateDuePayoutPhones(new Date(Date.now() + 48 * HOUR)), 0);
    assert.equal((await getRider(app, rider.id)).phone, rider.phone);
    await rejects(app.riders.withdrawFloat(rider.telegramId, 1_000), 'PAYOUT_CHANGE_HOLD');
  });

  it('BS-406: Telegram follows the page rule (no phone before pickup; escrow only if Telegram is bound to the paying device)', async () => {
    const app = makeApp();
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app, { floatBalance: 100_000 });
    const r = await getRider(app, rider.id);

    const e = await paidOrder(app, merchant);
    const link = await app.orders.createFollowLink(e.order.id, e.buyerToken, e.sessionToken);
    await app.orders.linkBuyerTelegram(link.payload, 777, 'fr');
    await app.orders.claim(rider.telegramId, e.order.id);
    assert.equal(app.orders.riderPhoneForTelegram(await getOrder(app, e.order.id), r), undefined); // before pickup
    await app.orders.confirmPickup(rider.telegramId, e.order.id);
    assert.equal(app.orders.riderPhoneForTelegram(await getOrder(app, e.order.id), r), r.phone);
    await patchOrder(app, e.order.id, (o) => { o.followSessionHash = 'someone-else'; }); // Telegram bound from another device
    assert.equal(app.orders.riderPhoneForTelegram(await getOrder(app, e.order.id), r), undefined);

    const c = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
    const l2 = await app.orders.createFollowLink(c.order.id, c.buyerToken);
    await app.orders.linkBuyerTelegram(l2.payload, 778, 'fr');
    await app.orders.claim(rider.telegramId, c.order.id);
    assert.equal(app.orders.riderPhoneForTelegram(await getOrder(app, c.order.id), r), undefined);
    await app.orders.confirmPickup(rider.telegramId, c.order.id);
    assert.equal(app.orders.riderPhoneForTelegram(await getOrder(app, c.order.id), r), r.phone);
  });

  it('BS-407: a late provider answer cannot touch a withdrawal an admin already resolved', async () => {
    const app = makeApp();
    const rider = await makeRider(app, { floatBalance: 30_000 });
    app.sim.throwingPayoutPhones.add(rider.phone);
    const t = (await app.riders.withdrawFloat(rider.telegramId, 4_000)).topup;
    await app.riders.resolveWithdrawal(t.id, 'REVERSE', 'not paid');
    await app.store.updateTopup({ ...(await app.store.getTopup(t.id))!, reference: 'late-ref' });
    await app.riders.applyTopupTransaction({ reference: 'late-ref', status: 'FAILED', amount: 4_000 } as any);
    await app.riders.applyTopupTransaction({ reference: 'late-ref', status: 'SUCCESSFUL', amount: 4_000 } as any);
    assert.equal((await app.store.getTopup(t.id))!.status, 'FAILED');
    assert.equal((await getRider(app, rider.id)).floatBalance, 30_000);
  });
});
