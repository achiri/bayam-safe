import express, { RequestHandler } from 'express';
import { Bot, webhookCallback } from 'grammy';
import type { BotContext } from './bot.js';

/**
 * Express handlers for Telegram's webhook. The JSON body must be parsed before grammY sees it,
 * and a failing update is logged and acknowledged instead of crashing the server (Telegram
 * would otherwise retry the same broken update forever).
 */
export function telegramWebhook(bot: Bot<BotContext>, secretToken?: string): RequestHandler[] {
  const handle = webhookCallback(bot, 'express', { secretToken, onTimeout: 'return', timeoutMilliseconds: 25_000 });
  return [
    express.json({ limit: '1mb' }),
    (req, res) => {
      Promise.resolve(handle(req, res)).catch((err) => {
        console.error('[bot] webhook update failed:', err);
        if (!res.headersSent) res.sendStatus(200);
      });
    }
  ];
}
