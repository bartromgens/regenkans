import {
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import {
  OverlayMode,
  ProbabilityTimelineResponse,
  RadarService,
  RadarTimelineFrame,
  RadarTimelineResponse,
} from '../radar/radar.service';
import { ModeToggle } from './mode-toggle/mode-toggle';
import { MapLegend } from './map-legend/map-legend';
import { TimelinePanel } from './timeline-panel/timeline-panel';
import { RadarMap, RadarOverlay } from './radar-map/radar-map';

@Component({
  imports: [ModeToggle, MapLegend, TimelinePanel, RadarMap],
  selector: 'app-home',
  styleUrl: './home.scss',
  templateUrl: './home.html',
})
export class Home implements OnInit {
  private readonly radarService = inject(RadarService);
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
  readonly overlay = signal<RadarOverlay | null>(null);

  ngOnInit(): void {
    void this.loadTimelines();
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
    if (!frame) {
      return;
    }

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
      this.overlay.set({ imageUrl: frame.image_url, bbox });
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
}
