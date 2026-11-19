import { RequestHandler } from 'express';

/**
 * Fixed-window in-memory rate limiter keyed by client IP + route.
 * Good enough for a single instance; use a shared store (Redis) when running several.
 */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.route?.path ?? req.path}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests, slow down.' });
      return;
    }
    next();
  };
}
