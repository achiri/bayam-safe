import { z } from 'zod';

/**
 * All runtime configuration, validated once at startup.
 * In production the app refuses to start with unsafe defaults.
 */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const csvNumbers = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isSafeInteger(n))
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_URL: z.string().url().default('http://localhost:4000'),

  DATABASE_URL: z.string().optional(),

  /** Secret used to encrypt release codes and hash access tokens. */
  APP_SECRET: z.string().min(32).optional(),
  /** Bearer key for /api/admin endpoints (scripts, emergencies). */
  ADMIN_API_KEY: z.string().min(24).optional(),
  /** Admin dashboard login. The password is stored only as a hash: `npm run admin:password`. */
  ADMIN_USERNAME: z.string().min(3).max(60).default('admin'),
  ADMIN_PASSWORD_HASH: z.string().startsWith('scrypt$').optional(),
  /** Telegram user ids allowed to use admin bot commands. */
  ADMIN_TELEGRAM_IDS: csvNumbers,

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** When set, the bot uses a webhook at PUBLIC_URL/api/webhooks/telegram instead of long polling. */
  TELEGRAM_USE_WEBHOOK: boolish.default(false),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  PAYMENT_PROVIDER: z.enum(['campay', 'simulated']).default('simulated'),
  CAMPAY_BASE_URL: z.string().url().default('https://demo.campay.net/api'),
  CAMPAY_USERNAME: z.string().optional(),
  CAMPAY_PASSWORD: z.string().optional(),
  CAMPAY_WEBHOOK_KEY: z.string().optional(),

  PLATFORM_COMMISSION_PCT: z.coerce.number().min(0).max(20).default(2.5),
  /** Unpaid orders expire after this many hours. */
  ORDER_PAYMENT_TTL_HOURS: z.coerce.number().positive().default(48),
  DISPATCH_RADIUS_KM: z.coerce.number().positive().default(8),
  MAX_CODE_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  SEED_DEMO_DATA: boolish.default(false)
});

export type AppConfig = z.infer<typeof schema> & { APP_SECRET: string };

const DEV_SECRET = 'dev-only-secret-change-me-dev-only-secret-change-me';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  const problems: string[] = [];

  if (cfg.NODE_ENV === 'production') {
    if (!cfg.APP_SECRET) problems.push('APP_SECRET is required in production (min 32 chars).');
    if (!cfg.DATABASE_URL) problems.push('DATABASE_URL is required in production (in-memory storage loses data).');
    if (cfg.PAYMENT_PROVIDER !== 'campay') problems.push('PAYMENT_PROVIDER must be "campay" in production.');
    if (cfg.SEED_DEMO_DATA) problems.push('SEED_DEMO_DATA must be off in production.');
    if (cfg.TELEGRAM_USE_WEBHOOK && !cfg.TELEGRAM_WEBHOOK_SECRET) {
      problems.push('TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_USE_WEBHOOK is on.');
    }
  }
  if (cfg.PAYMENT_PROVIDER === 'campay') {
    if (!cfg.CAMPAY_USERNAME || !cfg.CAMPAY_PASSWORD) problems.push('CAMPAY_USERNAME and CAMPAY_PASSWORD are required for Campay.');
    if (!cfg.CAMPAY_WEBHOOK_KEY) problems.push('CAMPAY_WEBHOOK_KEY is required to verify Campay webhooks.');
  }
  if (problems.length) throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  return { ...cfg, APP_SECRET: cfg.APP_SECRET ?? DEV_SECRET };
}
