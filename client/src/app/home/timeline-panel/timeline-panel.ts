import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatSliderModule } from '@angular/material/slider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TimelineSlot } from '../../radar/radar.service';

interface NowMark {
  edge: 'start' | 'end' | 'middle';
  offset: string;
}

interface SliderTrack {
  left: number;
  width: number;
}

/** Material slider thumb/tick inset from the host edge (`_tickMarkOffset`). */
const SLIDER_TRACK_INSET_PX = 3;

@Component({
  imports: [MatSliderModule, MatProgressSpinnerModule],
  selector: 'app-timeline-panel',
  styleUrl: './timeline-panel.scss',
  templateUrl: './timeline-panel.html',
})
export class TimelinePanel {
  private readonly destroyRef = inject(DestroyRef);
  private readonly sliderWrap = viewChild<ElementRef<HTMLElement>>('sliderWrap');
  private readonly clockMs = signal(Date.now());
  private readonly track = signal<SliderTrack | null>(null);
  private resizeObserver: ResizeObserver | null = null;
  private observedSlider: HTMLElement | null = null;

  readonly loading = input(false);
  readonly timelineError = input<string | null>(null);
  readonly frameError = input<string | null>(null);
  readonly frames = input<TimelineSlot[]>([]);
  readonly selectedIndex = input(0);
  readonly nowIndex = input(0);
  readonly currentLabel = input('');

  readonly indexChange = output<number>();
  readonly indexCommit = output<number>();

  constructor() {
    afterRenderEffect(() => {
      this.loading();
      this.timelineError();
      this.frames();
      untracked(() => this.bindSliderTrack());
    });

    const intervalId = window.setInterval(() => this.clockMs.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => {
      window.clearInterval(intervalId);
      this.resizeObserver?.disconnect();
    });
  }

  readonly nowMark = computed((): NowMark | null => {
    const frames = this.frames();
    const track = this.track();
    const nowMs = this.clockMs();
    this.nowIndex();

    if (frames.length <= 1 || track === null || track.width <= 0) {
      return null;
    }

    const fraction = fractionalNowIndex(frames, nowMs);
    const ratio = fraction / (frames.length - 1);
    const offsetPx = track.left + ratio * track.width;

    if (ratio <= 0) {
      return { edge: 'start', offset: `${track.left}px` };
    }
    if (ratio >= 1) {
      return { edge: 'end', offset: `${track.left + track.width}px` };
    }
    return { edge: 'middle', offset: `${offsetPx}px` };
  });

  readonly displayWith = (index: number): string => {
    const frame = this.frames()[index];
    if (!frame) {
      return '';
    }

    return new Intl.DateTimeFormat('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(frame.valid_at));
  };

  onSliderInput(index: number): void {
    this.indexChange.emit(index);
  }

  onSliderCommit(index: number): void {
    this.indexCommit.emit(index);
  }

  private bindSliderTrack(): void {
    const wrap = this.sliderWrap()?.nativeElement;
    const slider = wrap?.querySelector<HTMLElement>('mat-slider') ?? null;
    if (!wrap || !slider) {
      this.track.set(null);
      this.resizeObserver?.disconnect();
      this.observedSlider = null;
      return;
    }

    if (this.observedSlider !== slider) {
      this.resizeObserver?.disconnect();
      this.observedSlider = slider;
      this.resizeObserver = new ResizeObserver(() => this.measureTrack(wrap, slider));
      this.resizeObserver.observe(slider);
      this.resizeObserver.observe(wrap);
    }

    this.measureTrack(wrap, slider);
  }

  private measureTrack(wrap: HTMLElement, slider: HTMLElement): void {
    const wrapRect = wrap.getBoundingClientRect();
    const sliderRect = slider.getBoundingClientRect();
    this.track.set({
      left: sliderRect.left - wrapRect.left + SLIDER_TRACK_INSET_PX,
      width: Math.max(0, sliderRect.width - SLIDER_TRACK_INSET_PX * 2),
    });
  }
}

function fractionalNowIndex(frames: TimelineSlot[], nowMs: number): number {
  const last = frames.length - 1;
  const firstMs = new Date(frames[0].valid_at).getTime();
  const lastMs = new Date(frames[last].valid_at).getTime();

  if (nowMs <= firstMs) {
    return 0;
  }
  if (nowMs >= lastMs) {
    return last;
  }

  for (let index = 0; index < last; index++) {
    const startMs = new Date(frames[index].valid_at).getTime();
    const endMs = new Date(frames[index + 1].valid_at).getTime();
    if (nowMs < startMs || nowMs > endMs) {
      continue;
    }
    if (endMs === startMs) {
      return index;
    }
    return index + (nowMs - startMs) / (endMs - startMs);
  }

  return last;
}
