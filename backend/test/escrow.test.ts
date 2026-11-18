import { EscrowService } from '../src/services/escrow.service.js';
import { OtpService } from '../src/services/otp.service.js';

async function runTests() {
  console.log('🧪 Starting Cameroonian Escrow & Trust Layer Unit Tests...\n');
  const escrow = new EscrowService();

  // Test 1: Order Creation
  console.log('▶ Test 1: Creating an Escrow Order (Social Commerce)');
  const order = await escrow.createOrder({
    sellerName: 'Mama Douala Shoes',
    sellerPhone: '237671112233',
    itemTitle: 'Basket Sneakers Pointure 42',
    itemPrice: 20000,
    deliveryFee: 1500,
    buyerPhone: '237699887766'
  });

  if (!order.orderCode.startsWith('CM-ESC-')) throw new Error('Invalid order code format');
  if (order.totalAmount !== 21500) throw new Error(`Expected total 21500, got ${order.totalAmount}`);
  if (order.platformFee !== 500) throw new Error(`Expected platform fee 500 (2.5%), got ${order.platformFee}`);
  console.log(`✅ Order created successfully: [${order.orderCode}] Total: ${order.totalAmount} FCFA\n`);

  // Test 2: Payment Confirmation & 4-Digit Release Code
  console.log('▶ Test 2: Simulating MTN MoMo Webhook Payment Collection');
  const paymentResult = await escrow.confirmPayment(order.orderCode, 'MOMO-REF-99231', order.buyerPhone);
  if (paymentResult.order.status !== 'ESCROW_LOCKED') throw new Error('Status should be ESCROW_LOCKED');
  if (paymentResult.releaseCode.length !== 4) throw new Error('Release code must be 4 digits');
  console.log(`✅ Escrow locked! Secret 4-digit release code issued: ${paymentResult.releaseCode}\n`);

  // Test 3: Dispatch & Rider Arrives at Door
  console.log('▶ Test 3: Seller hands package to Moto Rider');
  await escrow.dispatchOrder(order.orderCode, '237675544332', 'Alain Moto Akwa');
  await escrow.markArrivedForInspection(order.orderCode);
  if (order.status !== 'DELIVERED_PENDING_CONFIRM') throw new Error('Status should be DELIVERED_PENDING_CONFIRM');
  console.log(`✅ Order marked as DELIVERED_PENDING_CONFIRM\n`);

  // Test 4: Wrong Code Verification Attempt
  console.log('▶ Test 4: Testing Invalid Code Lockout Defense');
  const badAttempt = await escrow.verifyReleaseCode(order.orderCode, '0000');
  if (badAttempt.success) throw new Error('Invalid code should have failed');
  if (order.verificationAttempts !== 1) throw new Error('Attempt count should be 1');
  console.log(`✅ Invalid code rejected correctly. Attempts: ${order.verificationAttempts}/3\n`);

  // Test 5: Buyer Inspects and Releases 4-digit Code to Rider
  console.log('▶ Test 5: Valid 4-digit Handshake Verification & Instant Payout');
  const validVerification = await escrow.verifyReleaseCode(order.orderCode, paymentResult.releaseCode);
  if (!validVerification.success) throw new Error('Valid code verification failed');
  if (validVerification.order.status !== 'COMPLETED') throw new Error('Status should be COMPLETED');
  if (validVerification.sellerPayout !== 19500) throw new Error(`Expected seller payout 19500, got ${validVerification.sellerPayout}`);
  if (validVerification.riderPayout !== 1500) throw new Error(`Expected rider payout 1500, got ${validVerification.riderPayout}`);
  console.log(`✅ Payout Disbursed: Seller: ${validVerification.sellerPayout} FCFA, Rider: ${validVerification.riderPayout} FCFA\n`);

  // Test 6: Dispute Flow (Rider Delivery Fee Protection Guarantee)
  console.log('▶ Test 6: Dispute & Return Flow (Rider Protection Guarantee)');
  const order2 = await escrow.createOrder({
    sellerName: 'Yaoundé Tech Hub',
    sellerPhone: '237699112233',
    itemTitle: 'Écouteurs Bluetooth Pro',
    itemPrice: 15000,
    deliveryFee: 1000,
    buyerPhone: '237670112233'
  });
  await escrow.confirmPayment(order2.orderCode, 'ORANGE-REF-11223');
  await escrow.dispatchOrder(order2.orderCode, '237679998877', 'Paul Moto Mokolo');
  
  // Buyer rejects package upon inspection
  const disputeResult = await escrow.disputeOrder(order2.orderCode, 'Client rejected size/color');
  if (disputeResult.order.status !== 'DISPUTED') throw new Error('Order should be DISPUTED');
  if (!disputeResult.riderCompensated) throw new Error('Rider must be compensated for delivery trip');
  console.log('✅ Dispute handled: Moto rider guaranteed delivery fee was protected and disbursed!\n');

  console.log('🎉 ALL UNIT TESTS PASSED SUCCESSFULLY! 🚀');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
