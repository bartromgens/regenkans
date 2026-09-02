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

  private map: maplibregl.Map | null = null;
  private marker: maplibregl.Marker | null = null;

  constructor() {
    effect(() => {
      const overlay = this.overlay();
      if (overlay) {
        void this.applyOverlay(overlay);
      } else {
        void this.clearOverlay();
      }
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

  private async applyOverlay(overlay: RadarOverlay): Promise<void> {
    await this.waitForMapReady();
    this.updateOverlay(overlay.imageUrl, overlay.bbox);
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
      },
    });
  }

  private async clearOverlay(): Promise<void> {
    await this.waitForMapReady();
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

  private waitForMapReady(): Promise<void> {
    if (!this.map) {
      return Promise.resolve();
    }
    if (this.map.isStyleLoaded()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.map?.once('load', () => resolve());
    });
  }
}
