import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { AppError } from '../src/domain/errors.js';
import { newId } from '../src/domain/secrets.js';
import { LedgerAccount, Order, User } from '../src/domain/types.js';
import { DomainEvent } from '../src/services/events.js';
import { Store } from '../src/storage/store.js';
import { TestApp, intraInput, makeApp, makeMerchant, makeRider, paidOrder, releaseCode, tick } from './helpers.js';

const ACCOUNTS: LedgerAccount[] = [
  'GATEWAY_CLEARING', 'ESCROW', 'MERCHANT_PAYABLE', 'RIDER_PAYABLE', 'BUYER_REFUND_PAYABLE', 'PLATFORM_REVENUE', 'RIDER_FLOAT'
];

async function balances(app: TestApp, refId?: string) {
  const out: Partial<Record<LedgerAccount, number>> = {};
  for (const a of ACCOUNTS) out[a] = await app.store.ledgerBalance(a, refId);
  return out;
}


const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const interInput = (patch: Parameters<typeof intraInput>[0] = {}) =>
  intraInput({ type: 'INTER_CITY', originAgencyId: 'buca-dla-mboppi', destinationCity: 'Yaoundé', deliveryFee: 3000, agencyFee: 2000, ...patch });

const yaoundeRider = (app: TestApp, patch: Parameters<typeof makeRider>[1] = {}) =>
  makeRider(app, { city: 'Yaoundé', location: { lat: 3.85, lng: 11.5 }, ...patch });

type Ev<T extends DomainEvent['type']> = Extract<DomainEvent, { type: T }>;
function evs<T extends DomainEvent['type']>(app: TestApp, type: T, orderId?: string): Ev<T>[] {
  return app.events.history.filter(
    (e): e is Ev<T> => e.type === type && (!orderId || ('order' in e && e.order.id === orderId))
  );
}

const getOrder = async (app: TestApp, id: string) => (await app.store.getOrder(id))!;
const getUser = async (app: TestApp, id: string) => (await app.store.getUser(id))!;
const getRider = async (app: TestApp, id: string) => (await app.store.getRider(id))!;
const kp = (o: Order) => o.payouts.map((p) => [p.kind, p.amount] as [string, number]);

/** Edits an order through the public store API (e.g. to backdate a timestamp). */
async function patchOrder(app: TestApp, id: string, fn: (o: Order) => void) {
  await app.store.tx(async (repo) => {
    const o = (await repo.getOrder(id))!;
    fn(o);
    await repo.updateOrder(o);
  });
}
async function patchUser(app: TestApp, id: string, fn: (u: User) => void) {
  await app.store.tx(async (repo) => {
    const u = (await repo.getUser(id))!;
    fn(u);
    await repo.updateUser(u);
  });
}

/** Every journal touching this order sums to zero, and no money is left parked for it. */
async function assertLedgerClean(app: TestApp, orderId: string, opts: { escrowLeft?: number } = {}) {
  for (const j of await app.store.listJournals(orderId)) {
    assert.equal(j.lines.reduce((s, l) => s + l.amount, 0), 0, `journal ${j.key} is unbalanced`);
  }
  assert.equal(await app.store.ledgerBalance('ESCROW', orderId), opts.escrowLeft ?? 0, 'ESCROW');
  for (const a of ['MERCHANT_PAYABLE', 'RIDER_PAYABLE', 'BUYER_REFUND_PAYABLE'] as LedgerAccount[]) {
    assert.equal(await app.store.ledgerBalance(a, orderId), 0, a);
  }
}

async function pickedUp(app: TestApp, merchant: User, rider: { telegramId: number }, input = intraInput()) {
  const p = await paidOrder(app, merchant, input);
  await app.orders.claim(rider.telegramId, p.order.id);
  await app.orders.confirmPickup(rider.telegramId, p.order.id);
  return { ...p, order: await getOrder(app, p.order.id) };
}

async function atAgency(app: TestApp, merchant: User, first: { telegramId: number }, input = interInput(), actualFee?: number) {
  const p = await pickedUp(app, merchant, first, input);
  await app.orders.recordAgencyDropoff(first.telegramId, p.order.id, 'BUCA-778812', 'photo-file-id', actualFee);
  return { ...p, order: await getOrder(app, p.order.id) };
}

async function outForDelivery(app: TestApp, merchant: User, first: { telegramId: number }, last: { telegramId: number }, actualFee?: number) {
  const p = await atAgency(app, merchant, first, interInput(), actualFee);
  await app.orders.markArrivedAtHub(p.order.id, { merchantId: merchant.id });
  await app.orders.claim(last.telegramId, p.order.id);
  await app.orders.confirmPickup(last.telegramId, p.order.id);
  return { ...p, order: await getOrder(app, p.order.id) };
}

async function deliverEscrow(app: TestApp, merchant: User, rider: { telegramId: number }) {
  const p = await pickedUp(app, merchant, rider);
  await app.orders.deliver(rider.telegramId, p.order.id, releaseCode(app, p.order));
  return getOrder(app, p.order.id);
}

const photo = (n = 600) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, n - 4), 1)]);

const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof AppError && e.code === code);

/** The same behavioural suite runs against every store implementation. */
export function orderFlowSuite(name: string, makeStore: () => Promise<Store>) {
  describe(`order flows (${name})`, () => {
    const stores: Store[] = [];
    const fresh = async () => {
      const store = await makeStore();
      stores.push(store);
      return makeApp({ store });
    };
    after(async () => {
      for (const s of stores) await s.close();
    });

    it('escrow, same city: pay → claim → pickup → code → payouts → settled, ledger balances', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order } = await paidOrder(app, merchant);
      assert.equal(order.status, 'AWAITING_RIDER');
      await tick();
      assert.ok(app.events.history.some((e) => e.type === 'order.offer' && e.offers.some((x) => x.rider.id === rider.id)));

      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.confirmPickup(rider.telegramId, order.id);
      const res = await app.orders.deliver(rider.telegramId, order.id, releaseCode(app, order));
      assert.equal(res.ok, true);
      assert.equal(res.order.status, 'SETTLED');
      assert.deepEqual(
        res.order.payouts.map((p) => [p.kind, p.amount, p.status]),
        [['MERCHANT', 19500, 'SENT'], ['FIRST_MILE_RIDER', 1500, 'SENT']]
      );
      assert.deepEqual(app.sim.withdrawals.map((w) => [w.phone, w.amount]), [[merchant.phone, 19500], [rider.phone, 1500]]);

      const b = await balances(app);
      assert.equal(b.ESCROW, 0);
      assert.equal(b.MERCHANT_PAYABLE, 0);
      assert.equal(b.RIDER_PAYABLE, 0);
      assert.equal(b.PLATFORM_REVENUE, 500);
      assert.equal(b.GATEWAY_CLEARING, -500);
      assert.equal((await app.store.getRider(rider.id))!.completedDeliveries, 1);
    });

    it('only one of two riders racing for the same job wins', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const r1 = await makeRider(app);
      const r2 = await makeRider(app);
      const { order } = await paidOrder(app, merchant);
      const results = await Promise.allSettled([app.orders.claim(r1.telegramId, order.id), app.orders.claim(r2.telegramId, order.id)]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.equal((loser.reason as AppError).code, 'CONFLICT');
    });

    it('riders cannot skip steps or act on jobs that are not theirs', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const other = await makeRider(app);
      const { order } = await paidOrder(app, merchant);
      await rejects(app.orders.deliver(rider.telegramId, order.id, releaseCode(app, order)), 'FORBIDDEN');
      await app.orders.claim(rider.telegramId, order.id);
      await rejects(app.orders.deliver(rider.telegramId, order.id, releaseCode(app, order)), 'CONFLICT'); // not picked up
      await rejects(app.orders.confirmPickup(other.telegramId, order.id), 'CONFLICT');
      const offDuty = await makeRider(app, { onDuty: false });
      await rejects(app.orders.claim(offDuty.telegramId, order.id), 'INVALID');
      const pending = await makeRider(app, { status: 'PENDING' });
      await rejects(app.orders.claim(pending.telegramId, order.id), 'RIDER_NOT_APPROVED');
    });

    it('wrong codes are counted and the order freezes into a dispute; admin refund keeps rider fee', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order } = await paidOrder(app, merchant);
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.confirmPickup(rider.telegramId, order.id);
      const good = releaseCode(app, order);
      const bad = good === '0000' ? '1111' : '0000';
      assert.equal((await app.orders.deliver(rider.telegramId, order.id, bad)).attemptsLeft, 2);
      assert.equal((await app.orders.deliver(rider.telegramId, order.id, bad)).attemptsLeft, 1);
      const third = await app.orders.deliver(rider.telegramId, order.id, bad);
      assert.equal(third.order.status, 'DISPUTED');
      await rejects(app.orders.deliver(rider.telegramId, order.id, good), 'CONFLICT');

      const refunded = await app.orders.resolveDispute(order.id, 'REFUND_BUYER', 'buyer refused');
      assert.equal(refunded.status, 'REFUNDED');
      assert.deepEqual(
        refunded.payouts.map((p) => [p.kind, p.amount, p.phone]),
        [['BUYER_REFUND', 20000, '+237677001122'], ['FIRST_MILE_RIDER', 1500, rider.phone]]
      );
      const b = await balances(app);
      assert.equal(b.ESCROW, 0);
      assert.equal(b.BUYER_REFUND_PAYABLE, 0);
      assert.equal(b.GATEWAY_CLEARING, 0);
    });

    it('buyer dispute can be released to the merchant by an admin', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order, buyerToken, sessionToken } = await paidOrder(app, merchant);
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.confirmPickup(rider.telegramId, order.id);
      const view = await app.orders.buyerOpenDispute(order.id, buyerToken, 'Rider asked for code before showing parcel', sessionToken);
      assert.equal(view.status, 'DISPUTED');
      const done = await app.orders.resolveDispute(order.id, 'RELEASE_TO_MERCHANT');
      assert.equal(done.status, 'SETTLED');
    });

    it('inter-city: agency drop-off, hub arrival, last-mile rider, split fees', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const first = await makeRider(app, { city: 'Douala' });
      const last = await makeRider(app, { city: 'Yaoundé', location: { lat: 3.85, lng: 11.5 } });
      const { order } = await paidOrder(
        app,
        merchant,
        intraInput({ type: 'INTER_CITY', originAgencyId: 'buca-dla-mboppi', destinationCity: 'Yaoundé', deliveryFee: 3000, agencyFee: 2000 })
      );
      assert.equal(order.total, 25000);
      await app.orders.claim(first.telegramId, order.id);
      await app.orders.confirmPickup(first.telegramId, order.id);
      await rejects(app.orders.deliver(first.telegramId, order.id, releaseCode(app, order)), 'FORBIDDEN');
      await app.orders.recordAgencyDropoff(first.telegramId, order.id, 'BUCA-778812', 'photo-file-id');
      await rejects(app.orders.markArrivedAtHub(order.id, { merchantId: 'someone-else' }), 'FORBIDDEN');
      await app.orders.markArrivedAtHub(order.id, { merchantId: merchant.id });
      await tick();
      const offer = app.events.history.findLast((e) => e.type === 'order.offer');
      assert.ok(offer && offer.type === 'order.offer' && offer.leg === 'LAST' && offer.offers.every((o) => o.rider.id !== first.id));

      await app.orders.claim(last.telegramId, order.id);
      await app.orders.confirmPickup(last.telegramId, order.id);
      const res = await app.orders.deliver(last.telegramId, order.id, releaseCode(app, order));
      assert.equal(res.order.status, 'SETTLED');
      assert.deepEqual(
        res.order.payouts.map((p) => [p.kind, p.amount]),
        [['MERCHANT', 19500], ['FIRST_MILE_RIDER', 3500], ['LAST_MILE_RIDER', 1500]]
      );
    });

    it('inter-city orders validate route and refuse cash on delivery', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const bad = (patch: object) => app.orders.createOrder(merchant, intraInput({ type: 'INTER_CITY', ...patch }));
      await rejects(bad({ originAgencyId: 'nope', destinationCity: 'Yaoundé' }), 'INVALID');
      await rejects(bad({ originAgencyId: 'buca-dla-mboppi', destinationCity: 'Douala' }), 'INVALID');
      await rejects(bad({ originAgencyId: 'buca-dla-mboppi', destinationCity: 'Bamenda' }), 'INVALID'); // no Buca terminal there
      await rejects(bad({ originAgencyId: 'buca-dla-mboppi', destinationCity: 'Yaoundé', paymentMode: 'COD' }), 'INVALID');
    });

    it('cash on delivery: float must cover the item, is reserved on claim and debited on delivery', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const poor = await makeRider(app, { floatBalance: 5000 });
      const rich = await makeRider(app, { floatBalance: 30000 });
      const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      assert.equal(order.status, 'AWAITING_RIDER');
      await tick();
      const offer = app.events.history.find((e) => e.type === 'order.offer' && e.order.id === order.id);
      assert.ok(offer && offer.type === 'order.offer');
      assert.deepEqual(offer.offers.map((o) => o.rider.id), [rich.id]);

      await rejects(app.orders.claim(poor.telegramId, order.id), 'INSUFFICIENT_FLOAT');
      await app.orders.claim(rich.telegramId, order.id);
      assert.equal((await app.store.getRider(rich.id))!.floatReserved, 20000);

      // A second COD job can't reuse the same float.
      const { order: second } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await rejects(app.orders.claim(rich.telegramId, second.id), 'INSUFFICIENT_FLOAT');

      await app.orders.confirmPickup(rich.telegramId, order.id);
      const res = await app.orders.deliver(rich.telegramId, order.id, releaseCode(app, order));
      assert.equal(res.order.status, 'SETTLED');
      const r = (await app.store.getRider(rich.id))!;
      assert.equal(r.floatBalance, 10000);
      assert.equal(r.floatReserved, 0);
      assert.deepEqual(res.order.payouts.map((p) => [p.kind, p.amount]), [['MERCHANT', 19500]]);
    });

    it('rider float top-up is credited once even if the webhook repeats', async () => {
      const app = await fresh();
      const rider = await makeRider(app);
      const { topup } = await app.riders.requestTopup(rider.telegramId, 10000);
      app.sim.approve(topup.reference!);
      await app.handlePaymentReference(topup.reference!);
      await app.handlePaymentReference(topup.reference!);
      assert.equal((await app.store.getRider(rider.id))!.floatBalance, 10000);
      assert.equal(await app.store.ledgerBalance('RIDER_FLOAT', rider.id), 10000);
    });

    it('payment confirmation is idempotent and amount mismatches are not accepted', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order } = await paidOrder(app, merchant);
      await app.handlePaymentReference(order.payment.reference!);
      assert.equal(await app.store.ledgerBalance('ESCROW', order.id), order.total);

      const created = await app.orders.createOrder(merchant, intraInput());
      await app.orders.initiatePayment(created.order.id, created.buyerToken, '677001122');
      const ref = (await app.store.getOrder(created.order.id))!.payment.reference!;
      app.sim.approve(ref, 100); // provider says only 100 FCFA arrived
      await app.handlePaymentReference(ref);
      assert.equal((await app.store.getOrder(created.order.id))!.status, 'PENDING_PAYMENT');
      await tick();
      assert.ok(app.events.history.some((e) => e.type === 'order.payment_mismatch'));
    });

    it('a failed payment can be retried; a pending one blocks a duplicate prompt', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
      await app.orders.initiatePayment(order.id, buyerToken, '677001122');
      await rejects(app.orders.initiatePayment(order.id, buyerToken, '677001122'), 'PAYMENT_IN_PROGRESS');
      app.sim.fail((await app.store.getOrder(order.id))!.payment.reference!);
      const again = await app.orders.initiatePayment(order.id, buyerToken, '699001122');
      assert.ok(again.sessionToken);
    });

    it('a buyer abroad can be the contact; the refund still goes to the Mobile Money number that paid', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order } = await paidOrder(app, merchant, intraInput({ buyerPhone: '+33 6 12 34 56 78' }));
      assert.equal(order.buyerPhone, '+33612345678');
      const c = await app.orders.cancel(order.id, { merchantId: merchant.id });
      assert.deepEqual(c.payouts.map((p) => [p.kind, p.phone]), [['BUYER_REFUND', '+237677001122']]);
      await rejects(app.orders.createOrder(merchant, intraInput({ buyerPhone: '0612345678' })), 'INVALID');
    });

    it('the buyer can cancel until pickup (full refund) but not after; the seller can always stop the deal', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);

      const a = await paidOrder(app, merchant);
      await app.orders.claim(rider.telegramId, a.order.id); // rider on the way to the seller: still cancellable
      const view = await app.orders.buyerCancel(a.order.id, a.buyerToken, a.sessionToken);
      assert.equal(view.status, 'REFUNDED');
      assert.equal(view.can.cancel, false);
      const refunded = (await app.store.getOrder(a.order.id))!;
      assert.deepEqual(refunded.payouts.map((p) => [p.kind, p.amount]), [['BUYER_REFUND', 21500]]);
      assert.match(refunded.history.at(-1)!.note!, /cancelled by buyer/);
      await rejects(app.orders.buyerCancel(a.order.id, 'wrong-token'), 'NOT_FOUND');

      const b = await paidOrder(app, merchant);
      await app.orders.claim(rider.telegramId, b.order.id);
      await app.orders.confirmPickup(rider.telegramId, b.order.id);
      await rejects(app.orders.buyerCancel(b.order.id, b.buyerToken), 'ALREADY_PICKED_UP');
      const stop = await app.orders.sellerCancel(b.order.id, merchant.id);
      assert.equal(stop.kind, 'return_opened');
      assert.equal(stop.order.status, 'DISPUTED');
      assert.equal(stop.order.dispute?.openedBy, 'MERCHANT');

      const c = await app.orders.createOrder(merchant, intraInput());
      assert.equal((await app.orders.sellerCancel(c.order.id, merchant.id)).order.status, 'CANCELLED');
      await rejects(app.orders.sellerCancel(c.order.id, 'someone-else'), 'NOT_FOUND');
    });

    it('"no rider found" is announced once, not on every 10-minute retry', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order } = await paidOrder(app, merchant); // no riders exist at all
      for (let i = 0; i < 3; i++) await app.orders.offerToRiders((await app.store.getOrder(order.id))!, 'FIRST');
      await tick();
      assert.equal(app.events.history.filter((e) => e.type === 'order.no_riders' && e.order.id === order.id).length, 1);
    });

    it('cancelling a paid order before pickup refunds the buyer in full', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order } = await paidOrder(app, merchant);
      await rejects(app.orders.cancel(order.id, { merchantId: 'not-me' }), 'FORBIDDEN');
      const c = await app.orders.cancel(order.id, { merchantId: merchant.id });
      assert.equal(c.status, 'REFUNDED');
      assert.deepEqual(c.payouts.map((p) => [p.kind, p.amount, p.status]), [['BUYER_REFUND', 21500, 'SENT']]);
    });

    it('failed payouts are retried with backoff, then flagged for review', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order } = await paidOrder(app, merchant);
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.confirmPickup(rider.telegramId, order.id);
      app.sim.failingPayoutPhones.add(merchant.phone);
      const res = await app.orders.deliver(rider.telegramId, order.id, releaseCode(app, order));
      assert.equal(res.order.status, 'DELIVERED');
      const p = res.order.payouts.find((x) => x.kind === 'MERCHANT')!;
      assert.equal(p.status, 'FAILED');

      // Within backoff: nothing happens. After backoff: retried.
      await app.orders.processPayouts(order.id);
      assert.equal((await app.store.getOrder(order.id))!.payouts[0].attempts, 1);
      let t = Date.now();
      for (let i = 0; i < 6; i++) {
        t += 3_600_000;
        await app.orders.processPayouts(order.id, t);
      }
      const flagged = (await app.store.getOrder(order.id))!.payouts.find((x) => x.kind === 'MERCHANT')!;
      assert.equal(flagged.status, 'NEEDS_REVIEW');
      await tick();
      assert.ok(app.events.history.some((e) => e.type === 'payout.attention'));

      app.sim.failingPayoutPhones.clear();
      const after = await app.orders.reviewPayout(order.id, flagged.id, 'RETRY');
      assert.equal(after!.status, 'SETTLED');
    });

    it('unpaid orders expire; the buyer link then refuses payment', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
      const n = await app.orders.expireStale(new Date(Date.now() + 49 * 3600_000));
      assert.equal(n, 1);
      assert.equal((await app.store.getOrder(order.id))!.status, 'EXPIRED');
      await rejects(app.orders.initiatePayment(order.id, buyerToken, '677001122'), 'CONFLICT');
    });

    it('release code is only revealed to the device that paid', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order, buyerToken, sessionToken } = await paidOrder(app, merchant);
      const payer = await app.orders.buyerView(order.id, buyerToken, sessionToken);
      assert.equal(payer.releaseCode, releaseCode(app, order));
      const otherDevice = await app.orders.buyerView(order.id, buyerToken);
      assert.equal(otherDevice.releaseCode, undefined);
      assert.equal(otherDevice.releaseCodeOnOtherDevice, true);
      await rejects(app.orders.buyerView(order.id, 'wrong-token', sessionToken), 'NOT_FOUND');
    });

    it('seller profile: no sales before submitting, badge only after admin approval, refusal needs a reason', async () => {
      const app = await fresh();
      const fresh1 = await makeMerchant(app, { kycStatus: 'NONE' });
      await rejects(app.orders.createOrder(fresh1, intraInput()), 'PROFILE_INCOMPLETE');

      await app.users.startDraft(fresh1.telegramId, 'merchant', 'shopName');
      await app.users.saveDraft(fresh1.telegramId, { shopName: 'Chez Awa' }, 'city');
      const mid = (await app.store.getUser(fresh1.id))!;
      assert.equal(mid.draft?.step, 'city');
      assert.equal(mid.draft?.data.shopName, 'Chez Awa');

      const profile = {
        shopName: 'Chez Awa', city: 'Douala', cniNumber: '1234 5678 9', selfieFileId: 'f-selfie', cniFrontFileId: 'f-front',
        cniBackFileId: 'f-back', shopPhotoFileId: 'f-shop', shopLocation: { lat: 4.05, lng: 9.7 }
      };
      await assert.rejects(app.users.submitMerchantProfile(fresh1.telegramId, { ...profile, shopPhotoFileId: undefined }), /shop photo/);
      await rejects(app.users.submitMerchantProfile(fresh1.telegramId, { ...profile, shopLocation: { lat: 48.8, lng: 2.3 } }), 'OUTSIDE_CAMEROON');
      const pending = await app.users.submitMerchantProfile(fresh1.telegramId, profile);
      assert.equal(pending.kycStatus, 'PENDING');
      assert.equal(pending.cniNumber, '123456789');
      assert.equal(pending.draft, undefined);
      const { order } = await app.orders.createOrder(pending, intraInput());
      assert.equal(order.merchantVerified, false);

      await rejects(app.users.decideKyc(fresh1.id, false), 'INVALID');
      const refused = await app.users.decideKyc(fresh1.id, false, 'Photos floues');
      assert.equal(refused.kycNote, 'Photos floues');
      await rejects(app.orders.createOrder(refused, intraInput()), 'PROFILE_REJECTED');
      const again = await app.users.submitMerchantProfile(fresh1.telegramId, profile);
      assert.equal((await app.users.decideKyc(again.id, true)).kycStatus, 'VERIFIED');
    });

    it('rider application: full documents, admin approval, public badge check, resubmission after refusal', async () => {
      const app = await fresh();
      const applicant = await makeMerchant(app, { kycStatus: 'NONE' });
      const application = {
        legalName: 'Moussa Njoya', cniNumber: '987654321', selfieFileId: 'r-selfie', cniFrontFileId: 'r-front', cniBackFileId: 'r-back',
        vehicleType: 'MOTO' as const, plateNumber: 'lt 123 ab', vehiclePhotoFileId: 'r-moto', city: 'Douala'
      };
      await rejects(app.riders.submitApplication(applicant.telegramId, { ...application, legalName: 'Moussa' }), 'INVALID');
      const rider = await app.riders.submitApplication(applicant.telegramId, application);
      assert.equal(rider.status, 'PENDING');
      assert.equal(rider.plateNumber, 'LT123AB');
      assert.match(rider.riderCode, /^BSR-[2-9A-HJKMNP-Z]{4}$/);
      assert.equal((await app.riders.verifyCode(rider.riderCode))!.verified, false);
      await rejects(app.riders.setDuty(applicant.telegramId, true), 'RIDER_NOT_APPROVED');
      await rejects(app.riders.submitApplication(applicant.telegramId, application), 'INVALID');

      await app.riders.decide(rider.id, 'REJECTED', 'Selfie flou');
      const resubmitted = await app.riders.submitApplication(applicant.telegramId, { ...application, selfieFileId: 'r-selfie-2' });
      assert.equal(resubmitted.status, 'PENDING');
      assert.equal(resubmitted.riderCode, rider.riderCode);
      await app.riders.decide(rider.id, 'APPROVED');
      const card = (await app.riders.verifyCode(rider.riderCode.toLowerCase()))!;
      assert.deepEqual([card.verified, card.firstName, card.selfieFileId], [true, 'Moussa', 'r-selfie-2']);
      assert.equal(await app.riders.verifyCode('BSR-XXXX'), undefined);
      assert.equal((await app.riders.setDuty(applicant.telegramId, true)).onDuty, true);
    });

    it('buyer sees who is delivering once a rider has the parcel', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order, buyerToken, sessionToken } = await paidOrder(app, merchant);
      assert.equal((await app.orders.buyerView(order.id, buyerToken, sessionToken)).rider, undefined);
      await app.orders.claim(rider.telegramId, order.id);
      const view = await app.orders.buyerView(order.id, buyerToken, sessionToken);
      assert.deepEqual(view.rider, { firstName: 'Test', plateNumber: 'LT-123-AB', riderCode: rider.riderCode, vehicleType: 'MOTO', hasPhoto: true, phone: rider.phone });
      assert.equal(await app.orders.riderPhotoFileId(order.id, buyerToken), 'selfie-file-id-0001');
      await rejects(app.orders.riderPhotoFileId(order.id, 'nope'), 'NOT_FOUND');
    });

    it('contact sharing only registers the sender’s own number', async () => {
      const app = await fresh();
      await assert.rejects(app.users.registerFromContact(5, { phone_number: '671234567', user_id: 6 }));
      const u = await app.users.registerFromContact(5, { phone_number: '+237 671 234 567', first_name: 'Awa', user_id: 5 });
      assert.equal(u.phone, '+237671234567');
    });

    // ================================================================== BS-101 timeouts

    it('timeouts: no rider → reminder at 6 h and 24 h (once each), automatic full refund at 48 h', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order } = await paidOrder(app, merchant); // no riders exist
      const hours = () => evs(app, 'order.stalled', order.id).map((e) => e.hours);

      assert.deepEqual(await app.orders.enforceTimeouts(Date.now() + 5 * HOUR), { reminded: 0, refunded: 0, released: 0 });
      assert.deepEqual(await app.orders.enforceTimeouts(Date.now() + 7 * HOUR), { reminded: 1, refunded: 0, released: 0 });
      assert.deepEqual(hours(), [6]);
      assert.equal((await app.orders.enforceTimeouts(Date.now() + 8 * HOUR)).reminded, 0); // not repeated
      assert.deepEqual(hours(), [6]);

      assert.equal((await app.orders.enforceTimeouts(Date.now() + 25 * HOUR)).reminded, 1);
      assert.deepEqual(hours(), [6, 24]);
      assert.equal((await app.orders.enforceTimeouts(Date.now() + 26 * HOUR)).reminded, 0);
      assert.deepEqual(hours(), [6, 24]);
      assert.equal((await getOrder(app, order.id)).status, 'AWAITING_RIDER');

      assert.deepEqual(await app.orders.enforceTimeouts(Date.now() + 49 * HOUR), { reminded: 0, refunded: 1, released: 0 });
      const refunded = await getOrder(app, order.id);
      assert.equal(refunded.status, 'REFUNDED');
      assert.match(refunded.history.at(-1)!.note!, /no rider within 48 h/);
      assert.deepEqual(refunded.payouts.map((p) => [p.kind, p.amount, p.status, p.phone]), [['BUYER_REFUND', 21500, 'SENT', '+237677001122']]);
      await assertLedgerClean(app, order.id);
      assert.equal(await app.store.ledgerBalance('GATEWAY_CLEARING', order.id), 0);
      // nothing left to do afterwards
      assert.deepEqual(await app.orders.enforceTimeouts(Date.now() + 60 * HOUR), { reminded: 0, refunded: 0, released: 0 });
    });

    it('timeouts: jumping straight past 24 h sends only the 24 h reminder, never the 6 h one afterwards', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order } = await paidOrder(app, merchant);
      await app.orders.enforceTimeouts(Date.now() + 25 * HOUR);
      await app.orders.enforceTimeouts(Date.now() + 26 * HOUR);
      assert.deepEqual(evs(app, 'order.stalled', order.id).map((e) => e.hours), [24]);
    });

    it('timeouts: a cash order nobody takes is cancelled at 48 h and moves no money', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      assert.equal((await app.orders.enforceTimeouts(Date.now() + 7 * HOUR)).reminded, 1);
      const res = await app.orders.enforceTimeouts(Date.now() + 49 * HOUR);
      assert.equal(res.refunded, 1);
      const o = await getOrder(app, order.id);
      assert.equal(o.status, 'CANCELLED');
      assert.deepEqual(o.payouts, []);
      assert.deepEqual(await app.store.listJournals(order.id), []);
    });

    it('timeouts: a rider who does not pick up in 45 min is released, counted as no-show, and the seller’s own-rider preference is dropped', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const own = await makeRider(app);
      const other = await makeRider(app);
      const { order } = await paidOrder(app, merchant, intraInput({ preferredRiderCode: own.riderCode }));
      assert.equal((await getOrder(app, order.id)).preferredRiderId, own.id);
      await app.orders.claim(own.telegramId, order.id);

      assert.equal((await app.orders.enforceTimeouts(Date.now() + 30 * MIN)).released, 0);
      assert.equal((await getOrder(app, order.id)).status, 'RIDER_ASSIGNED');

      const offersBefore = evs(app, 'order.offer', order.id).length;
      assert.deepEqual(await app.orders.enforceTimeouts(Date.now() + 46 * MIN), { reminded: 0, refunded: 0, released: 1 });
      const o = await getOrder(app, order.id);
      assert.equal(o.status, 'AWAITING_RIDER');
      assert.equal(o.firstMileRiderId, undefined);
      assert.equal(o.preferredRiderId, undefined);
      assert.equal((await getRider(app, own.id)).noShows, 1);
      assert.equal(evs(app, 'rider.no_show', order.id).length, 1);
      await tick();
      const offers = evs(app, 'order.offer', order.id);
      assert.ok(offers.length > offersBefore, 'job is offered again');
      assert.ok(offers.at(-1)!.offers.some((x) => x.rider.id === other.id), 'to the whole pool, not only the own rider');
      assert.equal(await app.store.ledgerBalance('ESCROW', order.id), order.total); // buyer's money untouched
    });

    it('timeouts: a released cash job gives the rider’s reserved float back', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app, { floatBalance: 30000 });
      const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(rider.telegramId, order.id);
      assert.equal((await getRider(app, rider.id)).floatReserved, 20000);
      await app.orders.enforceTimeouts(Date.now() + 46 * MIN);
      const r = await getRider(app, rider.id);
      assert.equal(r.floatReserved, 0);
      assert.equal(r.floatBalance, 30000);
      assert.equal(r.noShows, 1);
      const o = await getOrder(app, order.id);
      assert.equal(o.status, 'AWAITING_RIDER');
      assert.equal(o.codReserved, 0);
    });

    it('timeouts: last-mile rider who does not collect in 45 min → back to the destination hub', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const first = await makeRider(app);
      const last = await yaoundeRider(app);
      const { order } = await atAgency(app, merchant, first);
      await app.orders.markArrivedAtHub(order.id, { merchantId: merchant.id });
      await app.orders.claim(last.telegramId, order.id);
      assert.equal((await getOrder(app, order.id)).status, 'LAST_MILE_ASSIGNED');

      const offersBefore = evs(app, 'order.offer', order.id).length;
      assert.equal((await app.orders.enforceTimeouts(Date.now() + 46 * MIN)).released, 1);
      const o = await getOrder(app, order.id);
      assert.equal(o.status, 'AT_DESTINATION_HUB');
      assert.equal(o.lastMileRiderId, undefined);
      assert.equal(o.firstMileRiderId, first.id); // first leg untouched
      assert.equal((await getRider(app, last.id)).noShows, 1);
      assert.ok(!(await getRider(app, first.id)).noShows);
      await tick();
      const offers = evs(app, 'order.offer', order.id);
      assert.ok(offers.length > offersBefore);
      assert.equal(offers.at(-1)!.leg, 'LAST');
    });

    it('timeouts: a parcel waiting 24 h at the departure agency triggers one reminder', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const first = await makeRider(app);
      const { order } = await atAgency(app, merchant, first);
      assert.equal((await app.orders.enforceTimeouts(Date.now() + 23 * HOUR)).reminded, 0);
      assert.equal((await app.orders.enforceTimeouts(Date.now() + 25 * HOUR)).reminded, 1);
      assert.equal((await app.orders.enforceTimeouts(Date.now() + 26 * HOUR)).reminded, 0);
      assert.deepEqual(evs(app, 'order.stalled', order.id).map((e) => e.hours), [24]);
      assert.equal((await getOrder(app, order.id)).status, 'AT_AGENCY');
    });

    // ================================================================== BS-102 stray payments

    it('stray payment: a late success of an old attempt after the order is paid is refunded to the number that paid, once', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
      await app.orders.initiatePayment(order.id, buyerToken, '699001122');
      const ref1 = (await getOrder(app, order.id)).payment.reference!;
      app.sim.fail(ref1);
      await app.orders.initiatePayment(order.id, buyerToken, '677001122'); // retry → ref2
      const ref2 = (await getOrder(app, order.id)).payment.reference!;
      assert.notEqual(ref1, ref2);
      app.sim.approve(ref2);
      await app.handlePaymentReference(ref2);
      assert.equal((await getOrder(app, order.id)).status, 'AWAITING_RIDER');

      app.sim.approve(ref1); // the first prompt was approved after all
      await app.handlePaymentReference(ref1);
      await app.handlePaymentReference(ref1); // webhook repeats
      const o = await getOrder(app, order.id);
      assert.equal(o.status, 'AWAITING_RIDER');
      assert.deepEqual(o.payouts.map((p) => [p.kind, p.amount, p.status, p.phone]), [['BUYER_REFUND', order.total, 'SENT', '+237699001122']]);
      assert.equal(app.sim.withdrawals.filter((w) => w.phone === '+237699001122').length, 1);
      assert.ok((await app.store.listJournals(order.id)).some((j) => j.key === `stray:${ref1}`));
      await tick();
      assert.equal(evs(app, 'order.payment_mismatch', order.id).length, 1);
      // escrow still holds exactly the legitimate payment
      assert.equal(await app.store.ledgerBalance('BUYER_REFUND_PAYABLE', order.id), 0);
      assert.equal(await app.store.ledgerBalance('GATEWAY_CLEARING', order.id), -order.total);
      await assertLedgerClean(app, order.id, { escrowLeft: order.total });
    });

    it('stray payment: a wrong amount on the current attempt is refunded and the buyer can pay again', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
      await app.orders.initiatePayment(order.id, buyerToken, '677001122');
      const ref = (await getOrder(app, order.id)).payment.reference!;
      app.sim.approve(ref, 100);
      await app.handlePaymentReference(ref);

      const o = await getOrder(app, order.id);
      assert.equal(o.status, 'PENDING_PAYMENT');
      assert.equal(o.payment.reference, undefined);
      assert.deepEqual(o.payouts.map((p) => [p.kind, p.amount, p.status, p.phone]), [['BUYER_REFUND', 100, 'SENT', '+237677001122']]);
      assert.ok((await app.store.listJournals(order.id)).some((j) => j.key === `stray:${ref}`));
      assert.equal(await app.store.ledgerBalance('GATEWAY_CLEARING', order.id), 0);
      assert.equal(await app.store.ledgerBalance('BUYER_REFUND_PAYABLE', order.id), 0);
      assert.equal(await app.store.ledgerBalance('ESCROW', order.id), 0);

      // pay properly now: no PAYMENT_IN_PROGRESS block
      await app.orders.initiatePayment(order.id, buyerToken, '677001122');
      const ref2 = (await getOrder(app, order.id)).payment.reference!;
      app.sim.approve(ref2);
      await app.handlePaymentReference(ref2);
      assert.equal((await getOrder(app, order.id)).status, 'AWAITING_RIDER');
      await assertLedgerClean(app, order.id, { escrowLeft: order.total });
    });

    it('stray payment: an overpayment is refunded in full, not accepted', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
      await app.orders.initiatePayment(order.id, buyerToken, '677001122');
      const ref = (await getOrder(app, order.id)).payment.reference!;
      app.sim.approve(ref, order.total + 5000);
      await app.handlePaymentReference(ref);
      const o = await getOrder(app, order.id);
      assert.equal(o.status, 'PENDING_PAYMENT');
      assert.deepEqual(kp(o), [['BUYER_REFUND', order.total + 5000]]);
    });

    // ================================================================== BS-103 buyer absent / refusing

    it('buyer absent: rider must report first, waits 15 min, then the parcel goes back; seller confirms → refund minus the leg run', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const other = await makeRider(app);
      const { order } = await pickedUp(app, merchant, rider);

      await rejects(app.orders.riderReportBuyerAbsent(other.telegramId, order.id), 'FORBIDDEN');
      await rejects(app.orders.riderReturnParcel(rider.telegramId, order.id, 'ABSENT'), 'KEEP_WAITING'); // not reported yet
      const absent = await app.orders.riderReportBuyerAbsent(rider.telegramId, order.id);
      assert.equal(absent.absence?.side, 'BUYER');
      assert.equal(evs(app, 'order.absence', order.id).length, 1);
      const at = absent.absence!.at;
      assert.equal((await app.orders.riderReportBuyerAbsent(rider.telegramId, order.id)).absence!.at, at); // idempotent
      await rejects(app.orders.riderReturnParcel(rider.telegramId, order.id, 'ABSENT'), 'KEEP_WAITING');

      await patchOrder(app, order.id, (o) => { o.absence!.at = new Date(Date.now() - 14 * MIN).toISOString(); });
      await rejects(app.orders.riderReturnParcel(rider.telegramId, order.id, 'ABSENT'), 'KEEP_WAITING');
      await patchOrder(app, order.id, (o) => { o.absence!.at = new Date(Date.now() - 16 * MIN).toISOString(); });
      await rejects(app.orders.riderReturnParcel(other.telegramId, order.id, 'ABSENT'), 'NOT_FOUND');

      const d = await app.orders.riderReturnParcel(rider.telegramId, order.id, 'ABSENT');
      assert.equal(d.status, 'DISPUTED');
      assert.equal(d.dispute?.kind, 'BUYER_ABSENT');
      assert.equal(d.dispute?.returnRequired, true);
      assert.equal(d.dispute?.openedBy, 'RIDER');
      assert.equal(d.buyerRefusalAt, undefined); // prepaid orders don't count towards the cash rule

      await rejects(app.orders.sellerConfirmReturn(order.id, 'someone-else'), 'NOT_FOUND');
      const done = await app.orders.sellerConfirmReturn(order.id, merchant.id);
      assert.equal(done.status, 'REFUNDED');
      assert.deepEqual(done.payouts.map((p) => [p.kind, p.amount, p.status, p.phone]), [
        ['BUYER_REFUND', 20000, 'SENT', '+237677001122'],
        ['FIRST_MILE_RIDER', 1500, 'SENT', rider.phone]
      ]);
      assert.equal(done.dispute?.resolution, 'REFUND_BUYER');
      assert.ok(done.dispute?.returnReceivedAt);
      await assertLedgerClean(app, order.id);
      assert.equal(await app.store.ledgerBalance('GATEWAY_CLEARING', order.id), 0);
      await rejects(app.orders.sellerConfirmReturn(order.id, merchant.id), 'CONFLICT'); // only once
    });

    it('buyer refuses at the door: parcel returns immediately, same refund rule', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order } = await pickedUp(app, merchant, rider);
      const d = await app.orders.riderReturnParcel(rider.telegramId, order.id, 'REFUSED');
      assert.equal(d.status, 'DISPUTED');
      assert.equal(d.dispute?.kind, 'BUYER_REFUSED');
      assert.equal(d.dispute?.returnRequired, true);
      assert.equal(d.buyerRefusalAt, undefined);
      const done = await app.orders.sellerConfirmReturn(order.id, merchant.id);
      assert.deepEqual(kp(done), [['BUYER_REFUND', 20000], ['FIRST_MILE_RIDER', 1500]]);
      await assertLedgerClean(app, order.id);
    });

    it('buyer absent on an inter-city order: both riders keep their legs and the agency fee, buyer gets the item price back', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const first = await makeRider(app);
      const last = await yaoundeRider(app);
      const { order } = await outForDelivery(app, merchant, first, last);
      await rejects(app.orders.riderReportBuyerAbsent(first.telegramId, order.id), 'FORBIDDEN'); // not the delivering rider
      await app.orders.riderReportBuyerAbsent(last.telegramId, order.id);
      await patchOrder(app, order.id, (o) => { o.absence!.at = new Date(Date.now() - 20 * MIN).toISOString(); });
      await app.orders.riderReturnParcel(last.telegramId, order.id, 'ABSENT');
      const done = await app.orders.sellerConfirmReturn(order.id, merchant.id);
      assert.equal(done.status, 'REFUNDED');
      assert.deepEqual(kp(done), [['BUYER_REFUND', 20000], ['FIRST_MILE_RIDER', 3500], ['LAST_MILE_RIDER', 1500]]);
      assert.deepEqual(done.payouts.map((p) => p.status), ['SENT', 'SENT', 'SENT']);
      await assertLedgerClean(app, order.id);
      assert.equal(await app.store.ledgerBalance('GATEWAY_CLEARING', order.id), 0);
    });

    it('cash orders: refusal and absence set buyerRefusalAt, release the float, pay no one; 2 in 90 days → prepaid only', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app, { floatBalance: 100000 });
      const phone = '699112233';

      // 1st: refused at the door
      const a = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(rider.telegramId, a.order.id);
      await app.orders.confirmPickup(rider.telegramId, a.order.id);
      const refused = await app.orders.riderReturnParcel(rider.telegramId, a.order.id, 'REFUSED');
      assert.ok(refused.buyerRefusalAt);
      assert.equal((await getRider(app, rider.id)).floatReserved, 20000); // still held until the parcel is back
      const back = await app.orders.sellerConfirmReturn(a.order.id, merchant.id);
      assert.equal(back.status, 'REFUNDED');
      assert.deepEqual(back.payouts, []);
      const r = await getRider(app, rider.id);
      assert.deepEqual([r.floatReserved, r.floatBalance], [0, 100000]);
      assert.equal(await app.orders.buyerPrepaidOnly(phone), false);

      // 2nd: absent
      const b = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' })); // still allowed after one
      await app.orders.claim(rider.telegramId, b.order.id);
      await app.orders.confirmPickup(rider.telegramId, b.order.id);
      await app.orders.riderReportBuyerAbsent(rider.telegramId, b.order.id);
      await patchOrder(app, b.order.id, (o) => { o.absence!.at = new Date(Date.now() - 16 * MIN).toISOString(); });
      const absent = await app.orders.riderReturnParcel(rider.telegramId, b.order.id, 'ABSENT');
      assert.ok(absent.buyerRefusalAt);
      assert.equal(await app.orders.buyerPrepaidOnly(phone), true);
      assert.equal(await app.orders.buyerPrepaidOnly('+237 699 11 22 33'), true); // same number, other spelling
      assert.equal(await app.orders.buyerPrepaidOnly('not a phone'), false);

      await rejects(app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD', buyerPhone: phone })), 'BUYER_PREPAID_ONLY');
      const esc = await app.orders.createOrder(merchant, intraInput({ buyerPhone: phone })); // escrow still fine
      assert.equal(esc.order.status, 'PENDING_PAYMENT');
      const otherBuyer = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD', buyerPhone: '699778899' }));
      assert.equal(otherBuyer.order.status, 'AWAITING_RIDER');
    });

    it('cash orders: refusals older than 90 days do not count', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app, { floatBalance: 100000 });
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
        await app.orders.claim(rider.telegramId, order.id);
        await app.orders.confirmPickup(rider.telegramId, order.id);
        await app.orders.riderReturnParcel(rider.telegramId, order.id, 'REFUSED');
        ids.push(order.id);
      }
      assert.equal(await app.orders.buyerPrepaidOnly('699112233'), true);
      await patchOrder(app, ids[0], (o) => { o.buyerRefusalAt = new Date(Date.now() - 100 * DAY).toISOString(); });
      assert.equal(await app.orders.buyerPrepaidOnly('699112233'), false);
    });

    // ================================================================== BS-104 seller absent

    it('seller absent at pickup: job back to the pool, rider not penalised, seller counted, job re-offered', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const other = await makeRider(app);
      const { order } = await paidOrder(app, merchant);
      await rejects(app.orders.riderReportSellerAbsent(rider.telegramId, order.id), 'CONFLICT'); // not assigned yet
      await app.orders.claim(rider.telegramId, order.id);
      await rejects(app.orders.riderReportSellerAbsent(other.telegramId, order.id), 'CONFLICT');

      const offersBefore = evs(app, 'order.offer', order.id).length;
      const o = await app.orders.riderReportSellerAbsent(rider.telegramId, order.id);
      assert.equal(o.status, 'AWAITING_RIDER');
      assert.equal(o.firstMileRiderId, undefined);
      assert.equal(o.absence?.side, 'SELLER');
      assert.equal((await getUser(app, merchant.id)).absentAtPickup, 1);
      assert.ok(!(await getRider(app, rider.id)).noShows);
      assert.equal(evs(app, 'order.absence', order.id).filter((e) => e.side === 'SELLER').length, 1);
      await tick();
      assert.ok(evs(app, 'order.offer', order.id).length > offersBefore);
      assert.equal(await app.store.ledgerBalance('ESCROW', order.id), order.total);

      // the next rider takes it; a second absence is counted too; the marker clears at pickup
      await app.orders.claim(other.telegramId, order.id);
      await app.orders.riderReportSellerAbsent(other.telegramId, order.id);
      assert.equal((await getUser(app, merchant.id)).absentAtPickup, 2);
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.confirmPickup(rider.telegramId, order.id);
      assert.equal((await getOrder(app, order.id)).absence, undefined);
    });

    it('seller absent at pickup on a cash order releases the rider’s reserved float', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app, { floatBalance: 30000 });
      const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.riderReportSellerAbsent(rider.telegramId, order.id);
      const r = await getRider(app, rider.id);
      assert.deepEqual([r.floatReserved, r.floatBalance], [0, 30000]);
      assert.equal((await getOrder(app, order.id)).codReserved, 0);
    });

    // ================================================================== BS-105 late cancel / return

    it('late seller cancel (rider already accepted): buyer refunded in full, rider gets half the delivery fee, seller owes it and it is recovered from their next sale', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);

      // buyer cancelling at the same stage costs nobody anything
      const b = await paidOrder(app, merchant);
      await app.orders.claim(rider.telegramId, b.order.id);
      await app.orders.buyerCancel(b.order.id, b.buyerToken, b.sessionToken);
      assert.ok(!(await getUser(app, merchant.id)).owedToPlatform);
      assert.deepEqual(kp(await getOrder(app, b.order.id)), [['BUYER_REFUND', 21500]]);

      // seller cancelling before any rider accepted: also free
      const early = await paidOrder(app, merchant);
      await app.orders.sellerCancel(early.order.id, merchant.id);
      assert.ok(!(await getUser(app, merchant.id)).owedToPlatform);

      const { order } = await paidOrder(app, merchant);
      await app.orders.claim(rider.telegramId, order.id);
      const res = await app.orders.sellerCancel(order.id, merchant.id);
      assert.equal(res.kind, 'cancelled');
      const o = await getOrder(app, order.id);
      assert.equal(o.status, 'REFUNDED');
      assert.deepEqual(o.payouts.map((p) => [p.kind, p.amount, p.status, p.phone]), [
        ['BUYER_REFUND', 21500, 'SENT', '+237677001122'],
        ['FIRST_MILE_RIDER', 750, 'SENT', rider.phone]
      ]);
      assert.equal((await getUser(app, merchant.id)).owedToPlatform, 750);
      assert.ok((await app.store.listJournals(order.id)).some((j) => j.key.startsWith(`order:${order.id}:seller-charge:`)));
      assert.equal(await app.store.ledgerBalance('MERCHANT_RECEIVABLE', merchant.id), -750);
      await assertLedgerClean(app, order.id);

      // the seller's next completed sale pays the platform back
      const next = await deliverEscrow(app, merchant, rider);
      assert.equal(next.status, 'SETTLED');
      assert.deepEqual(kp(next), [['MERCHANT', 19500 - 750], ['FIRST_MILE_RIDER', 1500]]);
      assert.equal((await getUser(app, merchant.id)).owedToPlatform, 0);
      assert.equal(await app.store.ledgerBalance('MERCHANT_RECEIVABLE', merchant.id), 0);
      assert.equal(await app.store.ledgerBalance('PLATFORM_REVENUE', next.id), 500);
      await assertLedgerClean(app, next.id);
      // and the one after is not charged again
      const third = await deliverEscrow(app, merchant, rider);
      assert.deepEqual(kp(third), [['MERCHANT', 19500], ['FIRST_MILE_RIDER', 1500]]);
    });

    it('late seller cancel on a cash order: rider is paid half the fee, float released, debt recovered from the next cash sale', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app, { floatBalance: 100000 });
      const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.sellerCancel(order.id, merchant.id);
      const o = await getOrder(app, order.id);
      assert.equal(o.status, 'CANCELLED');
      assert.deepEqual(o.payouts.map((p) => [p.kind, p.amount, p.status]), [['FIRST_MILE_RIDER', 750, 'SENT']]);
      assert.equal((await getRider(app, rider.id)).floatReserved, 0);
      assert.equal((await getUser(app, merchant.id)).owedToPlatform, 750);
      assert.equal(await app.store.ledgerBalance('MERCHANT_RECEIVABLE', merchant.id), -750);
      await assertLedgerClean(app, order.id);

      const next = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(rider.telegramId, next.order.id);
      await app.orders.confirmPickup(rider.telegramId, next.order.id);
      const res = await app.orders.deliver(rider.telegramId, next.order.id, releaseCode(app, next.order));
      assert.deepEqual(kp(res.order), [['MERCHANT', 19500 - 750]]);
      assert.equal(res.order.status, 'SETTLED');
      assert.equal((await getUser(app, merchant.id)).owedToPlatform, 0);
      assert.equal(await app.store.ledgerBalance('MERCHANT_RECEIVABLE', merchant.id), 0);
      await assertLedgerClean(app, next.order.id);
    });

    it('seller debt larger than the next sale: the whole seller share is withheld and the rest carries over', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      await patchUser(app, merchant.id, (u) => { u.owedToPlatform = 30000; });
      const o = await deliverEscrow(app, merchant, rider);
      assert.equal(o.status, 'SETTLED');
      assert.deepEqual(kp(o), [['FIRST_MILE_RIDER', 1500]]); // no MERCHANT payout
      assert.equal((await getUser(app, merchant.id)).owedToPlatform, 30000 - 19500);
      assert.equal(await app.store.ledgerBalance('PLATFORM_REVENUE', o.id), 500);
      await assertLedgerClean(app, o.id);
    });

    it('seller asks for the parcel back after pickup (escrow): buyer refunded in full, riders’ legs charged to the seller', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order } = await pickedUp(app, merchant, rider);
      const r = await app.orders.sellerCancel(order.id, merchant.id);
      assert.equal(r.kind, 'return_opened');
      assert.equal(r.order.status, 'DISPUTED');
      assert.equal(r.order.dispute?.kind, 'SELLER_RETURN');
      assert.equal(r.order.dispute?.returnRequired, true);
      assert.equal(r.order.buyerRefusalAt, undefined);

      const done = await app.orders.sellerConfirmReturn(order.id, merchant.id);
      assert.equal(done.status, 'REFUNDED');
      assert.deepEqual(done.payouts.map((p) => [p.kind, p.amount, p.status, p.phone]), [
        ['BUYER_REFUND', 21500, 'SENT', '+237677001122'],
        ['FIRST_MILE_RIDER', 1500, 'SENT', rider.phone]
      ]);
      assert.equal((await getUser(app, merchant.id)).owedToPlatform, 1500);
      assert.equal(await app.store.ledgerBalance('MERCHANT_RECEIVABLE', merchant.id), -1500);
      await assertLedgerClean(app, order.id);

      const next = await deliverEscrow(app, merchant, rider);
      assert.deepEqual(kp(next), [['MERCHANT', 19500 - 1500], ['FIRST_MILE_RIDER', 1500]]);
      assert.equal((await getUser(app, merchant.id)).owedToPlatform, 0);
    });

    it('seller asks for the parcel back after pickup (cash): rider is paid the delivery fee by the platform, charged to the seller', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app, { floatBalance: 30000 });
      const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.confirmPickup(rider.telegramId, order.id);
      const r = await app.orders.sellerCancel(order.id, merchant.id);
      assert.equal(r.kind, 'return_opened');
      const done = await app.orders.sellerConfirmReturn(order.id, merchant.id);
      assert.equal(done.status, 'REFUNDED');
      assert.deepEqual(done.payouts.map((p) => [p.kind, p.amount, p.status]), [['FIRST_MILE_RIDER', 1500, 'SENT']]);
      assert.equal(done.buyerRefusalAt, undefined); // the seller's own return is not a buyer refusal
      const rd = await getRider(app, rider.id);
      assert.deepEqual([rd.floatReserved, rd.floatBalance], [0, 30000]);
      assert.equal((await getUser(app, merchant.id)).owedToPlatform, 1500);
      await assertLedgerClean(app, order.id);
    });

    // ================================================================== BS-106 buyer fallbacks

    it('buyer "I received it": escrow only from the phone that paid; cash from the link; settles and pays out', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app, { floatBalance: 30000 });
      const { order, buyerToken, sessionToken } = await paidOrder(app, merchant);
      await rejects(app.orders.buyerConfirmReceived(order.id, buyerToken, sessionToken), 'CONFLICT'); // not out for delivery yet
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.confirmPickup(rider.telegramId, order.id);

      await rejects(app.orders.buyerConfirmReceived(order.id, buyerToken), 'FORBIDDEN');
      await rejects(app.orders.buyerConfirmReceived(order.id, buyerToken, 'x'.repeat(30)), 'FORBIDDEN');
      await rejects(app.orders.buyerConfirmReceived(order.id, 'wrong-token', sessionToken), 'NOT_FOUND');
      assert.equal((await getOrder(app, order.id)).status, 'IN_TRANSIT');

      await rejects(app.orders.buyerConfirmReceived(order.id, buyerToken, sessionToken), 'TOO_EARLY'); // < 20 min after pickup
      await patchOrder(app, order.id, (o) => { for (const h of o.history) h.at = new Date(Date.parse(h.at) - 25 * MIN).toISOString(); });
      const view = await app.orders.buyerConfirmReceived(order.id, buyerToken, sessionToken);
      assert.equal(view.status, 'SETTLED');
      assert.equal(evs(app, 'order.buyer_confirmed', order.id).length, 1);
      const o = await getOrder(app, order.id);
      assert.deepEqual(o.payouts.map((p) => [p.kind, p.amount, p.status]), [['MERCHANT', 19500, 'SENT'], ['FIRST_MILE_RIDER', 1500, 'SENT']]);
      assert.match(o.history.find((h) => h.status === 'DELIVERED')!.note!, /buyer confirmed/);
      await assertLedgerClean(app, order.id);
      assert.equal(await app.store.ledgerBalance('PLATFORM_REVENUE', order.id), 500);
      await rejects(app.orders.buyerConfirmReceived(order.id, buyerToken, sessionToken), 'CONFLICT'); // only once

      // cash: only the rider confirms, with the code
      const cod = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(rider.telegramId, cod.order.id);
      await app.orders.confirmPickup(rider.telegramId, cod.order.id);
      await rejects(app.orders.buyerConfirmReceived(cod.order.id, cod.buyerToken), 'COD_CONFIRM_BY_RIDER');
      assert.equal((await app.orders.buyerView(cod.order.id, cod.buyerToken)).can.confirmReceived, false);
      assert.equal((await getOrder(app, cod.order.id)).status, 'IN_TRANSIT');
    });

    it('buyer "the agency called me": AT_AGENCY → destination hub and the last-mile job is offered', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const first = await makeRider(app);
      await yaoundeRider(app);
      const early = await paidOrder(app, merchant);
      await rejects(app.orders.buyerConfirmArrival(early.order.id, early.buyerToken, early.sessionToken), 'CONFLICT'); // not at an agency

      const { order, buyerToken, sessionToken } = await atAgency(app, merchant, first);
      await rejects(app.orders.buyerConfirmArrival(order.id, 'wrong-token'), 'NOT_FOUND');
      await rejects(app.orders.buyerConfirmArrival(order.id, buyerToken), 'FORBIDDEN'); // paid: only the paying phone
      assert.equal((await getOrder(app, order.id)).status, 'AT_AGENCY');
      const before = evs(app, 'order.offer', order.id).length;
      const view = await app.orders.buyerConfirmArrival(order.id, buyerToken, sessionToken);
      assert.equal(view.status, 'AT_DESTINATION_HUB');
      await tick();
      const offers = evs(app, 'order.offer', order.id);
      assert.ok(offers.length > before);
      assert.equal(offers.at(-1)!.leg, 'LAST');
      await rejects(app.orders.buyerConfirmArrival(order.id, buyerToken, sessionToken), 'CONFLICT'); // already moved on
    });

    it('buyer evidence: only on a dispute, images only, 500 B – 2.5 MB, at most 5', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order, buyerToken, sessionToken } = await pickedUp(app, merchant, rider);
      await rejects(app.orders.buyerAddEvidence(order.id, buyerToken, 'image/jpeg', photo(), sessionToken), 'CONFLICT'); // no dispute yet
      let view = await app.orders.buyerOpenDispute(order.id, buyerToken, 'Parcel is damaged', sessionToken);
      assert.equal(view.can.addEvidence, true);

      await rejects(app.orders.buyerAddEvidence(order.id, 'wrong-token', 'image/jpeg', photo(), sessionToken), 'NOT_FOUND');
      await rejects(app.orders.buyerAddEvidence(order.id, buyerToken, 'application/pdf', photo(), sessionToken), 'INVALID');
      await rejects(app.orders.buyerAddEvidence(order.id, buyerToken, 'image/heic', photo(), sessionToken), 'INVALID');
      await rejects(app.orders.buyerAddEvidence(order.id, buyerToken, 'image/gif', photo(), sessionToken), 'INVALID');
      await rejects(app.orders.buyerAddEvidence(order.id, buyerToken, 'image/jpeg', photo(499), sessionToken), 'INVALID');
      await rejects(app.orders.buyerAddEvidence(order.id, buyerToken, 'image/jpeg', photo(2_500_001), sessionToken), 'INVALID');
      assert.equal((await getOrder(app, order.id)).dispute?.evidence, undefined);

      await app.orders.buyerAddEvidence(order.id, buyerToken, 'image/jpeg', photo(500), sessionToken);
      await app.orders.buyerAddEvidence(order.id, buyerToken, 'image/jpeg; charset=binary', photo(), sessionToken);
      await app.orders.buyerAddEvidence(order.id, buyerToken, 'image/png', photo(2_500_000), sessionToken);
      await app.orders.buyerAddEvidence(order.id, buyerToken, 'IMAGE/WEBP', photo(), sessionToken);
      view = await app.orders.buyerView(order.id, buyerToken, sessionToken);
      assert.equal(view.can.addEvidence, true);
      await app.orders.buyerAddEvidence(order.id, buyerToken, 'image/jpeg', photo(), sessionToken);
      await rejects(app.orders.buyerAddEvidence(order.id, buyerToken, 'image/jpeg', photo(), sessionToken), 'INVALID'); // 6th
      const o = await getOrder(app, order.id);
      assert.equal(o.dispute?.evidence?.length, 5);
      for (const id of o.dispute!.evidence!) assert.ok(await app.store.getMedia(id));
      assert.equal((await app.orders.buyerView(order.id, buyerToken, sessionToken)).can.addEvidence, false);
    });

    // ================================================================== BS-107 admin tools

    it('admin resume: a code lock-out goes back to where it stopped, attempts reset, delivery then works', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order } = await pickedUp(app, merchant, rider);
      await rejects(app.orders.adminResume(order.id), 'CONFLICT'); // not disputed
      const good = releaseCode(app, order);
      const bad = good === '0000' ? '1111' : '0000';
      for (let i = 0; i < 3; i++) await app.orders.deliver(rider.telegramId, order.id, bad);
      assert.equal((await getOrder(app, order.id)).status, 'DISPUTED');
      assert.equal((await getOrder(app, order.id)).dispute?.kind, 'CODE_LOCK');

      const resumed = await app.orders.adminResume(order.id, 'typo');
      assert.equal(resumed.status, 'IN_TRANSIT');
      assert.equal(resumed.codeAttempts, 0);
      assert.equal(resumed.dispute?.resolution, 'RESUMED');
      assert.equal(resumed.dispute?.resolutionNote, 'typo');
      assert.ok(resumed.dispute?.resolvedAt);
      assert.equal((await app.orders.deliver(rider.telegramId, order.id, bad)).attemptsLeft, 2); // fresh attempts
      const res = await app.orders.deliver(rider.telegramId, order.id, good);
      assert.equal(res.order.status, 'SETTLED');
      await assertLedgerClean(app, order.id);
    });

    it('admin resume after a false "buyer absent" report clears the absence', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order } = await pickedUp(app, merchant, rider);
      await app.orders.riderReportBuyerAbsent(rider.telegramId, order.id);
      await patchOrder(app, order.id, (o) => { o.absence!.at = new Date(Date.now() - 20 * MIN).toISOString(); });
      await app.orders.riderReturnParcel(rider.telegramId, order.id, 'ABSENT');
      const resumed = await app.orders.adminResume(order.id);
      assert.equal(resumed.status, 'IN_TRANSIT');
      assert.equal(resumed.absence, undefined);
    });

    it('admin reassign (remove): rider is taken off before pickup, job back to the pool; not possible once picked up', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const other = await makeRider(app);
      const { order } = await paidOrder(app, merchant);
      await app.orders.claim(rider.telegramId, order.id);
      const before = evs(app, 'order.offer', order.id).length;
      const o = await app.orders.adminReassign(order.id, null);
      assert.equal(o.status, 'AWAITING_RIDER');
      assert.equal(o.firstMileRiderId, undefined);
      await tick();
      assert.ok(evs(app, 'order.offer', order.id).length > before);
      await app.orders.claim(other.telegramId, order.id); // somebody else can take it
      await app.orders.confirmPickup(other.telegramId, order.id);
      await rejects(app.orders.adminReassign(order.id, null), 'CONFLICT');
    });

    it('admin reassign (remove) on a cash order gives the float back', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app, { floatBalance: 30000 });
      const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.adminReassign(order.id, null);
      assert.equal((await getRider(app, rider.id)).floatReserved, 0);
      assert.equal((await getOrder(app, order.id)).codReserved, 0);
    });

    it('admin reassign (remove) on a job reserved for the seller’s own rider opens it to the whole pool', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const own = await makeRider(app);
      const other = await makeRider(app);
      const { order } = await paidOrder(app, merchant, intraInput({ preferredRiderCode: own.riderCode }));
      await app.orders.claim(own.telegramId, order.id);
      await app.orders.adminReassign(order.id, null);
      assert.equal((await getOrder(app, order.id)).preferredRiderId, undefined);
      await app.orders.claim(other.telegramId, order.id); // would throw RESERVED today
    });

    it('admin reassign to a named rider: works mid-delivery, the new rider is the one who is paid', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const a = await makeRider(app);
      const b = await makeRider(app);
      const pending = await makeRider(app, { status: 'PENDING' });
      const { order } = await pickedUp(app, merchant, a);
      await rejects(app.orders.adminReassign(order.id, 'BSR-ZZZZ'), 'RIDER_UNKNOWN');
      await rejects(app.orders.adminReassign(order.id, pending.riderCode), 'RIDER_NOT_APPROVED');
      const o = await app.orders.adminReassign(order.id, b.riderCode.toLowerCase());
      assert.equal(o.status, 'IN_TRANSIT');
      assert.equal(o.firstMileRiderId, b.id);
      assert.match(o.history.at(-1)!.note!, new RegExp(b.riderCode));
      assert.equal(evs(app, 'order.reassigned', order.id).length, 1);
      await rejects(app.orders.deliver(a.telegramId, order.id, releaseCode(app, order)), 'FORBIDDEN');
      const res = await app.orders.deliver(b.telegramId, order.id, releaseCode(app, order));
      assert.equal(res.order.status, 'SETTLED');
      assert.deepEqual(res.order.payouts.map((p) => [p.kind, p.phone]), [['MERCHANT', merchant.phone], ['FIRST_MILE_RIDER', b.phone]]);
      assert.ok(!(await getRider(app, a.id)).completedDeliveries);
      assert.equal((await getRider(app, b.id)).completedDeliveries, 1);
      await rejects(app.orders.adminReassign(order.id, a.riderCode), 'CONFLICT'); // settled: nobody to replace
    });

    it('admin reassign of a cash job moves the float reservation, or refuses when the new rider cannot cover it', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const a = await makeRider(app, { floatBalance: 30000 });
      const poor = await makeRider(app, { floatBalance: 5000 });
      const rich = await makeRider(app, { floatBalance: 30000 });
      const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(a.telegramId, order.id);

      await rejects(app.orders.adminReassign(order.id, poor.riderCode), 'INSUFFICIENT_FLOAT');
      assert.equal((await getRider(app, a.id)).floatReserved, 20000); // rolled back: old rider still covered
      let o = await getOrder(app, order.id);
      assert.deepEqual([o.firstMileRiderId, o.codRiderId, o.codReserved], [a.id, a.id, 20000]);

      o = await app.orders.adminReassign(order.id, rich.riderCode);
      assert.deepEqual([o.firstMileRiderId, o.codRiderId, o.codReserved], [rich.id, rich.id, 20000]);
      assert.equal((await getRider(app, a.id)).floatReserved, 0);
      assert.equal((await getRider(app, rich.id)).floatReserved, 20000);
      assert.equal((await getRider(app, poor.id)).floatReserved, 0);

      // and the delivery debits the new rider's float
      await app.orders.confirmPickup(rich.telegramId, order.id);
      const res = await app.orders.deliver(rich.telegramId, order.id, releaseCode(app, order));
      assert.equal(res.order.status, 'SETTLED');
      assert.deepEqual([(await getRider(app, rich.id)).floatBalance, (await getRider(app, a.id)).floatBalance], [10000, 30000]);
    });

    it('admin reassign of the same cash rider does not double-reserve the float', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const a = await makeRider(app, { floatBalance: 25000 });
      const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(a.telegramId, order.id);
      await app.orders.adminReassign(order.id, a.riderCode);
      assert.equal((await getRider(app, a.id)).floatReserved, 20000);
    });

    it('admin resend code: needs the buyer on Telegram, sends the real code, refused once finished', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order, buyerToken, sessionToken } = await paidOrder(app, merchant);
      await rejects(app.orders.adminResendCode(newId()), 'NOT_FOUND');
      await rejects(app.orders.adminResendCode(order.id), 'INVALID'); // not following on Telegram

      const link = await app.orders.createFollowLink(order.id, buyerToken, sessionToken);
      await app.orders.linkBuyerTelegram(link.payload, 555001, 'fr');
      const res = await app.orders.adminResendCode(order.id);
      assert.equal(res.id, order.id);
      const sent = evs(app, 'order.code_resent', order.id);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].code, releaseCode(app, order));

      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.confirmPickup(rider.telegramId, order.id);
      await app.orders.deliver(rider.telegramId, order.id, releaseCode(app, order));
      await rejects(app.orders.adminResendCode(order.id), 'CONFLICT');
      assert.equal(evs(app, 'order.code_resent', order.id).length, 1);
    });

    async function disputedInTransit(app: TestApp) {
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const p = await pickedUp(app, merchant, rider);
      await app.orders.buyerOpenDispute(p.order.id, p.buyerToken, 'Item does not match the photos', p.sessionToken);
      return { ...p, merchant, rider };
    }

    it('admin split: buyer share + rider leg + seller share minus commission pro-rata; payouts and journal add up', async () => {
      const app = await fresh();
      const { order, rider, merchant } = await disputedInTransit(app);
      const done = await app.orders.resolveDispute(order.id, 'SPLIT', 'half and half', { buyerAmount: 8000 });
      assert.equal(done.status, 'SETTLED');
      assert.equal(done.commission, 300); // 2.5 % of the seller's 12 000
      const byKind = Object.fromEntries(done.payouts.map((p) => [p.kind, p]));
      assert.deepEqual(
        [byKind.FIRST_MILE_RIDER.amount, byKind.BUYER_REFUND.amount, byKind.MERCHANT.amount],
        [1500, 8000, 11700]
      );
      assert.equal(byKind.FIRST_MILE_RIDER.phone, rider.phone);
      assert.equal(byKind.BUYER_REFUND.phone, '+237677001122');
      assert.equal(byKind.MERCHANT.phone, merchant.phone);
      assert.equal(done.payouts.reduce((s, p) => s + p.amount, 0), done.total - done.commission);
      assert.ok(done.payouts.every((p) => p.status === 'SENT'));
      assert.equal(done.dispute?.resolution, 'SPLIT');
      assert.equal(await app.store.ledgerBalance('PLATFORM_REVENUE', order.id), 300);
      await assertLedgerClean(app, order.id);
    });

    it('admin split: validates the buyer amount (0 … total − rider legs) and gives the seller nothing at the top end', async () => {
      const app = await fresh();
      const { order } = await disputedInTransit(app);
      const max = order.total - 1500; // 20 000
      for (const bad of [undefined, -1, max + 1, 1.5, Number.NaN]) {
        await rejects(app.orders.resolveDispute(order.id, 'SPLIT', 'x', { buyerAmount: bad as number }), 'INVALID');
      }
      const o = await getOrder(app, order.id);
      assert.equal(o.status, 'DISPUTED'); // untouched by the failed attempts
      assert.equal(o.dispute?.resolution, undefined);
      assert.deepEqual(o.payouts, []);
      assert.deepEqual((await app.store.listJournals(order.id)).map((j) => j.key), [`order:${order.id}:paid`]);
      assert.equal(await app.store.ledgerBalance('ESCROW', order.id), order.total);

      const full = await app.orders.resolveDispute(order.id, 'SPLIT', 'all to buyer', { buyerAmount: max });
      assert.deepEqual(kp(full), [['FIRST_MILE_RIDER', 1500], ['BUYER_REFUND', max]]);
      assert.equal(full.commission, 0);
      await assertLedgerClean(app, order.id);
    });

    it('admin split: buyer gets nothing → seller keeps item minus normal commission', async () => {
      const app = await fresh();
      const { order } = await disputedInTransit(app);
      const done = await app.orders.resolveDispute(order.id, 'SPLIT', undefined, { buyerAmount: 0 });
      assert.deepEqual(kp(done), [['FIRST_MILE_RIDER', 1500], ['MERCHANT', 19500]]);
      assert.equal(done.commission, 500);
      await assertLedgerClean(app, order.id);
    });

    it('admin split is refused on cash orders', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app, { floatBalance: 30000 });
      const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.confirmPickup(rider.telegramId, order.id);
      await app.orders.riderOpenDispute(rider.telegramId, order.id, 'Buyer is aggressive');
      await rejects(app.orders.resolveDispute(order.id, 'SPLIT', 'x', { buyerAmount: 100 }), 'INVALID');
      assert.equal((await getOrder(app, order.id)).status, 'DISPUTED');
    });

    it('admin split recovers what the seller owes the platform from the seller share', async () => {
      const app = await fresh();
      const { order, merchant } = await disputedInTransit(app);
      await patchUser(app, merchant.id, (u) => { u.owedToPlatform = 750; });
      const done = await app.orders.resolveDispute(order.id, 'SPLIT', 'x', { buyerAmount: 8000 });
      assert.equal(done.payouts.find((p) => p.kind === 'MERCHANT')!.amount, 11700 - 750);
      assert.equal((await getUser(app, merchant.id)).owedToPlatform, 0);
    });

    // ================================================================== BS-201 edit / rotate link

    it('edit before payment: price, fee, title and buyer number are recomputed; frozen once paying or paid', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const stranger = await makeMerchant(app);
      const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());

      await rejects(app.orders.editBeforePayment(order.id, stranger, { itemPrice: 1000 }), 'FORBIDDEN');
      await rejects(app.orders.editBeforePayment(order.id, merchant, { buyerPhone: merchant.phone }), 'INVALID');
      await rejects(app.orders.editBeforePayment(order.id, merchant, { itemPrice: 50 }), 'INVALID');
      await rejects(app.orders.editBeforePayment(order.id, merchant, { itemTitle: 'x' }), 'INVALID');
      await rejects(app.orders.editBeforePayment(order.id, merchant, { buyerPhone: 'abc' }), 'INVALID');
      const untouched = await getOrder(app, order.id);
      assert.deepEqual([untouched.itemPrice, untouched.total, untouched.buyerPhone, untouched.itemTitle], [20000, 21500, '+237699112233', 'Robe wax']);

      const titleOnly = await app.orders.editBeforePayment(order.id, merchant, { itemTitle: 'Robe wax bleue' });
      assert.deepEqual([titleOnly.itemTitle, titleOnly.itemPrice, titleOnly.total], ['Robe wax bleue', 20000, 21500]);

      const edited = await app.orders.editBeforePayment(order.id, merchant, { itemTitle: 'Sac cuir', itemPrice: 30000, deliveryFee: 2000, buyerPhone: '699445566' });
      assert.deepEqual(
        [edited.itemTitle, edited.itemPrice, edited.deliveryFee, edited.commission, edited.total, edited.buyerPhone],
        ['Sac cuir', 30000, 2000, 750, 32000, '+237699445566']
      );
      assert.equal(edited.history.at(-1)!.note, 'edited by seller');
      assert.equal(edited.status, 'PENDING_PAYMENT');

      // the buyer is asked for the new total
      await app.orders.initiatePayment(order.id, buyerToken, '677001122');
      await rejects(app.orders.editBeforePayment(order.id, merchant, { itemPrice: 1000 }), 'CONFLICT'); // payment prompt sent
      const ref = (await getOrder(app, order.id)).payment.reference!;
      app.sim.approve(ref);
      await app.handlePaymentReference(ref);
      assert.equal(await app.store.ledgerBalance('ESCROW', order.id), 32000);
      await rejects(app.orders.editBeforePayment(order.id, merchant, { itemPrice: 1000 }), 'CONFLICT'); // paid
    });

    it('edit before payment (cash): allowed until a rider accepts', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app, { floatBalance: 30000 });
      const { order } = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      const edited = await app.orders.editBeforePayment(order.id, merchant, { itemPrice: 25000 });
      assert.deepEqual([edited.itemPrice, edited.total, edited.commission], [25000, 26500, 625]);
      await app.orders.claim(rider.telegramId, order.id);
      assert.equal((await getRider(app, rider.id)).floatReserved, 25000);
      await rejects(app.orders.editBeforePayment(order.id, merchant, { itemPrice: 1000 }), 'CONFLICT');
    });

    it('rotate buyer link: old link and old Telegram follow-link die, the new one works; refused once paid or picked up', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
      const follow = await app.orders.createFollowLink(order.id, buyerToken);
      await app.orders.buyerView(order.id, buyerToken); // works

      await rejects(app.orders.rotateBuyerLink(order.id, 'someone-else'), 'FORBIDDEN');
      const { checkoutUrl } = await app.orders.rotateBuyerLink(order.id, merchant.id);
      await rejects(app.orders.buyerView(order.id, buyerToken), 'NOT_FOUND');
      await rejects(app.orders.initiatePayment(order.id, buyerToken, '677001122'), 'NOT_FOUND');
      await rejects(app.orders.linkBuyerTelegram(follow.payload, 777, 'fr'), 'LINK_EXPIRED');

      assert.ok(checkoutUrl.includes(`o=${order.id}`));
      const newToken = new URLSearchParams(checkoutUrl.split('#')[1]).get('t')!;
      assert.notEqual(newToken, buyerToken);
      const view = await app.orders.buyerView(order.id, newToken);
      assert.equal(view.status, 'PENDING_PAYMENT');

      // pay with the new link, then rotating is refused
      await app.orders.initiatePayment(order.id, newToken, '677001122');
      const ref = (await getOrder(app, order.id)).payment.reference!;
      app.sim.approve(ref);
      await app.handlePaymentReference(ref);
      await rejects(app.orders.rotateBuyerLink(order.id, merchant.id), 'CONFLICT');
      await app.orders.buyerView(order.id, newToken); // still the same link

      // cash order, rider picked up → refused as well
      const rider = await makeRider(app, { floatBalance: 30000 });
      const cod = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(rider.telegramId, cod.order.id);
      await app.orders.rotateBuyerLink(cod.order.id, merchant.id); // still a cancellable stage → allowed
      await app.orders.confirmPickup(rider.telegramId, cod.order.id);
      await rejects(app.orders.rotateBuyerLink(cod.order.id, merchant.id), 'CONFLICT');
    });

    // ================================================================== BS-301 agency fee claim

    it('agency fee claim: an approved extra moves from the seller’s share to the first-mile rider at settlement', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const first = await makeRider(app);
      const last = await yaoundeRider(app);
      const { order } = await atAgency(app, merchant, first, interInput(), 3000);
      assert.deepEqual(order.agencyFeeClaim && [order.agencyFeeClaim.amount, order.agencyFeeClaim.status], [3000, 'PENDING']);
      assert.equal(evs(app, 'order.agency_fee_claim', order.id).length, 1);
      assert.equal(order.agencyFee, 2000); // what the buyer paid is unchanged
      assert.equal(order.total, 25000);

      await rejects(app.orders.sellerDecideAgencyFee(order.id, 'someone-else', true), 'FORBIDDEN');
      const approved = await app.orders.sellerDecideAgencyFee(order.id, merchant.id, true);
      assert.equal(approved.agencyFeeClaim?.status, 'APPROVED');
      await rejects(app.orders.sellerDecideAgencyFee(order.id, merchant.id, false), 'CONFLICT'); // decided once

      await app.orders.markArrivedAtHub(order.id, { merchantId: merchant.id });
      await app.orders.claim(last.telegramId, order.id);
      await app.orders.confirmPickup(last.telegramId, order.id);
      const res = await app.orders.deliver(last.telegramId, order.id, releaseCode(app, order));
      assert.equal(res.order.status, 'SETTLED');
      assert.deepEqual(kp(res.order), [['MERCHANT', 19500 - 1000], ['FIRST_MILE_RIDER', 1500 + 2000 + 1000], ['LAST_MILE_RIDER', 1500]]);
      assert.equal(await app.store.ledgerBalance('PLATFORM_REVENUE', order.id), 500);
      await assertLedgerClean(app, order.id);
    });

    it('agency fee claim: a rejected extra leaves settlement unchanged', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const first = await makeRider(app);
      const last = await yaoundeRider(app);
      const { order } = await atAgency(app, merchant, first, interInput(), 3000);
      const rejected = await app.orders.sellerDecideAgencyFee(order.id, merchant.id, false);
      assert.equal(rejected.agencyFeeClaim?.status, 'REJECTED');
      await app.orders.markArrivedAtHub(order.id, { merchantId: merchant.id });
      await app.orders.claim(last.telegramId, order.id);
      await app.orders.confirmPickup(last.telegramId, order.id);
      const res = await app.orders.deliver(last.telegramId, order.id, releaseCode(app, order));
      assert.deepEqual(kp(res.order), [['MERCHANT', 19500], ['FIRST_MILE_RIDER', 3500], ['LAST_MILE_RIDER', 1500]]);
      await assertLedgerClean(app, order.id);
    });

    it('agency fee claim: none when the agency charged what was declared; absurd amounts are refused; nothing to decide without a claim', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const first = await makeRider(app);
      const p = await pickedUp(app, merchant, first, interInput());
      await rejects(app.orders.recordAgencyDropoff(first.telegramId, p.order.id, 'BUCA-778812', 'photo', 70_000), 'INVALID');
      assert.equal((await getOrder(app, p.order.id)).status, 'IN_TRANSIT'); // rolled back
      assert.equal((await getOrder(app, p.order.id)).waybillNumber, undefined);
      await app.orders.recordAgencyDropoff(first.telegramId, p.order.id, 'BUCA-778812', 'photo', 1500);
      const o = await getOrder(app, p.order.id);
      assert.equal(o.status, 'AT_AGENCY');
      assert.equal(o.agencyFeeClaim, undefined);
      assert.equal(evs(app, 'order.agency_fee_claim', o.id).length, 0);
      await rejects(app.orders.sellerDecideAgencyFee(o.id, merchant.id, true), 'CONFLICT');
    });

    // ================================================================== BS-204 / BS-208

    it('a rider can hold at most 3 active jobs; finishing one frees a slot', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const orders: Order[] = [];
      for (let i = 0; i < 3; i++) {
        const { order } = await paidOrder(app, merchant);
        await app.orders.claim(rider.telegramId, order.id);
        orders.push(order);
      }
      const fourth = await paidOrder(app, merchant);
      await rejects(app.orders.claim(rider.telegramId, fourth.order.id), 'TOO_MANY_JOBS');
      assert.equal((await getOrder(app, fourth.order.id)).status, 'AWAITING_RIDER');

      await app.orders.confirmPickup(rider.telegramId, orders[0].id);
      await rejects(app.orders.claim(rider.telegramId, fourth.order.id), 'TOO_MANY_JOBS'); // in transit still counts
      await app.orders.deliver(rider.telegramId, orders[0].id, releaseCode(app, orders[0]));
      const claimed = await app.orders.claim(rider.telegramId, fourth.order.id);
      assert.equal(claimed.status, 'RIDER_ASSIGNED');
      // another rider is not affected by this rider's load
      const fresh2 = await makeRider(app);
      const fifth = await paidOrder(app, merchant);
      assert.equal((await app.orders.claim(fresh2.telegramId, fifth.order.id)).status, 'RIDER_ASSIGNED');
    });

    it('a suspended seller cannot create orders (clear message); lifting the suspension restores access', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      await app.orders.createOrder(merchant, intraInput()); // fine before
      await patchUser(app, merchant.id, (u) => { u.suspendedAt = new Date().toISOString(); u.suspendNote = 'plaintes clients'; });
      const suspended = await getUser(app, merchant.id);
      await assert.rejects(app.orders.createOrder(suspended, intraInput()), (e: unknown) =>
        e instanceof AppError && e.code === 'SELLER_SUSPENDED' && /suspendu/.test(e.message) && /plaintes clients/.test(e.message)
      );
      await rejects(app.orders.createOrder(suspended, intraInput({ paymentMode: 'COD' })), 'SELLER_SUSPENDED');
      await patchUser(app, merchant.id, (u) => { u.suspendedAt = undefined; });
      const back = await app.orders.createOrder(await getUser(app, merchant.id), intraInput());
      assert.equal(back.order.status, 'PENDING_PAYMENT');
    });

    // ================================================================== BS-206 earnings

    it('rider earnings: week / month / total of sent payouts, pending ones, cash kept, deliveries', async () => {
      const app = await fresh();
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app, { floatBalance: 100000 });
      const stranger = await makeRider(app);
      const setSentAt = (id: string, daysAgo: number) =>
        patchOrder(app, id, (o) => { for (const p of o.payouts) p.sentAt = new Date(Date.now() - daysAgo * DAY).toISOString(); });

      const old = await deliverEscrow(app, merchant, rider);
      const mid = await deliverEscrow(app, merchant, rider);
      const recent = await deliverEscrow(app, merchant, rider);
      await setSentAt(old.id, 40);
      await setSentAt(mid.id, 10);

      const cod = await app.orders.createOrder(merchant, intraInput({ paymentMode: 'COD' }));
      await app.orders.claim(rider.telegramId, cod.order.id);
      await app.orders.confirmPickup(rider.telegramId, cod.order.id);
      await app.orders.deliver(rider.telegramId, cod.order.id, releaseCode(app, cod.order));

      app.sim.failingPayoutPhones.add(rider.phone);
      const stuck = await deliverEscrow(app, merchant, rider);
      assert.equal(stuck.status, 'DELIVERED');
      assert.equal(stuck.payouts.find((p) => p.kind === 'FIRST_MILE_RIDER')!.status, 'FAILED');

      const e = await app.orders.riderEarnings(rider.telegramId);
      assert.deepEqual(e, { week: 1500, month: 3000, total: 4500, pending: 1500, cashKept: 1500, deliveries: 5 });
      assert.equal(recent.status, 'SETTLED');

      const none = await app.orders.riderEarnings(stranger.telegramId);
      assert.deepEqual(none, { week: 0, month: 0, total: 0, pending: 0, cashKept: 0, deliveries: 0 });
    });
  });
}
