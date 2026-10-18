export interface RealLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: EventListener): void;
  removeEventListener(type: "visibilitychange", listener: EventListener): void;
}

export interface ForegroundLocationTrackerOptions {
  geolocation: Pick<Geolocation, "watchPosition" | "clearWatch">;
  visibility: VisibilitySource;
  onLocation: (location: RealLocation) => void;
  onPaused: () => void;
  onError?: (error: GeolocationPositionError) => void;
  now?: () => number;
}

const MINIMUM_REPORT_INTERVAL_MS = 5_000;

export class ForegroundLocationTracker {
  private watchId: number | undefined;
  private started = false;
  private lastReportedAt: number | undefined;
  private readonly now: () => number;
  private readonly onVisibilityChange: EventListener;

  constructor(private readonly options: ForegroundLocationTrackerOptions) {
    this.now = options.now ?? Date.now;
    this.onVisibilityChange = () => {
      if (options.visibility.hidden) {
        this.stopWatching();
        this.lastReportedAt = undefined;
        options.onPaused();
      } else {
        this.startWatching();
      }
    };
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.options.visibility.addEventListener("visibilitychange", this.onVisibilityChange);
    if (!this.options.visibility.hidden) {
      this.startWatching();
    }
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.options.visibility.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.stopWatching();
  }

  private startWatching(): void {
    if (!this.started || this.watchId !== undefined || this.options.visibility.hidden) {
      return;
    }
    this.watchId = this.options.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        if (
          !Number.isFinite(latitude) ||
          latitude < -90 ||
          latitude > 90 ||
          !Number.isFinite(longitude) ||
          longitude < -180 ||
          longitude > 180 ||
          !Number.isFinite(accuracy) ||
          accuracy < 0
        ) {
          return;
        }
        const timestamp = this.now();
        if (
          this.lastReportedAt !== undefined &&
          timestamp - this.lastReportedAt < MINIMUM_REPORT_INTERVAL_MS
        ) {
          return;
        }
        this.lastReportedAt = timestamp;
        this.options.onLocation({ latitude, longitude, accuracy, timestamp: position.timestamp });
      },
      (error) => this.options.onError?.(error),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 },
    );
  }

  private stopWatching(): void {
    if (this.watchId === undefined) {
      return;
    }
    this.options.geolocation.clearWatch(this.watchId);
    this.watchId = undefined;
  }
}
