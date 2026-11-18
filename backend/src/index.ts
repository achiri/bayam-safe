import dotenv from 'dotenv';
dotenv.config();

import { EscrowService } from './services/escrow.service.js';
import { createExpressApp } from './api/server.js';
import { createTelegramBot } from './bot/bot.js';

async function bootstrap() {
  const escrowService = new EscrowService();
  const app = createExpressApp(escrowService);
  const port = process.env.PORT || 4000;

  // Start HTTP Server
  app.listen(port, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Bayam-Sellam Escrow Backend running on port ${port}`);
    console.log(`🌐 Checkout Web UI: http://localhost:${port}/checkout.html`);
    console.log(`📱 Health Check:    http://localhost:${port}/api/health`);
    console.log(`=======================================================`);
  });

  // Start Telegram Bot
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken && !botToken.includes('MOCK_') && !botToken.includes('your_telegram')) {
    try {
      const bot = createTelegramBot(botToken, escrowService);
      console.log('🤖 Launching Telegram Bot long-polling...');
      bot.start({
        onStart: (botInfo) => {
          console.log(`✅ Telegram Bot @${botInfo.username} is active!`);
        }
      });
    } catch (err) {
      console.error('Failed to start Telegram Bot:', err);
    }
  } else {
    console.log('ℹ️  TELEGRAM_BOT_TOKEN not configured or in mock mode. Bot polling skipped.');
    console.log('👉 To connect a real bot: create one on Telegram via @BotFather and set TELEGRAM_BOT_TOKEN in .env');
  }

  // Pre-seed a sample transaction for immediate testing
  const sampleOrder = await escrowService.createOrder({
    sellerName: 'Boutique Chic Akwa',
    sellerPhone: '237671234567',
    itemTitle: 'Robe de Soirée & Chaussures (Douala)',
    itemPrice: 25000,
    deliveryFee: 1500,
    buyerPhone: '237691234567',
    deliveryAddress: 'Douala Bonamoussadi, Carrefour du Marché'
  });
  console.log(`💡 Pre-seeded test order created: Code [${sampleOrder.orderCode}]`);
  console.log(`   Direct test URL: http://localhost:${port}/checkout.html?code=${sampleOrder.orderCode}`);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
