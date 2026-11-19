import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { computePricing, refundPlan, settlementPlan } from '../src/domain/money.js';
import { canTransition, transition } from '../src/domain/order-state.js';
import { parseCoordinates } from '../src/domain/geo.js';
import { detectOperator, maskPhone, normalizeCameroonPhone, normalizeContactPhone } from '../src/domain/phone.js';
import { Secrets, newTrackingCode } from '../src/domain/secrets.js';
import { Order } from '../src/domain/types.js';
import { signHs256, verifyHs256 } from '../src/payments/jwt.js';

describe('phone numbers', () => {
  it('normalises the usual ways people type Cameroon numbers', () => {
    for (const raw of ['671234567', '6 71 23 45 67', '237671234567', '+237 671 234 567', '00237671234567']) {
      assert.equal(normalizeCameroonPhone(raw), '+237671234567');
    }
  });
  it('rejects non-mobile or malformed numbers', () => {
    for (const raw of ['', '12345', '271234567', '67123456', '+33612345678']) {
      assert.throws(() => normalizeCameroonPhone(raw));
    }
  });
  it('detects operators and admits uncertainty', () => {
    assert.equal(detectOperator('671234567'), 'MTN');
    assert.equal(detectOperator('652345678'), 'MTN');
    assert.equal(detectOperator('681234567'), 'MTN');
    assert.equal(detectOperator('699123456'), 'ORANGE');
    assert.equal(detectOperator('656123456'), 'ORANGE');
    assert.equal(detectOperator('662123456'), undefined);
    assert.equal(maskPhone('671234567'), '+237 6•• ••• 567');
  });
});

describe('buyer contact numbers', () => {
  it('accepts Cameroon numbers as before and foreign numbers written with their country code', () => {
    assert.equal(normalizeContactPhone('671234567'), '+237671234567');
    assert.equal(normalizeContactPhone('+237 671 234 567'), '+237671234567');
    assert.equal(normalizeContactPhone('+33 6 12 34 56 78'), '+33612345678');
    assert.equal(normalizeContactPhone('0044 7700 900123'), '+447700900123');
    assert.equal(normalizeContactPhone('+1 (415) 555-0100'), '+14155550100');
  });
  it('rejects foreign numbers without a country code and malformed input', () => {
    for (const raw of ['0612345678', '12345', '+12', '+237 271234567', 'abc', '']) assert.throws(() => normalizeContactPhone(raw), undefined, raw);
  });
});

describe('pricing and splits', () => {
  it('merchant pays the commission, buyer pays item + fees', () => {
    const p = computePricing(20000, 1500, 0, 2.5);
    assert.deepEqual(p, { itemPrice: 20000, deliveryFee: 1500, agencyFee: 0, commission: 500, total: 21500 });
  });
  it('rejects fractional or out-of-range amounts', () => {
    assert.throws(() => computePricing(1000.5, 0, 0, 2.5));
    assert.throws(() => computePricing(50, 0, 0, 2.5));
    assert.throws(() => computePricing(1000, -1, 0, 2.5));
  });
  it('settlement plan always adds up to total minus commission', () => {
    const intra = { type: 'INTRA_CITY' as const, itemPrice: 20000, commission: 500, deliveryFee: 1500, agencyFee: 0 };
    assert.equal(settlementPlan(intra).reduce((s, l) => s + l.amount, 0), 21000);
    const inter = { type: 'INTER_CITY' as const, itemPrice: 30000, commission: 750, deliveryFee: 3001, agencyFee: 2000 };
    const lines = settlementPlan(inter);
    assert.equal(lines.reduce((s, l) => s + l.amount, 0), 30000 + 3001 + 2000 - 750);
    assert.equal(lines.find((l) => l.kind === 'FIRST_MILE_RIDER')!.amount, 1500 + 2000);
    assert.equal(lines.find((l) => l.kind === 'LAST_MILE_RIDER')!.amount, 1501);
  });
  it('refunds keep only the delivery legs that actually ran', () => {
    const o = { type: 'INTER_CITY' as const, total: 35000, deliveryFee: 3000, agencyFee: 2000 };
    const none = refundPlan(o, { pickedUp: false, reachedAgency: false, lastMileRan: false });
    assert.deepEqual(none, [{ kind: 'BUYER_REFUND', amount: 35000 }]);
    const firstLeg = refundPlan(o, { pickedUp: true, reachedAgency: true, lastMileRan: false });
    assert.deepEqual(firstLeg, [
      { kind: 'BUYER_REFUND', amount: 35000 - 1500 - 2000 },
      { kind: 'FIRST_MILE_RIDER', amount: 3500 }
    ]);
  });
});

describe('order state machine', () => {
  const base = () => ({ status: 'PENDING_PAYMENT', trackingCode: 'BS-TEST', history: [], updatedAt: '' }) as unknown as Order;
  it('allows the happy path and records history', () => {
    const o = base();
    for (const s of ['AWAITING_RIDER', 'RIDER_ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'SETTLED'] as const) transition(o, s);
    assert.equal(o.status, 'SETTLED');
    assert.equal(o.history.length, 5);
  });
  it('blocks shortcuts such as paying out an unpaid order', () => {
    assert.equal(canTransition('PENDING_PAYMENT', 'DELIVERED'), false);
    assert.equal(canTransition('SETTLED', 'REFUNDED'), false);
    assert.equal(canTransition('IN_TRANSIT', 'CANCELLED'), false);
    assert.throws(() => transition(base(), 'SETTLED'));
  });
});

describe('secrets', () => {
  const s = new Secrets('x'.repeat(40));
  it('encrypts release codes reversibly but not deterministically', () => {
    const a = s.encrypt('0420');
    assert.notEqual(a, s.encrypt('0420'));
    assert.equal(s.decrypt(a), '0420');
    assert.throws(() => new Secrets('y'.repeat(40)).decrypt(a));
  });
  it('verifies tokens by hash only', () => {
    const tok = Secrets.token();
    const h = s.hashToken(tok);
    assert.equal(s.verifyToken(tok, h), true);
    assert.equal(s.verifyToken(tok + 'x', h), false);
    assert.equal(s.verifyToken(undefined, h), false);
  });
  it('tracking codes avoid ambiguous characters', () => {
    for (let i = 0; i < 200; i++) assert.match(newTrackingCode(), /^BS-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  });
});

describe('HS256 webhook signatures', () => {
  it('accepts valid and rejects tampered, wrong-key or expired tokens', () => {
    const tok = signHs256({ ref: 'abc' }, 'key');
    assert.deepEqual(verifyHs256(tok, 'key'), { ref: 'abc' });
    assert.equal(verifyHs256(tok, 'other'), null);
    assert.equal(verifyHs256(tok.slice(0, -2) + 'xx', 'key'), null);
    assert.equal(verifyHs256(signHs256({ exp: 1 }, 'key'), 'key'), null);
    assert.equal(verifyHs256('garbage', 'key'), null);
  });
});

describe('coordinates typed or pasted as text', () => {
  it('reads plain pairs and common Google Maps link shapes', () => {
    const at = { lat: 4.0511, lng: 9.7085 };
    for (const t of ['4.0511, 9.7085', '4.0511 9.7085', '4.0511;9.7085',
      'https://www.google.com/maps/place/Akwa/@4.0511,9.7085,17z', 'https://maps.google.com/?q=4.0511,9.7085',
      'https://www.google.com/maps/dir/?api=1&destination=4.0511%2C9.7085', 'https://www.google.com/maps/place/4.0511,9.7085']) {
      assert.deepEqual(parseCoordinates(t), at, t);
    }
    for (const t of ['Akwa market', '12', 'https://maps.app.goo.gl/AbCdEf', '200.1, 9.7']) assert.equal(parseCoordinates(t), undefined, t);
  });
});

describe('config', () => {
  it('refuses unsafe production settings', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /APP_SECRET|DATABASE_URL|PAYMENT_PROVIDER/);
  });
  it('requires Campay credentials and webhook key together', () => {
    assert.throws(() => loadConfig({ PAYMENT_PROVIDER: 'campay', CAMPAY_USERNAME: 'u', CAMPAY_PASSWORD: 'p' }), /CAMPAY_WEBHOOK_KEY/);
  });
});
