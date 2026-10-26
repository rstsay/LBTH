const MINIMUM_REPORT_INTERVAL_MS = 5_000;

export class ForegroundLocationTracker {
  constructor({
    geolocation,
    visibility,
    onLocation,
    onLocationReport,
    onPaused,
    onError,
    now = Date.now,
  }) {
    this.geolocation = geolocation;
    this.visibility = visibility;
    this.onLocation = onLocation;
    this.onLocationReport = onLocationReport;
    this.onPaused = onPaused;
    this.onError = onError;
    this.now = now;
    this.watchId = undefined;
    this.started = false;
    this.lastReportedAt = undefined;
    this.onVisibilityChange = () => {
      if (this.visibility.hidden) {
        this.stopWatching();
        this.lastReportedAt = undefined;
        this.onPaused();
      } else {
        this.startWatching();
      }
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.visibility.addEventListener("visibilitychange", this.onVisibilityChange);
    if (!this.visibility.hidden) this.startWatching();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.visibility.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.stopWatching();
  }

  startWatching() {
    if (!this.started || this.watchId !== undefined || this.visibility.hidden) return;
    this.watchId = this.geolocation.watchPosition(
      (position) => {
        if (!this.started || this.visibility.hidden) return;
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
        const location = { latitude, longitude, accuracy, timestamp: position.timestamp };
        this.onLocation(location);
        const reportedAt = this.now();
        if (
          this.lastReportedAt === undefined ||
          reportedAt - this.lastReportedAt >= MINIMUM_REPORT_INTERVAL_MS
        ) {
          this.lastReportedAt = reportedAt;
          this.onLocationReport(location);
        }
      },
      (error) => {
        if (this.started && !this.visibility.hidden) this.onError?.(error);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  }

  stopWatching() {
    if (this.watchId === undefined) return;
    this.geolocation.clearWatch(this.watchId);
    this.watchId = undefined;
  }
}
