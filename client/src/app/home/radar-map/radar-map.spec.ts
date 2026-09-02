import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { stubSource, StubImageSource } = vi.hoisted(() => {
  class StubImageSource {
    url = '';
    private listeners = new Map<string, Set<(event?: unknown) => void>>();
    static updateImageCalls: string[] = [];
    static inFlight = false;
    static pendingResolve: (() => void) | null = null;

    updateImage(options: { url: string; coordinates: unknown }): this {
      StubImageSource.updateImageCalls.push(options.url);
      expect(StubImageSource.inFlight).toBe(false);
      StubImageSource.inFlight = true;
      this.url = options.url;
      StubImageSource.pendingResolve = () => {
        StubImageSource.inFlight = false;
        this.emit('data', { sourceDataType: 'metadata' });
      };
      return this;
    }

    on(event: string, handler: (event?: unknown) => void): void {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler);
    }

    off(event: string, handler: (event?: unknown) => void): void {
      this.listeners.get(event)?.delete(handler);
    }

    emit(event: string, payload?: unknown): void {
      for (const handler of this.listeners.get(event) ?? []) {
        handler(payload);
      }
    }

    static reset(): void {
      StubImageSource.updateImageCalls = [];
      StubImageSource.inFlight = false;
      StubImageSource.pendingResolve = null;
    }
  }

  return { stubSource: new StubImageSource(), StubImageSource };
});

vi.mock('maplibre-gl', () => {
  class StubMap {
    isStyleLoaded(): boolean {
      return true;
    }

    addControl = vi.fn();
    on = vi.fn();
    off = vi.fn();
    once = vi.fn();
    getSource = vi.fn((id: string) => (id === 'radar-overlay' ? stubSource : undefined));
    getLayer = vi.fn(() => ({}));
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

import { RadarMap, RadarOverlay } from './radar-map';

class MockImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const bbox: [number, number, number, number] = [3, 50, 7, 54];

function overlayFor(url: string): RadarOverlay {
  return { imageUrl: url, bbox };
}

describe('RadarMap overlay pump', () => {
  let fixture: ComponentFixture<RadarMap>;
  let appliedUrls: string[] = [];

  beforeEach(async () => {
    StubImageSource.reset();
    appliedUrls = [];
    vi.stubGlobal('Image', MockImage);

    await TestBed.configureTestingModule({
      imports: [RadarMap],
    }).compileComponents();

    fixture = TestBed.createComponent(RadarMap);
    fixture.componentInstance.overlayApplied.subscribe((url) => appliedUrls.push(url));
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function flushPump(): Promise<void> {
    await fixture.whenStable();
    await Promise.resolve();
    await Promise.resolve();
  }

  async function settleCurrentLoad(): Promise<void> {
    StubImageSource.pendingResolve?.();
    await flushPump();
  }

  it('serializes updateImage calls and collapses intermediate overlays', async () => {
    fixture.componentRef.setInput('overlay', overlayFor('/frame-a.png'));
    await flushPump();
    expect(StubImageSource.updateImageCalls).toEqual(['/frame-a.png']);

    fixture.componentRef.setInput('overlay', overlayFor('/frame-b.png'));
    fixture.componentRef.setInput('overlay', overlayFor('/frame-c.png'));
    await flushPump();
    expect(StubImageSource.updateImageCalls).toEqual(['/frame-a.png']);

    await settleCurrentLoad();
    expect(StubImageSource.updateImageCalls).toEqual(['/frame-a.png', '/frame-c.png']);
    expect(appliedUrls).toEqual([]);

    await settleCurrentLoad();
    expect(appliedUrls).toEqual(['/frame-c.png']);
  });

  it('applies the last requested overlay after an earlier load resolves late', async () => {
    fixture.componentRef.setInput('overlay', overlayFor('/frame-a.png'));
    await flushPump();

    fixture.componentRef.setInput('overlay', overlayFor('/frame-b.png'));
    await flushPump();

    await settleCurrentLoad();
    await settleCurrentLoad();
    expect(appliedUrls).toEqual(['/frame-b.png']);
    expect(StubImageSource.updateImageCalls.at(-1)).toBe('/frame-b.png');
  });
});
