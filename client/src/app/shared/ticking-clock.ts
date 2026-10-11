import { DestroyRef, inject, signal, Signal } from '@angular/core';

export function injectTickingClock(intervalMs: number): Signal<number> {
  const destroyRef = inject(DestroyRef);
  const clockMs = signal(Date.now());
  const intervalId = window.setInterval(() => clockMs.set(Date.now()), intervalMs);
  destroyRef.onDestroy(() => window.clearInterval(intervalId));
  return clockMs;
}
