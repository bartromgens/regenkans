import { BreakpointObserver } from '@angular/cdk/layout';
import {
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import {
  FrameSource,
  OverlayMode,
  PointSeriesPoint,
  PointSeriesResponse,
  ProbabilityTimelineResponse,
  RadarService,
  TimelineSlot,
} from '../radar/radar.service';
import { ModeToggle } from './mode-toggle/mode-toggle';
import { MapLegend } from './map-legend/map-legend';
import { TimelinePanel } from './timeline-panel/timeline-panel';
import { MapLocation, RadarMap, RadarOverlay } from './radar-map/radar-map';
import {
  CHART_WINDOW_AFTER_HOURS,
  CHART_WINDOW_BEFORE_HOURS,
  RainChart,
} from './rain-chart/rain-chart';
import { framesForSliderMode } from './slider-frames';
import { TrackingService } from '../tracking.service';

const SCRUB_THROTTLE_MS = 150;
const PLAY_INTERVAL_MS = 700;
const HOUR_MS = 60 * 60 * 1000;
const MOBILE_BREAKPOINT = '(max-width: 640px)';
const GEOLOCATION_TIMEOUT_MS = 10_000;
/** Latest the warm-up may start once the browser reports itself idle. */
const WARM_UP_IDLE_TIMEOUT_MS = 2_000;
/** Warm-up delay where `requestIdleCallback` is missing, as on Safari. */
const WARM_UP_FALLBACK_DELAY_MS = 1_000;
/** How often to check the backend for newer radar/forecast data. */
const TIMELINE_POLL_INTERVAL_MS = 2 * 60 * 1000;
/** How long a manual-refresh failure message stays visible. */
const REFRESH_ERROR_DISPLAY_MS = 4_000;
/** How long without timeline interaction before the view resumes following "now". */
const IDLE_RESUME_MS = 3 * 60 * 1000;

export type MobileTab = 'map' | 'chart';

@Component({
  imports: [ModeToggle, MapLegend, TimelinePanel, RadarMap, RainChart],
  selector: 'app-home',
  styleUrl: './home.scss',
  templateUrl: './home.html',
})
export class Home implements OnInit {
  private readonly radarService = inject(RadarService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly breakpointObserver = inject(BreakpointObserver);
  private readonly tracking = inject(TrackingService);
  private readonly radarMap = viewChild(RadarMap);
  private readonly rainChart = viewChild(RainChart);
  private wasMobile = false;
  private wasShowingChart = false;
  private timelineReady = false;
  private autoplayStarted = false;
  private frameLoadToken = 0;
  private pointLoadToken = 0;
  private geolocationLoadToken = 0;
  private nowIndexIntervalId: ReturnType<typeof setInterval> | null = null;
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private refreshErrorTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private idleResumeTimerId: ReturnType<typeof setTimeout> | null = null;
  private playIntervalId: ReturnType<typeof setInterval> | null = null;
  private scrubTimerId: ReturnType<typeof setTimeout> | null = null;
  private pendingScrubIndex: number | null = null;
  private lastFrameLoadAt = 0;
  private appliedImageUrl: string | null = null;
  private sharedBbox: [number, number, number, number] | null = null;
  private sharedBboxImageUrl: string | null = null;
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
  readonly frameError = signal<string | null>(null);
  readonly frames = signal<TimelineSlot[]>([]);
  readonly sliderFrames = computed(() => framesForSliderMode(this.frames(), this.mode()));
  readonly selectedIndex = signal(0);
  readonly nowIndex = signal(0);
  readonly currentLabel = signal('');
  readonly mode = signal<OverlayMode>('probability');
  readonly ensembleAvailable = signal(false);
  readonly knmiEnsembleUnavailable = signal(false);
  readonly overlay = signal<RadarOverlay | null>(null);
  readonly selectedLocation = signal<MapLocation | null>(null);
  readonly pointSeries = signal<PointSeriesPoint[]>([]);
  readonly pointLoading = signal(false);
  readonly pointExtending = signal(false);
  readonly pointError = signal<string | null>(null);
  readonly locationLabel = signal('');
  readonly chartExtendedWindow = signal(false);
  readonly playing = signal(false);
  readonly mobileTab = signal<MobileTab>('map');
  readonly chartTabNeedsAttention = signal(false);
  readonly geolocationLoading = signal(false);
  readonly geolocationError = signal<string | null>(null);
  readonly isMobile = toSignal(
    this.breakpointObserver.observe(MOBILE_BREAKPOINT).pipe(map((result) => result.matches)),
    { initialValue: false },
  );

  constructor() {
    effect(() => {
      const mobile = this.isMobile();
      if (mobile && !this.wasMobile) {
        this.mobileTab.set('map');
      }
      if (mobile !== this.wasMobile) {
        requestAnimationFrame(() => this.schedulePaneResize());
      }
      this.wasMobile = mobile;
      untracked(() => this.maybeStartAutoplay());
    });

    effect(() => {
      const showingChart = this.showRainChart();
      if (showingChart && !this.wasShowingChart) {
        this.tracking.trackEvent('Chart Interaction', 'View');
      }
      this.wasShowingChart = showingChart;
    });
  }

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => {
      if (this.scrubTimerId !== null) {
        clearTimeout(this.scrubTimerId);
      }
      if (this.refreshErrorTimeoutId !== null) {
        clearTimeout(this.refreshErrorTimeoutId);
      }
      if (this.idleResumeTimerId !== null) {
        clearTimeout(this.idleResumeTimerId);
      }
      this.stopPlay();
    });
    void this.loadTimeline();
  }

  onMapClick(location: MapLocation): void {
    this.selectedLocation.set(location);
    this.locationLabel.set(this.formatLocation(location));
    this.chartExtendedWindow.set(false);
    if (this.isMobile() && this.mobileTab() === 'map') {
      this.chartTabNeedsAttention.set(true);
    }
    // Start fetching chart data immediately so it is ready when the user opens the chart tab.
    void this.loadPointSeries(location);
  }

  onMobileTabChange(tab: MobileTab): void {
    if (tab === this.mobileTab()) {
      return;
    }

    if (tab === 'chart' && this.mobileTab() === 'map') {
      this.stopPlay();
      this.chartTabNeedsAttention.set(false);
    }

    if (tab === 'map') {
      this.cancelGeolocationRequest();
    }

    this.mobileTab.set(tab);
    requestAnimationFrame(() => this.schedulePaneResize());

    if (tab === 'chart' && !this.selectedLocation()) {
      void this.requestBrowserGeolocation();
      return;
    }

    if (tab === 'chart') {
      this.ensureChartDataLoaded();
    }
  }

  private schedulePaneResize(): void {
    if (!this.isMobile() || this.mobileTab() === 'map') {
      this.radarMap()?.resize();
    }
    if (this.isMobile() && this.mobileTab() === 'chart') {
      this.rainChart()?.resize();
    }
  }

  onChartClosed(): void {
    this.pointLoadToken += 1;
    this.selectedLocation.set(null);
    this.pointSeries.set([]);
    this.pointError.set(null);
    this.pointLoading.set(false);
    this.pointExtending.set(false);
    this.chartExtendedWindow.set(false);
    this.locationLabel.set('');
  }

  onChartWindowChange(extended: boolean): void {
    if (!extended) {
      this.chartExtendedWindow.set(false);
      return;
    }

    const location = this.selectedLocation();
    if (!location || this.pointExtending() || this.chartExtendedWindow()) {
      return;
    }

    void this.loadExtendedPointSeries(location);
  }

  onSliderInput(index: number): void {
    if (!Number.isFinite(index)) {
      return;
    }

    this.followingNow = false;
    this.scheduleIdleResume();
    this.stopPlay();

    const timelineFrames = this.sliderFrames();
    const slot = timelineFrames[index];
    if (!slot) {
      return;
    }

    this.selectedIndex.set(index);
    this.currentLabel.set(this.formatValidAt(slot.valid_at));
    this.prefetchAround(index, timelineFrames);
    this.scheduleFrameLoad(index);
  }

  onSliderCommit(index: number): void {
    if (!Number.isFinite(index)) {
      return;
    }

    this.followingNow = false;
    this.scheduleIdleResume();
    if (this.scrubTimerId !== null) {
      clearTimeout(this.scrubTimerId);
      this.scrubTimerId = null;
    }
    this.pendingScrubIndex = null;

    const timelineFrames = this.sliderFrames();
    const slot = timelineFrames[index];
    if (slot) {
      this.selectedIndex.set(index);
      this.currentLabel.set(this.formatValidAt(slot.valid_at));
    }

    this.tracking.trackEvent('Timeline Interaction', 'Scrub');
    this.lastFrameLoadAt = Date.now();
    void this.showFrame(index);
  }

  onOverlayApplied(imageUrl: string): void {
    this.appliedImageUrl = imageUrl;
    this.frameError.set(null);

    const expected = this.expectedImageUrlForSelection();
    if (expected !== null && expected !== imageUrl) {
      void this.showFrame(this.selectedIndex());
    }
  }

  onOverlayFailed(_imageUrl: string): void {
    this.frameError.set('Kan radarbeeld niet laden.');
  }

  async setMode(nextMode: OverlayMode): Promise<void> {
    if (nextMode === this.mode()) {
      return;
    }
    if (nextMode === 'probability' && !this.ensembleAvailable()) {
      return;
    }
    if (nextMode === 'expected' && !this.ensembleAvailable()) {
      return;
    }

    this.tracking.trackEvent('Map Interaction', 'Mode Change', nextMode);
    if (!this.followingNow) {
      this.scheduleIdleResume();
    }

    const currentValidAt = this.sliderFrames()[this.selectedIndex()]?.valid_at ?? null;
    this.mode.set(nextMode);
    this.sharedBbox = null;
    this.sharedBboxImageUrl = null;
    // Whatever is still queued belongs to the mode being left behind.
    this.radarService.cancelQueuedPrefetches();

    const nextFrames = this.sliderFrames();
    this.nowIndex.set(this.resolveNowIndex(nextFrames));
    await this.selectFrame(indexForValidAt(nextFrames, currentValidAt));
    this.scheduleWindowWarmUp();
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

  /**
   * Start the animation once the timeline first loads, on both mobile and
   * desktop, so the resting state of the page is always a live animation.
   */
  private maybeStartAutoplay(): void {
    if (this.autoplayStarted || !this.timelineReady) {
      return;
    }
    if ((this.isMobile() && this.mobileTab() === 'chart') || this.sliderFrames().length <= 1) {
      return;
    }

    this.autoplayStarted = true;
    this.startPlay();
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

    if (!this.playing() && !(this.isMobile() && this.mobileTab() === 'chart')) {
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

  private stopPlay(): void {
    if (this.playIntervalId !== null) {
      clearInterval(this.playIntervalId);
      this.playIntervalId = null;
    }
    this.playing.set(false);
  }

  private async loadTimeline(): Promise<void> {
    this.loading.set(true);
    this.timelineError.set(null);

    try {
      const timeline = await this.fetchProbabilityTimeline();
      await this.applyTimeline(timeline, { isInitialLoad: true });
    } catch {
      this.timelineError.set('Kan radartijdlijn niet laden.');
    } finally {
      this.loading.set(false);
      requestAnimationFrame(() => this.schedulePaneResize());
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
   * Skipped while a scrub is being debounced so it never fights an in-flight
   * drag; silently retried on the next tick on failure, since this runs
   * unattended and a transient network blip is not worth surfacing.
   */
  private async pollTimeline(): Promise<void> {
    if (this.timelineRequestInFlight || this.scrubTimerId !== null) {
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
    this.destroyRef.onDestroy(() => {
      if (this.pollIntervalId !== null) {
        clearInterval(this.pollIntervalId);
      }
    });
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

    const previousValidAt = this.sliderFrames()[this.selectedIndex()]?.valid_at ?? null;
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
    this.scheduleWindowWarmUp();

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

    this.destroyRef.onDestroy(() => {
      if (this.nowIndexIntervalId !== null) {
        clearInterval(this.nowIndexIntervalId);
      }
    });
  }

  private async selectFrame(index: number): Promise<void> {
    this.selectedIndex.set(index);
    this.lastFrameLoadAt = Date.now();
    await this.showFrame(index);
  }

  private scheduleFrameLoad(index: number): void {
    this.pendingScrubIndex = index;
    const elapsed = Date.now() - this.lastFrameLoadAt;
    if (elapsed >= SCRUB_THROTTLE_MS) {
      this.runFrameLoad(index);
      return;
    }

    if (this.scrubTimerId !== null) {
      clearTimeout(this.scrubTimerId);
    }

    this.scrubTimerId = setTimeout(() => {
      this.scrubTimerId = null;
      if (this.pendingScrubIndex !== null) {
        this.runFrameLoad(this.pendingScrubIndex);
      }
    }, SCRUB_THROTTLE_MS - elapsed);
  }

  private runFrameLoad(index: number): void {
    if (this.scrubTimerId !== null) {
      clearTimeout(this.scrubTimerId);
      this.scrubTimerId = null;
    }
    this.pendingScrubIndex = null;
    this.lastFrameLoadAt = Date.now();
    void this.showFrame(index);
  }

  private expectedImageUrlForSelection(): string | null {
    const slot = this.sliderFrames()[this.selectedIndex()];
    if (!slot) {
      return null;
    }
    return this.sourceForMode(slot)?.image_url ?? null;
  }

  private sourceForMode(slot: TimelineSlot): FrameSource | null {
    if (this.mode() === 'intensity') {
      return slot.intensity;
    }
    if (this.mode() === 'expected') {
      if (slot.expected) {
        return slot.expected;
      }
      if (slot.kind === 'observed' && slot.intensity) {
        return slot.intensity;
      }
      return null;
    }
    if (slot.probability) {
      return slot.probability;
    }
    if (slot.kind === 'observed' && slot.intensity) {
      return slot.intensity;
    }
    return null;
  }

  private unavailableMessage(mode: OverlayMode): string {
    if (mode === 'intensity') {
      return 'Intensiteit niet beschikbaar voor dit tijdstip.';
    }
    if (mode === 'expected') {
      return 'Verwachte intensiteit niet beschikbaar voor dit tijdstip.';
    }
    return 'Kans niet beschikbaar voor dit tijdstip.';
  }

  private async showFrame(index: number): Promise<void> {
    const timelineFrames = this.sliderFrames();
    const slot = timelineFrames[index];
    if (!slot) {
      return;
    }

    this.currentLabel.set(this.formatValidAt(slot.valid_at));
    this.prefetchAround(index, timelineFrames);

    const source = this.sourceForMode(slot);
    if (!source) {
      this.frameError.set(this.unavailableMessage(this.mode()));
      this.appliedImageUrl = null;
      this.overlay.set(null);
      return;
    }

    const token = ++this.frameLoadToken;
    try {
      this.frameError.set(null);
      const canReuseBbox =
        this.sharedBbox !== null && this.sharedBboxImageUrl === source.image_url;
      const bbox = canReuseBbox
        ? this.sharedBbox!
        : source.bbox ?? await this.radarService.resolveBbox(source);
      if (token !== this.frameLoadToken) {
        return;
      }

      this.sharedBbox = bbox;
      this.sharedBboxImageUrl = source.image_url;
      this.overlay.set({ imageUrl: source.image_url, bbox });
    } catch {
      if (token === this.frameLoadToken) {
        this.frameError.set('Kan radarbeeld niet laden.');
      }
    }
  }

  private prefetchAround(
    index: number,
    timelineFrames: TimelineSlot[],
  ): void {
    for (let offset = -3; offset <= 3; offset++) {
      const neighbor = timelineFrames[index + offset];
      if (!neighbor || offset === 0) {
        continue;
      }
      const source = this.sourceForMode(neighbor);
      if (source) {
        this.radarService.prefetchFrame(source.image_url);
      }
    }
  }

  /**
   * Warm every frame of the slider window once the map has something to show.
   *
   * Dragging the slider then hits the browser cache instead of the network.
   * It waits for idle time so it never competes with the first frame or the
   * basemap tiles, and the service caps how many run at once.
   */
  private scheduleWindowWarmUp(): void {
    runWhenIdle(() => this.warmSliderWindow());
  }

  private warmSliderWindow(): void {
    const timelineFrames = this.sliderFrames();
    const index = this.selectedIndex();
    const imageUrls: string[] = [];

    // Expand outward from the selected frame so the frames the user is most
    // likely to reach next are the first ones to arrive.
    for (let offset = 1; offset < timelineFrames.length; offset++) {
      for (const neighborIndex of [index + offset, index - offset]) {
        const neighbor = timelineFrames[neighborIndex];
        const source = neighbor ? this.sourceForMode(neighbor) : null;
        if (source) {
          imageUrls.push(source.image_url);
        }
      }
    }

    this.radarService.warmFrames(imageUrls);
  }

  private formatValidAt(value: string): string {
    return new Intl.DateTimeFormat('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }

  private formatLocation(location: MapLocation): string {
    const lat = location.lat.toFixed(3);
    const lng = location.lng.toFixed(3);
    return `${lat}°N, ${lng}°E`;
  }

  private cancelGeolocationRequest(): void {
    this.geolocationLoadToken += 1;
    this.geolocationLoading.set(false);
  }

  private async requestBrowserGeolocation(): Promise<void> {
    this.cancelGeolocationRequest();
    const token = this.geolocationLoadToken;
    this.geolocationError.set(null);

    if (!navigator.geolocation) {
      this.geolocationError.set('Locatiebepaling wordt niet ondersteund door je browser.');
      return;
    }

    this.geolocationLoading.set(true);

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: GEOLOCATION_TIMEOUT_MS,
          maximumAge: 60_000,
        });
      });

      if (token !== this.geolocationLoadToken) {
        return;
      }

      this.onMapClick({
        lng: position.coords.longitude,
        lat: position.coords.latitude,
      });
    } catch {
      if (token !== this.geolocationLoadToken) {
        return;
      }

      this.geolocationError.set(
        'Kan je locatie niet bepalen. Kies handmatig een punt op de kaart.',
      );
    } finally {
      if (token === this.geolocationLoadToken) {
        this.geolocationLoading.set(false);
      }
    }
  }

  private ensureChartDataLoaded(): void {
    const location = this.selectedLocation();
    if (
      !location ||
      this.pointLoading() ||
      this.pointExtending() ||
      this.pointSeries().length > 0
    ) {
      return;
    }

    void this.loadPointSeries(location);
  }

  private async loadPointSeries(location: MapLocation): Promise<void> {
    const token = ++this.pointLoadToken;
    this.pointLoading.set(true);
    this.pointError.set(null);
    this.pointSeries.set([]);

    try {
      const response = await new Promise<PointSeriesResponse>((resolve, reject) => {
        this.radarService
          .getPointSeries(
            location.lat,
            location.lng,
            CHART_WINDOW_BEFORE_HOURS,
            CHART_WINDOW_AFTER_HOURS,
          )
          .subscribe({
            next: resolve,
            error: reject,
          });
      });

      if (token !== this.pointLoadToken) {
        return;
      }

      this.pointSeries.set(response.points);
    } catch {
      if (token === this.pointLoadToken) {
        this.pointError.set('Kan regenreeks voor deze locatie niet laden.');
      }
    } finally {
      if (token === this.pointLoadToken) {
        this.pointLoading.set(false);
      }
    }
  }

  private async loadExtendedPointSeries(location: MapLocation): Promise<void> {
    const token = ++this.pointLoadToken;
    this.pointExtending.set(true);
    this.pointError.set(null);

    try {
      const response = await new Promise<PointSeriesResponse>((resolve, reject) => {
        this.radarService
          .getPointSeries(location.lat, location.lng, CHART_WINDOW_BEFORE_HOURS)
          .subscribe({
            next: resolve,
            error: reject,
          });
      });

      if (token !== this.pointLoadToken) {
        return;
      }

      this.pointSeries.set(response.points);
      this.chartExtendedWindow.set(true);
    } catch {
      // Keep the short series visible; the user can retry the extended toggle.
    } finally {
      if (token === this.pointLoadToken) {
        this.pointExtending.set(false);
      }
    }
  }

  readonly showRainChart = computed(() => {
    if (!this.selectedLocation()) {
      return false;
    }
    return !this.isMobile() || this.mobileTab() === 'chart';
  });

  readonly chartMaxAvailableHours = computed(() => {
    const frames = this.frames();
    const nowMs = Date.now();
    let maxProbabilityMs: number | null = null;

    for (const slot of frames) {
      if (slot.probability === null) {
        continue;
      }
      const timeMs = new Date(slot.valid_at).getTime();
      if (maxProbabilityMs === null || timeMs > maxProbabilityMs) {
        maxProbabilityMs = timeMs;
      }
    }

    if (maxProbabilityMs === null) {
      return null;
    }

    const hoursAhead = (maxProbabilityMs - nowMs) / HOUR_MS;
    if (hoursAhead <= CHART_WINDOW_AFTER_HOURS + 0.25) {
      return null;
    }

    return Math.ceil(hoursAhead);
  });

  readonly selectedValidAt = computed(() => {
    const frames = this.sliderFrames();
    const index = this.selectedIndex();
    return frames[index]?.valid_at ?? null;
  });
}

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout: number },
  ) => number;
};

function runWhenIdle(callback: () => void): void {
  const idleWindow = window as IdleWindow;
  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(callback, { timeout: WARM_UP_IDLE_TIMEOUT_MS });
    return;
  }

  setTimeout(callback, WARM_UP_FALLBACK_DELAY_MS);
}

function indexForValidAt(frames: TimelineSlot[], validAt: string | null): number {
  if (frames.length === 0) {
    return 0;
  }
  if (validAt === null) {
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
