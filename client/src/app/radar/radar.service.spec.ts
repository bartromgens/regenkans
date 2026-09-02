import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FrameSource, RadarService } from './radar.service';

describe('RadarService', () => {
  let service: RadarService;
  let fetchMock: ReturnType<typeof vi.fn>;

  const source: FrameSource = {
    issued_at: '2026-08-30T14:45:00Z',
    lead_minutes: 5,
    image_url: '/api/radar/frames/RAD_NL25_RAC_FM_202608301445.h5/5.png',
    bbox_url: '/api/radar/frames/RAD_NL25_RAC_FM_202608301445.h5/5.bbox',
    bbox: null,
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    TestBed.configureTestingModule({
      providers: [RadarService, provideHttpClient()],
    });
    service = TestBed.inject(RadarService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolveBbox fetches bbox_url and forwards the abort signal', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ bbox: [3, 50, 7, 54] }),
    });

    const bbox = await service.resolveBbox(source, controller.signal);

    expect(bbox).toEqual([3, 50, 7, 54]);
    expect(fetchMock).toHaveBeenCalledWith(source.bbox_url, {
      signal: controller.signal,
    });
  });

  it('prefetchFrame forwards the abort signal to fetch', () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue({ ok: true });

    service.prefetchFrame(source.image_url, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(source.image_url, {
      signal: controller.signal,
    });
  });
});
