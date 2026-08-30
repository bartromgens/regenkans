import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type FrameKind = 'observed' | 'forecast';

export interface RadarTimelineFrame {
  valid_at: string;
  kind: FrameKind;
  issued_at: string;
  lead_minutes: number;
  image_url: string;
  bbox: [number, number, number, number] | null;
}

export interface RadarTimelineResponse {
  generated_at: string;
  now: string | null;
  frames: RadarTimelineFrame[];
}

@Injectable({ providedIn: 'root' })
export class RadarService {
  private readonly http = inject(HttpClient);
  private readonly bboxCache = new Map<string, [number, number, number, number]>();

  getTimeline(hours = 6): Observable<RadarTimelineResponse> {
    return this.http.get<RadarTimelineResponse>('/api/radar/timeline/', {
      params: { hours: String(hours) },
    });
  }

  async resolveBbox(frame: RadarTimelineFrame): Promise<[number, number, number, number]> {
    if (frame.bbox) {
      this.bboxCache.set(frame.image_url, frame.bbox);
      return frame.bbox;
    }

    const cached = this.bboxCache.get(frame.image_url);
    if (cached) {
      return cached;
    }

    const response = await fetch(frame.image_url);
    if (!response.ok) {
      throw new Error(`Failed to load radar frame: ${response.status}`);
    }

    const bboxHeader = response.headers.get('X-Radar-BBox');
    if (!bboxHeader) {
      throw new Error('Radar frame response missing X-Radar-BBox header');
    }

    const bbox = bboxHeader.split(',').map(Number) as [number, number, number, number];
    this.bboxCache.set(frame.image_url, bbox);
    return bbox;
  }

  prefetchFrame(imageUrl: string): void {
    void fetch(imageUrl).catch(() => undefined);
  }
}
