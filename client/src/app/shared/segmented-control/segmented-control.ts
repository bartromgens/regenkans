import { Component, input, output } from '@angular/core';

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
  busy?: boolean;
}

@Component({
  selector: 'app-segmented-control',
  styleUrl: './segmented-control.scss',
  templateUrl: './segmented-control.html',
})
export class SegmentedControl<T extends string = string> {
  readonly options = input.required<SegmentedOption<T>[]>();
  readonly value = input.required<T>();
  readonly size = input<'default' | 'compact'>('default');

  readonly valueChange = output<T>();

  select(option: SegmentedOption<T>): void {
    if (option.disabled || option.value === this.value()) {
      return;
    }
    this.valueChange.emit(option.value);
  }
}
