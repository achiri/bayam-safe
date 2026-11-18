import { EscrowService } from '../src/services/escrow.service.js';
import { UserService } from '../src/services/user.service.js';

async function runWowTestSuite() {
  console.log('🌟 Running BayamSafe Complete "WOW" Suite (Onboarding, KYC, Loans, GPS & Leaderboard)...\n');
  const escrow = new EscrowService();
  const userService = new UserService();

  // Test 1: 1-Tap Merchant Onboarding via Phone Contact
  console.log('▶ Test 1: 1-Tap Telegram Contact Onboarding for Merchant');
  const merchant = userService.registerUserFromContact(
    991122,
    '+237670112233',
    'Chantal Mode Douala',
    'MERCHANT',
    'Chantal Fashion Akwa',
    'Douala'
  );
  if (merchant.kycLevel !== 1) throw new Error('New merchant should be Level 1');
  console.log(`✅ Merchant onboarded: ${merchant.shopName} (${merchant.phoneNumber}) - KYC Level: ${merchant.kycLevel}\n`);

  // Test 2: Level 2 CNI Verification (Verified Badge 🏅)
  console.log('▶ Test 2: Level 2 CNI Verification -> Green Verified Badge');
  const verifiedMerchant = userService.upgradeMerchantToVerified(merchant.phoneNumber, '1092837465');
  if (!verifiedMerchant.isVerifiedMerchant || verifiedMerchant.kycLevel !== 2) {
    throw new Error('Merchant should be Level 2 verified');
  }
  console.log(`✅ Merchant upgraded to Level 2! Verified Badge 🏅: ${verifiedMerchant.isVerifiedMerchant}\n`);

  // Test 3: Merchant Working Capital Credit Line Unlocking
  console.log('▶ Test 3: Processing Volume & Unlocking Working Capital Nano-Loans');
  userService.recordMerchantTransaction(merchant.phoneNumber, 200000); // Process 200,000 FCFA
  const updatedMerchant = userService.getUser(merchant.phoneNumber)!;
  if (updatedMerchant.unlockedCreditLimit !== 60000) { // 30% of 200,000 = 60,000 FCFA
    throw new Error(`Expected 60,000 FCFA credit, got ${updatedMerchant.unlockedCreditLimit}`);
  }
  console.log(`✅ Working Capital Unlocked: ${updatedMerchant.unlockedCreditLimit} FCFA inventory loan based on turnover!\n`);

  // Test 4: Rider Onboarding with Float Collateral
  console.log('▶ Test 4: Rider Registration with Moto Plate & Float Collateral');
  const rider = userService.registerRider({
    telegramId: 887766,
    fullName: 'Moustapha Moto Bassa',
    phoneNumber: '+237679887766',
    cniNumber: '1192837460',
    plateNumber: 'LT-902-CD',
    vehicleType: 'MOTO',
    initialFloatDeposit: 15000
  });
  if (rider.walletBalance !== 15000) throw new Error('Float balance should be 15,000 FCFA');
  console.log(`✅ Rider registered: ${rider.fullName} (${rider.plateNumber}) with Float: ${rider.walletBalance} FCFA\n`);

  // Test 5: Rider Leaderboard
  console.log('▶ Test 5: Motomen Weekly Leaderboard & Prime Rewards');
  const leaderboard = userService.getRiderLeaderboard();
  if (leaderboard.length === 0) throw new Error('Leaderboard should have riders');
  console.log(`✅ Leaderboard active: #1 Rider is ${leaderboard[0].fullName} with ${leaderboard[0].completedDeliveries} completed deliveries\n`);

  // Test 6: Unified Escrow Order with GPS & Navigation
  console.log('▶ Test 6: Creating Unified Order with GPS Pin and WhatsApp Flash Pitch');
  const order = await escrow.createUnifiedOrder({
    orderType: 'INTRA_CITY',
    merchantName: verifiedMerchant.shopName || 'Chantal Fashion',
    merchantPhone: verifiedMerchant.phoneNumber,
    isMerchantVerified: verifiedMerchant.isVerifiedMerchant,
    recipientPhone: '+237699112233',
    itemTitle: 'Robe de Cérémonie',
    itemPrice: 35000,
    deliveryFee: 1500,
    paymentMode: 'DIGITAL_ESCROW',
    pickupAddress: 'Douala Marché Akwa',
    dropoffAddress: 'Douala Bonapriso',
    dropoffLocation: { latitude: 4.0201, longitude: 9.7042 },
    landmarkNotes: 'Barrière noire après la pharmacie du rond-point'
  });

  console.log(`✅ Order generated: [${order.trackingCode}] Total: ${order.totalAmount} FCFA`);
  console.log(`   📍 Destination GPS: ${order.dropoffLocation?.latitude}, ${order.dropoffLocation?.longitude}`);
  console.log(`   🗺️ Google Maps Navigation: https://www.google.com/maps/dir/?api=1&destination=${order.dropoffLocation?.latitude},${order.dropoffLocation?.longitude}\n`);

  console.log('🎉 ALL WOW-FACTOR FEATURES VERIFIED AND PASSING! 🚀');
}

runWowTestSuite().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
