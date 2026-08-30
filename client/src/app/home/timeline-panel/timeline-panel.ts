import { Component, computed, input, output } from '@angular/core';
import { MatSliderModule } from '@angular/material/slider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { RadarTimelineFrame } from '../../radar/radar.service';

@Component({
  imports: [MatSliderModule, MatProgressSpinnerModule],
  selector: 'app-timeline-panel',
  styleUrl: './timeline-panel.scss',
  templateUrl: './timeline-panel.html',
})
export class TimelinePanel {
  readonly loading = input(false);
  readonly timelineError = input<string | null>(null);
  readonly frameError = input<string | null>(null);
  readonly frames = input<RadarTimelineFrame[]>([]);
  readonly selectedIndex = input(0);
  readonly nowIndex = input(0);
  readonly currentLabel = input('');

  readonly indexChange = output<number>();

  readonly nowMark = computed(() => {
    const frames = this.frames();
    const nowIndex = this.nowIndex();
    const last = frames.length - 1;
    if (frames.length === 0 || nowIndex < 0 || nowIndex > last) {
      return null;
    }

    const ratio = last === 0 ? 0 : nowIndex / last;
    const tickOffsetPx = 3;
    return {
      offset: `calc(${tickOffsetPx}px + ${ratio} * (100% - ${tickOffsetPx * 2}px))`,
      edge: ratio < 0.06 ? 'start' : ratio > 0.94 ? 'end' : 'center',
    };
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
}
