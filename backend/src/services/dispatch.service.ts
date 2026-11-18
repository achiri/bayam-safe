import { DispatchCandidate, GeoLocation, RiderProfile, UnifiedOrder } from '../domain/types.js';

export class DispatchService {
  private riders: Map<string, RiderProfile> = new Map();
  private lockedOrders: Set<string> = new Set(); // Distributed mutex lock simulation (Redlock)
  private readonly riskRatio = 1.0; // 100% collateral required for COD orders

  constructor() {
    this.seedRiders();
  }

  private seedRiders() {
    const defaultRiders: RiderProfile[] = [
      {
        userId: 'rider_dla_01',
        fullName: 'Jean-Pierre Moto Akwa',
        phoneNumber: '+237 675 11 22 33',
        cniNumber: '1092837461',
        vehicleType: 'MOTO',
        walletBalance: 35000, // 35,000 FCFA float
        isActive: true,
        trustScore: 4.9,
        currentLocation: { latitude: 4.0511, longitude: 9.7085 }, // Akwa, Douala
        lastLocationUpdate: new Date()
      },
      {
        userId: 'rider_dla_02',
        fullName: 'Emmanuel Moto Bonaberi',
        phoneNumber: '+237 679 44 55 66',
        cniNumber: '1092837462',
        vehicleType: 'MOTO',
        walletBalance: 15000, // 15,000 FCFA float
        isActive: true,
        trustScore: 4.7,
        currentLocation: { latitude: 4.075, longitude: 9.663 }, // Bonaberi, Douala
        lastLocationUpdate: new Date()
      },
      {
        userId: 'rider_yde_01',
        fullName: 'Patrick Moto Mokolo',
        phoneNumber: '+237 699 77 88 99',
        cniNumber: '1092837463',
        vehicleType: 'MOTO',
        walletBalance: 50000,
        isActive: true,
        trustScore: 5.0,
        currentLocation: { latitude: 3.8667, longitude: 11.5167 }, // Mokolo, Yaoundé
        lastLocationUpdate: new Date()
      }
    ];

    for (const r of defaultRiders) {
      this.riders.set(r.userId, r);
    }
  }

  /**
   * Update live location of a moto rider (from Telegram Live Location)
   */
  updateRiderLocation(userId: string, location: GeoLocation, isActive: boolean = true) {
    let rider = this.riders.get(userId);
    if (rider) {
      rider.currentLocation = location;
      rider.isActive = isActive;
      rider.lastLocationUpdate = new Date();
    }
  }

  /**
   * Calculate haversine distance between two coordinates in kilometers
   */
  private calculateDistanceKm(loc1: GeoLocation, loc2: GeoLocation): number {
    const R = 6371; // Earth radius in km
    const dLat = ((loc2.latitude - loc1.latitude) * Math.PI) / 180;
    const dLon = ((loc2.longitude - loc1.longitude) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((loc1.latitude * Math.PI) / 180) *
        Math.cos((loc2.latitude * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return parseFloat((R * c).toFixed(2));
  }

  /**
   * Geospatial Candidate Discovery: Redis GEOSEARCH within radius (e.g. 5km)
   * Validates active status, trust score >= 4.0, and COD Collateral Float Guard
   */
  findNearestRiders(
    pickupLoc: GeoLocation,
    radiusKm: number = 8,
    requiredCodAmount: number = 0
  ): DispatchCandidate[] {
    const candidates: DispatchCandidate[] = [];

    for (const rider of this.riders.values()) {
      if (!rider.isActive || !rider.currentLocation) continue;
      if (rider.trustScore < 4.0) continue;

      const distance = this.calculateDistanceKm(pickupLoc, rider.currentLocation);
      if (distance <= radiusKm) {
        // Collateral Float Guard: Rider float must cover the COD amount to eliminate theft risk
        const isFloatEligible = rider.walletBalance >= requiredCodAmount * this.riskRatio;

        candidates.push({
          rider,
          distanceKm: distance,
          isFloatEligible
        });
      }
    }

    // Sort by nearest distance
    return candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  }

  /**
   * Concurrency Safety: Atomic Mutex Lock (Redlock Pattern)
   * Ensures exactly one rider successfully commits to an order
   */
  async acquireOrderGig(orderId: string, riderId: string): Promise<boolean> {
    if (this.lockedOrders.has(orderId)) {
      return false; // Order already claimed by another rider
    }

    this.lockedOrders.add(orderId);
    return true;
  }

  releaseOrderGig(orderId: string) {
    this.lockedOrders.delete(orderId);
  }

  getRider(userId: string): RiderProfile | undefined {
    return this.riders.get(userId);
  }

  getAllRiders(): RiderProfile[] {
    return Array.from(this.riders.values());
  }
}
