import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { EscrowService } from '../services/escrow.service.js';
import { PaymentService } from '../services/payment.service.js';

export function createExpressApp(escrowService: EscrowService): express.Express {
  const app = express();
  const paymentService = new PaymentService();

  app.use(cors());
  app.use(express.json());

  // Serve static WebApp & checkout frontend
  const webPath = path.resolve(process.cwd(), '../web');
  app.use(express.static(webPath));

  // Health check
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'Bayam-Sellam Escrow API', env: process.env.NODE_ENV || 'dev' });
  });

  // 1. Create Order
  app.post('/api/orders', async (req: Request, res: Response) => {
    try {
      const { sellerName, sellerPhone, itemTitle, itemPrice, deliveryFee, buyerPhone, deliveryAddress } = req.body;
      if (!itemTitle || !itemPrice || !sellerPhone) {
        res.status(400).json({ error: 'Missing required fields (itemTitle, itemPrice, sellerPhone)' });
        return;
      }
      const order = await escrowService.createOrder({
        sellerName: sellerName || 'Social Vendor',
        sellerPhone,
        itemTitle,
        itemPrice: Number(itemPrice),
        deliveryFee: Number(deliveryFee || 0),
        buyerPhone,
        deliveryAddress
      });
      res.status(201).json({ success: true, order });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. Get Order by Code
  app.get('/api/orders/:code', (req: Request, res: Response) => {
    const order = escrowService.getOrder(req.params.code);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    // Omit internal hash for security
    const { releaseCodeHash, ...safeOrder } = order;
    res.json({ success: true, order: safeOrder });
  });

  // 3. Initiate Payment (MTN MoMo or Orange Money USSD Push)
  app.post('/api/orders/:code/pay', async (req: Request, res: Response) => {
    try {
      const { buyerPhone } = req.body;
      const order = escrowService.getOrder(req.params.code);
      if (!order) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }
      const phoneToUse = buyerPhone || order.buyerPhone;
      if (!phoneToUse) {
        res.status(400).json({ error: 'Buyer phone number required for Mobile Money push prompt' });
        return;
      }

      const paymentResult = await paymentService.initiateCollection(
        order.orderCode,
        order.totalAmount,
        phoneToUse
      );

      res.json({ success: true, paymentResult });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. Sandbox Helper: Simulate USSD PIN confirmation immediately
  app.post('/api/orders/:code/simulate-payment', async (req: Request, res: Response) => {
    try {
      const { buyerPhone } = req.body;
      const order = escrowService.getOrder(req.params.code);
      if (!order) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }

      const mockRef = `SIMULATED-${Date.now()}`;
      const { order: updatedOrder, releaseCode } = await escrowService.confirmPayment(
        order.orderCode,
        mockRef,
        buyerPhone || order.buyerPhone || '237670000001'
      );

      res.json({
        success: true,
        message: 'Sandbox payment successfully simulated! Funds locked in escrow.',
        order: updatedOrder,
        secretReleaseCodeForBuyer: releaseCode
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. Dispatch Order (Assign Rider)
  app.post('/api/orders/:code/dispatch', async (req: Request, res: Response) => {
    try {
      const { riderPhone, riderName } = req.body;
      const order = await escrowService.dispatchOrder(req.params.code, riderPhone, riderName);
      res.json({ success: true, order });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 6. Verify Release Code (Buyer or Rider submits 4-digit code)
  app.post('/api/orders/:code/verify-code', async (req: Request, res: Response) => {
    try {
      const { releaseCode } = req.body;
      if (!releaseCode) {
        res.status(400).json({ error: 'Release code required' });
        return;
      }
      const result = await escrowService.verifyReleaseCode(req.params.code, releaseCode);
      if (result.success) {
        res.json({
          success: true,
          message: 'Code confirmed! Funds instantly disbursed to Seller and Rider.',
          order: result.order,
          sellerPayout: result.sellerPayout,
          riderPayout: result.riderPayout
        });
      } else {
        res.status(400).json({ success: false, message: result.message });
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 7. Dispute Order
  app.post('/api/orders/:code/dispute', async (req: Request, res: Response) => {
    try {
      const { reason } = req.body;
      const result = await escrowService.disputeOrder(req.params.code, reason || 'Buyer rejected package upon inspection');
      res.json({
        success: true,
        message: 'Order disputed. Return initiated.',
        order: result.order,
        riderCompensated: result.riderCompensated
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 8. Payment Webhook (Campay / Notch Pay)
  app.post('/api/webhooks/campay', async (req: Request, res: Response) => {
    try {
      const { reference, external_reference, status } = req.body;
      console.log('[PAYMENT WEBHOOK RECEIVED]', req.body);

      if (status === 'SUCCESSFUL' && external_reference) {
        await escrowService.confirmPayment(external_reference, reference);
      }

      res.status(200).json({ received: true });
    } catch (err: any) {
      console.error('Webhook error:', err);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return app;
}
