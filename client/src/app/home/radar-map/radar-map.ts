import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  effect,
  input,
  output,
} from '@angular/core';
import * as maplibregl from 'maplibre-gl';

const OVERLAY_SOURCE_ID = 'radar-overlay';
const OVERLAY_LAYER_ID = 'radar-overlay-layer';
const SOURCE_SETTLE_TIMEOUT_MS = 4_000;

export interface RadarOverlay {
  imageUrl: string;
  bbox: [number, number, number, number];
}

export interface MapLocation {
  lng: number;
  lat: number;
}

@Component({
  selector: 'app-radar-map',
  styleUrl: './radar-map.scss',
  templateUrl: './radar-map.html',
})
export class RadarMap implements OnInit, OnDestroy {
  @ViewChild('mapContainer', { static: true })
  mapContainer!: ElementRef<HTMLDivElement>;

  readonly overlay = input<RadarOverlay | null>(null);
  readonly markerLocation = input<MapLocation | null>(null);

  readonly locationClick = output<MapLocation>();
  readonly overlayApplied = output<string>();
  readonly overlayFailed = output<string>();

  private map: maplibregl.Map | null = null;
  private marker: maplibregl.Marker | null = null;
  private mapHasLoaded = false;
  private desiredOverlay: RadarOverlay | null = null;
  private appliedOverlay: RadarOverlay | null = null;
  private pumping = false;

  constructor() {
    effect(() => {
      this.desiredOverlay = this.overlay();
      void this.pumpOverlay();
    });

    effect(() => {
      this.updateMarker(this.markerLocation());
    });
  }

  ngOnInit(): void {
    this.initMap();
  }

  ngOnDestroy(): void {
    this.marker?.remove();
    this.map?.remove();
  }

  resize(): void {
    this.map?.resize();
  }

  private initMap(): void {
    this.map = new maplibregl.Map({
      container: this.mapContainer.nativeElement,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [5.3, 52.2],
      zoom: 7,
    });

    this.map.addControl(new maplibregl.NavigationControl(), 'top-right');

    const geolocateControl = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: false,
      showAccuracyCircle: false,
      fitBoundsOptions: { maxZoom: 10 },
    });
    this.map.addControl(geolocateControl, 'top-right');
    geolocateControl.on('geolocate', (position: GeolocationPosition) => {
      this.locationClick.emit({
        lng: position.coords.longitude,
        lat: position.coords.latitude,
      });
    });

    this.map.on('click', (event) => {
      this.locationClick.emit({
        lng: event.lngLat.lng,
        lat: event.lngLat.lat,
      });
    });

    this.map.once('load', () => {
      this.mapHasLoaded = true;
    });
  }

  private updateMarker(location: MapLocation | null): void {
    if (!this.map) {
      return;
    }

    if (!location) {
      this.marker?.remove();
      this.marker = null;
      return;
    }

    if (this.marker) {
      this.marker.setLngLat([location.lng, location.lat]);
      return;
    }

    this.marker = new maplibregl.Marker({ color: '#1d4ed8' })
      .setLngLat([location.lng, location.lat])
      .addTo(this.map);
  }

  private async pumpOverlay(): Promise<void> {
    if (this.pumping) {
      return;
    }

    this.pumping = true;
    try {
      while (!this.sameOverlay(this.desiredOverlay, this.appliedOverlay)) {
        const target = this.desiredOverlay;
        if (target === null) {
          await this.waitForMapReady();
          await this.clearOverlayInternal();
          this.appliedOverlay = null;
          continue;
        }

        await this.waitForMapReady();
        await this.preloadImage(target.imageUrl);
        if (!this.sameOverlay(target, this.desiredOverlay)) {
          continue;
        }

        const settled = this.sourceSettled(target.imageUrl);
        this.updateOverlay(target.imageUrl, target.bbox);
        const didSettle = await settled;
        if (!this.sameOverlay(target, this.desiredOverlay)) {
          continue;
        }

        this.appliedOverlay = target;
        if (didSettle) {
          this.overlayApplied.emit(target.imageUrl);
        } else {
          this.overlayFailed.emit(target.imageUrl);
        }
      }
    } finally {
      this.pumping = false;
      if (!this.sameOverlay(this.desiredOverlay, this.appliedOverlay)) {
        void this.pumpOverlay();
      }
    }
  }

  private updateOverlay(
    imageUrl: string,
    bbox: [number, number, number, number],
  ): void {
    if (!this.map) {
      return;
    }

    const [west, south, east, north] = bbox;
    const coordinates: [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ] = [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ];

    const existingSource = this.map.getSource(OVERLAY_SOURCE_ID) as
      | maplibregl.ImageSource
      | undefined;

    if (existingSource) {
      existingSource.updateImage({ url: imageUrl, coordinates });
      return;
    }

    this.map.addSource(OVERLAY_SOURCE_ID, {
      type: 'image',
      url: imageUrl,
      coordinates,
    });

    this.map.addLayer({
      id: OVERLAY_LAYER_ID,
      type: 'raster',
      source: OVERLAY_SOURCE_ID,
      paint: {
        'raster-opacity': 0.85,
        'raster-fade-duration': 0,
      },
    });
  }

  private async clearOverlayInternal(): Promise<void> {
    if (!this.map) {
      return;
    }

    if (this.map.getLayer(OVERLAY_LAYER_ID)) {
      this.map.removeLayer(OVERLAY_LAYER_ID);
    }
    if (this.map.getSource(OVERLAY_SOURCE_ID)) {
      this.map.removeSource(OVERLAY_SOURCE_ID);
    }
  }

  private sourceSettled(imageUrl: string): Promise<boolean> {
    const map = this.map;
    if (!map) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve(true);
      }, SOURCE_SETTLE_TIMEOUT_MS);

      const onSourceData = (event: maplibregl.MapSourceDataEvent) => {
        if (event.sourceId && event.sourceId !== OVERLAY_SOURCE_ID) {
          return;
        }
        if (
          event.sourceDataType === 'metadata' ||
          event.sourceDataType === 'content' ||
          event.sourceDataType === 'idle'
        ) {
          cleanup();
          resolve(true);
        }
      };

      const onSourceEvent = (event?: { sourceDataType?: string }) => {
        if (
          event?.sourceDataType === 'metadata' ||
          event?.sourceDataType === 'content' ||
          event?.sourceDataType === 'idle'
        ) {
          cleanup();
          resolve(true);
        }
      };

      const onError = () => {
        cleanup();
        resolve(false);
      };

      const pollId = setInterval(() => {
        if (this.isSourceLoaded(imageUrl)) {
          cleanup();
          resolve(true);
        }
      }, 50);

      const cleanup = () => {
        clearTimeout(timeoutId);
        clearInterval(pollId);
        map.off('sourcedata', onSourceData);
        const source = map.getSource(OVERLAY_SOURCE_ID) as
          | maplibregl.ImageSource
          | undefined;
        source?.off('data', onSourceEvent);
        source?.off('error', onError);
      };

      map.on('sourcedata', onSourceData);
      const source = map.getSource(OVERLAY_SOURCE_ID) as
        | maplibregl.ImageSource
        | undefined;
      source?.on('data', onSourceEvent);
      source?.on('error', onError);
    });
  }

  private isSourceLoaded(imageUrl: string): boolean {
    const source = this.map?.getSource(OVERLAY_SOURCE_ID) as
      | (maplibregl.ImageSource & { loaded?: () => boolean })
      | undefined;
    if (!source) {
      return false;
    }
    if (source.url && source.url !== imageUrl) {
      return false;
    }
    return source.loaded?.() ?? false;
  }

  private sameOverlay(
    left: RadarOverlay | null,
    right: RadarOverlay | null,
  ): boolean {
    if (left === right) {
      return true;
    }
    if (left === null || right === null) {
      return false;
    }
    return (
      left.imageUrl === right.imageUrl &&
      left.bbox[0] === right.bbox[0] &&
      left.bbox[1] === right.bbox[1] &&
      left.bbox[2] === right.bbox[2] &&
      left.bbox[3] === right.bbox[3]
    );
  }

  private preloadImage(url: string): Promise<void> {
    return new Promise((resolve) => {
      const image = new Image();
      const timeoutId = setTimeout(() => resolve(), SOURCE_SETTLE_TIMEOUT_MS);
      const finish = () => {
        clearTimeout(timeoutId);
        resolve();
      };
      image.onload = finish;
      image.onerror = finish;
      image.src = url;
    });
  }

  private waitForMapReady(): Promise<void> {
    if (!this.map || this.mapHasLoaded) {
      return Promise.resolve();
    }
    if (this.map.isStyleLoaded()) {
      this.mapHasLoaded = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.map?.once('load', () => {
        this.mapHasLoaded = true;
        resolve();
      });
    });
  }
}
