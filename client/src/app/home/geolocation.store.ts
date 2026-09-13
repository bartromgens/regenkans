import { Injectable, signal } from '@angular/core';
import { MapLocation } from './radar-map/radar-map';

const GEOLOCATION_TIMEOUT_MS = 10_000;

/**
 * One-shot browser geolocation, used to pick a location for the mobile chart
 * tab when the user has not tapped the map.
 */
@Injectable()
export class GeolocationStore {
  private loadToken = 0;

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Abandon any request in flight, so its result is ignored when it lands. */
  cancel(): void {
    this.loadToken += 1;
    this.loading.set(false);
  }

  /** Resolves to the user's position, or `null` when it could not be had. */
  async request(): Promise<MapLocation | null> {
    this.cancel();
    const token = this.loadToken;
    this.error.set(null);

    if (!navigator.geolocation) {
      this.error.set('Locatiebepaling wordt niet ondersteund door je browser.');
      return null;
    }

    this.loading.set(true);

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: GEOLOCATION_TIMEOUT_MS,
          maximumAge: 60_000,
        });
      });

      if (token !== this.loadToken) {
        return null;
      }

      return { lng: position.coords.longitude, lat: position.coords.latitude };
    } catch {
      if (token !== this.loadToken) {
        return null;
      }

      this.error.set('Kan je locatie niet bepalen. Kies handmatig een punt op de kaart.');
      return null;
    } finally {
      if (token === this.loadToken) {
        this.loading.set(false);
      }
    }
  }
}
