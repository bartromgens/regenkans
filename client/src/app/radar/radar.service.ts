import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type FrameKind = 'observed' | 'forecast';
export type OverlayMode = 'intensity' | 'probability' | 'expected';

export interface FrameSource {
  issued_at: string;
  lead_minutes: number;
  image_url: string;
  bbox_url: string;
  bbox: [number, number, number, number] | null;
}

export interface TimelineSlot {
  valid_at: string;
  kind: FrameKind;
  intensity: FrameSource | null;
  probability: FrameSource | null;
  expected: FrameSource | null;
}

export interface RadarTimelineResponse {
  generated_at: string;
  now: string | null;
  frames: TimelineSlot[];
}

export interface ProbabilityTimelineResponse extends RadarTimelineResponse {
  ensemble_available: boolean;
  knmi_ensemble_unavailable: boolean;
}

export interface PointSeriesPoint {
  valid_at: string;
  kind: FrameKind;
  intensity: number | null;
  probability: number | null;
  expected: number | null;
  p25: number | null;
  p75: number | null;
}

export interface PointSeriesResponse {
  lat: number;
  lng: number;
  now: string | null;
  points: PointSeriesPoint[];
}

/** History and ensemble forecast window on the slider and default chart. */
export const TIMELINE_WINDOW_HOURS = 4;
/** Radar nowcast forecast window on the intensity slider. */
export const NOWCAST_FORECAST_HOURS = 2;

/**
 * How many frame prefetches may be in flight at once.
 *
 * Frames are warmed a whole slider window at a time, so they need a ceiling:
 * without one they would saturate the connection and delay the basemap tiles
 * and the frame the user is actually looking at.
 */
const MAX_CONCURRENT_PREFETCHES = 4;

const SLOW_CONNECTION_TYPES = new Set(['slow-2g', '2g', '3g']);

interface BboxResponse {
  bbox: [number, number, number, number];
}

/** `priority` is not in the DOM typings yet, but browsers honour it. */
interface PrefetchRequestInit extends RequestInit {
  priority?: 'high' | 'low' | 'auto';
}

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

@Injectable({ providedIn: 'root' })
export class RadarService {
  private readonly http = inject(HttpClient);
  private readonly bboxCache = new Map<string, [number, number, number, number]>();
  private readonly pendingBboxFetches = new Map<
    string,
    Promise<[number, number, number, number]>
  >();
  /** Image URLs already requested, whether queued, in flight or cached. */
  private readonly prefetchedImageUrls = new Set<string>();
  private readonly prefetchQueue: string[] = [];
  private inFlightPrefetches = 0;

  getTimeline(hours = 24): Observable<RadarTimelineResponse> {
    return this.http.get<RadarTimelineResponse>('/api/radar/timeline/', {
      params: { hours: String(hours) },
    });
  }

  getProbabilityTimeline(
    hours = TIMELINE_WINDOW_HOURS,
    futureHours = TIMELINE_WINDOW_HOURS,
  ): Observable<ProbabilityTimelineResponse> {
    return this.http.get<ProbabilityTimelineResponse>('/api/ensemble/timeline/', {
      params: {
        hours: String(hours),
        future_hours: String(futureHours),
      },
    });
  }

  getPointSeries(
    lat: number,
    lng: number,
    hours = 24,
    futureHours?: number,
  ): Observable<PointSeriesResponse> {
    const params: Record<string, string> = {
      lat: String(lat),
      lng: String(lng),
      hours: String(hours),
    };
    if (futureHours !== undefined) {
      params['future_hours'] = String(futureHours);
    }
    return this.http.get<PointSeriesResponse>('/api/radar/point/', { params });
  }

  async resolveBbox(source: FrameSource): Promise<[number, number, number, number]> {
    if (source.bbox) {
      this.bboxCache.set(source.image_url, source.bbox);
      return source.bbox;
    }

    const cached = this.bboxCache.get(source.image_url);
    if (cached) {
      return cached;
    }

    const pending = this.pendingBboxFetches.get(source.bbox_url);
    if (pending) {
      return pending;
    }

    const request = this.fetchBbox(source).finally(() => {
      this.pendingBboxFetches.delete(source.bbox_url);
    });
    this.pendingBboxFetches.set(source.bbox_url, request);
    return request;
  }

  /**
   * Warm a single frame ahead of anything already queued.
   *
   * Used for the frames next to the slider handle: whatever the background
   * warm-up is working through, those are the ones the user reaches next.
   */
  prefetchFrame(imageUrl: string): void {
    this.enqueuePrefetch(imageUrl, 'front');
  }

  /**
   * Warm a run of frames in the background, in the order given.
   *
   * Skipped on metered or slow connections: near-neighbour prefetching keeps
   * scrubbing usable there, and several MB of frames the visitor may never
   * look at is a poor trade on mobile data.
   */
  warmFrames(imageUrls: string[]): void {
    if (!this.bulkPrefetchAllowed()) {
      return;
    }

    for (const imageUrl of imageUrls) {
      this.enqueuePrefetch(imageUrl, 'back');
    }
  }

  /**
   * Drop frames that have not started loading yet.
   *
   * Called when the mode changes: the queued frames belong to the mode the
   * user just left, so finishing them would only delay the new one.
   */
  cancelQueuedPrefetches(): void {
    for (const imageUrl of this.prefetchQueue) {
      this.prefetchedImageUrls.delete(imageUrl);
    }
    this.prefetchQueue.length = 0;
  }

  private enqueuePrefetch(imageUrl: string, position: 'front' | 'back'): void {
    if (this.prefetchedImageUrls.has(imageUrl)) {
      return;
    }

    this.prefetchedImageUrls.add(imageUrl);
    if (position === 'front') {
      this.prefetchQueue.unshift(imageUrl);
    } else {
      this.prefetchQueue.push(imageUrl);
    }
    this.drainPrefetchQueue();
  }

  private drainPrefetchQueue(): void {
    while (
      this.inFlightPrefetches < MAX_CONCURRENT_PREFETCHES &&
      this.prefetchQueue.length > 0
    ) {
      const imageUrl = this.prefetchQueue.shift() as string;
      this.inFlightPrefetches += 1;
      void this.fetchIntoCache(imageUrl).finally(() => {
        this.inFlightPrefetches -= 1;
        this.drainPrefetchQueue();
      });
    }
  }

  private async fetchIntoCache(imageUrl: string): Promise<void> {
    const init: PrefetchRequestInit = { priority: 'low' };

    try {
      const response = await fetch(imageUrl, init);
      // The body has to be read to completion. A response whose body is never
      // consumed can have its transfer cancelled once it is garbage collected,
      // which would leave nothing in the HTTP cache for the map to reuse.
      await response.blob();
      if (!response.ok) {
        this.prefetchedImageUrls.delete(imageUrl);
      }
    } catch {
      this.prefetchedImageUrls.delete(imageUrl);
    }
  }

  private bulkPrefetchAllowed(): boolean {
    const connection = (
      navigator as Navigator & { connection?: NetworkInformation }
    ).connection;
    if (!connection) {
      return true;
    }
    if (connection.saveData) {
      return false;
    }
    return !SLOW_CONNECTION_TYPES.has(connection.effectiveType ?? '');
  }

  private async fetchBbox(
    source: FrameSource,
  ): Promise<[number, number, number, number]> {
    const response = await fetch(source.bbox_url);
    if (!response.ok) {
      throw new Error(`Failed to load radar frame bbox: ${response.status}`);
    }

    const payload = (await response.json()) as BboxResponse;
    this.bboxCache.set(source.image_url, payload.bbox);
    return payload.bbox;
  }
}
