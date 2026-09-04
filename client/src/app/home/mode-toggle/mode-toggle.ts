import { Component, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { OverlayMode } from '../../radar/radar.service';

@Component({
  selector: 'app-mode-toggle',
  imports: [MatIconModule],
  styleUrl: './mode-toggle.scss',
  templateUrl: './mode-toggle.html',
})
export class ModeToggle {
  readonly mode = input.required<OverlayMode>();
  readonly ensembleAvailable = input(false);

  readonly modeChange = output<OverlayMode>();

  readonly showInfo = signal(false);

  selectMode(nextMode: OverlayMode): void {
    if (
      (nextMode === 'probability' || nextMode === 'expected') &&
      !this.ensembleAvailable()
    ) {
      return;
    }
    this.modeChange.emit(nextMode);
  }

  toggleInfo(): void {
    this.showInfo.update((value) => !value);
  }
}
