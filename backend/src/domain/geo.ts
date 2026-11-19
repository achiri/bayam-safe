import { GeoPoint } from './types.js';
import { invalid } from './errors.js';

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Rough bounding box around Cameroon, to reject garbage coordinates. */
export function assertGeoPoint(p: unknown): GeoPoint {
  const g = p as GeoPoint;
  if (!g || typeof g.lat !== 'number' || typeof g.lng !== 'number' || !Number.isFinite(g.lat) || !Number.isFinite(g.lng)) {
    throw invalid('Invalid GPS location');
  }
  if (g.lat < 1.5 || g.lat > 13.2 || g.lng < 8.3 || g.lng > 16.3) {
    throw invalid('GPS location must be inside Cameroon');
  }
  return { lat: Math.round(g.lat * 1e6) / 1e6, lng: Math.round(g.lng * 1e6) / 1e6 };
}

export const googleMapsRoute = (p: GeoPoint) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
