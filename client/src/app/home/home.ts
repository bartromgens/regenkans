import {
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  FrameSource,
  OverlayMode,
  PointSeriesPoint,
  PointSeriesResponse,
  ProbabilityTimelineResponse,
  RadarService,
  TimelineSlot,
} from '../radar/radar.service';
import { ModeToggle } from './mode-toggle/mode-toggle';
import { MapLegend } from './map-legend/map-legend';
import { TimelinePanel } from './timeline-panel/timeline-panel';
import { MapLocation, RadarMap, RadarOverlay } from './radar-map/radar-map';
import {
  CHART_WINDOW_AFTER_HOURS,
  CHART_WINDOW_BEFORE_HOURS,
  RainChart,
} from './rain-chart/rain-chart';

const SCRUB_THROTTLE_MS = 150;
const PLAY_INTERVAL_MS = 700;
const HOUR_MS = 60 * 60 * 1000;

@Component({
  imports: [ModeToggle, MapLegend, TimelinePanel, RadarMap, RainChart],
  selector: 'app-home',
  styleUrl: './home.scss',
  templateUrl: './home.html',
})
export class Home implements OnInit {
  private readonly radarService = inject(RadarService);
  private readonly destroyRef = inject(DestroyRef);
  private frameLoadToken = 0;
  private pointLoadToken = 0;
  private nowIndexIntervalId: ReturnType<typeof setInterval> | null = null;
  private playIntervalId: ReturnType<typeof setInterval> | null = null;
  private scrubTimerId: ReturnType<typeof setTimeout> | null = null;
  private pendingScrubIndex: number | null = null;
  private lastFrameLoadAt = 0;
  private appliedImageUrl: string | null = null;
  private sharedBbox: [number, number, number, number] | null = null;
  private sharedBboxImageUrl: string | null = null;

  readonly loading = signal(true);
  readonly timelineError = signal<string | null>(null);
  readonly frameError = signal<string | null>(null);
  readonly frames = signal<TimelineSlot[]>([]);
  readonly selectedIndex = signal(0);
  readonly nowIndex = signal(0);
  readonly currentLabel = signal('');
  readonly mode = signal<OverlayMode>('probability');
  readonly ensembleAvailable = signal(false);
  readonly overlay = signal<RadarOverlay | null>(null);
  readonly selectedLocation = signal<MapLocation | null>(null);
  readonly pointSeries = signal<PointSeriesPoint[]>([]);
  readonly pointLoading = signal(false);
  readonly pointExtending = signal(false);
  readonly pointError = signal<string | null>(null);
  readonly locationLabel = signal('');
  readonly chartExtendedWindow = signal(false);
  readonly playing = signal(false);

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => {
      if (this.scrubTimerId !== null) {
        clearTimeout(this.scrubTimerId);
      }
      this.stopPlay();
    });
    void this.loadTimeline();
  }

  onMapClick(location: MapLocation): void {
    this.selectedLocation.set(location);
    this.locationLabel.set(this.formatLocation(location));
    this.chartExtendedWindow.set(false);
    void this.loadPointSeries(location);
  }

  onChartClosed(): void {
    this.pointLoadToken += 1;
    this.selectedLocation.set(null);
    this.pointSeries.set([]);
    this.pointError.set(null);
    this.pointLoading.set(false);
    this.pointExtending.set(false);
    this.chartExtendedWindow.set(false);
    this.locationLabel.set('');
  }

  onChartWindowChange(extended: boolean): void {
    if (!extended) {
      this.chartExtendedWindow.set(false);
      return;
    }

    const location = this.selectedLocation();
    if (!location || this.pointExtending() || this.chartExtendedWindow()) {
      return;
    }

    void this.loadExtendedPointSeries(location);
  }

  onSliderInput(index: number): void {
    if (!Number.isFinite(index)) {
      return;
    }

    this.stopPlay();

    const timelineFrames = this.frames();
    const slot = timelineFrames[index];
    if (!slot) {
      return;
    }

    this.selectedIndex.set(index);
    this.currentLabel.set(this.formatValidAt(slot.valid_at));
    this.prefetchAround(index, timelineFrames);
    this.scheduleFrameLoad(index);
  }

  onSliderCommit(index: number): void {
    if (!Number.isFinite(index)) {
      return;
    }

    if (this.scrubTimerId !== null) {
      clearTimeout(this.scrubTimerId);
      this.scrubTimerId = null;
    }
    this.pendingScrubIndex = null;

    const timelineFrames = this.frames();
    const slot = timelineFrames[index];
    if (slot) {
      this.selectedIndex.set(index);
      this.currentLabel.set(this.formatValidAt(slot.valid_at));
    }

    this.lastFrameLoadAt = Date.now();
    void this.showFrame(index);
  }

  onOverlayApplied(imageUrl: string): void {
    this.appliedImageUrl = imageUrl;
    this.frameError.set(null);

    const expected = this.expectedImageUrlForSelection();
    if (expected !== null && expected !== imageUrl) {
      void this.showFrame(this.selectedIndex());
    }
  }

  onOverlayFailed(_imageUrl: string): void {
    this.frameError.set('Kan radarbeeld niet laden.');
  }

  async setMode(nextMode: OverlayMode): Promise<void> {
    if (nextMode === this.mode()) {
      return;
    }
    if (nextMode === 'probability' && !this.ensembleAvailable()) {
      return;
    }
    if (nextMode === 'expected' && !this.ensembleAvailable()) {
      return;
    }

    this.mode.set(nextMode);
    this.sharedBbox = null;
    this.sharedBboxImageUrl = null;
    await this.showFrame(this.selectedIndex());
  }

  togglePlay(): void {
    if (this.playing()) {
      this.stopPlay();
      return;
    }

    const timelineFrames = this.frames();
    if (timelineFrames.length <= 1) {
      return;
    }

    if (this.selectedIndex() >= timelineFrames.length - 1) {
      void this.selectFrame(0);
    }

    this.playing.set(true);
    this.playIntervalId = setInterval(() => this.advancePlayback(), PLAY_INTERVAL_MS);
  }

  private advancePlayback(): void {
    const timelineFrames = this.frames();
    const nextIndex = this.selectedIndex() + 1;
    if (nextIndex >= timelineFrames.length) {
      this.stopPlay();
      return;
    }

    void this.selectFrame(nextIndex);
  }

  private stopPlay(): void {
    if (this.playIntervalId !== null) {
      clearInterval(this.playIntervalId);
      this.playIntervalId = null;
    }
    this.playing.set(false);
  }

  private async loadTimeline(): Promise<void> {
    this.loading.set(true);
    this.timelineError.set(null);

    try {
      const timeline = await new Promise<ProbabilityTimelineResponse>((resolve, reject) => {
        this.radarService.getProbabilityTimeline().subscribe({
          next: resolve,
          error: reject,
        });
      });

      this.ensembleAvailable.set(timeline.ensemble_available);
      if (!timeline.ensemble_available) {
        this.mode.set('intensity');
      }
      this.frames.set(timeline.frames);

      if (timeline.frames.length === 0) {
        this.timelineError.set('Nog geen radargegevens geïmporteerd.');
        return;
      }

      const nowIndex = this.resolveNowIndex(timeline.frames);
      this.nowIndex.set(nowIndex);
      this.startNowIndexRefresh();
      await this.selectFrame(nowIndex);
    } catch {
      this.timelineError.set('Kan radartijdlijn niet laden.');
    } finally {
      this.loading.set(false);
    }
  }

  private resolveNowIndex(timelineFrames: TimelineSlot[]): number {
    const nowTime = Date.now();
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    timelineFrames.forEach((slot, index) => {
      const distance = Math.abs(new Date(slot.valid_at).getTime() - nowTime);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  private startNowIndexRefresh(): void {
    if (this.nowIndexIntervalId !== null) {
      clearInterval(this.nowIndexIntervalId);
    }

    this.nowIndexIntervalId = setInterval(() => {
      const frames = this.frames();
      if (frames.length === 0) {
        return;
      }
      this.nowIndex.set(this.resolveNowIndex(frames));
    }, 60_000);

    this.destroyRef.onDestroy(() => {
      if (this.nowIndexIntervalId !== null) {
        clearInterval(this.nowIndexIntervalId);
      }
    });
  }

  private async selectFrame(index: number): Promise<void> {
    this.selectedIndex.set(index);
    this.lastFrameLoadAt = Date.now();
    await this.showFrame(index);
  }

  private scheduleFrameLoad(index: number): void {
    this.pendingScrubIndex = index;
    const elapsed = Date.now() - this.lastFrameLoadAt;
    if (elapsed >= SCRUB_THROTTLE_MS) {
      this.runFrameLoad(index);
      return;
    }

    if (this.scrubTimerId !== null) {
      clearTimeout(this.scrubTimerId);
    }

    this.scrubTimerId = setTimeout(() => {
      this.scrubTimerId = null;
      if (this.pendingScrubIndex !== null) {
        this.runFrameLoad(this.pendingScrubIndex);
      }
    }, SCRUB_THROTTLE_MS - elapsed);
  }

  private runFrameLoad(index: number): void {
    if (this.scrubTimerId !== null) {
      clearTimeout(this.scrubTimerId);
      this.scrubTimerId = null;
    }
    this.pendingScrubIndex = null;
    this.lastFrameLoadAt = Date.now();
    void this.showFrame(index);
  }

  private expectedImageUrlForSelection(): string | null {
    const slot = this.frames()[this.selectedIndex()];
    if (!slot) {
      return null;
    }
    return this.sourceForMode(slot)?.image_url ?? null;
  }

  private sourceForMode(slot: TimelineSlot): FrameSource | null {
    if (this.mode() === 'intensity') {
      return slot.intensity;
    }
    if (this.mode() === 'expected') {
      if (slot.expected) {
        return slot.expected;
      }
      if (slot.kind === 'observed' && slot.intensity) {
        return slot.intensity;
      }
      return null;
    }
    if (slot.probability) {
      return slot.probability;
    }
    if (slot.kind === 'observed' && slot.intensity) {
      return slot.intensity;
    }
    return null;
  }

  private unavailableMessage(mode: OverlayMode): string {
    if (mode === 'intensity') {
      return 'Intensiteit niet beschikbaar voor dit tijdstip.';
    }
    if (mode === 'expected') {
      return 'Verwachte intensiteit niet beschikbaar voor dit tijdstip.';
    }
    return 'Kans niet beschikbaar voor dit tijdstip.';
  }

  private async showFrame(index: number): Promise<void> {
    const timelineFrames = this.frames();
    const slot = timelineFrames[index];
    if (!slot) {
      return;
    }

    this.currentLabel.set(this.formatValidAt(slot.valid_at));
    this.prefetchAround(index, timelineFrames);

    const source = this.sourceForMode(slot);
    if (!source) {
      this.frameError.set(this.unavailableMessage(this.mode()));
      this.appliedImageUrl = null;
      this.overlay.set(null);
      return;
    }

    const token = ++this.frameLoadToken;
    try {
      this.frameError.set(null);
      const canReuseBbox =
        this.sharedBbox !== null && this.sharedBboxImageUrl === source.image_url;
      const bbox = canReuseBbox
        ? this.sharedBbox!
        : source.bbox ?? await this.radarService.resolveBbox(source);
      if (token !== this.frameLoadToken) {
        return;
      }

      this.sharedBbox = bbox;
      this.sharedBboxImageUrl = source.image_url;
      this.overlay.set({ imageUrl: source.image_url, bbox });
    } catch {
      if (token === this.frameLoadToken) {
        this.frameError.set('Kan radarbeeld niet laden.');
      }
    }
  }

  private prefetchAround(
    index: number,
    timelineFrames: TimelineSlot[],
  ): void {
    for (let offset = -3; offset <= 3; offset++) {
      const neighbor = timelineFrames[index + offset];
      if (!neighbor || offset === 0) {
        continue;
      }
      const source = this.sourceForMode(neighbor);
      if (source) {
        this.radarService.prefetchFrame(source.image_url);
      }
    }
  }

  private formatValidAt(value: string): string {
    return new Intl.DateTimeFormat('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }

  private formatLocation(location: MapLocation): string {
    const lat = location.lat.toFixed(3);
    const lng = location.lng.toFixed(3);
    return `${lat}°N, ${lng}°E`;
  }

  private async loadPointSeries(location: MapLocation): Promise<void> {
    const token = ++this.pointLoadToken;
    this.pointLoading.set(true);
    this.pointError.set(null);
    this.pointSeries.set([]);

    try {
      const response = await new Promise<PointSeriesResponse>((resolve, reject) => {
        this.radarService
          .getPointSeries(
            location.lat,
            location.lng,
            CHART_WINDOW_BEFORE_HOURS,
            CHART_WINDOW_AFTER_HOURS,
          )
          .subscribe({
            next: resolve,
            error: reject,
          });
      });

      if (token !== this.pointLoadToken) {
        return;
      }

      this.pointSeries.set(response.points);
    } catch {
      if (token === this.pointLoadToken) {
        this.pointError.set('Kan regenreeks voor deze locatie niet laden.');
      }
    } finally {
      if (token === this.pointLoadToken) {
        this.pointLoading.set(false);
      }
    }
  }

  private async loadExtendedPointSeries(location: MapLocation): Promise<void> {
    const token = ++this.pointLoadToken;
    this.pointExtending.set(true);
    this.pointError.set(null);

    try {
      const response = await new Promise<PointSeriesResponse>((resolve, reject) => {
        this.radarService
          .getPointSeries(location.lat, location.lng, CHART_WINDOW_BEFORE_HOURS)
          .subscribe({
            next: resolve,
            error: reject,
          });
      });

      if (token !== this.pointLoadToken) {
        return;
      }

      this.pointSeries.set(response.points);
      this.chartExtendedWindow.set(true);
    } catch {
      // Keep the short series visible; the user can retry the extended toggle.
    } finally {
      if (token === this.pointLoadToken) {
        this.pointExtending.set(false);
      }
    }
  }

  readonly chartMaxAvailableHours = computed(() => {
    const frames = this.frames();
    const nowMs = Date.now();
    let maxProbabilityMs: number | null = null;

    for (const slot of frames) {
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

  readonly selectedValidAt = computed(() => {
    const frames = this.frames();
    const index = this.selectedIndex();
    return frames[index]?.valid_at ?? null;
  });
}
