import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VersionConflictError } from '../src/domain/errors.js';
import { Order } from '../src/domain/types.js';
import { MemoryStore } from '../src/storage/memory.js';
import { Repo } from '../src/storage/store.js';
import { intraInput, makeApp, makeMerchant, makeRider, paidOrder } from './helpers.js';

const H = 3600_000;

/** Memory store whose next N transactions fail with a version conflict before running. */
class FlakyStore extends MemoryStore {
  failNext = 0;
  attempts = 0;
  override async tx<T>(fn: (repo: Repo) => Promise<T>): Promise<T> {
    this.attempts++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new VersionConflictError('User');
    }
    return super.tx(fn);
  }
}

const stalledEvents = (app: ReturnType<typeof makeApp>, id: string) =>
  app.events.history.filter((e: any) => e.type === 'order.stalled' && e.order.id === id) as any[];

describe('architect review fixes (backend)', () => {
  it('1. no-show release re-checks the fresh row (rider changed => skipped)', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const a = await makeRider(app);
    const b = await makeRider(app);
    const { order } = await paidOrder(app, m);
    const assigned = await app.orders.claim(a.telegramId, order.id);
    const snapshot = (await app.store.getOrder(order.id))!;
    await app.orders.unassign(a.telegramId, order.id);
    await app.orders.claim(b.telegramId, order.id);
    // Stale snapshot says "A is assigned and late": must be ignored.
    const released = await (app.orders as any).releaseNoShow(snapshot, Date.now() + 2 * H);
    assert.equal(released, false);
    const now = (await app.store.getOrder(order.id))!;
    assert.equal(now.status, 'RIDER_ASSIGNED');
    assert.equal(now.firstMileRiderId, b.id);
    assert.equal(assigned.status, 'RIDER_ASSIGNED');
    // Not late yet on the fresh row either => skipped even for the right rider.
    assert.equal(await (app.orders as any).releaseNoShow(now, Date.now() + 60_000), false);
    // Really late => released.
    assert.equal(await (app.orders as any).releaseNoShow(now, Date.now() + 2 * H), true);
    assert.equal((await app.store.getOrder(order.id))!.status, 'AWAITING_RIDER');
  });

  it('2. oldest-first listing pages through everything and honours the cursor', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { order } = await paidOrder(app, m);
      // Force a known updatedAt ordering (oldest = first created).
      await app.store.tx(async (repo) => {
        const o = (await repo.getOrder(order.id))!;
        o.updatedAt = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
        await repo.updateOrder(o);
      });
      ids.push(order.id);
    }
    const first = await app.store.listOrdersByStatusOldestFirst(['AWAITING_RIDER'], 2);
    assert.deepEqual(first.map((o) => o.id), ids.slice(0, 2));
    const next = await app.store.listOrdersByStatusOldestFirst(['AWAITING_RIDER'], 10, { updatedAt: first[1].updatedAt, id: first[1].id });
    assert.deepEqual(next.map((o) => o.id), ids.slice(2));
    const all = await (app.orders as any).listAllOldestFirst(['AWAITING_RIDER']);
    assert.equal(all.length, 5);
    assert.equal(all[0].id, ids[0]);
    // payment-reference filter
    assert.equal((await app.store.listOrdersByStatusOldestFirst(['AWAITING_RIDER'], 10, undefined, { withPaymentReference: true })).length, 5);
    assert.equal((await app.store.listOrdersByStatusOldestFirst(['PENDING_PAYMENT'], 10, undefined, { withPaymentReference: true })).length, 0);
  });

  it('3. stray payment: refunded once, notified once; unknown payer => NEEDS_REVIEW payout', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const { order } = await paidOrder(app, m);
    const count = () => app.events.history.filter((e: any) => e.type === 'order.payment_mismatch').length;
    const before = count();
    const stray = { reference: 'unknown-ref-1', status: 'SUCCESSFUL' as const, amount: order.total, externalReference: `order:${order.id}` };
    await app.orders.applyOrderTransaction(stray);
    await app.orders.applyOrderTransaction(stray);
    assert.equal(count(), before + 1, 'mismatch emitted once');
    const o = (await app.store.getOrder(order.id))!;
    const payouts = o.payouts.filter((p) => p.kind === 'BUYER_REFUND');
    assert.equal(payouts.length, 1, 'only one refund payout');
    assert.equal(payouts[0].status, 'NEEDS_REVIEW');
    assert.equal(payouts[0].phone, '');
    assert.equal(payouts[0].amount, order.total);
    assert.ok((await app.store.listJournals(order.id)).some((j) => j.key === 'stray:unknown-ref-1'));
    assert.ok(app.events.history.some((e: any) => e.type === 'payout.attention' && e.order.id === order.id));
    // processPayouts leaves it alone and RETRY without a number is refused
    await app.orders.processPayouts(order.id);
    assert.equal((await app.store.getOrder(order.id))!.payouts.find((p) => p.kind === 'BUYER_REFUND')!.status, 'NEEDS_REVIEW');
    await assert.rejects(() => app.orders.reviewPayout(order.id, payouts[0].id, 'RETRY'), /no destination number/);
  });

  it('4. admin reassign after pickup keeps the COD reservation with the old rider', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const a = await makeRider(app, { floatBalance: 100_000 });
    const b = await makeRider(app, { floatBalance: 100_000 });
    const { order } = await app.orders.createOrder(m, intraInput({ paymentMode: 'COD' }));
    await app.orders.claim(a.telegramId, order.id);
    await app.orders.confirmPickup(a.telegramId, order.id);
    const reassigned = await app.orders.adminReassign(order.id, b.riderCode);
    assert.equal(reassigned.firstMileRiderId, b.id);
    assert.equal(reassigned.codRiderId, a.id);
    assert.equal(reassigned.codReserved, order.itemPrice);
    assert.equal((await app.store.getRider(a.id))!.floatReserved, order.itemPrice);
    assert.equal((await app.store.getRider(b.id))!.floatReserved, 0);
    assert.match(reassigned.history.at(-1)!.note ?? '', /replaced by admin/);
  });

  it('4b. reassign refuses a rider who already runs the other leg', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const a = await makeRider(app);
    const { order } = await paidOrder(app, m);
    await app.orders.claim(a.telegramId, order.id);
    // fake an inter-city style order where A is also the last-mile rider
    await app.store.tx(async (repo) => {
      const o = (await repo.getOrder(order.id))!;
      o.lastMileRiderId = a.id;
      await repo.updateOrder(o);
    });
    await assert.rejects(() => app.orders.adminReassign(order.id, a.riderCode), /last leg/);
  });

  it('5. sellerConfirmReturn can be retried when the return was already recorded', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const a = await makeRider(app);
    const { order } = await paidOrder(app, m);
    await app.orders.claim(a.telegramId, order.id);
    await app.orders.confirmPickup(a.telegramId, order.id);
    const r = await app.orders.sellerCancel(order.id, m.id);
    assert.equal(r.kind, 'return_opened');
    await app.store.tx(async (repo) => {
      const o = (await repo.getOrder(order.id))!;
      o.dispute!.returnReceivedAt = new Date().toISOString(); // a previous attempt recorded it, then failed
      await repo.updateOrder(o);
    });
    const done = await app.orders.sellerConfirmReturn(order.id, m.id);
    assert.ok(['REFUNDED'].includes(done.status));
  });

  it('6. split pays the seller to the payout number', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED', payoutPhone: '+237670000999' });
    const a = await makeRider(app);
    const { order } = await paidOrder(app, m);
    await app.orders.claim(a.telegramId, order.id);
    await app.orders.confirmPickup(a.telegramId, order.id);
    await app.orders.openDispute(order.id, 'BUYER', 'item not as described');
    const done = await app.orders.resolveDispute(order.id, 'SPLIT', 'half each', { buyerAmount: 5000 });
    const merchantPayout = done.payouts.find((p) => p.kind === 'MERCHANT');
    assert.ok(merchantPayout);
    assert.equal(merchantPayout!.phone, '+237670000999');
    assert.ok(done.history.some((h) => /split/.test(h.note ?? '')));
  });

  it('7. mutate retries a version conflict a bounded number of times', async () => {
    const store = new FlakyStore();
    const app = makeApp({ store });
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const { order } = await app.orders.createOrder(m, intraInput());
    store.failNext = 2;
    const { order: updated } = await (app.orders as any).mutate(order.id, (o: Order) => {
      o.itemTitle = 'Retried';
    });
    assert.equal(updated.itemTitle, 'Retried');
    store.failNext = 3;
    await assert.rejects(() => (app.orders as any).mutate(order.id, () => undefined), /modified concurrently/);
  });

  it('8. seller-charge journal keys are per reason', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const a = await makeRider(app);
    const { order } = await paidOrder(app, m);
    await app.orders.claim(a.telegramId, order.id);
    await app.orders.cancel(order.id, { merchantId: m.id });
    const keys = (await app.store.listJournals(order.id)).map((j) => j.key);
    assert.ok(keys.some((k) => k.startsWith(`order:${order.id}:seller-charge:`) && k.length > `order:${order.id}:seller-charge:`.length), keys.join(','));
  });

  it('9. resuming a refused COD order clears the refusal count', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const a = await makeRider(app, { floatBalance: 100_000 });
    const { order } = await app.orders.createOrder(m, intraInput({ paymentMode: 'COD' }));
    await app.orders.claim(a.telegramId, order.id);
    await app.orders.confirmPickup(a.telegramId, order.id);
    await app.orders.riderReturnParcel(a.telegramId, order.id, 'REFUSED');
    const since = new Date(Date.now() - 86_400_000).toISOString();
    assert.equal(await app.store.countBuyerRefusals(order.buyerPhone, since), 1);
    await app.orders.adminResume(order.id, 'rider was wrong');
    assert.equal(await app.store.countBuyerRefusals(order.buyerPhone, since), 0);
  });

  it('11. the 48 h refund clock is not reset by claim/release cycles', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const a = await makeRider(app);
    const { order } = await paidOrder(app, m);
    await app.orders.claim(a.telegramId, order.id);
    await app.orders.unassign(a.telegramId, order.id); // statusSince is "now" again
    const res = await app.orders.enforceTimeouts(Date.now() + 49 * H);
    assert.equal(res.refunded, 1);
    assert.equal((await app.store.getOrder(order.id))!.status, 'REFUNDED');
  });

  it('13. stalls without a timeout raise one admin event each', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const a = await makeRider(app);
    const { order } = await paidOrder(app, m);
    await app.orders.claim(a.telegramId, order.id);
    await app.orders.confirmPickup(a.telegramId, order.id);
    assert.equal(stalledEvents(app, order.id).length, 0);
    const res = await app.orders.enforceTimeouts(Date.now() + 7 * H);
    assert.equal(res.reminded, 1);
    assert.equal(stalledEvents(app, order.id).length, 1);
    assert.equal(stalledEvents(app, order.id)[0].hours, 6);
    await app.orders.enforceTimeouts(Date.now() + 8 * H);
    assert.equal(stalledEvents(app, order.id).length, 1, 'only once');
  });

  it('C. returning to the pool resets the 6 h / 24 h reminders', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const a = await makeRider(app);
    const { order } = await paidOrder(app, m);
    await app.orders.enforceTimeouts(Date.now() + 7 * H);
    assert.equal(stalledEvents(app, order.id).length, 1);
    await app.orders.claim(a.telegramId, order.id);
    await app.orders.unassign(a.telegramId, order.id);
    assert.ok(!(await app.store.getOrder(order.id))!.reminders?.includes('stalled-6h'));
    await app.orders.enforceTimeouts(Date.now() + 7 * H);
    assert.equal(stalledEvents(app, order.id).length, 2);
  });

  it('A. unassign clears the seller-preferred rider so the job opens to the pool', async () => {
    const app = makeApp();
    const m = await makeMerchant(app, { kycStatus: 'VERIFIED' });
    const a = await makeRider(app);
    const b = await makeRider(app);
    const { order } = await paidOrder(app, m, intraInput({ preferredRiderCode: a.riderCode }));
    await app.orders.claim(a.telegramId, order.id);
    await app.orders.unassign(a.telegramId, order.id);
    assert.equal((await app.store.getOrder(order.id))!.preferredRiderId, undefined);
    const claimed = await app.orders.claim(b.telegramId, order.id);
    assert.equal(claimed.firstMileRiderId, b.id);
  });
});
