import { TravelAgency } from '../domain/types.js';

export class AgencyService {
  private agencies: Map<string, TravelAgency> = new Map();

  constructor() {
    this.seedAgencies();
  }

  private seedAgencies() {
    const defaultAgencies: TravelAgency[] = [
      {
        id: 'agency_moghamo_dla',
        name: 'Moghamo Express',
        city: 'Douala',
        terminalName: 'Gare Bonaberi',
        contactPhone: '+237 677 10 20 30',
        location: { latitude: 4.0763, longitude: 9.6644 }
      },
      {
        id: 'agency_moghamo_bda',
        name: 'Moghamo Express',
        city: 'Bamenda',
        terminalName: 'Mile 4 Station',
        contactPhone: '+237 677 10 20 31',
        location: { latitude: 5.9597, longitude: 10.1512 }
      },
      {
        id: 'agency_guarantee_yde',
        name: 'Guarantee Express',
        city: 'Yaoundé',
        terminalName: 'Terminal Mvan',
        contactPhone: '+237 677 40 50 60',
        location: { latitude: 3.8242, longitude: 11.5167 }
      },
      {
        id: 'agency_guarantee_dla',
        name: 'Guarantee Express',
        city: 'Douala',
        terminalName: 'Agence Bassa Ndokoti',
        contactPhone: '+237 677 40 50 61',
        location: { latitude: 4.0483, longitude: 9.736 }
      },
      {
        id: 'agency_buca_dla',
        name: 'Buca Voyages',
        city: 'Douala',
        terminalName: 'Gare Routière Mboppi',
        contactPhone: '+237 699 80 90 00',
        location: { latitude: 4.0531, longitude: 9.7121 }
      },
      {
        id: 'agency_buca_yde',
        name: 'Buca Voyages',
        city: 'Yaoundé',
        terminalName: 'Station Mvan',
        contactPhone: '+237 699 80 90 01',
        location: { latitude: 3.825, longitude: 11.518 }
      }
    ];

    for (const a of defaultAgencies) {
      this.agencies.set(a.id, a);
    }
  }

  getAgencies(city?: string): TravelAgency[] {
    const list = Array.from(this.agencies.values());
    if (city) {
      return list.filter((a) => a.city.toLowerCase() === city.toLowerCase());
    }
    return list;
  }

  getAgencyById(id: string): TravelAgency | undefined {
    return this.agencies.get(id);
  }
}
