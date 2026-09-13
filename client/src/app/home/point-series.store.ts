import { Injectable, computed, inject, signal } from '@angular/core';
import { PointSeriesPoint, PointSeriesResponse, RadarService } from '../radar/radar.service';
import { MapLocation } from './radar-map/radar-map';
import { CHART_WINDOW_AFTER_HOURS, CHART_WINDOW_BEFORE_HOURS } from './rain-chart/rain-chart';
import { TimelineStore } from './timeline.store';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The rain series for the location the user picked, feeding the chart.
 *
 * Requests are token-guarded rather than cancelled, so a stale response that
 * arrives after a newer click or a chart close is simply dropped.
 */
@Injectable()
export class PointSeriesStore {
  private readonly radarService = inject(RadarService);
  private readonly timeline = inject(TimelineStore);
  private loadToken = 0;

  readonly location = signal<MapLocation | null>(null);
  readonly locationLabel = signal('');
  readonly points = signal<PointSeriesPoint[]>([]);
  readonly loading = signal(false);
  readonly extending = signal(false);
  readonly error = signal<string | null>(null);
  readonly extendedWindow = signal(false);

  /**
   * How far ahead the chart could reach if extended, or `null` when that is
   * not meaningfully further than the window it already shows.
   */
  readonly maxAvailableHours = computed(() => {
    const nowMs = Date.now();
    let maxProbabilityMs: number | null = null;

    for (const slot of this.timeline.frames()) {
      if (slot.probability === null) {
        continue;
      }
      const timeMs = new Date(slot.valid_at).getTime();
      if (maxProbabilityMs === null || timeMs > maxProbabilityMs) {
        maxProbabilityMs = timeMs;
      }
    }

    if (maxProbabilityMs === null) {
      return null;
    }

    const hoursAhead = (maxProbabilityMs - nowMs) / HOUR_MS;
    if (hoursAhead <= CHART_WINDOW_AFTER_HOURS + 0.25) {
      return null;
    }

    return Math.ceil(hoursAhead);
  });

  selectLocation(location: MapLocation): void {
    this.location.set(location);
    this.locationLabel.set(formatLocation(location));
    this.extendedWindow.set(false);
    // Start fetching chart data immediately so it is ready when the user opens the chart tab.
    void this.load(location);
  }

  clear(): void {
    this.loadToken += 1;
    this.location.set(null);
    this.points.set([]);
    this.error.set(null);
    this.loading.set(false);
    this.extending.set(false);
    this.extendedWindow.set(false);
    this.locationLabel.set('');
  }

  /** Fetch the series for an already selected location, if nothing has yet. */
  ensureLoaded(): void {
    const location = this.location();
    if (!location || this.loading() || this.extending() || this.points().length > 0) {
      return;
    }

    void this.load(location);
  }

  setWindowExtended(extended: boolean): void {
    if (!extended) {
      this.extendedWindow.set(false);
      return;
    }

    const location = this.location();
    if (!location || this.extending() || this.extendedWindow()) {
      return;
    }

    void this.loadExtended(location);
  }

  private async load(location: MapLocation): Promise<void> {
    const token = ++this.loadToken;
    this.loading.set(true);
    this.error.set(null);
    this.points.set([]);

    try {
      const response = await this.fetchPointSeries(location, CHART_WINDOW_AFTER_HOURS);

      if (token !== this.loadToken) {
        return;
      }

      this.points.set(response.points);
    } catch {
      if (token === this.loadToken) {
        this.error.set('Kan regenreeks voor deze locatie niet laden.');
      }
    } finally {
      if (token === this.loadToken) {
        this.loading.set(false);
      }
    }
  }

  private async loadExtended(location: MapLocation): Promise<void> {
    const token = ++this.loadToken;
    this.extending.set(true);
    this.error.set(null);

    try {
      const response = await this.fetchPointSeries(location);

      if (token !== this.loadToken) {
        return;
      }

      this.points.set(response.points);
      this.extendedWindow.set(true);
    } catch {
      // Keep the short series visible; the user can retry the extended toggle.
    } finally {
      if (token === this.loadToken) {
        this.extending.set(false);
      }
    }
  }

  private fetchPointSeries(
    location: MapLocation,
    afterHours?: number,
  ): Promise<PointSeriesResponse> {
    return new Promise((resolve, reject) => {
      this.radarService
        .getPointSeries(location.lat, location.lng, CHART_WINDOW_BEFORE_HOURS, afterHours)
        .subscribe({
          next: resolve,
          error: reject,
        });
    });
  }
}

function formatLocation(location: MapLocation): string {
  const lat = location.lat.toFixed(3);
  const lng = location.lng.toFixed(3);
  return `${lat}°N, ${lng}°E`;
}
