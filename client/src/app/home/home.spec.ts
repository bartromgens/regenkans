import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { BreakpointObserver } from '@angular/cdk/layout';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('maplibre-gl', () => {
  class StubMap {
    isStyleLoaded(): boolean {
      return true;
    }

    addControl = vi.fn();
    on = vi.fn();
    off = vi.fn();
    once = vi.fn();
    getSource = vi.fn();
    getLayer = vi.fn();
    addSource = vi.fn();
    addLayer = vi.fn();
    removeLayer = vi.fn();
    removeSource = vi.fn();
    remove = vi.fn();
    resize = vi.fn();
  }

  class StubMarker {
    setLngLat = vi.fn().mockReturnThis();
    addTo = vi.fn().mockReturnThis();
    remove = vi.fn();
  }

  return {
    Map: StubMap,
    Marker: StubMarker,
    NavigationControl: class {},
    GeolocateControl: class {
      on = vi.fn();
    },
  };
});

import { framesForSliderMode, Home } from './home';
import { RadarService, TimelineSlot } from '../radar/radar.service';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

const mobileMatches$ = new BehaviorSubject({ matches: false, breakpoints: {} });

const breakpointObserver = {
  observe: vi.fn(() => mobileMatches$.asObservable()),
};

function makeFrame(index: number): TimelineSlot {
  return {
    valid_at: `2026-08-30T${String(index).padStart(2, '0')}:00:00Z`,
    kind: 'forecast',
    intensity: {
      issued_at: '2026-08-30T14:45:00Z',
      lead_minutes: index * 5,
      image_url: `/api/frame/${index}.png`,
      bbox_url: `/api/frame/${index}.bbox`,
      bbox: [3, 50, 7, 54],
    },
    probability: null,
    expected: null,
  };
}

describe('Home slider frame loading', () => {
  let fixture: ComponentFixture<Home>;
  let home: Home;
  let overlaySetSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    mobileMatches$.next({ matches: false, breakpoints: {} });

    const radarService = {
      getProbabilityTimeline: vi.fn(() => NEVER),
      resolveBbox: vi.fn(),
      prefetchFrame: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [
        provideHttpClient(),
        { provide: RadarService, useValue: radarService },
        { provide: BreakpointObserver, useValue: breakpointObserver },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Home);
    home = fixture.componentInstance;
    home.frames.set(Array.from({ length: 10 }, (_, index) => makeFrame(index)));
    home.loading.set(false);
    home.mode.set('intensity');
    overlaySetSpy = vi.spyOn(home.overlay, 'set');
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushAsync(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('updates selectedIndex on every scrub but throttles overlay loads', async () => {
    home.onSliderInput(1);
    home.onSliderInput(2);
    home.onSliderInput(3);

    expect(home.selectedIndex()).toBe(3);
    expect(overlaySetSpy).toHaveBeenCalledTimes(1);
    expect(overlaySetSpy.mock.calls[0][0]?.imageUrl).toBe('/api/frame/1.png');

    vi.advanceTimersByTime(150);
    await flushAsync();

    expect(overlaySetSpy.mock.calls.at(-1)?.[0]?.imageUrl).toBe('/api/frame/3.png');
  });

  it('loads the final frame immediately on slider commit', async () => {
    home.onSliderInput(1);
    home.onSliderInput(2);
    overlaySetSpy.mockClear();

    home.onSliderCommit(9);

    expect(home.selectedIndex()).toBe(9);
    await flushAsync();
    expect(overlaySetSpy).toHaveBeenCalledWith({
      imageUrl: '/api/frame/9.png',
      bbox: [3, 50, 7, 54],
    });
  });

  it('reconciles when the applied overlay does not match the selection', async () => {
    home.selectedIndex.set(5);
    overlaySetSpy.mockClear();

    home.onOverlayApplied('/api/frame/2.png');
    await flushAsync();

    expect(overlaySetSpy).toHaveBeenCalledTimes(1);
    expect(overlaySetSpy.mock.calls[0][0]?.imageUrl).toBe('/api/frame/5.png');
  });
});

describe('Home playback', () => {
  let fixture: ComponentFixture<Home>;
  let home: Home;

  beforeEach(async () => {
    vi.useFakeTimers();
    mobileMatches$.next({ matches: false, breakpoints: {} });

    const radarService = {
      getProbabilityTimeline: vi.fn(() => NEVER),
      resolveBbox: vi.fn(),
      prefetchFrame: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [
        provideHttpClient(),
        { provide: RadarService, useValue: radarService },
        { provide: BreakpointObserver, useValue: breakpointObserver },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Home);
    home = fixture.componentInstance;
    home.frames.set(Array.from({ length: 10 }, (_, index) => makeFrame(index)));
    home.loading.set(false);
    home.mode.set('intensity');
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushAsync(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('advances selectedIndex on each tick', async () => {
    home.selectedIndex.set(0);

    home.togglePlay();
    expect(home.playing()).toBe(true);

    vi.advanceTimersByTime(700);
    await flushAsync();
    expect(home.selectedIndex()).toBe(1);

    vi.advanceTimersByTime(700);
    await flushAsync();
    expect(home.selectedIndex()).toBe(2);
  });

  it('stops itself automatically once it passes the last frame', async () => {
    home.selectedIndex.set(9);

    home.togglePlay();
    expect(home.selectedIndex()).toBe(0);

    for (let tick = 0; tick < 9; tick++) {
      vi.advanceTimersByTime(700);
      await flushAsync();
    }
    expect(home.selectedIndex()).toBe(9);
    expect(home.playing()).toBe(true);

    vi.advanceTimersByTime(700);
    await flushAsync();
    expect(home.playing()).toBe(false);
    expect(home.selectedIndex()).toBe(9);
  });

  it('stops playback when the user drags the slider manually', () => {
    home.togglePlay();
    expect(home.playing()).toBe(true);

    home.onSliderInput(3);
    expect(home.playing()).toBe(false);
  });
});

describe('Home mobile tabs', () => {
  let fixture: ComponentFixture<Home>;
  let home: Home;
  let getCurrentPositionSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mobileMatches$.next({ matches: true, breakpoints: {} });

    getCurrentPositionSpy = vi.fn();
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: getCurrentPositionSpy,
      },
    });

    const radarService = {
      getProbabilityTimeline: vi.fn(() => NEVER),
      getPointSeries: vi.fn(() => NEVER),
      resolveBbox: vi.fn(),
      prefetchFrame: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [
        provideHttpClient(),
        { provide: RadarService, useValue: radarService },
        { provide: BreakpointObserver, useValue: breakpointObserver },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Home);
    home = fixture.componentInstance;
    home.frames.set(Array.from({ length: 10 }, (_, index) => makeFrame(index)));
    home.loading.set(false);
    home.mode.set('intensity');
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function flushAsync(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('stays on the map tab and highlights the chart tab after a map click on mobile', () => {
    expect(home.mobileTab()).toBe('map');
    expect(home.chartTabNeedsAttention()).toBe(false);

    home.onMapClick({ lat: 52.2, lng: 5.3 });

    expect(home.mobileTab()).toBe('map');
    expect(home.chartTabNeedsAttention()).toBe(true);
    expect(home.selectedLocation()).toEqual({ lat: 52.2, lng: 5.3 });
  });

  it('clears the chart tab attention flag when opening the chart tab', () => {
    home.onMapClick({ lat: 52.2, lng: 5.3 });
    expect(home.chartTabNeedsAttention()).toBe(true);

    home.onMobileTabChange('chart');

    expect(home.chartTabNeedsAttention()).toBe(false);
    expect(home.mobileTab()).toBe('chart');
  });

  it('allows switching back to the map tab after selecting a location', () => {
    home.onMapClick({ lat: 52.2, lng: 5.3 });
    expect(home.mobileTab()).toBe('map');

    home.onMobileTabChange('chart');
    home.onMobileTabChange('map');

    expect(home.mobileTab()).toBe('map');
    expect(home.selectedLocation()).toEqual({ lat: 52.2, lng: 5.3 });
  });

  it('stops playback when leaving the map tab', () => {
    home.togglePlay();
    expect(home.playing()).toBe(true);

    home.onMobileTabChange('chart');

    expect(home.playing()).toBe(false);
  });

  it('requests browser geolocation when opening the chart tab without a location', async () => {
    getCurrentPositionSpy.mockImplementation((success: PositionCallback) => {
      success({
        coords: {
          latitude: 52.1,
          longitude: 5.2,
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
          toJSON: () => ({}),
        },
        timestamp: Date.now(),
        toJSON: () => ({}),
      } as GeolocationPosition);
    });

    home.onMobileTabChange('chart');
    await flushAsync();

    expect(getCurrentPositionSpy).toHaveBeenCalledOnce();
    expect(home.mobileTab()).toBe('chart');
    expect(home.selectedLocation()).toEqual({ lat: 52.1, lng: 5.2 });
  });

  it('keeps the user on the chart tab when geolocation fails', async () => {
    getCurrentPositionSpy.mockImplementation(
      (_success: PositionCallback, error: PositionErrorCallback) => {
        error({
          code: 1,
          message: 'User denied geolocation',
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
        });
      },
    );

    home.onMobileTabChange('chart');
    await flushAsync();

    expect(home.mobileTab()).toBe('chart');
    expect(home.selectedLocation()).toBeNull();
    expect(home.geolocationError()).toContain('Kan je locatie niet bepalen');
  });
});

describe('Home mobile autoplay', () => {
  let fixture: ComponentFixture<Home>;
  let home: Home;

  function timelineResponse() {
    const now = Date.now();
    return {
      generated_at: new Date(now).toISOString(),
      now: new Date(now).toISOString(),
      ensemble_available: false,
      knmi_ensemble_unavailable: false,
      frames: [-20, -10, 0, 10, 20].map((minutes, index) => ({
        ...makeFrame(index),
        valid_at: new Date(now + minutes * 60_000).toISOString(),
      })),
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushAsync(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('starts playback after the timeline loads on mobile', async () => {
    mobileMatches$.next({ matches: true, breakpoints: {} });

    const radarService = {
      getProbabilityTimeline: vi.fn(() => of(timelineResponse())),
      resolveBbox: vi.fn(),
      prefetchFrame: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [
        provideHttpClient(),
        { provide: RadarService, useValue: radarService },
        { provide: BreakpointObserver, useValue: breakpointObserver },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Home);
    home = fixture.componentInstance;
    fixture.detectChanges();
    await flushAsync();

    expect(home.playing()).toBe(true);
    expect(home.nowIndex()).toBe(2);
    expect(home.selectedIndex()).toBe(2);
  });

  it('does not autoplay after the timeline loads on desktop', async () => {
    mobileMatches$.next({ matches: false, breakpoints: {} });

    const radarService = {
      getProbabilityTimeline: vi.fn(() => of(timelineResponse())),
      resolveBbox: vi.fn(),
      prefetchFrame: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [
        provideHttpClient(),
        { provide: RadarService, useValue: radarService },
        { provide: BreakpointObserver, useValue: breakpointObserver },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Home);
    home = fixture.componentInstance;
    fixture.detectChanges();
    await flushAsync();

    expect(home.playing()).toBe(false);
  });

  it('loops playback on mobile instead of stopping at the last frame', async () => {
    vi.useFakeTimers();
    mobileMatches$.next({ matches: true, breakpoints: {} });

    const radarService = {
      getProbabilityTimeline: vi.fn(() => NEVER),
      resolveBbox: vi.fn(),
      prefetchFrame: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [
        provideHttpClient(),
        { provide: RadarService, useValue: radarService },
        { provide: BreakpointObserver, useValue: breakpointObserver },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Home);
    home = fixture.componentInstance;
    home.frames.set(Array.from({ length: 4 }, (_, index) => makeFrame(index)));
    home.loading.set(false);
    home.mode.set('intensity');
    home.nowIndex.set(1);
    home.selectedIndex.set(3);
    fixture.detectChanges();

    home.togglePlay();
    expect(home.selectedIndex()).toBe(1);

    vi.advanceTimersByTime(700);
    await flushAsync();
    expect(home.selectedIndex()).toBe(2);

    vi.advanceTimersByTime(700);
    await flushAsync();
    expect(home.selectedIndex()).toBe(3);

    vi.advanceTimersByTime(700);
    await flushAsync();
    expect(home.playing()).toBe(true);
    expect(home.selectedIndex()).toBe(1);
  });
});

describe('Home mobile map click on desktop', () => {
  let fixture: ComponentFixture<Home>;
  let home: Home;

  beforeEach(async () => {
    mobileMatches$.next({ matches: false, breakpoints: {} });

    const radarService = {
      getProbabilityTimeline: vi.fn(() => NEVER),
      getPointSeries: vi.fn(() => NEVER),
      resolveBbox: vi.fn(),
      prefetchFrame: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [
        provideHttpClient(),
        { provide: RadarService, useValue: radarService },
        { provide: BreakpointObserver, useValue: breakpointObserver },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Home);
    home = fixture.componentInstance;
    home.loading.set(false);
    fixture.detectChanges();
  });

  it('does not change the mobile tab on desktop map clicks', () => {
    home.onMapClick({ lat: 52.2, lng: 5.3 });

    expect(home.mobileTab()).toBe('map');
    expect(home.selectedLocation()).toEqual({ lat: 52.2, lng: 5.3 });
  });
});

describe('Home KNMI ensemble fallback', () => {
  async function flushAsync(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loadHome(timeline: {
    ensemble_available: boolean;
    knmi_ensemble_unavailable: boolean;
  }): Promise<Home> {
    vi.useFakeTimers();
    mobileMatches$.next({ matches: false, breakpoints: {} });

    const now = Date.now();
    const radarService = {
      getProbabilityTimeline: vi.fn(() =>
        of({
          generated_at: new Date(now).toISOString(),
          now: new Date(now).toISOString(),
          ensemble_available: timeline.ensemble_available,
          knmi_ensemble_unavailable: timeline.knmi_ensemble_unavailable,
          frames: [-20, -10, 0, 10, 20].map((minutes, index) => ({
            ...makeFrame(index),
            valid_at: new Date(now + minutes * 60_000).toISOString(),
          })),
        }),
      ),
      resolveBbox: vi.fn().mockResolvedValue([3, 50, 7, 54]),
      prefetchFrame: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [
        provideHttpClient(),
        { provide: RadarService, useValue: radarService },
        { provide: BreakpointObserver, useValue: breakpointObserver },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(Home);
    fixture.detectChanges();
    await flushAsync();
    return fixture.componentInstance;
  }

  it('falls back to nowcast and reports KNMI after a successful stale ingest', async () => {
    const home = await loadHome({
      ensemble_available: false,
      knmi_ensemble_unavailable: true,
    });

    expect(home.mode()).toBe('intensity');
    expect(home.knmiEnsembleUnavailable()).toBe(true);
    expect(home.ensembleAvailable()).toBe(false);
  });

  it('falls back to nowcast without blaming KNMI when ingest did not succeed', async () => {
    const home = await loadHome({
      ensemble_available: false,
      knmi_ensemble_unavailable: false,
    });

    expect(home.mode()).toBe('intensity');
    expect(home.knmiEnsembleUnavailable()).toBe(false);
  });
});

describe('framesForSliderMode', () => {
  const observed = makeFrame(0);
  observed.kind = 'observed';
  observed.valid_at = '2026-08-30T12:00:00Z';

  const nowcast = makeFrame(1);
  nowcast.valid_at = '2026-08-30T13:30:00Z';

  const lateNowcast = makeFrame(2);
  lateNowcast.valid_at = '2026-08-30T14:30:00Z';

  const ensembleOnly = makeFrame(3);
  ensembleOnly.valid_at = '2026-08-30T15:30:00Z';
  ensembleOnly.intensity = null;
  ensembleOnly.probability = {
    issued_at: '2026-08-30T12:00:00Z',
    lead_minutes: 210,
    image_url: '/api/ensemble/3.png',
    bbox_url: '/api/ensemble/3.bbox',
    bbox: [3, 50, 7, 54],
  };

  const frames = [observed, nowcast, lateNowcast, ensembleOnly];

  it('keeps the full ensemble forecast in probability mode', () => {
    expect(framesForSliderMode(frames, 'probability')).toEqual(frames);
    expect(framesForSliderMode(frames, 'expected')).toEqual(frames);
  });

  it('limits the intensity slider to two hours of nowcast', () => {
    expect(framesForSliderMode(frames, 'intensity')).toEqual([observed, nowcast]);
  });
});

describe('Home intensity slider window', () => {
  let fixture: ComponentFixture<Home>;
  let home: Home;

  beforeEach(async () => {
    mobileMatches$.next({ matches: false, breakpoints: {} });

    const radarService = {
      getProbabilityTimeline: vi.fn(() => NEVER),
      resolveBbox: vi.fn().mockResolvedValue([3, 50, 7, 54]),
      prefetchFrame: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [
        provideHttpClient(),
        { provide: RadarService, useValue: radarService },
        { provide: BreakpointObserver, useValue: breakpointObserver },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Home);
    home = fixture.componentInstance;

    const observed: TimelineSlot = {
      ...makeFrame(0),
      kind: 'observed',
      valid_at: '2026-08-30T12:00:00Z',
    };
    const nowcast: TimelineSlot = { ...makeFrame(1), valid_at: '2026-08-30T13:30:00Z' };
    const ensembleOnly: TimelineSlot = {
      ...makeFrame(2),
      valid_at: '2026-08-30T15:30:00Z',
      intensity: null,
      probability: {
        issued_at: '2026-08-30T12:00:00Z',
        lead_minutes: 210,
        image_url: '/api/ensemble/2.png',
        bbox_url: '/api/ensemble/2.bbox',
        bbox: [3, 50, 7, 54],
      },
    };

    home.frames.set([observed, nowcast, ensembleOnly]);
    home.ensembleAvailable.set(true);
    home.loading.set(false);
    home.mode.set('probability');
    home.selectedIndex.set(2);
  });

  it('clamps the selection when switching to intensity nowcast', async () => {
    expect(home.sliderFrames().length).toBe(3);

    await home.setMode('intensity');

    expect(home.sliderFrames().map((frame) => frame.valid_at)).toEqual([
      '2026-08-30T12:00:00Z',
      '2026-08-30T13:30:00Z',
    ]);
    expect(home.selectedIndex()).toBe(1);
  });
});
