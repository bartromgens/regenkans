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

  onSliderInput(index: number): void {
    this.indexChange.emit(index);
  }
}
