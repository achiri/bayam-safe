import { RiderProfile, User, UserRole } from '../domain/types.js';

export class UserService {
  private users: Map<string, User> = new Map(); // key = telegramId or phone
  private riders: Map<string, RiderProfile> = new Map();

  constructor() {
    this.seedInitialUsers();
  }

  private seedInitialUsers() {
    // Seed a verified pilot merchant
    const demoMerchant: User = {
      id: 'merchant_seed_01',
      telegramId: 10001,
      phoneNumber: '+237671112233',
      fullName: 'Boutique Chic Akwa',
      shopName: 'Boutique Chic Akwa',
      city: 'Douala',
      role: 'MERCHANT',
      preferredLanguage: 'fr',
      isVerifiedMerchant: true,
      kycLevel: 2,
      cniNumber: '1102938475',
      cniPhotoUrl: 'https://storage.bayamsafe.cm/cni/demo_cni.jpg',
      totalVolumeProcessed: 650000, // 650,000 FCFA processed
      unlockedCreditLimit: 195000,   // 195,000 FCFA inventory loan unlocked!
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.users.set('+237671112233', demoMerchant);

    // Seed top riders
    const demoRider1: RiderProfile = {
      userId: 'rider_dla_01',
      telegramId: 20001,
      fullName: 'Jean-Pierre Moto Akwa',
      phoneNumber: '+237675112233',
      cniNumber: '1092837461',
      vehicleType: 'MOTO',
      plateNumber: 'LT-849-AB',
      walletBalance: 35000,
      isActive: true,
      trustScore: 4.95,
      completedDeliveries: 142,
      currentLocation: { latitude: 4.0511, longitude: 9.7085 },
      lastLocationUpdate: new Date()
    };

    const demoRider2: RiderProfile = {
      userId: 'rider_yde_01',
      telegramId: 20002,
      fullName: 'Patrick Moto Mokolo',
      phoneNumber: '+237699778899',
      cniNumber: '1092837463',
      vehicleType: 'MOTO',
      plateNumber: 'CE-312-XY',
      walletBalance: 50000,
      isActive: true,
      trustScore: 5.0,
      completedDeliveries: 210,
      currentLocation: { latitude: 3.8667, longitude: 11.5167 },
      lastLocationUpdate: new Date()
    };

    this.riders.set(demoRider1.userId, demoRider1);
    this.riders.set(demoRider2.userId, demoRider2);
  }

  /**
   * 1-Tap Onboarding via Telegram Native Phone Contact
   */
  registerUserFromContact(
    telegramId: number,
    phoneNumber: string,
    fullName: string,
    role: UserRole = 'MERCHANT',
    shopName?: string,
    city: string = 'Douala'
  ): User {
    const cleanPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    let user = this.users.get(cleanPhone) || Array.from(this.users.values()).find(u => u.telegramId === telegramId);

    if (user) {
      user.telegramId = telegramId;
      user.fullName = fullName;
      user.role = role;
      if (shopName) user.shopName = shopName;
      user.city = city;
      user.updatedAt = new Date();
      return user;
    }

    user = {
      id: `user_${Date.now()}`,
      telegramId,
      phoneNumber: cleanPhone,
      fullName,
      shopName: shopName || fullName,
      city,
      role,
      preferredLanguage: 'fr',
      isVerifiedMerchant: false,
      kycLevel: 1, // Phone verified
      totalVolumeProcessed: 0,
      unlockedCreditLimit: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.users.set(cleanPhone, user);
    return user;
  }

  /**
   * Level 2 KYC Upgrade: CNI Submission -> Green Verified Badge
   */
  upgradeMerchantToVerified(phoneNumber: string, cniNumber: string, cniPhotoUrl?: string): User {
    const cleanPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    const user = this.users.get(cleanPhone);
    if (!user) throw new Error('Utilisateur introuvable');

    user.cniNumber = cniNumber;
    user.cniPhotoUrl = cniPhotoUrl || `https://storage.bayamsafe.cm/cni/${user.id}.jpg`;
    user.isVerifiedMerchant = true;
    user.kycLevel = 2;
    user.updatedAt = new Date();

    console.log(`[MERCHANT VERIFIED 🏅] ${user.shopName} (${user.phoneNumber}) is now a Level 2 Verified Merchant!`);
    return user;
  }

  /**
   * Records completed order volume and recalculates working capital inventory nano-credit
   */
  recordMerchantTransaction(phoneNumber: string, amount: number): User | undefined {
    const cleanPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    const user = this.users.get(cleanPhone);
    if (!user) return undefined;

    user.totalVolumeProcessed += amount;
    // Working capital: 30% of total processed volume unlocked up to 250,000 FCFA
    user.unlockedCreditLimit = Math.min(250000, Math.round(user.totalVolumeProcessed * 0.3));
    user.updatedAt = new Date();
    return user;
  }

  /**
   * Rider Registration Flow
   */
  registerRider(data: {
    telegramId: number;
    fullName: string;
    phoneNumber: string;
    cniNumber: string;
    plateNumber: string;
    vehicleType: 'MOTO' | 'CAR' | 'VAN';
    initialFloatDeposit?: number;
  }): RiderProfile {
    const cleanPhone = data.phoneNumber.startsWith('+') ? data.phoneNumber : `+${data.phoneNumber}`;
    const userId = `rider_${Date.now()}`;

    const rider: RiderProfile = {
      userId,
      telegramId: data.telegramId,
      fullName: data.fullName,
      phoneNumber: cleanPhone,
      cniNumber: data.cniNumber,
      plateNumber: data.plateNumber,
      vehicleType: data.vehicleType,
      walletBalance: data.initialFloatDeposit || 5000,
      isActive: true,
      trustScore: 5.0,
      completedDeliveries: 0,
      lastLocationUpdate: new Date()
    };

    this.riders.set(userId, rider);
    console.log(`[RIDER ONBOARDED 🏍️] ${rider.fullName} (${rider.plateNumber}) with float ${rider.walletBalance} FCFA`);
    return rider;
  }

  /**
   * Get Top 5 Riders Leaderboard
   */
  getRiderLeaderboard(): RiderProfile[] {
    return Array.from(this.riders.values())
      .sort((a, b) => b.completedDeliveries - a.completedDeliveries)
      .slice(0, 5);
  }

  getUser(phoneOrId: string): User | undefined {
    return this.users.get(phoneOrId) || Array.from(this.users.values()).find(u => u.id === phoneOrId);
  }

  getRider(idOrPhone: string): RiderProfile | undefined {
    return this.riders.get(idOrPhone) || Array.from(this.riders.values()).find(r => r.phoneNumber === idOrPhone);
  }
}
