export interface Coordinates {
  latitude: number;
  longitude: number;
}

export const COLLECTION_THRESHOLD_METERS: 20;
export const EARTH_RADIUS_METERS: 6_371_000;

export function distanceMeters(first: Coordinates, second: Coordinates): number;
