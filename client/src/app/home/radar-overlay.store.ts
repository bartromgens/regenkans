import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { OverlayMode, RadarService, TimelineSlot } from '../radar/radar.service';
import { sourceForMode, unavailableMessage } from './frame-source';
import { RadarOverlay } from './radar-map/radar-map';

const SCRUB_THROTTLE_MS = 150;
/** Latest the warm-up may start once the browser reports itself idle. */
const WARM_UP_IDLE_TIMEOUT_MS = 2_000;
/** Warm-up delay where `requestIdleCallback` is missing, as on Safari. */
const WARM_UP_FALLBACK_DELAY_MS = 1_000;

/**
 * Turns "show me frame N in mode M" into the image layer on the map.
 *
 * Handles everything between that request and the picture: resolving the
 * source, its bounding box, throttling a drag down to something the network
 * can keep up with, and prefetching what the user is about to reach.
 */
@Injectable()
export class RadarOverlayStore {
  private readonly radarService = inject(RadarService);
  private readonly destroyRef = inject(DestroyRef);
  private loadToken = 0;
  private scrubTimerId: ReturnType<typeof setTimeout> | null = null;
  private pendingScrub: { frames: TimelineSlot[]; index: number; mode: OverlayMode } | null = null;
  private lastLoadAt = 0;
  private sharedBbox: [number, number, number, number] | null = null;
  private sharedBboxImageUrl: string | null = null;

  readonly overlay = signal<RadarOverlay | null>(null);
  readonly error = signal<string | null>(null);

  constructor() {
    this.destroyRef.onDestroy(() => this.cancelPendingScrub());
  }

  /** Whether a throttled scrub load is still waiting to fire. */
  scrubPending(): boolean {
    return this.scrubTimerId !== null;
  }

  /** Show a frame right away, dropping any throttled load still pending. */
  async show(frames: TimelineSlot[], index: number, mode: OverlayMode): Promise<void> {
    this.cancelPendingScrub();
    this.lastLoadAt = Date.now();

    const slot = frames[index];
    if (!slot) {
      return;
    }

    this.prefetchAround(frames, index, mode);

    const source = sourceForMode(slot, mode);
    if (!source) {
      this.error.set(unavailableMessage(mode));
      this.overlay.set(null);
      return;
    }

    const token = ++this.loadToken;
    try {
      this.error.set(null);
      const canReuseBbox = this.sharedBbox !== null && this.sharedBboxImageUrl === source.image_url;
      const bbox = canReuseBbox
        ? this.sharedBbox!
        : (source.bbox ?? (await this.radarService.resolveBbox(source)));
      if (token !== this.loadToken) {
        return;
      }

      this.sharedBbox = bbox;
      this.sharedBboxImageUrl = source.image_url;
      this.overlay.set({ imageUrl: source.image_url, bbox });
    } catch {
      if (token === this.loadToken) {
        this.error.set('Kan radarbeeld niet laden.');
      }
    }
  }

  /**
   * Show a frame the user is dragging towards, at most once per
   * `SCRUB_THROTTLE_MS`; neighbours are prefetched without waiting.
   */
  showThrottled(frames: TimelineSlot[], index: number, mode: OverlayMode): void {
    this.prefetchAround(frames, index, mode);

    const elapsed = Date.now() - this.lastLoadAt;
    if (elapsed >= SCRUB_THROTTLE_MS) {
      void this.show(frames, index, mode);
      return;
    }

    if (this.scrubTimerId !== null) {
      clearTimeout(this.scrubTimerId);
    }

    this.pendingScrub = { frames, index, mode };
    this.scrubTimerId = setTimeout(() => {
      this.scrubTimerId = null;
      const pending = this.pendingScrub;
      if (pending) {
        void this.show(pending.frames, pending.index, pending.mode);
      }
    }, SCRUB_THROTTLE_MS - elapsed);
  }

  /** The map reports the image it actually put up. */
  markApplied(): void {
    this.error.set(null);
  }

  markFailed(): void {
    this.error.set('Kan radarbeeld niet laden.');
  }

  /** The images differ per mode, so nothing about the old one carries over. */
  resetForModeChange(): void {
    this.sharedBbox = null;
    this.sharedBboxImageUrl = null;
    // Whatever is still queued belongs to the mode being left behind.
    this.radarService.cancelQueuedPrefetches();
  }

  /**
   * Warm every frame of the slider window once the map has something to show.
   *
   * Dragging the slider then hits the browser cache instead of the network.
   * It waits for idle time so it never competes with the first frame or the
   * basemap tiles, and the service caps how many run at once.
   */
  scheduleWindowWarmUp(frames: TimelineSlot[], index: number, mode: OverlayMode): void {
    runWhenIdle(() => {
      const imageUrls: string[] = [];

      // Expand outward from the selected frame so the frames the user is most
      // likely to reach next are the first ones to arrive.
      for (let offset = 1; offset < frames.length; offset++) {
        for (const neighborIndex of [index + offset, index - offset]) {
          const neighbor = frames[neighborIndex];
          const source = neighbor ? sourceForMode(neighbor, mode) : null;
          if (source) {
            imageUrls.push(source.image_url);
          }
        }
      }

      this.radarService.warmFrames(imageUrls);
    });
  }

  private prefetchAround(frames: TimelineSlot[], index: number, mode: OverlayMode): void {
    for (let offset = -3; offset <= 3; offset++) {
      const neighbor = frames[index + offset];
      if (!neighbor || offset === 0) {
        continue;
      }
      const source = sourceForMode(neighbor, mode);
      if (source) {
        this.radarService.prefetchFrame(source.image_url);
      }
    }
  }

  private cancelPendingScrub(): void {
    if (this.scrubTimerId !== null) {
      clearTimeout(this.scrubTimerId);
      this.scrubTimerId = null;
    }
    this.pendingScrub = null;
  }
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};

function runWhenIdle(callback: () => void): void {
  const idleWindow = window as IdleWindow;
  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(callback, { timeout: WARM_UP_IDLE_TIMEOUT_MS });
    return;
  }

  setTimeout(callback, WARM_UP_FALLBACK_DELAY_MS);
}
