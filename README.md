# Bayam-Sellam Escrow & Trust Layer (Cameroon 🇨🇲)

> **Decentralized Trust Engine for Social Commerce (TikTok, Instagram, WhatsApp, Facebook)**  
> Built for Cameroon with MTN Mobile Money (MoMo) and Orange Money (OM) integrations.

---

## 🏗️ What We Built

1. **Dual-Mode Escrow Engine**:
   - **Telegram Bot (`backend/src/bot/bot.ts`)**: Built with Grammy.js, supporting bilingual conversation (French 🇫🇷 & English 🇬🇧), seller order generation, buyer tracking, and a dedicated **Rider Mode** (`/rider_mode`).
   - **Mobile Web Checkout & Mini App (`web/checkout.html`)**: Mobile-first responsive checkout for TikTok/WhatsApp/Instagram buyers who do not have Telegram installed.

2. **Automated Handshake & Rider Protection Logic**:
   - **4-Digit Release OTP Protocol**: Argon2/HMAC-hashed secret code issued exclusively to the buyer upon MoMo/OM payment confirmation.
   - **Rider Handover Verification**: Moto riders can verify the buyer's 4-digit code directly in the bot or mobile interface to instantly trigger their delivery fee payout without waiting for the vendor.
   - **Zero-Risk Dispute Engine**: If the buyer rejects the order upon delivery, the moto delivery fee is **automatically deducted from the buyer's escrow deposit and paid to the rider**, while the item price is refunded. The seller never loses delivery money on rejected cash-on-delivery orders.

3. **Double-Entry Ledger (`database/schema.sql`)**:
   - Complete PostgreSQL schema with journal entries and postings preventing double-spending and ensuring strict reconciliation for COBAC / CEMAC regulatory compliance.

4. **Sandbox Gateway Integration (`backend/src/services/payment.service.ts`)**:
   - Sandbox provider for Campay & Notch Pay with automated fallback simulation for MTN MoMo and Orange Money USSD prompts (`*126#` and `#150#`).

---

## 🚀 Quick Start Guide

### 1. Run the Test Suite
```bash
cd backend
npm test
```

### 2. Start the Backend & Web Checkout
```bash
cd backend
npm run dev
```

The server will start on port `4000`:
- **Web Checkout UI**: `http://localhost:4000/checkout.html`
- **Pre-seeded Demo Order**: `http://localhost:4000/checkout.html?code=CM-ESC-XXXXX`
- **API Health Check**: `http://localhost:4000/api/health`

### 3. Connect a Real Telegram Bot
1. Open Telegram and search for `@BotFather`.
2. Send `/newbot` and follow the instructions to get your `API_TOKEN`.
3. In `backend/.env`, set:
   ```env
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
   ```
4. Restart the backend (`npm run dev`). Your bot will automatically start polling!

---

## 📡 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/orders` | Create a new escrow order |
| `GET` | `/api/orders/:code` | Retrieve order status and details |
| `POST` | `/api/orders/:code/pay` | Initiate MTN MoMo / Orange Money USSD push |
| `POST` | `/api/orders/:code/simulate-payment` | Sandbox endpoint to simulate instant buyer payment approval |
| `POST` | `/api/orders/:code/dispatch` | Assign moto rider & dispatch package |
| `POST` | `/api/orders/:code/verify-code` | Verify 4-digit release code and trigger instant payouts |
| `POST` | `/api/orders/:code/dispute` | Buyer rejects package; compensates rider and initiates return |
| `POST` | `/api/webhooks/campay` | Webhook listener for payment gateway callbacks |
