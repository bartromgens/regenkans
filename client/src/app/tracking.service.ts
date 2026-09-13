import { Injectable, inject } from '@angular/core';
import { MatomoTracker } from 'ngx-matomo-client';

@Injectable({ providedIn: 'root' })
export class TrackingService {
  private readonly tracker = inject(MatomoTracker, { optional: true });

  trackEvent(category: string, action: string, name?: string, value?: number): void {
    this.tracker?.trackEvent(category, action, name, value);
  }
}
