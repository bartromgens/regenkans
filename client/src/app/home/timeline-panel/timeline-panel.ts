import { Component, input, output } from '@angular/core';
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
