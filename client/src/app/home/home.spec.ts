import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { BreakpointObserver } from '@angular/cdk/layout';
import { BehaviorSubject, NEVER } from 'rxjs';
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

import { Home } from './home';
import { RadarService, TimelineSlot } from '../radar/radar.service';

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

  beforeEach(async () => {
    mobileMatches$.next({ matches: true, breakpoints: {} });

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

  it('switches to the chart tab after a map click on mobile', () => {
    expect(home.mobileTab()).toBe('map');

    home.onMapClick({ lat: 52.2, lng: 5.3 });

    expect(home.mobileTab()).toBe('chart');
    expect(home.selectedLocation()).toEqual({ lat: 52.2, lng: 5.3 });
  });

  it('allows switching back to the map tab after selecting a location', () => {
    home.onMapClick({ lat: 52.2, lng: 5.3 });
    expect(home.mobileTab()).toBe('chart');

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
