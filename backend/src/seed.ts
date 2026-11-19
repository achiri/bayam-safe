import { App } from './app.js';
import { newId, newRiderCode } from './domain/secrets.js';
import { Rider, User } from './domain/types.js';
import { SimulatedGateway } from './payments/simulated.js';

/**
 * Local demo data (SEED_DEMO_DATA=true, never in production): one merchant, two approved
 * riders and one escrow order whose checkout link is printed to the console.
 */
export async function seedDemoData(app: App): Promise<void> {
  const now = new Date().toISOString();
  const merchantTg = 900_000_001;
  let merchant = await app.store.getUserByTelegram(merchantTg);
  if (!merchant) {
    merchant = {
      id: newId(), version: 1, telegramId: merchantTg, phone: '+237670000001', fullName: 'Demo Boutique',
      shopName: 'Demo Boutique Akwa', city: 'Douala', lang: 'fr', kycStatus: 'VERIFIED', createdAt: now, updatedAt: now
    } satisfies User;
    await app.store.insertUser(merchant);
  }

  const riders: Array<[number, string, string, { lat: number; lng: number }]> = [
    [900_000_101, 'Demo Rider Akwa', '+237670000101', { lat: 4.0511, lng: 9.7085 }],
    [900_000_102, 'Demo Rider Mvan', '+237690000102', { lat: 3.8242, lng: 11.5167 }]
  ];
  for (const [tg, name, phone, location] of riders) {
    if (await app.store.getRiderByTelegram(tg)) continue;
    const user: User = { id: newId(), version: 1, telegramId: tg, phone, fullName: name, shopName: name, lang: 'fr', kycStatus: 'NONE', createdAt: now, updatedAt: now };
    await app.store.insertUser(user);
    const rider: Rider = {
      id: newId(), version: 1, userId: user.id, telegramId: tg, riderCode: newRiderCode(), fullName: name, phone, cniNumber: `DEMO${tg}`, plateNumber: 'LT-000-AA',
      vehicleType: 'MOTO', city: location.lat > 4 ? 'Douala' : 'Yaoundé', status: 'APPROVED', onDuty: true, floatBalance: 0, floatReserved: 0,
      completedDeliveries: 0, location, locationUpdatedAt: now, createdAt: now, updatedAt: now
    };
    await app.store.insertRider(rider);
  }

  const { order, checkoutUrl } = await app.orders.createOrder(merchant, {
    type: 'INTRA_CITY',
    paymentMode: 'ESCROW',
    itemTitle: 'Robe de soirée (démo)',
    itemPrice: 25000,
    deliveryFee: 1500,
    buyerPhone: '+237690000002',
    pickupAddress: 'Marché Akwa, Douala',
    pickupLocation: { lat: 4.0511, lng: 9.7085 }
  });
  console.log(`Demo order ${order.trackingCode}: ${checkoutUrl}`);

  await seedDashboardActivity(app, merchant, now);
}

/** A seller and a rider awaiting review, one completed sale and one dispute, so the admin dashboard has something to show. */
async function seedDashboardActivity(app: App, merchant: User, now: string) {
  if (!(app.gateway instanceof SimulatedGateway)) return;
  const sim = app.gateway;

  const sellerTg = 900_000_201;
  if (!(await app.store.getUserByTelegram(sellerTg))) {
    await app.store.insertUser({
      id: newId(), version: 1, telegramId: sellerTg, phone: '+237690000201', fullName: 'Demo Seller Pending', shopName: 'Demo Wax Bonapriso',
      city: 'Douala', lang: 'fr', kycStatus: 'PENDING', cniNumber: '000000201', selfieFileId: 'demo-no-file-selfie', cniFrontFileId: 'demo-no-file-front',
      cniBackFileId: 'demo-no-file-back', shopPhotoFileId: 'demo-no-file-shop', shopLocation: { lat: 4.0186, lng: 9.6935 }, kycSubmittedAt: now,
      createdAt: now, updatedAt: now
    });
  }
  const applicantTg = 900_000_301;
  if (!(await app.store.getRiderByTelegram(applicantTg))) {
    const u: User = { id: newId(), version: 1, telegramId: applicantTg, phone: '+237670000301', fullName: 'Demo Applicant', shopName: 'Demo Applicant', lang: 'fr', kycStatus: 'NONE', createdAt: now, updatedAt: now };
    await app.store.insertUser(u);
    await app.riders.submitApplication(applicantTg, {
      legalName: 'Demo Applicant Rider', cniNumber: '000000301', selfieFileId: 'demo-no-file-r-selfie', cniFrontFileId: 'demo-no-file-r-front',
      cniBackFileId: 'demo-no-file-r-back', vehicleType: 'MOTO', plateNumber: 'LT-301-DM', vehiclePhotoFileId: 'demo-no-file-r-moto', city: 'Douala'
    });
  }

  const rider = await app.store.getRiderByTelegram(900_000_101);
  if (!rider) return;
  const runSale = async (title: string, price: number, finish: 'deliver' | 'dispute') => {
    const { order, buyerToken } = await app.orders.createOrder(merchant, {
      type: 'INTRA_CITY', paymentMode: 'ESCROW', itemTitle: title, itemPrice: price, deliveryFee: 1500,
      buyerPhone: '+237690000002', pickupAddress: 'Marché Akwa, Douala', pickupLocation: { lat: 4.0511, lng: 9.7085 }
    });
    await app.orders.updateDeliveryDetails(order.id, buyerToken, { dropoffLocation: { lat: 4.0726, lng: 9.7343 }, landmark: 'Portail bleu, face pharmacie' });
    await app.orders.initiatePayment(order.id, buyerToken, '+237677000002');
    const ref = (await app.store.getOrder(order.id))!.payment.reference!;
    sim.approve(ref);
    await app.handlePaymentReference(ref);
    await app.orders.claim(rider.telegramId, order.id);
    await app.orders.confirmPickup(rider.telegramId, order.id);
    if (finish === 'deliver') await app.orders.deliver(rider.telegramId, order.id, app.secrets.decrypt((await app.store.getOrder(order.id))!.releaseCodeEnc));
    else await app.orders.openDispute(order.id, 'BUYER', 'Taille différente de la photo (démo)');
  };
  await runSale('Sac en cuir (démo)', 18000, 'deliver');
  await runSale('Chaussures taille 42 (démo)', 22000, 'dispute');
}
