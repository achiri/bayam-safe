import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import path from 'node:path';
import { App } from '../app.js';
import { AppError, forbidden, invalid } from '../domain/errors.js';
import { safeEqual } from '../domain/secrets.js';
import { LedgerAccount, Order, OrderStatus, User } from '../domain/types.js';
import { SimulatedGateway } from '../payments/simulated.js';
import { rateLimit } from './rate-limit.js';
import { createAdminSession, verifyAdminSession, verifyPassword } from './admin-auth.js';

type Async = (req: Request, res: Response) => Promise<unknown>;
const h =
  (fn: Async): RequestHandler =>
  (req, res, next) =>
    fn(req, res).catch(next);

const buyerToken = (req: Request) => req.header('x-buyer-token') ?? undefined;
const buyerSession = (req: Request) => req.header('x-buyer-session') ?? undefined;

/** Strips secrets before an order leaves the server (admin views). */
export function redactOrder(o: Order) {
  const { buyerTokenHash, buyerSessionHash, releaseCodeEnc, ...rest } = o;
  const { pendingSessionHash, ...payment } = o.payment;
  return { ...rest, payment };
}

/** Admin view of a user: drop the unfinished sign-up draft (raw answers) but keep documents' file ids. */
export function redactUser(u: User) {
  const { draft, ...rest } = u;
  return { ...rest, signupInProgress: draft ? { kind: draft.kind, step: draft.step, startedAt: draft.startedAt } : undefined };
}

const ACCOUNTS: LedgerAccount[] = [
  'GATEWAY_CLEARING', 'ESCROW', 'MERCHANT_PAYABLE', 'RIDER_PAYABLE', 'BUYER_REFUND_PAYABLE', 'PLATFORM_REVENUE', 'RIDER_FLOAT'
];

export interface ServerOptions {
  /** Extra routes mounted before the error handler (e.g. Telegram webhook). */
  mount?: (app: express.Express) => void;
  webDir?: string;
  /** Values the landing page may read (e.g. the bot username for t.me links). */
  publicConfig?: () => { botUsername?: string };
}

export function createServer(appCtx: App, opts: ServerOptions = {}): express.Express {
  const { config, orders, users, riders, store, gateway } = appCtx;
  const app = express();
  app.disable('x-powered-by');
  if (config.NODE_ENV === 'production') app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=()');
    next();
  });

  // ---------------------------------------------------------------- static pages (landing, checkout, admin)
  const webDir = opts.webDir ?? path.resolve(__dirname, '../../../web');
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
  app.use(express.static(webDir, { index: false, setHeaders: (res) => res.setHeader('Content-Security-Policy', csp) }));

  const json = express.json({ limit: '20kb' });

  // ---------------------------------------------------------------- public
  app.get('/', (_req, res) => {
    res.setHeader('Content-Security-Policy', csp);
    res.sendFile(path.join(webDir, 'index.html'));
  });

  app.get('/admin', (_req, res) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Robots-Tag', 'noindex');
    res.sendFile(path.join(webDir, 'admin.html'));
  });

  app.get('/api/config', (_req, res) => {
    res.json({ botUsername: opts.publicConfig?.().botUsername ?? null });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', storage: store.kind, payments: gateway.name, env: config.NODE_ENV });
  });

  app.get(
    '/api/track/:code',
    rateLimit({ windowMs: 60_000, max: 30 }),
    h(async (req, res) => res.json(await orders.publicStatus(req.params.code)))
  );

  // ---------------------------------------------------------------- buyer checkout
  const buyerLimiter = rateLimit({ windowMs: 60_000, max: 60 });

  app.get(
    '/api/checkout/:orderId',
    buyerLimiter,
    h(async (req, res) => res.json(await orders.buyerView(req.params.orderId, buyerToken(req), buyerSession(req))))
  );

  app.patch(
    '/api/checkout/:orderId/delivery',
    buyerLimiter,
    json,
    h(async (req, res) => {
      const { dropoffAddress, dropoffLocation, landmark } = req.body ?? {};
      res.json(await orders.updateDeliveryDetails(req.params.orderId, buyerToken(req), { dropoffAddress, dropoffLocation, landmark }));
    })
  );

  app.put(
    '/api/checkout/:orderId/voice',
    rateLimit({ windowMs: 60_000, max: 6 }),
    express.raw({ type: 'audio/*', limit: '450kb' }),
    h(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) throw invalid('Send the recording as an audio/* body');
      await orders.attachVoiceNote(req.params.orderId, buyerToken(req), req.header('content-type') ?? '', req.body);
      res.status(204).end();
    })
  );

  app.post(
    '/api/checkout/:orderId/pay',
    rateLimit({ windowMs: 60_000, max: 5 }),
    json,
    h(async (req, res) => {
      const result = await orders.initiatePayment(req.params.orderId, buyerToken(req), String(req.body?.payerPhone ?? ''));
      res.json(result);
    })
  );

  /** Photo of the rider carrying this buyer's parcel, so they can recognise them at the door. */
  app.get(
    '/api/checkout/:orderId/rider-photo',
    buyerLimiter,
    h(async (req, res) => {
      const fileId = await orders.riderPhotoFileId(req.params.orderId, buyerToken(req));
      if (!fileId || !appCtx.files) throw new AppError('NOT_FOUND', 'No photo', 404);
      const f = await appCtx.files.fetch(fileId);
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Cache-Control', 'private, max-age=600');
      res.send(f.data);
    })
  );

  app.post(
    '/api/checkout/:orderId/dispute',
    rateLimit({ windowMs: 60_000, max: 5 }),
    json,
    h(async (req, res) => res.json(await orders.buyerOpenDispute(req.params.orderId, buyerToken(req), String(req.body?.reason ?? ''))))
  );

  // ---------------------------------------------------------------- payment webhook
  // Campay calls this with the transaction fields and a JWT `signature` (GET query or POST body).
  // We verify the signature, then re-read the transaction from Campay before acting on it.
  const campayWebhook = h(async (req, res) => {
    const params = { ...(req.query as Record<string, unknown>), ...(typeof req.body === 'object' ? req.body : {}) };
    const notice = gateway.parseWebhook(params);
    if (!notice) {
      console.warn('[webhook] rejected unsigned/invalid Campay notification');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    await appCtx.handlePaymentReference(notice.reference);
    res.json({ received: true });
  });
  app.get('/api/webhooks/campay', rateLimit({ windowMs: 60_000, max: 120 }), campayWebhook);
  app.post('/api/webhooks/campay', rateLimit({ windowMs: 60_000, max: 120 }), express.urlencoded({ extended: false, limit: '20kb' }), json, campayWebhook);

  // ---------------------------------------------------------------- dev-only payment simulator
  if (gateway instanceof SimulatedGateway && config.NODE_ENV !== 'production') {
    app.post(
      '/api/dev/checkout/:orderId/approve',
      h(async (req, res) => {
        await orders.buyerView(req.params.orderId, buyerToken(req)); // authenticates the buyer link
        const o = await store.getOrder(req.params.orderId);
        if (!o?.payment.reference) throw invalid('Start a payment first');
        gateway.approve(o.payment.reference);
        await appCtx.handlePaymentReference(o.payment.reference);
        res.json({ approved: true });
      })
    );
    app.post(
      '/api/dev/topups/:reference/approve',
      h(async (req, res) => {
        gateway.approve(req.params.reference);
        await appCtx.handlePaymentReference(req.params.reference);
        res.json({ approved: true });
      })
    );
  }

  // ---------------------------------------------------------------- admin
  // Username/password login → short-lived signed session token. Heavily rate limited.
  app.post(
    '/api/admin/login',
    rateLimit({ windowMs: 15 * 60_000, max: 8 }),
    json,
    h(async (req, res) => {
      if (!config.ADMIN_PASSWORD_HASH) throw new AppError('LOGIN_DISABLED', 'Password login is not set up on this server (ADMIN_PASSWORD_HASH).', 503);
      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      const userOk = safeEqual(username.toLowerCase(), config.ADMIN_USERNAME.toLowerCase());
      const passOk = verifyPassword(password, config.ADMIN_PASSWORD_HASH); // always computed: same timing for bad usernames
      if (!userOk || !passOk) {
        console.warn(`[admin] failed login for "${username.slice(0, 60)}" from ${req.ip}`);
        throw new AppError('BAD_LOGIN', 'Wrong username or password.', 401);
      }
      res.json(createAdminSession(config.APP_SECRET, config.ADMIN_USERNAME));
    })
  );

  const admin = express.Router();
  admin.use((req, _res, next) => {
    const presented = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const keyOk = !!config.ADMIN_API_KEY && !!presented && safeEqual(presented, config.ADMIN_API_KEY);
    const sessionOk = !!presented && !!verifyAdminSession(config.APP_SECRET, presented);
    if (!keyOk && !sessionOk) return next(forbidden('Admin login required'));
    next();
  });
  admin.use(json);

  admin.get(
    '/orders',
    h(async (req, res) => {
      const statuses = typeof req.query.status === 'string' ? (req.query.status.split(',') as OrderStatus[]) : undefined;
      const list = await store.listOrders({ statuses, limit: Number(req.query.limit ?? 100) });
      res.json(list.map(redactOrder));
    })
  );
  admin.get(
    '/orders/:id',
    h(async (req, res) => {
      const o = await store.getOrder(req.params.id);
      if (!o) throw new AppError('NOT_FOUND', 'Order not found', 404);
      res.json({ order: redactOrder(o), journals: await store.listJournals(o.id) });
    })
  );
  admin.post(
    '/orders/:id/resolve',
    h(async (req, res) => {
      const resolution = req.body?.resolution;
      if (resolution !== 'REFUND_BUYER' && resolution !== 'RELEASE_TO_MERCHANT') throw invalid('resolution must be REFUND_BUYER or RELEASE_TO_MERCHANT');
      res.json(redactOrder(await orders.resolveDispute(req.params.id, resolution, req.body?.note)));
    })
  );
  admin.post('/orders/:id/cancel', h(async (req, res) => res.json(redactOrder(await orders.cancel(req.params.id, { admin: true })))));
  admin.post('/orders/:id/arrived', h(async (req, res) => res.json(redactOrder(await orders.markArrivedAtHub(req.params.id, { admin: true })))));
  admin.post(
    '/orders/:id/payouts/:payoutId/review',
    h(async (req, res) => {
      const action = req.body?.action;
      if (action !== 'MARK_SENT' && action !== 'RETRY') throw invalid('action must be MARK_SENT or RETRY');
      const o = await orders.reviewPayout(req.params.id, req.params.payoutId, action, req.body?.reference);
      res.json(o ? redactOrder(o) : { ok: true });
    })
  );
  admin.get('/kyc', h(async (_req, res) => res.json((await users.pendingKyc()).map(redactUser))));
  admin.get('/users', h(async (req, res) => res.json((await store.listUsers(Number(req.query.limit ?? 300))).map(redactUser))));
  admin.get(
    '/users/:id',
    h(async (req, res) => {
      const u = await store.getUser(req.params.id);
      if (!u) throw new AppError('NOT_FOUND', 'User not found', 404);
      const sales = await store.listOrders({ merchantId: u.id, limit: 50 });
      res.json({ user: redactUser(u), orders: sales.map(redactOrder) });
    })
  );
  admin.post(
    '/users/:id/kyc',
    h(async (req, res) => res.json(redactUser(await users.decideKyc(req.params.id, req.body?.approve === true, req.body?.note))))
  );
  admin.get('/riders', h(async (req, res) => res.json(await store.listRiders({ status: req.query.status as any }))));
  admin.post(
    '/riders/:id/status',
    h(async (req, res) => {
      const status = req.body?.status;
      if (!['APPROVED', 'REJECTED', 'SUSPENDED'].includes(status)) throw invalid('status must be APPROVED, REJECTED or SUSPENDED');
      res.json(await riders.decide(req.params.id, status, req.body?.note));
    })
  );

  /** Streams a document a user sent to the bot (selfie, ID card, shop photo, waybill). */
  admin.get(
    '/files/:fileId',
    h(async (req, res) => {
      if (!appCtx.files) throw new AppError('UNAVAILABLE', 'Documents are only available when the Telegram bot is configured', 503);
      const f = await appCtx.files.fetch(req.params.fileId);
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Cache-Control', 'private, max-age=600');
      res.send(f.data);
    })
  );

  /** One call for the dashboard's home: money, queues, activity. */
  admin.get(
    '/overview',
    h(async (_req, res) => {
      const [recent, pendingKyc, riderList] = await Promise.all([
        store.listOrders({ limit: 500 }),
        users.pendingKyc(),
        store.listRiders({})
      ]);
      const byStatus: Record<string, number> = {};
      for (const o of recent) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      const completed = recent.filter((o) => o.status === 'SETTLED' || o.status === 'DELIVERED');
      const days: { day: string; orders: number; gmv: number }[] = [];
      const today = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
        const dayOrders = recent.filter((o) => o.createdAt.slice(0, 10) === d);
        days.push({ day: d, orders: dayOrders.length, gmv: dayOrders.filter((o) => completed.includes(o)).reduce((s, o) => s + o.total, 0) });
      }
      res.json({
        money: {
          escrowHeld: await store.ledgerBalance('ESCROW'),
          revenue: await store.ledgerBalance('PLATFORM_REVENUE'),
          gmvCompleted: completed.reduce((s, o) => s + o.total, 0),
          riderFloat: await store.ledgerBalance('RIDER_FLOAT')
        },
        queues: {
          kycPending: pendingKyc.length,
          ridersPending: riderList.filter((r) => r.status === 'PENDING').length,
          disputes: byStatus.DISPUTED ?? 0,
          payoutsNeedingReview: recent.reduce((n, o) => n + o.payouts.filter((p) => p.status === 'NEEDS_REVIEW' || p.status === 'FAILED').length, 0)
        },
        fleet: {
          approved: riderList.filter((r) => r.status === 'APPROVED').length,
          onDuty: riderList.filter((r) => r.status === 'APPROVED' && r.onDuty).length
        },
        byStatus,
        days,
        sampleSize: recent.length
      });
    })
  );

  /** Everything the live map needs: on-duty riders and parcels on the move. */
  admin.get(
    '/map',
    h(async (_req, res) => {
      const active = await store.listOrders({
        statuses: ['AWAITING_RIDER', 'RIDER_ASSIGNED', 'IN_TRANSIT', 'AT_AGENCY', 'AT_DESTINATION_HUB', 'LAST_MILE_ASSIGNED', 'OUT_FOR_DELIVERY', 'DISPUTED'],
        limit: 300
      });
      const riderList = await store.listRiders({ status: 'APPROVED' });
      res.json({
        riders: riderList
          .filter((r) => r.location)
          .map((r) => ({ id: r.id, name: r.fullName, code: r.riderCode, onDuty: r.onDuty, location: r.location, at: r.locationUpdatedAt, plate: r.plateNumber })),
        orders: active.map((o) => ({
          id: o.id, trackingCode: o.trackingCode, status: o.status, itemTitle: o.itemTitle, total: o.total,
          pickup: o.pickupLocation, dropoff: o.dropoffLocation, riderId: o.lastMileRiderId ?? o.firstMileRiderId
        }))
      });
    })
  );
  admin.get(
    '/ledger',
    h(async (_req, res) => {
      const balances: Record<string, number> = {};
      for (const a of ACCOUNTS) balances[a] = await store.ledgerBalance(a);
      res.json({ balances, sum: Object.values(balances).reduce((s, v) => s + v, 0) });
    })
  );
  app.use('/api/admin', admin);

  opts.mount?.(app);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown endpoint' }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.httpStatus).json({ error: err.code, message: err.message });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.too.large' || e?.type === 'entity.parse.failed') {
      res.status(e.status ?? 400).json({ error: 'BAD_REQUEST', message: e.message });
      return;
    }
    console.error('[api] unhandled error:', err);
    res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong. Please try again.' });
  });

  return app;
}
