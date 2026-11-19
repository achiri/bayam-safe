import { haversineKm } from '../domain/geo.js';
import { GeoPoint, Order, Rider } from '../domain/types.js';
import { Store } from '../storage/store.js';
import { RiderOffer } from './events.js';

const LOCATION_FRESH_MS = 30 * 60 * 1000;
const MAX_OFFERS = 5;

/**
 * Picks riders to offer a job to. At pilot scale (hundreds of riders) a scan of on-duty riders
 * is fine; switch to PostGIS/Redis geo queries when that stops being true.
 */
export class DispatchService {
  constructor(
    private readonly store: Store,
    private readonly radiusKm: number
  ) {}

  availableFloat(r: Rider): number {
    return r.floatBalance - r.floatReserved;
  }

  async candidates(order: Order, leg: 'FIRST' | 'LAST', now = Date.now()): Promise<RiderOffer[]> {
    const riders = await this.store.listRiders({ status: 'APPROVED', onDuty: true });
    const origin: GeoPoint | undefined = leg === 'FIRST' ? order.pickupLocation : order.dropoffLocation;
    const city = leg === 'LAST' ? order.destinationCity : order.originCity;

    const offers: RiderOffer[] = [];
    for (const r of riders) {
      if (r.id === order.firstMileRiderId && leg === 'LAST') continue;
      if (order.paymentMode === 'COD' && this.availableFloat(r) < order.itemPrice) continue;
      const fresh = r.location && r.locationUpdatedAt && now - Date.parse(r.locationUpdatedAt) < LOCATION_FRESH_MS;
      if (origin && fresh) {
        const d = haversineKm(origin, r.location!);
        if (d <= this.radiusKm) offers.push({ rider: r, distanceKm: Math.round(d * 10) / 10 });
      } else if (city && r.city && r.city.toLowerCase() === city.toLowerCase()) {
        offers.push({ rider: r });
      } else if (!origin && !city) {
        offers.push({ rider: r });
      }
    }
    return offers
      .sort((a, b) => (a.distanceKm ?? Number.MAX_VALUE) - (b.distanceKm ?? Number.MAX_VALUE))
      .slice(0, MAX_OFFERS);
  }
}
