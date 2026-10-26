import { describe, expect, it, vi } from "vitest";
import { ForegroundLocationTracker } from "../web/location.js";

class MockGeolocation {
  watches = new Map();
  errors = new Map();
  watchOptions = [];
  cleared = [];
  nextId = 0;

  watchPosition(successCallback, errorCallback, options) {
    const id = ++this.nextId;
    this.watches.set(id, successCallback);
    if (errorCallback) this.errors.set(id, errorCallback);
    this.watchOptions.push(options);
    return id;
  }

  clearWatch(id) {
    this.cleared.push(id);
    this.watches.delete(id);
    this.errors.delete(id);
  }

  report(id, position) {
    this.watches.get(id)?.(position);
  }
}

class MockVisibilityTarget extends EventTarget {
  hidden = false;

  setHidden(hidden) {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const position = (latitude, timestamp = 10_000) => ({
  coords: { latitude, longitude: 121, accuracy: 5 },
  timestamp,
});

describe("正式前端前景定位追蹤", () => {
  it("reports each valid fix but rate-limits server reports to once every five seconds", () => {
    const geolocation = new MockGeolocation();
    const visibility = new MockVisibilityTarget();
    const onLocation = vi.fn();
    const onLocationReport = vi.fn();
    let now = 10_000;
    const tracker = new ForegroundLocationTracker({
      geolocation,
      visibility,
      onLocation,
      onLocationReport,
      onPaused: vi.fn(),
      now: () => now,
    });

    tracker.start();
    geolocation.report(1, position(25));
    now += 4_999;
    geolocation.report(1, position(25.1));
    now += 1;
    geolocation.report(1, position(25.2));

    expect(geolocation.watchOptions[0]).toMatchObject({
      enableHighAccuracy: true,
      maximumAge: 0,
    });
    expect(onLocation).toHaveBeenCalledTimes(3);
    expect(onLocationReport).toHaveBeenCalledTimes(2);
    expect(onLocation).toHaveBeenLastCalledWith({
      latitude: 25.2,
      longitude: 121,
      accuracy: 5,
      timestamp: 10_000,
    });
    expect(onLocationReport).toHaveBeenLastCalledWith({
      latitude: 25.2,
      longitude: 121,
      accuracy: 5,
      timestamp: 10_000,
    });
    tracker.stop();
  });

  it("stops location reports in the background and requires a fresh fix after returning", () => {
    const geolocation = new MockGeolocation();
    const visibility = new MockVisibilityTarget();
    const onLocation = vi.fn();
    const onLocationReport = vi.fn();
    const onPaused = vi.fn();
    const tracker = new ForegroundLocationTracker({
      geolocation,
      visibility,
      onLocation,
      onLocationReport,
      onPaused,
      now: () => 10_000,
    });

    tracker.start();
    const staleCallback = geolocation.watches.get(1);
    visibility.setHidden(true);
    staleCallback?.(position(25.1));
    expect(geolocation.watches.size).toBe(0);
    expect(geolocation.cleared).toEqual([1]);
    expect(onPaused).toHaveBeenCalledTimes(1);
    expect(onLocation).not.toHaveBeenCalled();
    expect(onLocationReport).not.toHaveBeenCalled();

    visibility.setHidden(false);
    geolocation.report(2, position(25.2));
    expect(onLocation).toHaveBeenCalledTimes(1);
    expect(onLocationReport).toHaveBeenCalledTimes(1);
    tracker.stop();
  });

  it("resumes a tracker that started in the background and ignores errors after disposal", () => {
    const geolocation = new MockGeolocation();
    const visibility = new MockVisibilityTarget();
    const onLocation = vi.fn();
    const onLocationReport = vi.fn();
    const onError = vi.fn();
    const tracker = new ForegroundLocationTracker({
      geolocation,
      visibility,
      onLocation,
      onLocationReport,
      onPaused: vi.fn(),
      onError,
      now: () => 10_000,
    });

    visibility.hidden = true;
    tracker.start();
    expect(geolocation.watches.size).toBe(0);
    visibility.setHidden(false);
    expect(geolocation.watches.size).toBe(1);

    const staleErrorCallback = geolocation.errors.get(1);
    const error = { code: 1, message: "permission denied" };
    staleErrorCallback?.(error);
    expect(onError).toHaveBeenCalledWith(error);

    tracker.stop();
    staleErrorCallback?.(error);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onLocation).not.toHaveBeenCalled();
    expect(onLocationReport).not.toHaveBeenCalled();
  });

  it("ignores invalid readings and stops safely when disposed", () => {
    const geolocation = new MockGeolocation();
    const visibility = new MockVisibilityTarget();
    const onLocation = vi.fn();
    const onLocationReport = vi.fn();
    const tracker = new ForegroundLocationTracker({
      geolocation,
      visibility,
      onLocation,
      onLocationReport,
      onPaused: vi.fn(),
      now: () => 10_000,
    });

    tracker.start();
    geolocation.report(1, {
      ...position(Number.NaN),
      coords: { latitude: Number.NaN, longitude: 121, accuracy: 5 },
    });
    tracker.stop();
    visibility.setHidden(true);
    visibility.setHidden(false);

    expect(onLocation).not.toHaveBeenCalled();
    expect(onLocationReport).not.toHaveBeenCalled();
    expect(geolocation.watches.size).toBe(0);
    expect(geolocation.cleared).toEqual([1]);
  });
});
