import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-refresh-button',
  styleUrl: './refresh-button.scss',
  templateUrl: './refresh-button.html',
})
export class RefreshButton {
  readonly refreshing = input(false);
  readonly error = input<string | null>(null);

  readonly refresh = output<void>();
}
