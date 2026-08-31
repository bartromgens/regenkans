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
import { RainChart } from './rain-chart/rain-chart';

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
  private sharedBbox: [number, number, number, number] | null = null;
  private sharedBboxImageUrl: string | null = null;

  readonly loading = signal(true);
  readonly timelineError = signal<string | null>(null);
  readonly frameError = signal<string | null>(null);
  readonly frames = signal<TimelineSlot[]>([]);
  readonly selectedIndex = signal(0);
  readonly nowIndex = signal(0);
  readonly currentLabel = signal('');
  readonly mode = signal<OverlayMode>('intensity');
  readonly ensembleAvailable = signal(false);
  readonly overlay = signal<RadarOverlay | null>(null);
  readonly selectedLocation = signal<MapLocation | null>(null);
  readonly pointSeries = signal<PointSeriesPoint[]>([]);
  readonly pointLoading = signal(false);
  readonly pointError = signal<string | null>(null);
  readonly locationLabel = signal('');

  ngOnInit(): void {
    void this.loadTimeline();
  }

  onMapClick(location: MapLocation): void {
    this.selectedLocation.set(location);
    this.locationLabel.set(this.formatLocation(location));
    void this.loadPointSeries(location);
  }

  onChartClosed(): void {
    this.selectedLocation.set(null);
    this.pointSeries.set([]);
    this.pointError.set(null);
    this.pointLoading.set(false);
    this.locationLabel.set('');
  }

  onSliderInput(index: number): void {
    if (!Number.isFinite(index) || index === this.selectedIndex()) {
      return;
    }
    void this.selectFrame(index);
  }

  async setMode(nextMode: OverlayMode): Promise<void> {
    if (nextMode === this.mode()) {
      return;
    }
    if (nextMode === 'probability' && !this.ensembleAvailable()) {
      return;
    }

    this.mode.set(nextMode);
    this.sharedBbox = null;
    this.sharedBboxImageUrl = null;
    await this.showFrame(this.selectedIndex());
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
      this.frames.set(timeline.frames);

      if (timeline.frames.length === 0) {
        this.timelineError.set('No radar data ingested yet.');
        return;
      }

      const nowIndex = this.resolveNowIndex(timeline.frames);
      this.nowIndex.set(nowIndex);
      this.startNowIndexRefresh();
      await this.selectFrame(nowIndex);
    } catch {
      this.timelineError.set('Could not load radar timeline.');
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
    await this.showFrame(index);
  }

  private sourceForMode(slot: TimelineSlot): FrameSource | null {
    if (this.mode() === 'intensity') {
      return slot.intensity;
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
    return mode === 'intensity'
      ? 'Intensity not available for this time.'
      : 'Probability not available for this time.';
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
        this.frameError.set('Could not load radar frame.');
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
          this.radarService.getPointSeries(location.lat, location.lng).subscribe({
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
        this.pointError.set('Could not load rain series for this location.');
      }
    } finally {
      if (token === this.pointLoadToken) {
        this.pointLoading.set(false);
      }
    }
  }

  readonly selectedValidAt = computed(() => {
    const frames = this.frames();
    const index = this.selectedIndex();
    return frames[index]?.valid_at ?? null;
  });
}
