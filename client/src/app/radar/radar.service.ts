import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type FrameKind = 'observed' | 'forecast';
export type OverlayMode = 'intensity' | 'probability' | 'expected';

export interface FrameSource {
  issued_at: string;
  lead_minutes: number;
  image_url: string;
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
}

export interface PointSeriesPoint {
  valid_at: string;
  kind: FrameKind;
  intensity: number | null;
  probability: number | null;
  expected: number | null;
}

export interface PointSeriesResponse {
  lat: number;
  lng: number;
  now: string | null;
  points: PointSeriesPoint[];
}

@Injectable({ providedIn: 'root' })
export class RadarService {
  private readonly http = inject(HttpClient);
  private readonly bboxCache = new Map<string, [number, number, number, number]>();

  getTimeline(hours = 24): Observable<RadarTimelineResponse> {
    return this.http.get<RadarTimelineResponse>('/api/radar/timeline/', {
      params: { hours: String(hours) },
    });
  }

  getProbabilityTimeline(hours = 24): Observable<ProbabilityTimelineResponse> {
    return this.http.get<ProbabilityTimelineResponse>('/api/ensemble/timeline/', {
      params: { hours: String(hours) },
    });
  }

  getPointSeries(lat: number, lng: number, hours = 24): Observable<PointSeriesResponse> {
    return this.http.get<PointSeriesResponse>('/api/radar/point/', {
      params: {
        lat: String(lat),
        lng: String(lng),
        hours: String(hours),
      },
    });
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

    const response = await fetch(source.image_url);
    if (!response.ok) {
      throw new Error(`Failed to load radar frame: ${response.status}`);
    }

    const bboxHeader = response.headers.get('X-Radar-BBox');
    if (!bboxHeader) {
      throw new Error('Radar frame response missing X-Radar-BBox header');
    }

    const bbox = bboxHeader.split(',').map(Number) as [number, number, number, number];
    this.bboxCache.set(source.image_url, bbox);
    return bbox;
  }

  prefetchFrame(imageUrl: string): void {
    void fetch(imageUrl).catch(() => undefined);
  }
}
