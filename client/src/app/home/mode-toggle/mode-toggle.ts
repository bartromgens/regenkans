import { Component, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { OverlayMode, requiresEnsemble } from '../../radar/radar.service';
import {
  SegmentedControl,
  SegmentedOption,
} from '../../shared/segmented-control/segmented-control';

@Component({
  selector: 'app-mode-toggle',
  imports: [MatIconModule, SegmentedControl],
  styleUrl: './mode-toggle.scss',
  templateUrl: './mode-toggle.html',
})
export class ModeToggle {
  readonly mode = input.required<OverlayMode>();
  readonly ensembleAvailable = input(false);
  readonly knmiEnsembleUnavailable = input(false);

  readonly modeChange = output<OverlayMode>();

  readonly showInfo = signal(false);

  readonly modeOptions = computed((): SegmentedOption<OverlayMode>[] => {
    const ensemble = this.ensembleAvailable();
    return [
      { value: 'intensity', label: 'Radar' },
      { value: 'probability', label: 'Kans', disabled: !ensemble },
      { value: 'expected', label: 'Gemiddelde', disabled: !ensemble },
    ];
  });

  selectMode(nextMode: OverlayMode): void {
    if (requiresEnsemble(nextMode) && !this.ensembleAvailable()) {
      return;
    }
    this.modeChange.emit(nextMode);
  }

  toggleInfo(): void {
    this.showInfo.update((value) => !value);
  }
}
