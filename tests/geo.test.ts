import { describe, expect, it } from "vitest";
import {
  COLLECTION_THRESHOLD_METERS,
  EARTH_RADIUS_METERS,
  distanceMeters,
} from "../web/geo.js";

describe("共用 Haversine 定位距離", () => {
  it("exports the fixed collection threshold and Earth radius", () => {
    expect(COLLECTION_THRESHOLD_METERS).toBe(20);
    expect(EARTH_RADIUS_METERS).toBe(6_371_000);
  });

  it("calculates a known one-degree equatorial distance using the Haversine formula", () => {
    expect(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(
      111_194.9266,
      3,
    );
  });

  it("handles identical points, high latitudes, and antimeridian crossings", () => {
    expect(distanceMeters({ latitude: 25, longitude: 121 }, { latitude: 25, longitude: 121 })).toBe(
      0,
    );
    expect(
      distanceMeters({ latitude: 80, longitude: 0 }, { latitude: 80, longitude: 1 }),
    ).toBeCloseTo(19_308.6, 0);
    expect(
      distanceMeters({ latitude: 0, longitude: 179.999 }, { latitude: 0, longitude: -179.999 }),
    ).toBeCloseTo(222.39, 1);
    expect(
      distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 }),
    ).toBeCloseTo(Math.PI * EARTH_RADIUS_METERS, 5);
  });
});
