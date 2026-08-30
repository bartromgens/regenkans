import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { MatSliderModule } from '@angular/material/slider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import * as maplibregl from 'maplibre-gl';
import {
  OverlayMode,
  ProbabilityTimelineResponse,
  RadarService,
  RadarTimelineFrame,
  RadarTimelineResponse,
} from '../radar/radar.service';

const OVERLAY_SOURCE_ID = 'radar-overlay';
const OVERLAY_LAYER_ID = 'radar-overlay-layer';

@Component({
  imports: [MatSliderModule, MatProgressSpinnerModule],
  selector: 'app-home',
  styleUrl: './home.scss',
  templateUrl: './home.html',
})
export class Home implements OnInit, OnDestroy {
  @ViewChild('mapContainer', { static: true })
  mapContainer!: ElementRef<HTMLDivElement>;

  private readonly radarService = inject(RadarService);
  private map: maplibregl.Map | null = null;
  private intensityFrames: RadarTimelineFrame[] = [];
  private probabilityFrames: RadarTimelineFrame[] = [];
  private intensityNow: string | null = null;
  private probabilityNow: string | null = null;
  private frameLoadToken = 0;
  private sharedBbox: [number, number, number, number] | null = null;
  private sharedBboxOverlay: OverlayMode | null = null;

  readonly loading = signal(true);
  readonly timelineError = signal<string | null>(null);
  readonly frameError = signal<string | null>(null);
  readonly frames = signal<RadarTimelineFrame[]>([]);
  readonly selectedIndex = signal(0);
  readonly nowIndex = signal(0);
  readonly currentLabel = signal('');
  readonly mode = signal<OverlayMode>('intensity');
  readonly ensembleAvailable = signal(false);

  ngOnInit(): void {
    this.initMap();
    void this.loadTimelines();
  }

  ngOnDestroy(): void {
    this.map?.remove();
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
    this.sharedBboxOverlay = null;

    const timelineFrames = nextMode === 'intensity'
      ? this.intensityFrames
      : this.probabilityFrames;
    this.frames.set(timelineFrames);

    if (timelineFrames.length === 0) {
      this.timelineError.set(
        nextMode === 'probability'
          ? 'No ensemble forecast ingested yet.'
          : 'No radar data ingested yet.',
      );
      return;
    }

    this.timelineError.set(null);
    const now = nextMode === 'intensity' ? this.intensityNow : this.probabilityNow;
    const nowIndex = this.resolveNowIndex(timelineFrames, now);
    this.nowIndex.set(nowIndex);
    await this.selectFrame(nowIndex);
  }

  formatValidAt(value: string): string {
    return new Intl.DateTimeFormat('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }

  private initMap(): void {
    this.map = new maplibregl.Map({
      container: this.mapContainer.nativeElement,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [5.3, 52.2],
      zoom: 7,
    });

    this.map.addControl(new maplibregl.NavigationControl(), 'top-right');
  }

  private async loadTimelines(): Promise<void> {
    this.loading.set(true);
    this.timelineError.set(null);

    try {
      const intensityTimeline = await new Promise<RadarTimelineResponse>((resolve, reject) => {
        this.radarService.getTimeline().subscribe({
          next: resolve,
          error: reject,
        });
      });
      const probabilityTimeline = await new Promise<ProbabilityTimelineResponse>(
        (resolve, reject) => {
          this.radarService.getProbabilityTimeline().subscribe({
            next: resolve,
            error: reject,
          });
        },
      );

      this.intensityFrames = intensityTimeline.frames;
      this.probabilityFrames = probabilityTimeline.frames;
      this.intensityNow = intensityTimeline.now;
      this.probabilityNow = probabilityTimeline.now;
      this.ensembleAvailable.set(probabilityTimeline.ensemble_available);

      const timelineFrames = this.intensityFrames;
      this.frames.set(timelineFrames);

      if (timelineFrames.length === 0) {
        this.timelineError.set('No radar data ingested yet.');
        return;
      }

      const nowIndex = this.resolveNowIndex(timelineFrames, this.intensityNow);
      this.nowIndex.set(nowIndex);
      await this.selectFrame(nowIndex);
    } catch {
      this.timelineError.set('Could not load radar timeline.');
    } finally {
      this.loading.set(false);
    }
  }

  private resolveNowIndex(
    timelineFrames: RadarTimelineFrame[],
    now: string | null,
  ): number {
    if (!now) {
      return timelineFrames.findIndex((frame) => frame.lead_minutes === 0);
    }

    const nowTime = new Date(now).getTime();
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    timelineFrames.forEach((frame, index) => {
      if (frame.lead_minutes !== 0) {
        return;
      }
      const distance = Math.abs(new Date(frame.issued_at).getTime() - nowTime);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  private async selectFrame(index: number): Promise<void> {
    this.selectedIndex.set(index);
    await this.showFrame(index);
  }

  private async showFrame(index: number): Promise<void> {
    const timelineFrames = this.frames();
    const frame = timelineFrames[index];
    if (!frame || !this.map) {
      return;
    }

    await this.waitForMapReady();

    this.currentLabel.set(this.formatValidAt(frame.valid_at));
    this.prefetchAround(index, timelineFrames);

    const token = ++this.frameLoadToken;
    try {
      this.frameError.set(null);
      const canReuseBbox =
        this.sharedBbox !== null && this.sharedBboxOverlay === frame.overlay;
      const bbox = canReuseBbox
        ? this.sharedBbox!
        : frame.bbox ?? await this.radarService.resolveBbox(frame);
      if (token !== this.frameLoadToken) {
        return;
      }

      this.sharedBbox = bbox;
      this.sharedBboxOverlay = frame.overlay;
      this.updateOverlay(frame.image_url, bbox);
    } catch {
      if (token === this.frameLoadToken) {
        this.frameError.set('Could not load radar frame.');
      }
    }
  }

  private prefetchAround(
    index: number,
    timelineFrames: RadarTimelineFrame[],
  ): void {
    for (let offset = -3; offset <= 3; offset++) {
      const neighbor = timelineFrames[index + offset];
      if (neighbor && offset !== 0) {
        this.radarService.prefetchFrame(neighbor.image_url);
      }
    }
  }

  private updateOverlay(
    imageUrl: string,
    bbox: [number, number, number, number],
  ): void {
    if (!this.map) {
      return;
    }

    const [west, south, east, north] = bbox;
    const coordinates: [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ] = [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ];

    const existingSource = this.map.getSource(OVERLAY_SOURCE_ID) as
      | maplibregl.ImageSource
      | undefined;

    if (existingSource) {
      existingSource.updateImage({ url: imageUrl, coordinates });
      return;
    }

    this.map.addSource(OVERLAY_SOURCE_ID, {
      type: 'image',
      url: imageUrl,
      coordinates,
    });

    this.map.addLayer({
      id: OVERLAY_LAYER_ID,
      type: 'raster',
      source: OVERLAY_SOURCE_ID,
      paint: {
        'raster-opacity': 0.85,
      },
    });
  }

  private waitForMapReady(): Promise<void> {
    if (!this.map) {
      return Promise.resolve();
    }
    if (this.map.isStyleLoaded()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.map?.once('load', () => resolve());
    });
  }
}
