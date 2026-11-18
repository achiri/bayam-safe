import { EscrowService } from '../src/services/escrow.service.js';

async function runUnifiedTests() {
  console.log('🧪 Running BayamSafe Unified Escrow & Micro-Logistics Test Suite...\n');
  const escrow = new EscrowService();

  // Test 1: Intra-City with Exact GPS Coordinates & Navigation Link
  console.log('▶ Test 1: Intra-City Delivery with Exact GPS Pin & Landmark Note');
  const intraOrder = await escrow.createUnifiedOrder({
    orderType: 'INTRA_CITY',
    merchantName: 'Boutique Akwa Mode',
    merchantPhone: '+237671112233',
    recipientPhone: '+237699887766',
    itemTitle: 'Sac à Main Cuir',
    itemPrice: 15000,
    deliveryFee: 1500,
    paymentMode: 'DIGITAL_ESCROW',
    pickupAddress: 'Douala, Marché Akwa',
    pickupLocation: { latitude: 4.0511, longitude: 9.7085 },
    dropoffAddress: 'Douala, Bonamoussadi',
    dropoffLocation: { latitude: 4.0763, longitude: 9.6644 },
    landmarkNotes: 'Portail bleu en face pharmacie du peuple'
  });

  if (!intraOrder.trackingCode.startsWith('BS-DLA-')) throw new Error('Invalid tracking code');
  console.log(`✅ Order created: [${intraOrder.trackingCode}] Total: ${intraOrder.totalAmount} FCFA`);
  console.log(`   📍 Destination GPS: ${intraOrder.dropoffLocation?.latitude}, ${intraOrder.dropoffLocation?.longitude}`);
  console.log(`   🗺️ Rider Google Maps Route: https://www.google.com/maps/dir/?api=1&destination=${intraOrder.dropoffLocation?.latitude},${intraOrder.dropoffLocation?.longitude}\n`);

  // Test 2: Geospatial Dispatch Matching (Find nearest rider)
  console.log('▶ Test 2: Geospatial Dispatch Discovery (Redis GeoSearch)');
  const dispatch = escrow.getDispatchService();
  const nearest = dispatch.findNearestRiders(intraOrder.pickupLocation!, 10);
  if (nearest.length === 0) throw new Error('No riders found nearby');
  console.log(`✅ Found ${nearest.length} active riders nearby: Closest is ${nearest[0].rider.fullName} (${nearest[0].distanceKm} km away)\n`);

  // Test 3: Assign Rider with Atomic Mutex Lock
  console.log('▶ Test 3: Assigning Rider with Atomic Mutex Lock');
  await escrow.assignRider(intraOrder.trackingCode, nearest[0].rider.userId);
  await escrow.markAtPickupAndInTransit(intraOrder.trackingCode);
  if (intraOrder.status !== 'IN_TRANSIT') throw new Error('Status should be IN_TRANSIT');
  console.log(`✅ Rider ${intraOrder.firstMileRiderName} assigned and in transit with parcel\n`);

  // Test 4: Final Handshake with 4-Digit Release Code & PoD Photo
  console.log('▶ Test 4: Customer Verification via 4-Digit Code & PoD Photo');
  const settlement = await escrow.verifyDeliveryAndSettle(
    intraOrder.trackingCode,
    intraOrder.rawReleaseCodeForTesting!,
    'https://storage.bayamsafe.cm/pod/photo_123.jpg'
  );
  if (!settlement.success) throw new Error('Settlement failed');
  console.log(`✅ Delivery completed and settled! Merchant payout: ${settlement.merchantPayout} FCFA, Rider payout: ${settlement.firstMilePayout} FCFA\n`);

  // Test 5: Inter-City Travel Agency Concierge (Douala -> Bamenda via Moghamo Express)
  console.log('▶ Test 5: Inter-City Bus Agency Concierge (Douala ➡️ Bamenda)');
  const interOrder = await escrow.createUnifiedOrder({
    orderType: 'INTER_CITY_AGENCY',
    merchantName: 'Tech Vendor Douala',
    merchantPhone: '+237670001122',
    recipientPhone: '+237678990011',
    itemTitle: 'iPhone 13 Pro Reconditionné',
    itemPrice: 350000,
    deliveryFee: 4000,
    agencyId: 'agency_moghamo_dla',
    agencyFee: 3000,
    paymentMode: 'DIGITAL_ESCROW',
    pickupAddress: 'Douala Akwa',
    dropoffAddress: 'Bamenda Commercial Avenue'
  });

  console.log(`✅ Inter-city order initiated with ${interOrder.agencyName} (${interOrder.agencyTerminal})`);

  // Drop at agency & upload waybill
  await escrow.recordAgencyDropoff(interOrder.trackingCode, 'MOG-WB-98214', 'https://storage.bayamsafe.cm/waybills/wb_98214.jpg');
  if (interOrder.status !== 'AGENCY_DROPPED') throw new Error('Status should be AGENCY_DROPPED');
  console.log(`✅ Package dropped at bus station! Waybill logged: ${interOrder.agencyWaybillNumber}`);

  // Bus arrives at destination terminal
  await escrow.recordDestinationHubArrival(interOrder.trackingCode);
  if (interOrder.status !== 'DESTINATION_HUB') throw new Error('Status should be DESTINATION_HUB');
  console.log(`✅ Bus arrived at destination agency terminal: ${interOrder.status}\n`);

  console.log('🎉 ALL UNIFIED TESTS (GPS, DISPATCH, ESCROW & AGENCY) PASSED SUCCESSFULLY! 🚀');
}

runUnifiedTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
