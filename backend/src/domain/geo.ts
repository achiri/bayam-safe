import { GeoPoint } from './types.js';
import { AppError, invalid } from './errors.js';

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Locations are limited to Cameroon by default. Staging can switch this off
 * (RESTRICT_TO_CAMEROON=false) so testers abroad can complete sign-up.
 */
let restrictToCameroon = true;
export function setCameroonGeofence(enabled: boolean) {
  restrictToCameroon = enabled;
}

/** Rough bounding box around Cameroon. */
export function isInCameroon(p: GeoPoint): boolean {
  return p.lat >= 1.5 && p.lat <= 13.2 && p.lng >= 8.3 && p.lng <= 16.3;
}

export class OutsideCameroonError extends AppError {
  constructor(public readonly point: GeoPoint) {
    super('OUTSIDE_CAMEROON', 'GPS location must be inside Cameroon', 400);
  }
}

export function assertGeoPoint(p: unknown): GeoPoint {
  const g = p as GeoPoint;
  if (!g || typeof g.lat !== 'number' || typeof g.lng !== 'number' || !Number.isFinite(g.lat) || !Number.isFinite(g.lng)) {
    throw invalid('Invalid GPS location');
  }
  if (Math.abs(g.lat) > 90 || Math.abs(g.lng) > 180) throw invalid('Invalid GPS location');
  const point = { lat: Math.round(g.lat * 1e6) / 1e6, lng: Math.round(g.lng * 1e6) / 1e6 };
  if (restrictToCameroon && !isInCameroon(point)) throw new OutsideCameroonError(point);
  return point;
}

/**
 * Reads a position typed or pasted as text: "4.0511, 9.7085", "4.0511 9.7085", or a Google Maps
 * link (".../@4.0511,9.7085,17z", "?q=4.0511,9.7085", "?ll=…", "/place/4.0511,9.7085").
 * Returns undefined when the text holds no coordinates.
 */
export function parseCoordinates(text: string): GeoPoint | undefined {
  const t = text.trim();
  const patterns = [
    /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, // maps URL with @lat,lng
    /[?&](?:q|ll|query|destination)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i,
    /\/place\/(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/,
    /^(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)$/ // plain "lat, lng"
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return undefined;
}

export const googleMapsRoute = (p: GeoPoint) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
