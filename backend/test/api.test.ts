import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createServer } from '../src/api/server.js';
import { CampayGateway } from '../src/payments/campay.js';
import { signHs256 } from '../src/payments/jwt.js';
import { intraInput, makeApp, makeMerchant, makeRider, TestApp } from './helpers.js';

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
    const dispute = await call('POST', `/api/checkout/${order.id}/dispute`, { headers: auth, json: { reason: 'Colis abîmé' } });
    assert.equal(dispute.body.status, 'DISPUTED');
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
    assert.equal((await call('GET', '/api/admin/orders')).status, 403);
    assert.equal((await call('GET', '/api/admin/orders', { headers: { authorization: 'Bearer wrong' } })).status, 403);
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

  it('unknown API routes return JSON 404', async () => {
    const r = await call('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'NOT_FOUND');
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
