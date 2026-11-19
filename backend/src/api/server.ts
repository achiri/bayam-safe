import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import path from 'node:path';
import { App } from '../app.js';
import { AppError, forbidden, invalid } from '../domain/errors.js';
import { safeEqual } from '../domain/secrets.js';
import { LedgerAccount, Order, OrderStatus } from '../domain/types.js';
import { SimulatedGateway } from '../payments/simulated.js';
import { rateLimit } from './rate-limit.js';

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

const ACCOUNTS: LedgerAccount[] = [
  'GATEWAY_CLEARING', 'ESCROW', 'MERCHANT_PAYABLE', 'RIDER_PAYABLE', 'BUYER_REFUND_PAYABLE', 'PLATFORM_REVENUE', 'RIDER_FLOAT'
];

export interface ServerOptions {
  /** Extra routes mounted before the error handler (e.g. Telegram webhook). */
  mount?: (app: express.Express) => void;
  webDir?: string;
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

  // ---------------------------------------------------------------- static checkout page
  const webDir = opts.webDir ?? path.resolve(__dirname, '../../../web');
  app.use(
    express.static(webDir, {
      index: false,
      setHeaders: (res) => {
        res.setHeader(
          'Content-Security-Policy',
          [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com",
            "style-src 'self' 'unsafe-inline' https://unpkg.com",
            "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
            "media-src 'self' blob:",
            "connect-src 'self'",
            "frame-ancestors 'none'"
          ].join('; ')
        );
      }
    })
  );

  const json = express.json({ limit: '20kb' });

  // ---------------------------------------------------------------- public
  app.get('/', (_req, res) => {
    res.type('text/plain').send('BayamSafe API. Buyers open their private checkout link; merchants and riders use the Telegram bot.');
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
  const admin = express.Router();
  admin.use((req, _res, next) => {
    const key = config.ADMIN_API_KEY;
    const presented = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!key || !presented || !safeEqual(presented, key)) return next(forbidden('Admin key required'));
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
  admin.get('/kyc', h(async (_req, res) => res.json(await users.pendingKyc())));
  admin.post('/users/:id/kyc', h(async (req, res) => res.json(await users.decideKyc(req.params.id, req.body?.approve === true))));
  admin.get('/riders', h(async (req, res) => res.json(await store.listRiders({ status: req.query.status as any }))));
  admin.post(
    '/riders/:id/status',
    h(async (req, res) => {
      const status = req.body?.status;
      if (status !== 'APPROVED' && status !== 'SUSPENDED') throw invalid('status must be APPROVED or SUSPENDED');
      res.json(await riders.decide(req.params.id, status));
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
