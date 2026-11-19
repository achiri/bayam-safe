import { App, createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { newId } from '../src/domain/secrets.js';
import { Order, Rider, User } from '../src/domain/types.js';
import { SimulatedGateway } from '../src/payments/simulated.js';
import { CreateOrderInput } from '../src/services/order.service.js';
import { MemoryStore } from '../src/storage/memory.js';
import { Store } from '../src/storage/store.js';

export interface TestApp extends App {
  sim: SimulatedGateway;
}

export function makeApp(opts: { store?: Store; env?: Record<string, string> } = {}): TestApp {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_SECRET: 'test-secret-test-secret-test-secret-1234',
    ADMIN_API_KEY: 'admin-key-admin-key-admin-key',
    PUBLIC_URL: 'http://localhost:4000',
    ...opts.env
  });
  const sim = new SimulatedGateway();
  const app = createApp(config, { store: opts.store ?? new MemoryStore(), gateway: sim });
  return Object.assign(app, { sim });
}

let tg = 1000;
const nextTg = () => ++tg;

export async function makeMerchant(app: App, patch: Partial<User> = {}): Promise<User> {
  const now = new Date().toISOString();
  const u: User = {
    id: newId(), version: 1, telegramId: nextTg(), phone: `+2376700${String(tg).padStart(5, '0')}`,
    fullName: 'Test Merchant', shopName: 'Test Shop', city: 'Douala', lang: 'fr', kycStatus: 'NONE',
    createdAt: now, updatedAt: now, ...patch
  };
  await app.store.insertUser(u);
  return u;
}

export async function makeRider(app: App, patch: Partial<Rider> = {}): Promise<Rider> {
  const user = await makeMerchant(app, { phone: `+2376910${String(tg + 1).padStart(5, '0')}` });
  const now = new Date().toISOString();
  const r: Rider = {
    id: newId(), version: 1, userId: user.id, telegramId: user.telegramId, fullName: 'Test Rider', phone: user.phone,
    cniNumber: `CNI${user.telegramId}`, plateNumber: 'LT-123-AB', vehicleType: 'MOTO', city: 'Douala', status: 'APPROVED',
    onDuty: true, floatBalance: 0, floatReserved: 0, completedDeliveries: 0,
    location: { lat: 4.0511, lng: 9.7085 }, locationUpdatedAt: now, createdAt: now, updatedAt: now, ...patch
  };
  await app.store.insertRider(r);
  return r;
}

export const intraInput = (patch: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  type: 'INTRA_CITY',
  paymentMode: 'ESCROW',
  itemTitle: 'Robe wax',
  itemPrice: 20000,
  deliveryFee: 1500,
  buyerPhone: '699112233',
  pickupAddress: 'Marché Akwa',
  pickupLocation: { lat: 4.05, lng: 9.71 },
  ...patch
});

/** Creates an order and runs the buyer payment through the simulated provider. */
export async function paidOrder(app: TestApp, merchant: User, input = intraInput()) {
  const created = await app.orders.createOrder(merchant, input);
  const pay = await app.orders.initiatePayment(created.order.id, created.buyerToken, '677001122');
  const o = (await app.store.getOrder(created.order.id))!;
  app.sim.approve(o.payment.reference!);
  await app.handlePaymentReference(o.payment.reference!);
  return { ...created, sessionToken: pay.sessionToken, order: (await app.store.getOrder(created.order.id))! };
}

export const releaseCode = (app: App, o: Order) => app.secrets.decrypt(o.releaseCodeEnc);

/** Lets fire-and-forget event handlers run. */
export const tick = () => new Promise((r) => setImmediate(r));
