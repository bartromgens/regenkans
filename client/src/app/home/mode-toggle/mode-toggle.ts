import { Component, input, output } from '@angular/core';
import { OverlayMode } from '../../radar/radar.service';

@Component({
  selector: 'app-mode-toggle',
  styleUrl: './mode-toggle.scss',
  templateUrl: './mode-toggle.html',
})
export class ModeToggle {
  readonly mode = input.required<OverlayMode>();
  readonly ensembleAvailable = input(false);

  readonly modeChange = output<OverlayMode>();

  selectMode(nextMode: OverlayMode): void {
    if (nextMode === 'probability' && !this.ensembleAvailable()) {
      return;
    }
    this.modeChange.emit(nextMode);
  }
}
