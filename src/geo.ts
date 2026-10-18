export const COLLECTION_THRESHOLD_METERS = 20;
export const EARTH_RADIUS_METERS = 6_371_000;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export function distanceMeters(from: Coordinates, to: Coordinates): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const fromLatitude = radians(from.latitude);
  const toLatitude = radians(to.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const boundedHaversine = Math.min(1, Math.max(0, haversine));
  const centralAngle = 2 * Math.atan2(
    Math.sqrt(boundedHaversine),
    Math.sqrt(1 - boundedHaversine),
  );
  return EARTH_RADIUS_METERS * centralAngle;
}
