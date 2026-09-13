import { Component, input, output } from '@angular/core';

/** Fills the mobile chart tab while no location has been picked yet. */
@Component({
  selector: 'app-chart-placeholder',
  styleUrl: './chart-placeholder.scss',
  templateUrl: './chart-placeholder.html',
})
export class ChartPlaceholder {
  readonly loading = input(false);
  readonly error = input<string | null>(null);

  readonly backToMap = output<void>();
}
