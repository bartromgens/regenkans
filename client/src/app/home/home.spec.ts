import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { NEVER } from 'rxjs';
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

    const radarService = {
      getProbabilityTimeline: vi.fn(() => NEVER),
      resolveBbox: vi.fn(),
      prefetchFrame: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [provideHttpClient(), { provide: RadarService, useValue: radarService }],
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
