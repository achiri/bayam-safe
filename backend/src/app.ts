import { AppConfig } from './config.js';
import { Secrets } from './domain/secrets.js';
import { CampayGateway } from './payments/campay.js';
import { PaymentGateway } from './payments/gateway.js';
import { SimulatedGateway } from './payments/simulated.js';
import { DispatchService } from './services/dispatch.service.js';
import { EventBus } from './services/events.js';
import { OrderService } from './services/order.service.js';
import { RiderService } from './services/rider.service.js';
import { FileFetcher, TelegramFiles } from './services/telegram-files.js';
import { UserService } from './services/user.service.js';
import { MemoryStore } from './storage/memory.js';
import { PostgresStore, nodePostgresDriver } from './storage/postgres.js';
import { Store } from './storage/store.js';

export interface App {
  config: AppConfig;
  store: Store;
  gateway: PaymentGateway;
  events: EventBus;
  secrets: Secrets;
  users: UserService;
  riders: RiderService;
  orders: OrderService;
  dispatch: DispatchService;
  /** Reads photos users sent to the bot (undefined when no bot token is configured). */
  files?: FileFetcher;
  /** Routes a provider transaction reference to the order or float top-up it belongs to. */
  handlePaymentReference(reference: string): Promise<void>;
}

export function createGateway(config: AppConfig): PaymentGateway {
  if (config.PAYMENT_PROVIDER === 'campay') {
    return new CampayGateway({
      baseUrl: config.CAMPAY_BASE_URL,
      username: config.CAMPAY_USERNAME!,
      password: config.CAMPAY_PASSWORD!,
      webhookKey: config.CAMPAY_WEBHOOK_KEY!
    });
  }
  return new SimulatedGateway();
}

export function createStore(config: AppConfig): Store {
  return config.DATABASE_URL ? new PostgresStore(nodePostgresDriver(config.DATABASE_URL)) : new MemoryStore();
}

export function createApp(config: AppConfig, overrides: { store?: Store; gateway?: PaymentGateway; files?: FileFetcher } = {}): App {
  const store = overrides.store ?? createStore(config);
  const gateway = overrides.gateway ?? createGateway(config);
  const events = new EventBus();
  const files = overrides.files ?? (config.TELEGRAM_BOT_TOKEN ? new TelegramFiles(config.TELEGRAM_BOT_TOKEN) : undefined);
  const secrets = new Secrets(config.APP_SECRET);
  const users = new UserService(store, events);
  const riders = new RiderService(store, users, gateway, events);
  const dispatch = new DispatchService(store, config.DISPATCH_RADIUS_KM);
  const orders = new OrderService(store, gateway, events, secrets, dispatch, riders, {
    commissionPct: config.PLATFORM_COMMISSION_PCT,
    paymentTtlHours: config.ORDER_PAYMENT_TTL_HOURS,
    maxCodeAttempts: config.MAX_CODE_ATTEMPTS,
    publicUrl: config.PUBLIC_URL
  });

  async function handlePaymentReference(reference: string) {
    const tx = await gateway.getTransaction(reference);
    if (tx.externalReference?.startsWith('topup:') || (await store.getTopupByRef(reference))) {
      await riders.applyTopupTransaction(tx);
    } else {
      await orders.applyOrderTransaction(tx);
    }
  }

  return { config, store, gateway, events, secrets, users, riders, orders, dispatch, files, handlePaymentReference };
}

/** Background jobs: expire unpaid orders, retry payouts. Returns a stop function. */
export function startJobs(app: App): () => void {
  const run = (name: string, fn: () => Promise<unknown>) => () =>
    fn().catch((e) => console.error(`[job:${name}]`, e));
  const timers = [
    setInterval(run('expire', () => app.orders.expireStale()), 5 * 60_000),
    setInterval(run('payouts', () => app.orders.processAllPendingPayouts()), 2 * 60_000),
    setInterval(run('reoffer', () => app.orders.reofferStale()), 10 * 60_000)
  ];
  timers.forEach((t) => t.unref());
  return () => timers.forEach(clearInterval);
}
