import 'dotenv/config';
import { webhookCallback } from 'grammy';
import { createApp, startJobs } from './app.js';
import { createServer } from './api/server.js';
import { createBot } from './bot/bot.js';
import { loadConfig } from './config.js';
import { seedDemoData } from './seed.js';
import { Secrets } from './domain/secrets.js';

async function main() {
  const config = loadConfig();
  if (!config.ADMIN_API_KEY && config.SEED_DEMO_DATA && config.NODE_ENV !== 'production') {
    // Demo convenience: a throwaway key, printed once, valid until the process stops.
    config.ADMIN_API_KEY = Secrets.token(18);
    console.log(`Demo admin key (this run only): ${config.ADMIN_API_KEY}`);
  }
  const app = createApp(config);
  await app.store.migrate();

  if (config.SEED_DEMO_DATA) await seedDemoData(app);

  const bot = config.TELEGRAM_BOT_TOKEN ? createBot(app, config.TELEGRAM_BOT_TOKEN) : undefined;

  const server = createServer(app, {
    publicConfig: () => ({ botUsername: bot?.isInited() ? bot.botInfo.username : undefined }),
    mount: (http) => {
      if (bot && config.TELEGRAM_USE_WEBHOOK) {
        http.post('/api/webhooks/telegram', webhookCallback(bot, 'express', { secretToken: config.TELEGRAM_WEBHOOK_SECRET }));
      }
    }
  });

  const listener = server.listen(config.PORT, () => {
    console.log(`BayamSafe API on :${config.PORT} · storage=${app.store.kind} · payments=${app.gateway.name} · env=${config.NODE_ENV}`);
    if (app.store.kind === 'memory') console.warn('⚠️  In-memory storage: data is lost on restart. Set DATABASE_URL for real use.');
    if (app.gateway.name === 'simulated') console.warn('⚠️  Simulated payments: no real money moves.');
  });

  if (bot) {
    await bot.init();
    if (config.TELEGRAM_USE_WEBHOOK) {
      await bot.api.setWebhook(`${config.PUBLIC_URL.replace(/\/$/, '')}/api/webhooks/telegram`, {
        secret_token: config.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'edited_message', 'callback_query']
      });
      console.log(`Telegram bot @${bot.botInfo.username} via webhook`);
    } else {
      await bot.api.deleteWebhook();
      void bot.start({ allowed_updates: ['message', 'edited_message', 'callback_query'] });
      console.log(`Telegram bot @${bot.botInfo.username} via long polling`);
    }
  } else {
    console.log('TELEGRAM_BOT_TOKEN not set: bot disabled (create one with @BotFather).');
  }

  // Catch up on anything left from a previous run, then keep jobs going.
  await app.orders.processAllPendingPayouts().catch((e) => console.error('[startup] payouts:', e));
  const stopJobs = startJobs(app);

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down…`);
    stopJobs();
    await bot?.stop().catch(() => undefined);
    listener.close();
    await app.store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
