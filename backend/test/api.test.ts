import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createServer } from '../src/api/server.js';
import { CampayGateway } from '../src/payments/campay.js';
import { signHs256 } from '../src/payments/jwt.js';
import { createAdminSession, hashPassword, verifyAdminSession, verifyPassword } from '../src/api/admin-auth.js';
import { createPinToken } from '../src/domain/secrets.js';
import { intraInput, makeApp, makeMerchant, makeRider, releaseCode, TestApp } from './helpers.js';

const ADMIN = 'admin-key-admin-key-admin-key';

describe('HTTP API', () => {
  let app: TestApp;
  let server: Server;
  let base: string;

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
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  };

  it('health reports storage and payment mode', async () => {
    const r = await call('GET', '/api/health');
    assert.deepEqual(r.body, { status: 'ok', storage: 'memory', payments: 'simulated', env: 'test' });
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  it('serves the checkout page with a CSP', async () => {
    const res = await fetch(`${base}/checkout.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });

  it('full buyer journey over HTTP; release code only for the paying device', async () => {
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app);
    const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
    const auth = { 'x-buyer-token': buyerToken };

    assert.equal((await call('GET', `/api/checkout/${order.id}`)).status, 404);
    assert.equal((await call('GET', `/api/checkout/${order.id}`, { headers: { 'x-buyer-token': 'nope' } })).status, 404);

    const view = await call('GET', `/api/checkout/${order.id}`, { headers: auth });
    assert.equal(view.status, 200);
    assert.equal(view.body.status, 'PENDING_PAYMENT');
    assert.equal(view.body.releaseCode, undefined);
    for (const secret of ['buyerTokenHash', 'releaseCodeEnc', 'buyerPhone', 'merchantPhone']) assert.equal(secret in view.body, false);

    const patched = await call('PATCH', `/api/checkout/${order.id}/delivery`, {
      headers: auth,
      json: { dropoffLocation: { lat: 4.02, lng: 9.7 }, landmark: 'Portail bleu' }
    });
    assert.equal(patched.body.landmark, 'Portail bleu');
    const outside = await call('PATCH', `/api/checkout/${order.id}/delivery`, { headers: auth, json: { dropoffLocation: { lat: 48.8, lng: 2.3 } } });
    assert.equal(outside.status, 400);

    const badPhone = await call('POST', `/api/checkout/${order.id}/pay`, { headers: auth, json: { payerPhone: '123' } });
    assert.equal(badPhone.status, 400);
    const pay = await call('POST', `/api/checkout/${order.id}/pay`, { headers: auth, json: { payerPhone: '677 00 11 22' } });
    assert.equal(pay.status, 200);
    assert.equal(pay.body.operator, 'MTN');
    const session = pay.body.sessionToken as string;

    const approve = await call('POST', `/api/dev/checkout/${order.id}/approve`, { headers: auth });
    assert.equal(approve.status, 200);

    const payerView = await call('GET', `/api/checkout/${order.id}`, { headers: { ...auth, 'x-buyer-session': session } });
    assert.equal(payerView.body.status, 'AWAITING_RIDER');
    assert.match(payerView.body.releaseCode, /^\d{4}$/);
    const merchantPeek = await call('GET', `/api/checkout/${order.id}`, { headers: auth });
    assert.equal(merchantPeek.body.releaseCode, undefined);
    assert.equal(merchantPeek.body.releaseCodeOnOtherDevice, true);

    await app.orders.claim(rider.telegramId, order.id);
    await app.orders.confirmPickup(rider.telegramId, order.id);
    const dispute = await call('POST', `/api/checkout/${order.id}/dispute`, { headers: { ...auth, 'x-buyer-session': session }, json: { reason: 'Colis abîmé' } });
    assert.equal(dispute.body.status, 'DISPUTED');
  });

  it('buyer can cancel from the checkout page before pickup', async () => {
    const merchant = await makeMerchant(app);
    const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
    const auth = { 'x-buyer-token': buyerToken };
    const before = await call('GET', `/api/checkout/${order.id}`, { headers: auth });
    assert.equal(before.body.can.cancel, true);
    assert.equal((await call('POST', `/api/checkout/${order.id}/cancel`)).status, 404);
    const res = await call('POST', `/api/checkout/${order.id}/cancel`, { headers: auth });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'CANCELLED');
    assert.equal(res.body.can.cancel, false);
  });

  it('public tracking shows status only', async () => {
    const merchant = await makeMerchant(app);
    const { order } = await app.orders.createOrder(merchant, intraInput());
    const r = await call('GET', `/api/track/${order.trackingCode.toLowerCase()}`);
    assert.deepEqual(Object.keys(r.body).sort(), ['status', 'trackingCode', 'updatedAt']);
  });

  it('voice notes accept small audio only', async () => {
    const merchant = await makeMerchant(app);
    const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
    const put = (type: string, size: number) =>
      fetch(`${base}/api/checkout/${order.id}/voice`, { method: 'PUT', headers: { 'content-type': type, 'x-buyer-token': buyerToken }, body: Buffer.alloc(size, 1) });
    assert.equal((await put('audio/webm', 5000)).status, 204);
    assert.equal((await put('audio/webm', 600_000)).status, 413);
    assert.equal((await put('text/plain', 5000)).status, 400);
    assert.ok((await app.store.getOrder(order.id))!.voiceNoteId);
  });

  it('admin endpoints require the bearer key and never leak secrets', async () => {
    assert.equal((await call('GET', '/api/admin/orders')).status, 401);
    assert.equal((await call('GET', '/api/admin/orders', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const list = await call('GET', '/api/admin/orders', { headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(list.status, 200);
    assert.ok(list.body.length > 0);
    for (const o of list.body) {
      assert.equal('releaseCodeEnc' in o, false);
      assert.equal('buyerTokenHash' in o, false);
    }
    const ledger = await call('GET', '/api/admin/ledger', { headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(ledger.body.sum, 0);
  });

  it('admin can resolve a dispute', async () => {
    const merchant = await makeMerchant(app);
    const rider = await makeRider(app);
    const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
    await app.orders.initiatePayment(order.id, buyerToken, '677001122');
    const ref = (await app.store.getOrder(order.id))!.payment.reference!;
    app.sim.approve(ref);
    await app.handlePaymentReference(ref);
    await app.orders.claim(rider.telegramId, order.id);
    await app.orders.confirmPickup(rider.telegramId, order.id);
    await app.orders.openDispute(order.id, 'BUYER', 'wrong size');
    const r = await call('POST', `/api/admin/orders/${order.id}/resolve`, {
      headers: { authorization: `Bearer ${ADMIN}` },
      json: { resolution: 'REFUND_BUYER', note: 'returned to seller' }
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'REFUNDED');
  });

  it('admin overview, seller review with reason, and the map feed', async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    const seller = await makeMerchant(app, { kycStatus: 'PENDING', selfieFileId: 'x', draft: { kind: 'merchant', step: 'city', data: { cniNumber: 'secret' }, startedAt: new Date().toISOString() } });
    const ov = await call('GET', '/api/admin/overview', { headers: auth });
    assert.equal(ov.status, 200);
    assert.ok(ov.body.queues.kycPending >= 1);
    assert.equal(ov.body.days.length, 14);
    const users = await call('GET', '/api/admin/users', { headers: auth });
    const listed = users.body.find((u: any) => u.id === seller.id);
    assert.equal(listed.draft, undefined);
    assert.deepEqual(listed.signupInProgress.step, 'city');
    assert.equal((await call('POST', `/api/admin/users/${seller.id}/kyc`, { headers: auth, json: { approve: false } })).status, 400);
    const refused = await call('POST', `/api/admin/users/${seller.id}/kyc`, { headers: auth, json: { approve: false, note: 'CNI illisible' } });
    assert.equal(refused.body.kycStatus, 'REJECTED');
    assert.equal((await call('GET', '/api/admin/files/abcdefghijkl', { headers: auth })).status, 503);
    const map = await call('GET', '/api/admin/map', { headers: auth });
    assert.ok(Array.isArray(map.body.riders) && Array.isArray(map.body.orders));
  });

  describe('v2 buyer and admin endpoints', () => {
    const auth = { authorization: `Bearer ${ADMIN}` };

    const disputedOrder = async () => {
      const merchant = await makeMerchant(app);
      const rider = await makeRider(app);
      const { order, buyerToken } = await app.orders.createOrder(merchant, intraInput());
      const pay = await app.orders.initiatePayment(order.id, buyerToken, '677001122');
      const ref = (await app.store.getOrder(order.id))!.payment.reference!;
      app.sim.approve(ref);
      await app.handlePaymentReference(ref);
      await app.orders.claim(rider.telegramId, order.id);
      await app.orders.confirmPickup(rider.telegramId, order.id);
      await app.orders.openDispute(order.id, 'BUYER', 'wrong size');
      return { merchant, rider, order, buyerToken, session: pay.sessionToken };
    };

    it('new admin endpoints require admin auth', async () => {
      const checks: [string, string][] = [
        ['POST', '/api/admin/orders/x/resume'], ['POST', '/api/admin/orders/x/reassign'], ['POST', '/api/admin/orders/x/send-code'],
        ['POST', '/api/admin/users/x/suspend'], ['POST', '/api/admin/users/x/unsuspend'], ['GET', '/api/admin/payout-phones'],
        ['POST', '/api/admin/users/x/payout-phone'], ['GET', '/api/admin/media/x'], ['GET', '/api/admin/audit']
      ];
      for (const [m, p] of checks) assert.equal((await call(m, p, m === 'GET' ? {} : { json: {} })).status, 401, `${m} ${p}`);
    });

    it('buyer confirm endpoints need the buyer token', async () => {
      const merchant = await makeMerchant(app);
      const { order } = await app.orders.createOrder(merchant, intraInput());
      assert.equal((await call('POST', `/api/checkout/${order.id}/confirm-received`)).status, 404);
      assert.equal((await call('POST', `/api/checkout/${order.id}/confirm-arrival`)).status, 404);
    });

    it('evidence upload validates mime and size, and the admin can view it', async () => {
      const { order, buyerToken, session } = await disputedOrder();
      const jpeg = (size: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, size - 4), 1)]);
      const post = (type: string, size: number, token = buyerToken) =>
        fetch(`${base}/api/checkout/${order.id}/evidence`, { method: 'POST', headers: { 'content-type': type, 'x-buyer-token': token, 'x-buyer-session': session }, body: jpeg(size) });
      assert.equal((await post('image/jpeg', 1000, 'nope')).status, 404);
      assert.equal((await post('text/plain', 1000)).status, 400);
      assert.equal((await post('image/jpeg', 100)).status, 400);
      assert.equal((await post('image/jpeg', 3_500_000)).status, 413);
      const ok = await post('image/jpeg', 2000);
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true });
      const evidence = (await app.store.getOrder(order.id))!.dispute!.evidence!;
      assert.equal(evidence.length, 1);
      const media = await fetch(`${base}/api/admin/media/${evidence[0]}`, { headers: auth });
      assert.equal(media.status, 200);
      assert.equal(media.headers.get('content-type'), 'image/jpeg');
      assert.equal((await fetch(`${base}/api/admin/media/${evidence[0]}`)).status, 401);
    });

    it('resolve (including SPLIT validation) writes an audit row, and the order view hides secrets', async () => {
      const { order } = await disputedOrder();
      const bad = await call('POST', `/api/admin/orders/${order.id}/resolve`, { headers: auth, json: { resolution: 'SPLIT' } });
      assert.equal(bad.status, 400);
      const r = await call('POST', `/api/admin/orders/${order.id}/resolve`, { headers: auth, json: { resolution: 'REFUND_BUYER', note: 'ok' } });
      assert.equal(r.status, 200);
      assert.equal('releaseCodeEnc' in r.body, false);
      assert.equal('buyerSessionHash' in r.body, false);
      const log = await call('GET', '/api/admin/audit?limit=10', { headers: auth });
      assert.equal(log.status, 200);
      const row = log.body.find((a: any) => a.target === order.id && a.action.startsWith('dispute.resolve'));
      assert.ok(row);
      assert.equal(row.actor, 'admin');
    });

    it('send-code never returns the code and is audited', async () => {
      const merchant = await makeMerchant(app);
      const { order } = await app.orders.createOrder(merchant, intraInput());
      const o = (await app.store.getOrder(order.id))!;
      await app.store.updateOrder({ ...o, buyerTelegramId: 4242 });
      const code = releaseCode(app, o);
      const r = await call('POST', `/api/admin/orders/${order.id}/send-code`, { headers: auth });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true });
      assert.equal(JSON.stringify(r.body).includes(code), false);
      const log = await call('GET', '/api/admin/audit', { headers: auth });
      assert.ok(log.body.some((a: any) => a.action === 'order.send_code' && a.target === order.id));
    });

    it('suspending a seller blocks new orders and is audited; unsuspend restores', async () => {
      const merchant = await makeMerchant(app);
      const s = await call('POST', `/api/admin/users/${merchant.id}/suspend`, { headers: auth, json: { note: 'fraud check' } });
      assert.equal(s.status, 200);
      assert.ok(s.body.suspendedAt);
      await assert.rejects(app.orders.createOrder((await app.store.getUser(merchant.id))!, intraInput()), /suspendu/);
      const u = await call('POST', `/api/admin/users/${merchant.id}/unsuspend`, { headers: auth });
      assert.equal(u.body.suspendedAt, undefined);
      await app.orders.createOrder((await app.store.getUser(merchant.id))!, intraInput());
      const log = await call('GET', '/api/admin/audit', { headers: auth });
      assert.ok(log.body.some((a: any) => a.action === 'user.suspend' && a.target === merchant.id && a.note === 'fraud check'));
    });

    it('payout phone change needs admin approval', async () => {
      const merchant = await makeMerchant(app);
      await assert.rejects(app.users.requestPayoutPhone(merchant.telegramId, merchant.phone), /déjà/);
      await assert.rejects(app.users.requestPayoutPhone(merchant.telegramId, '12345'));
      await app.users.requestPayoutPhone(merchant.telegramId, '677 55 44 33');
      const pending = await call('GET', '/api/admin/payout-phones', { headers: auth });
      assert.ok(pending.body.some((u: any) => u.id === merchant.id && u.pendingPayoutPhone));
      const d = await call('POST', `/api/admin/users/${merchant.id}/payout-phone`, { headers: auth, json: { approve: true } });
      assert.equal(d.status, 200);
      // approval only schedules the change (24 h cool-down): the old number stays in force
      assert.equal(d.body.payoutPhone, undefined);
      assert.ok(d.body.pendingPayoutPhone);
      assert.ok(d.body.payoutPhoneEffectiveAt);
      const scheduled = await call('GET', '/api/admin/payout-phones', { headers: auth });
      assert.equal(scheduled.body.find((u: any) => u.id === merchant.id).scheduled, true);
      await app.users.activatePayoutPhoneIfDue(merchant.id, new Date(Date.now() + 25 * 3600_000));
      assert.ok((await app.store.getUser(merchant.id))!.payoutPhone);
      assert.equal((await app.store.getUser(merchant.id))!.pendingPayoutPhone, undefined);
      assert.equal((await call('POST', `/api/admin/users/${merchant.id}/payout-phone`, { headers: auth, json: {} })).status, 400);
    });

    it('rider float withdrawal debits the balance, and reverts if the payout fails', async () => {
      const rider = await makeRider(app, { floatBalance: 10_000, floatReserved: 2_000 });
      await assert.rejects(app.riders.withdrawFloat(rider.telegramId, 9_000), /solde/);
      await assert.rejects(app.riders.withdrawFloat(rider.telegramId, 100));
      const { rider: after, topup } = await app.riders.withdrawFloat(rider.telegramId, 5_000);
      assert.equal(after.floatBalance, 5_000);
      assert.equal(topup.kind, 'WITHDRAWAL');
      app.sim.failingPayoutPhones.add(rider.phone);
      await assert.rejects(app.riders.withdrawFloat(rider.telegramId, 1_000), /échoué/);
      assert.equal((await app.store.getRider(rider.id))!.floatBalance, 5_000);
      app.sim.failingPayoutPhones.delete(rider.phone);
    });

    it('security PIN WebApp page and API endpoints', async () => {
      const merchant = await makeMerchant(app);

      // GET /pin serves HTML with customized CSP allowing telegram.org
      const pinPage = await fetch(`${base}/pin`);
      assert.equal(pinPage.status, 200);
      assert.match(pinPage.headers.get('content-security-policy') ?? '', /telegram\.org/);
      assert.match(await pinPage.text(), /BayamSafe · Code PIN Sécurisé/);

      // GET /api/pin/session without token or invalid token
      assert.equal((await call('GET', '/api/pin/session')).status, 401);
      assert.equal((await call('GET', '/api/pin/session?t=invalid.token')).status, 401);

      // Valid set_pin token
      const setToken = createPinToken(app.config.APP_SECRET, {
        userId: merchant.id,
        telegramId: merchant.telegramId,
        action: 'set_pin',
        purpose: 'manage'
      });
      const sess = await call('GET', `/api/pin/session?t=${encodeURIComponent(setToken)}`);
      assert.equal(sess.status, 200);
      assert.deepEqual(sess.body, {
        ok: true,
        mode: 'set',
        purpose: 'manage',
        user: { fullName: merchant.fullName, shopName: merchant.shopName }
      });

      // POST /api/pin/set with invalid PIN
      assert.equal((await call('POST', '/api/pin/set', { json: { token: setToken, pin: '123' } })).status, 400); // 3 digits
      assert.equal((await call('POST', '/api/pin/set', { json: { token: setToken, pin: '1234' } })).status, 400); // trivial
      assert.equal((await call('POST', '/api/pin/set', { json: { token: setToken, pin: '0000' } })).status, 400); // trivial

      // POST /api/pin/set with valid PIN
      const setOk = await call('POST', '/api/pin/set', { json: { token: setToken, pin: '8294' } });
      assert.equal(setOk.status, 200);
      assert.equal(setOk.body.ok, true);

      const userAfter = (await app.store.getUser(merchant.id))!;
      assert.ok(userAfter.pinHash);
      assert.ok(userAfter.pinSetAt);
      assert.equal(app.users.isPinAuthenticated(userAfter), true);

      // Verify token
      const verifyToken = createPinToken(app.config.APP_SECRET, {
        userId: merchant.id,
        telegramId: merchant.telegramId,
        action: 'verify_pin',
        purpose: 'retrait:5000'
      });

      // Wrong PIN
      const wrong = await call('POST', '/api/pin/verify', { json: { token: verifyToken, pin: '9999' } });
      assert.equal(wrong.status, 400);
      assert.equal(wrong.body.ok, false);
      assert.equal(wrong.body.remainingAttempts, 4);

      // Correct PIN
      const correct = await call('POST', '/api/pin/verify', { json: { token: verifyToken, pin: '8294' } });
      assert.equal(correct.status, 200);
      assert.equal(correct.body.ok, true);

      // Admin user view redacts pinHash
      const adminUsers = await call('GET', '/api/admin/users', { headers: auth });
      const found = adminUsers.body.find((u: any) => u.id === merchant.id);
      assert.ok(found);
      assert.equal('pinHash' in found, false);
    });
  });

  it('serves the landing page at / and the dashboard at /admin', async () => {
    const home = await fetch(base + '/');
    assert.match(await home.text(), /Vendez en ligne/);
    const admin = await fetch(base + '/admin');
    assert.equal(admin.headers.get('x-robots-tag'), 'noindex');
    assert.match(await admin.text(), /Poste de contrôle/);
    assert.deepEqual((await call('GET', '/api/config')).body, { botUsername: null });
  });

  it('unknown API routes return JSON 404', async () => {
    const r = await call('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'NOT_FOUND');
  });
});

describe('admin password login', () => {
  it('logs in with username and password, issues an expiring session, and rejects bad credentials', async () => {
    const hash = hashPassword('correct horse battery');
    const app = makeApp({ env: { ADMIN_USERNAME: 'boss', ADMIN_PASSWORD_HASH: hash } });
    const server = createServer(app, { webDir: path.resolve(__dirname, '../../web') }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = (username: string, password: string) =>
      fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    try {
      assert.equal((await login('boss', 'wrong password')).status, 401);
      assert.equal((await login('someone', 'correct horse battery')).status, 401);
      const ok = await login('BOSS', 'correct horse battery');
      assert.equal(ok.status, 200);
      const { token, expiresAt } = await ok.json();
      assert.ok(Date.parse(expiresAt) > Date.now());
      const overview = await fetch(base + '/api/admin/overview', { headers: { authorization: `Bearer ${token}` } });
      assert.equal(overview.status, 200);
      const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
      assert.equal((await fetch(base + '/api/admin/overview', { headers: { authorization: `Bearer ${tampered}` } })).status, 401);
    } finally {
      server.close();
    }
    const expired = createAdminSession('test-secret-test-secret-test-secret-1234', 'boss', 1000, Date.now() - 5000);
    assert.equal(verifyAdminSession('test-secret-test-secret-test-secret-1234', expired.token), null);
    assert.equal(verifyPassword('x', 'not-a-hash'), false);
  });

  it('refuses password login when no hash is configured', async () => {
    const server = createServer(makeApp(), { webDir: path.resolve(__dirname, '../../web') }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'anything-at-all' })
    });
    server.close();
    assert.equal(res.status, 503);
  });
});

describe('Campay gateway', () => {
  const key = 'webhook-key';
  const calls: Array<{ url: string; body?: any; auth?: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, auth: (init?.headers as Record<string, string>)?.Authorization });
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (url.endsWith('/token/')) return reply(200, { token: 'tok-1', expires_in: 3600 });
    if (url.endsWith('/collect/')) return reply(200, { reference: 'ref-1', ussd_code: '*126#', operator: 'MTN' });
    if (url.includes('/transaction/ref-1/')) return reply(200, { reference: 'ref-1', status: 'SUCCESSFUL', amount: '21500', external_reference: 'order:x', operator: 'MTN' });
    return reply(400, { message: 'bad request' });
  };
  const gw = new CampayGateway({ baseUrl: 'https://demo.campay.net/api', username: 'u', password: 'p', webhookKey: key, fetchImpl: fakeFetch });

  it('authenticates once, sends amounts as strings and numbers in 237 format', async () => {
    const res = await gw.collect({ amount: 21500, phone: '+237677001122', description: 'test', externalReference: 'order:x' });
    assert.deepEqual(res, { reference: 'ref-1', operator: 'MTN', ussdCode: '*126#' });
    const tx = await gw.getTransaction('ref-1');
    assert.deepEqual(tx, { reference: 'ref-1', status: 'SUCCESSFUL', amount: 21500, externalReference: 'order:x', operator: 'MTN' });
    assert.equal(calls.filter((c) => c.url.endsWith('/token/')).length, 1);
    const collect = calls.find((c) => c.url.endsWith('/collect/'))!;
    assert.deepEqual(collect.body, { amount: '21500', currency: 'XAF', from: '237677001122', description: 'test', external_reference: 'order:x' });
    assert.equal(collect.auth, 'Token tok-1');
  });

  it('surfaces provider errors', async () => {
    await assert.rejects(gw.withdraw({ amount: 1, phone: '+237677001122', description: 'x', externalReference: 'p' }), /bad request/);
  });

  it('only trusts webhooks with a valid signature', () => {
    assert.equal(gw.parseWebhook({ reference: 'ref-1', status: 'SUCCESSFUL' }), null);
    assert.equal(gw.parseWebhook({ reference: 'ref-1', status: 'SUCCESSFUL', signature: signHs256({}, 'other') }), null);
    assert.deepEqual(gw.parseWebhook({ reference: 'ref-1', status: 'SUCCESSFUL', signature: signHs256({ iat: 1 }, key) }), {
      reference: 'ref-1',
      status: 'SUCCESSFUL',
      externalReference: undefined
    });
  });
});
