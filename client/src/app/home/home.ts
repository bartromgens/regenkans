import {
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import {
  FrameSource,
  OverlayMode,
  ProbabilityTimelineResponse,
  RadarService,
  TimelineSlot,
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
  private timelineNow: string | null = null;
  private frameLoadToken = 0;
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

  ngOnInit(): void {
    void this.loadTimeline();
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

      this.timelineNow = timeline.now;
      this.ensembleAvailable.set(timeline.ensemble_available);
      this.frames.set(timeline.frames);

      if (timeline.frames.length === 0) {
        this.timelineError.set('No radar data ingested yet.');
        return;
      }

      const nowIndex = this.resolveNowIndex(timeline.frames, timeline.now);
      this.nowIndex.set(nowIndex);
      await this.selectFrame(nowIndex);
    } catch {
      this.timelineError.set('Could not load radar timeline.');
    } finally {
      this.loading.set(false);
    }
  }

  private resolveNowIndex(
    timelineFrames: TimelineSlot[],
    now: string | null,
  ): number {
    if (!now) {
      return timelineFrames.findIndex(
        (slot) => slot.intensity?.lead_minutes === 0,
      );
    }

    const nowTime = new Date(now).getTime();
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    timelineFrames.forEach((slot, index) => {
      const intensity = slot.intensity;
      if (!intensity || intensity.lead_minutes !== 0) {
        return;
      }
      const distance = Math.abs(new Date(intensity.issued_at).getTime() - nowTime);
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

  private sourceForMode(slot: TimelineSlot): FrameSource | null {
    return this.mode() === 'intensity' ? slot.intensity : slot.probability;
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
    const mode = this.mode();
    for (let offset = -3; offset <= 3; offset++) {
      const neighbor = timelineFrames[index + offset];
      if (!neighbor || offset === 0) {
        continue;
      }
      const source = mode === 'intensity' ? neighbor.intensity : neighbor.probability;
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
}
