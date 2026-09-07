import { Component, computed, input } from '@angular/core';
import { OverlayMode } from '../../radar/radar.service';

@Component({
  selector: 'app-map-legend',
  styleUrl: './map-legend.scss',
  templateUrl: './map-legend.html',
})
export class MapLegend {
  readonly mode = input.required<OverlayMode>();

  readonly legendLabel = computed(() => {
    switch (this.mode()) {
      case 'probability':
        return 'Regenkans in procent';
      case 'expected':
        return 'Verwachte intensiteit in millimeter per uur';
      default:
        return 'Regenintensiteit in millimeter per uur';
    }
  });
}
