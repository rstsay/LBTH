import { describe, expect, it, vi } from "vitest";
import { ForegroundLocationTracker } from "../src/location.ts";

interface MockPosition {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
  };
  timestamp: number;
}

class MockGeolocation implements Geolocation {
  readonly watches = new Map<number, PositionCallback>();
  readonly errors = new Map<number, PositionErrorCallback>();
  readonly watchOptions: PositionOptions[] = [];
  cleared: number[] = [];
  private nextId = 0;

  getCurrentPosition(): void {}

  watchPosition(
    successCallback: PositionCallback,
    errorCallback?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): number {
    const id = ++this.nextId;
    this.watches.set(id, successCallback);
    if (errorCallback) {
      this.errors.set(id, errorCallback);
    }
    if (options) {
      this.watchOptions.push(options);
    }
    return id;
  }

  clearWatch(id: number): void {
    this.cleared.push(id);
    this.watches.delete(id);
    this.errors.delete(id);
  }

  report(id: number, position: MockPosition): void {
    this.watches.get(id)?.(position as GeolocationPosition);
  }
}

class MockVisibilityTarget extends EventTarget {
  hidden = false;

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("前景定位追蹤", () => {
  it("starts high-accuracy real geolocation only in the foreground and stops immediately in background", () => {
    const geolocation = new MockGeolocation();
    const visibility = new MockVisibilityTarget();
    const onLocation = vi.fn();
    const onPaused = vi.fn();
    const tracker = new ForegroundLocationTracker({
      geolocation,
      visibility,
      onLocation,
      onPaused,
      now: () => 10_000,
    });

    tracker.start();
    expect(geolocation.watches.size).toBe(1);
    expect(geolocation.watchOptions[0]).toMatchObject({
      enableHighAccuracy: true,
      maximumAge: 0,
    });

    visibility.setHidden(true);
    expect(geolocation.watches.size).toBe(0);
    expect(geolocation.cleared).toEqual([1]);
    expect(onPaused).toHaveBeenCalledTimes(1);

    visibility.setHidden(false);
    expect(geolocation.watches.size).toBe(1);
    expect(geolocation.watchOptions).toHaveLength(2);
    tracker.stop();
  });

  it("limits location reports to one per five seconds and requires a fresh fix after returning foreground", () => {
    const geolocation = new MockGeolocation();
    const visibility = new MockVisibilityTarget();
    const onLocation = vi.fn();
    let timestamp = 10_000;
    const tracker = new ForegroundLocationTracker({
      geolocation,
      visibility,
      onLocation,
      onPaused: vi.fn(),
      now: () => timestamp,
    });
    tracker.start();
    const firstWatchId = 1;
    const position = (latitude: number): MockPosition =>
      ({
        coords: { latitude, longitude: 121, accuracy: 5 },
        timestamp,
      }) as MockPosition;

    geolocation.report(firstWatchId, position(25));
    timestamp += 4_999;
    geolocation.report(firstWatchId, position(25.1));
    expect(onLocation).toHaveBeenCalledTimes(1);

    timestamp += 1;
    geolocation.report(firstWatchId, position(25.2));
    expect(onLocation).toHaveBeenCalledTimes(2);

    visibility.setHidden(true);
    visibility.setHidden(false);
    geolocation.report(2, position(25.3));
    expect(onLocation).toHaveBeenCalledTimes(3);
    expect(onLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ latitude: 25.3, accuracy: 5 }),
    );
    tracker.stop();
  });

  it("ignores invalid GPS readings and stops watching when disposed", () => {
    const geolocation = new MockGeolocation();
    const visibility = new MockVisibilityTarget();
    const onLocation = vi.fn();
    const tracker = new ForegroundLocationTracker({
      geolocation,
      visibility,
      onLocation,
      onPaused: vi.fn(),
      now: () => 10_000,
    });
    tracker.start();
    geolocation.report(
      1,
      {
        coords: { latitude: Number.NaN, longitude: 121, accuracy: 5 },
        timestamp: 10_000,
      } as MockPosition,
    );
    tracker.stop();
    visibility.setHidden(true);
    visibility.setHidden(false);

    expect(onLocation).not.toHaveBeenCalled();
    expect(geolocation.watches.size).toBe(0);
    expect(geolocation.cleared).toEqual([1]);
  });
});
