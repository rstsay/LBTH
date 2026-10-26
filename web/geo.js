export const COLLECTION_THRESHOLD_METERS = 20;
export const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

export function distanceMeters(first, second) {
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude)
      * Math.sin(longitudeDelta / 2) ** 2;
  const boundedHaversine = Math.min(1, Math.max(0, haversine));
  const centralAngle = 2 * Math.atan2(
    Math.sqrt(boundedHaversine),
    Math.sqrt(1 - boundedHaversine),
  );
  return EARTH_RADIUS_METERS * centralAngle;
}
