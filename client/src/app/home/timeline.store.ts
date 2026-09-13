import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  OverlayMode,
  ProbabilityTimelineResponse,
  RadarService,
  TimelineSlot,
} from '../radar/radar.service';
import { TrackingService } from '../tracking.service';
import { sourceForMode } from './frame-source';
import { LayoutStore } from './layout.store';
import { RadarOverlayStore } from './radar-overlay.store';
import { framesForSliderMode } from './slider-frames';

const PLAY_INTERVAL_MS = 700;
/** How often to check the backend for newer radar/forecast data. */
const TIMELINE_POLL_INTERVAL_MS = 2 * 60 * 1000;
/** How long a manual-refresh failure message stays visible. */
const REFRESH_ERROR_DISPLAY_MS = 4_000;
/** How long without timeline interaction before the view resumes following "now". */
const IDLE_RESUME_MS = 3 * 60 * 1000;

/**
 * The radar timeline behind the map: which frames exist, which one is shown,
 * and how the shown one keeps up with newly imported data.
 *
 * Getting the picture onto the map is `RadarOverlayStore`'s job; this store
 * only decides which frame that should be.
 */
@Injectable()
export class TimelineStore {
  private readonly radarService = inject(RadarService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly tracking = inject(TrackingService);
  private readonly layout = inject(LayoutStore);
  private readonly overlayStore = inject(RadarOverlayStore);
  private timelineReady = false;
  private autoplayStarted = false;
  private nowIndexIntervalId: ReturnType<typeof setInterval> | null = null;
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private refreshErrorTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private idleResumeTimerId: ReturnType<typeof setTimeout> | null = null;
  private playIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastGeneratedAt: string | null = null;
  private timelineRequestInFlight = false;
  /**
   * Whether the shown frame should keep tracking "now" as new data arrives.
   *
   * Turned off the moment the user scrubs or explicitly starts playback, so a
   * background refresh never yanks their chosen point in time away from them.
   * Mobile autoplay starting on its own does not count: it should keep
   * following "now" so its endless loop stays live.
   */
  private followingNow = true;

  readonly loading = signal(true);
  readonly timelineError = signal<string | null>(null);
  readonly refreshing = signal(false);
  readonly refreshError = signal<string | null>(null);
  readonly frames = signal<TimelineSlot[]>([]);
  readonly selectedIndex = signal(0);
  readonly nowIndex = signal(0);
  readonly currentLabel = signal('');
  readonly mode = signal<OverlayMode>('probability');
  readonly ensembleAvailable = signal(false);
  readonly knmiEnsembleUnavailable = signal(false);
  readonly playing = signal(false);

  readonly overlay = this.overlayStore.overlay;
  readonly frameError = this.overlayStore.error;
  readonly sliderFrames = computed(() => framesForSliderMode(this.frames(), this.mode()));
  readonly selectedValidAt = computed(
    () => this.sliderFrames()[this.selectedIndex()]?.valid_at ?? null,
  );

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.refreshErrorTimeoutId !== null) {
        clearTimeout(this.refreshErrorTimeoutId);
      }
      if (this.idleResumeTimerId !== null) {
        clearTimeout(this.idleResumeTimerId);
      }
      if (this.nowIndexIntervalId !== null) {
        clearInterval(this.nowIndexIntervalId);
      }
      if (this.pollIntervalId !== null) {
        clearInterval(this.pollIntervalId);
      }
      this.stopPlay();
    });
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.timelineError.set(null);

    try {
      const timeline = await this.fetchProbabilityTimeline();
      await this.applyTimeline(timeline, { isInitialLoad: true });
    } catch {
      this.timelineError.set('Kan radartijdlijn niet laden.');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Manually re-check for new data, for the refresh button.
   *
   * A no-op fetch (nothing new since the last successful load) intentionally
   * leaves the view untouched; only a genuine failure is surfaced, and only
   * briefly, since the timeline already shown is still perfectly valid.
   */
  async manualRefresh(): Promise<void> {
    if (this.timelineRequestInFlight) {
      return;
    }

    if (this.refreshErrorTimeoutId !== null) {
      clearTimeout(this.refreshErrorTimeoutId);
      this.refreshErrorTimeoutId = null;
    }
    this.refreshError.set(null);
    this.refreshing.set(true);
    this.timelineRequestInFlight = true;

    try {
      const timeline = await this.fetchProbabilityTimeline();
      if (timeline.generated_at !== this.lastGeneratedAt) {
        await this.applyTimeline(timeline, { isInitialLoad: false });
      }
    } catch {
      this.refreshError.set('Kan niet vernieuwen.');
      this.refreshErrorTimeoutId = setTimeout(() => {
        this.refreshError.set(null);
        this.refreshErrorTimeoutId = null;
      }, REFRESH_ERROR_DISPLAY_MS);
    } finally {
      this.timelineRequestInFlight = false;
      this.refreshing.set(false);
    }
  }

  /** Switch overlay mode, keeping the user on the same point in time. */
  async setMode(nextMode: OverlayMode): Promise<void> {
    if (nextMode === this.mode() || !this.modeSelectable(nextMode)) {
      return;
    }

    this.tracking.trackEvent('Map Interaction', 'Mode Change', nextMode);
    if (!this.followingNow) {
      this.scheduleIdleResume();
    }

    const currentValidAt = this.selectedValidAt();
    this.mode.set(nextMode);
    this.overlayStore.resetForModeChange();

    const nextFrames = this.sliderFrames();
    this.nowIndex.set(this.resolveNowIndex(nextFrames));
    await this.selectFrame(indexForValidAt(nextFrames, currentValidAt));
    this.warmSliderWindow();
  }

  /** The slider is being dragged: keep up, but do not fetch on every pixel. */
  onSliderInput(index: number): void {
    if (!Number.isFinite(index)) {
      return;
    }

    this.stopPlay();
    if (!this.beginManualSelection(index)) {
      return;
    }

    this.overlayStore.showThrottled(this.sliderFrames(), index, this.mode());
  }

  /** The slider was released: show the chosen frame without further delay. */
  onSliderCommit(index: number): void {
    if (!Number.isFinite(index)) {
      return;
    }

    this.beginManualSelection(index);
    this.tracking.trackEvent('Timeline Interaction', 'Scrub');
    void this.overlayStore.show(this.sliderFrames(), index, this.mode());
  }

  onOverlayApplied(imageUrl: string): void {
    this.overlayStore.markApplied();

    // The map can lag a frame behind a fast scrub; nudge it back into line.
    const expected = this.expectedImageUrlForSelection();
    if (expected !== null && expected !== imageUrl) {
      void this.showSelectedFrame();
    }
  }

  onOverlayFailed(_imageUrl: string): void {
    this.overlayStore.markFailed();
  }

  togglePlay(): void {
    this.followingNow = false;
    this.scheduleIdleResume();

    if (this.playing()) {
      this.stopPlay();
      return;
    }

    this.startPlay();
  }

  stopPlay(): void {
    if (this.playIntervalId !== null) {
      clearInterval(this.playIntervalId);
      this.playIntervalId = null;
    }
    this.playing.set(false);
  }

  /**
   * Start the animation once the timeline first loads, on both mobile and
   * desktop, so the resting state of the page is always a live animation.
   */
  maybeStartAutoplay(): void {
    if (this.autoplayStarted || !this.timelineReady) {
      return;
    }
    if (!this.layout.mapVisible() || this.sliderFrames().length <= 1) {
      return;
    }

    this.autoplayStarted = true;
    this.startPlay();
  }

  private modeSelectable(mode: OverlayMode): boolean {
    return mode === 'intensity' || this.ensembleAvailable();
  }

  /**
   * Move the selection to a frame the user picked themselves.
   *
   * Returns the slot, or `null` when the index is not one we can show, so the
   * callers can bail out after the follow-and-resume bookkeeping is done.
   */
  private beginManualSelection(index: number): TimelineSlot | null {
    this.followingNow = false;
    this.scheduleIdleResume();

    const slot = this.sliderFrames()[index];
    if (!slot) {
      return null;
    }

    this.selectedIndex.set(index);
    this.currentLabel.set(formatValidAt(slot.valid_at));
    return slot;
  }

  /**
   * Reset the shown frame to a live, looping animation.
   *
   * Called once `IDLE_RESUME_MS` has passed without timeline interaction, so
   * a scrub or an explicit pause does not permanently strand the view away
   * from "now".
   */
  private resumeLiveView(): void {
    this.followingNow = true;

    const frames = this.sliderFrames();
    if (frames.length === 0) {
      return;
    }

    const nowIndex = this.resolveNowIndex(frames);
    this.nowIndex.set(nowIndex);
    void this.selectFrame(nowIndex);

    if (!this.playing() && this.layout.mapVisible()) {
      this.startPlay();
    }
  }

  private scheduleIdleResume(): void {
    if (this.idleResumeTimerId !== null) {
      clearTimeout(this.idleResumeTimerId);
    }
    this.idleResumeTimerId = setTimeout(() => {
      this.idleResumeTimerId = null;
      this.resumeLiveView();
    }, IDLE_RESUME_MS);
  }

  private startPlay(): void {
    const timelineFrames = this.sliderFrames();
    if (timelineFrames.length <= 1 || this.playing()) {
      return;
    }

    if (this.selectedIndex() >= timelineFrames.length - 1) {
      void this.selectFrame(this.followingNow ? this.nowIndex() : 0);
    }

    this.playing.set(true);
    this.playIntervalId = setInterval(() => this.advancePlayback(), PLAY_INTERVAL_MS);
  }

  private advancePlayback(): void {
    const timelineFrames = this.sliderFrames();
    const nextIndex = this.selectedIndex() + 1;
    if (nextIndex >= timelineFrames.length) {
      // Following "now" is the resting state, so it loops back and keeps
      // playing; a manually started playthrough just stops at the end.
      if (this.followingNow) {
        void this.selectFrame(this.nowIndex());
        return;
      }
      this.stopPlay();
      return;
    }

    void this.selectFrame(nextIndex);
  }

  private fetchProbabilityTimeline(): Promise<ProbabilityTimelineResponse> {
    return new Promise((resolve, reject) => {
      this.radarService.getProbabilityTimeline().subscribe({
        next: resolve,
        error: reject,
      });
    });
  }

  /**
   * Background check for newer data, on `TIMELINE_POLL_INTERVAL_MS`.
   *
   * Skipped while a scrub is being throttled so it never fights an in-flight
   * drag; silently retried on the next tick on failure, since this runs
   * unattended and a transient network blip is not worth surfacing.
   */
  private async pollTimeline(): Promise<void> {
    if (this.timelineRequestInFlight || this.overlayStore.scrubPending()) {
      return;
    }

    this.timelineRequestInFlight = true;
    try {
      const timeline = await this.fetchProbabilityTimeline();
      if (timeline.generated_at === this.lastGeneratedAt) {
        return;
      }
      await this.applyTimeline(timeline, { isInitialLoad: false });
    } catch {
      // Keep showing the current data; the next tick will try again.
    } finally {
      this.timelineRequestInFlight = false;
    }
  }

  private startPolling(): void {
    if (this.pollIntervalId !== null) {
      return;
    }

    this.pollIntervalId = setInterval(() => void this.pollTimeline(), TIMELINE_POLL_INTERVAL_MS);
  }

  /**
   * Apply a fetched timeline, for both the initial load and later refreshes.
   *
   * When still `followingNow`, the shown frame jumps to the new "now" so a
   * left-open tab keeps showing live data; otherwise the user's selected
   * point in time is preserved by `valid_at` even though the window shifted.
   */
  private async applyTimeline(
    timeline: ProbabilityTimelineResponse,
    options: { isInitialLoad: boolean },
  ): Promise<void> {
    this.lastGeneratedAt = timeline.generated_at;
    this.ensembleAvailable.set(timeline.ensemble_available);
    this.knmiEnsembleUnavailable.set(Boolean(timeline.knmi_ensemble_unavailable));
    if (!timeline.ensemble_available && options.isInitialLoad) {
      this.mode.set('intensity');
    }

    const previousValidAt = this.selectedValidAt();
    this.frames.set(timeline.frames);

    if (timeline.frames.length === 0) {
      this.timelineError.set('Nog geen radargegevens geïmporteerd.');
      return;
    }
    this.timelineError.set(null);

    const nextFrames = this.sliderFrames();
    const nowIndex = this.resolveNowIndex(nextFrames);
    this.nowIndex.set(nowIndex);

    const targetIndex =
      options.isInitialLoad || this.followingNow
        ? nowIndex
        : indexForValidAt(nextFrames, previousValidAt);
    await this.selectFrame(targetIndex);
    this.warmSliderWindow();

    if (options.isInitialLoad) {
      this.startNowIndexRefresh();
      this.startPolling();
      this.timelineReady = true;
      this.maybeStartAutoplay();
    }
  }

  private resolveNowIndex(timelineFrames: TimelineSlot[]): number {
    const nowTime = Date.now();
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    timelineFrames.forEach((slot, index) => {
      const distance = Math.abs(new Date(slot.valid_at).getTime() - nowTime);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  private startNowIndexRefresh(): void {
    if (this.nowIndexIntervalId !== null) {
      clearInterval(this.nowIndexIntervalId);
    }

    this.nowIndexIntervalId = setInterval(() => {
      const frames = this.sliderFrames();
      if (frames.length === 0) {
        return;
      }
      this.nowIndex.set(this.resolveNowIndex(frames));
    }, 60_000);
  }

  private async selectFrame(index: number): Promise<void> {
    this.selectedIndex.set(index);
    await this.showSelectedFrame();
  }

  private async showSelectedFrame(): Promise<void> {
    const timelineFrames = this.sliderFrames();
    const index = this.selectedIndex();
    const slot = timelineFrames[index];
    if (!slot) {
      return;
    }

    this.currentLabel.set(formatValidAt(slot.valid_at));
    await this.overlayStore.show(timelineFrames, index, this.mode());
  }

  private expectedImageUrlForSelection(): string | null {
    const slot = this.sliderFrames()[this.selectedIndex()];
    if (!slot) {
      return null;
    }
    return sourceForMode(slot, this.mode())?.image_url ?? null;
  }

  private warmSliderWindow(): void {
    this.overlayStore.scheduleWindowWarmUp(this.sliderFrames(), this.selectedIndex(), this.mode());
  }
}

function formatValidAt(value: string): string {
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

/** The frame at `validAt`, or the last one before it once the window shifts. */
function indexForValidAt(frames: TimelineSlot[], validAt: string | null): number {
  if (frames.length === 0 || validAt === null) {
    return 0;
  }

  const exact = frames.findIndex((slot) => slot.valid_at === validAt);
  if (exact >= 0) {
    return exact;
  }

  const targetMs = new Date(validAt).getTime();
  let bestIndex = 0;
  for (let index = 0; index < frames.length; index++) {
    if (new Date(frames[index].valid_at).getTime() <= targetMs) {
      bestIndex = index;
    }
  }
  return bestIndex;
}
