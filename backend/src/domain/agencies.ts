import { TravelAgency } from './types.js';

/**
 * Partner bus-agency terminals. Coordinates are approximate and should be confirmed on the
 * ground before launch; contact numbers are intentionally not stored until verified.
 */
export const AGENCIES: TravelAgency[] = [
  { id: 'moghamo-dla-bonaberi', name: 'Moghamo Express', city: 'Douala', terminalName: 'Bonabéri', location: { lat: 4.0763, lng: 9.6644 } },
  { id: 'moghamo-bda-mile4', name: 'Moghamo Express', city: 'Bamenda', terminalName: 'Mile 4', location: { lat: 5.9597, lng: 10.1512 } },
  { id: 'guarantee-dla-ndokoti', name: 'Guarantee Express', city: 'Douala', terminalName: 'Bassa Ndokoti', location: { lat: 4.0483, lng: 9.736 } },
  { id: 'guarantee-yde-mvan', name: 'Guarantee Express', city: 'Yaoundé', terminalName: 'Mvan', location: { lat: 3.8242, lng: 11.5167 } },
  { id: 'buca-dla-mboppi', name: 'Buca Voyages', city: 'Douala', terminalName: 'Mboppi', location: { lat: 4.0531, lng: 9.7121 } },
  { id: 'buca-yde-mvan', name: 'Buca Voyages', city: 'Yaoundé', terminalName: 'Mvan', location: { lat: 3.825, lng: 11.518 } },
  { id: 'touristique-yde-nsam', name: 'Touristique Express', city: 'Yaoundé', terminalName: 'Nsam', location: { lat: 3.834, lng: 11.5074 } }
];

export const CITIES = ['Douala', 'Yaoundé', 'Bamenda', 'Buea', 'Bafoussam'] as const;

export const getAgency = (id: string) => AGENCIES.find((a) => a.id === id);
export const agenciesInCity = (city: string) => AGENCIES.filter((a) => a.city.toLowerCase() === city.toLowerCase());
