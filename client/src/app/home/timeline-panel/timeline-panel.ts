import { Component, computed, input, output } from '@angular/core';
import { MatSliderModule } from '@angular/material/slider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TimelineSlot } from '../../radar/radar.service';

interface NowMark {
  edge: 'start' | 'end' | 'middle';
  offset: string;
}

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
  readonly frames = input<TimelineSlot[]>([]);
  readonly selectedIndex = input(0);
  readonly nowIndex = input(0);
  readonly currentLabel = input('');

  readonly indexChange = output<number>();

  readonly nowMark = computed((): NowMark | null => {
    const frameCount = this.frames().length;
    const nowIndex = this.nowIndex();
    if (frameCount <= 1 || nowIndex < 0) {
      return null;
    }

    const ratio = nowIndex / (frameCount - 1);
    if (ratio <= 0) {
      return { edge: 'start', offset: '0%' };
    }
    if (ratio >= 1) {
      return { edge: 'end', offset: '100%' };
    }
    return { edge: 'middle', offset: `${ratio * 100}%` };
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
