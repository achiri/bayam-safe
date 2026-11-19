import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { AppError } from '../src/domain/errors.js';
import { LedgerAccount } from '../src/domain/types.js';
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
      const { order, buyerToken } = await paidOrder(app, merchant);
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.confirmPickup(rider.telegramId, order.id);
      const view = await app.orders.buyerOpenDispute(order.id, buyerToken, 'Rider asked for code before showing parcel');
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
  });
}
