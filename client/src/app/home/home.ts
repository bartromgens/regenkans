import { Component, OnInit, computed, effect, inject, untracked, viewChild } from '@angular/core';
import { TrackingService } from '../tracking.service';
import { ChartPlaceholder } from './chart-placeholder/chart-placeholder';
import { GeolocationStore } from './geolocation.store';
import { LayoutStore } from './layout.store';
import { MapLegend } from './map-legend/map-legend';
import { MobileTab, MobileTabs } from './mobile-tabs/mobile-tabs';
import { ModeToggle } from './mode-toggle/mode-toggle';
import { PointSeriesStore } from './point-series.store';
import { MapLocation, RadarMap } from './radar-map/radar-map';
import { RadarOverlayStore } from './radar-overlay.store';
import { RainChart } from './rain-chart/rain-chart';
import { RefreshButton } from './refresh-button/refresh-button';
import { TimelinePanel } from './timeline-panel/timeline-panel';
import { TimelineStore } from './timeline.store';

/**
 * The radar page: a map pane and a chart pane, side by side on desktop and
 * behind tabs on mobile.
 *
 * The state lives in the four page-scoped stores; what is left here is the
 * wiring between them and the things only the page can do, such as telling a
 * pane to re-measure itself once it is back on screen.
 */
@Component({
  imports: [
    ChartPlaceholder,
    MapLegend,
    MobileTabs,
    ModeToggle,
    RadarMap,
    RainChart,
    RefreshButton,
    TimelinePanel,
  ],
  providers: [LayoutStore, RadarOverlayStore, TimelineStore, PointSeriesStore, GeolocationStore],
  selector: 'app-home',
  styleUrl: './home.scss',
  templateUrl: './home.html',
})
export class Home implements OnInit {
  readonly layout = inject(LayoutStore);
  readonly timeline = inject(TimelineStore);
  readonly pointSeries = inject(PointSeriesStore);
  readonly geolocation = inject(GeolocationStore);
  private readonly tracking = inject(TrackingService);
  private readonly radarMap = viewChild(RadarMap);
  private readonly rainChart = viewChild(RainChart);
  private wasMobile = false;
  private wasShowingChart = false;

  readonly showRainChart = computed(
    () => this.pointSeries.location() !== null && this.layout.chartVisible(),
  );

  constructor() {
    effect(() => {
      const mobile = this.layout.isMobile();
      if (mobile && !this.wasMobile) {
        this.layout.mobileTab.set('map');
      }
      if (mobile !== this.wasMobile) {
        requestAnimationFrame(() => this.schedulePaneResize());
      }
      this.wasMobile = mobile;
      untracked(() => this.timeline.maybeStartAutoplay());
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
    void this.timeline.load().finally(() => {
      requestAnimationFrame(() => this.schedulePaneResize());
    });
  }

  onMapClick(location: MapLocation): void {
    this.pointSeries.selectLocation(location);
    if (this.layout.isMobile() && this.layout.mobileTab() === 'map') {
      this.layout.chartTabNeedsAttention.set(true);
    }
  }

  onMobileTabChange(tab: MobileTab): void {
    if (tab === this.layout.mobileTab()) {
      return;
    }

    if (tab === 'chart') {
      this.timeline.stopPlay();
      this.layout.chartTabNeedsAttention.set(false);
    } else {
      this.geolocation.cancel();
    }

    this.layout.mobileTab.set(tab);
    requestAnimationFrame(() => this.schedulePaneResize());

    if (tab !== 'chart') {
      return;
    }

    if (this.pointSeries.location()) {
      this.pointSeries.ensureLoaded();
      return;
    }

    void this.selectBrowserLocation();
  }

  private async selectBrowserLocation(): Promise<void> {
    const location = await this.geolocation.request();
    if (location) {
      this.onMapClick(location);
    }
  }

  /** Both panes measure themselves on layout, so re-measure once shown. */
  private schedulePaneResize(): void {
    if (this.layout.mapVisible()) {
      this.radarMap()?.resize();
    } else {
      this.rainChart()?.resize();
    }
  }
}
