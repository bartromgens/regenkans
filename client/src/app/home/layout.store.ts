import { BreakpointObserver } from '@angular/cdk/layout';
import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { MobileTab } from './mobile-tabs/mobile-tabs';

const MOBILE_BREAKPOINT = '(max-width: 640px)';

/**
 * Which of the two panes the user is looking at.
 *
 * Desktop shows both at once; mobile shows one at a time behind a tab bar, so
 * "is the map on screen" is a question the rest of the page keeps asking.
 */
@Injectable()
export class LayoutStore {
  private readonly breakpointObserver = inject(BreakpointObserver);

  readonly isMobile = toSignal(
    this.breakpointObserver.observe(MOBILE_BREAKPOINT).pipe(map((result) => result.matches)),
    { initialValue: false },
  );
  readonly mobileTab = signal<MobileTab>('map');
  readonly chartTabNeedsAttention = signal(false);

  /** Whether each pane is on screen; on desktop both always are. */
  readonly mapVisible = computed(() => !this.isMobile() || this.mobileTab() === 'map');
  readonly chartVisible = computed(() => !this.isMobile() || this.mobileTab() === 'chart');
}
