import { Component, input, output } from '@angular/core';

export type MobileTab = 'map' | 'chart';

@Component({
  selector: 'app-mobile-tabs',
  styleUrl: './mobile-tabs.scss',
  templateUrl: './mobile-tabs.html',
})
export class MobileTabs {
  readonly activeTab = input.required<MobileTab>();
  readonly chartNeedsAttention = input(false);

  readonly tabChange = output<MobileTab>();
}
