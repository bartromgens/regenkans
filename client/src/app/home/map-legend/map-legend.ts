import { Component, input } from '@angular/core';
import { OverlayMode } from '../../radar/radar.service';

@Component({
  selector: 'app-map-legend',
  styleUrl: './map-legend.scss',
  templateUrl: './map-legend.html',
})
export class MapLegend {
  readonly mode = input.required<OverlayMode>();
}
