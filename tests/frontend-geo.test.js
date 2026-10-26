import { describe, expect, it } from "vitest";
import {
  COLLECTION_THRESHOLD_METERS as frontendThreshold,
  EARTH_RADIUS_METERS as frontendRadius,
  distanceMeters as frontendDistanceMeters,
} from "../web/geo.js";
import {
  COLLECTION_THRESHOLD_METERS as serverThreshold,
  EARTH_RADIUS_METERS as serverRadius,
  distanceMeters as serverDistanceMeters,
} from "../web/geo.js";

describe("前端與伺服器定位距離一致", () => {
  it("uses a single Haversine implementation in the browser and server", () => {
    expect(frontendDistanceMeters).toBe(serverDistanceMeters);
  });

  it("shares the fixed collection threshold and Earth radius", () => {
    expect(frontendThreshold).toBe(serverThreshold);
    expect(frontendThreshold).toBe(20);
    expect(frontendRadius).toBe(serverRadius);
    expect(frontendRadius).toBe(6_371_000);
  });

  it.each([
    [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }],
    [{ latitude: 80, longitude: 0 }, { latitude: 80, longitude: 1 }],
    [{ latitude: 0, longitude: 179.999 }, { latitude: 0, longitude: -179.999 }],
    [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 }],
    [{ latitude: 25, longitude: 121 }, { latitude: 25, longitude: 121 }],
  ])("uses identical Haversine distances for %o and %o", (from, to) => {
    expect(frontendDistanceMeters(from, to)).toBe(serverDistanceMeters(from, to));
  });

  it("compares an exact 20-metre equatorial distance without rounding", () => {
    const longitudeDelta = (frontendThreshold / frontendRadius) * (180 / Math.PI);
    const distance = frontendDistanceMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: longitudeDelta },
    );
    expect(distance).toBeLessThanOrEqual(frontendThreshold);
    expect(distance).toBe(serverDistanceMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: longitudeDelta },
    ));
  });
});
