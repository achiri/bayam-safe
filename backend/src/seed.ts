import { App } from './app.js';
import { newId } from './domain/secrets.js';
import { Rider, User } from './domain/types.js';

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
      shopName: 'Demo Boutique Akwa', city: 'Douala', lang: 'fr', kycStatus: 'NONE', createdAt: now, updatedAt: now
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
      id: newId(), version: 1, userId: user.id, telegramId: tg, fullName: name, phone, cniNumber: `DEMO${tg}`, plateNumber: 'LT-000-AA',
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
}
