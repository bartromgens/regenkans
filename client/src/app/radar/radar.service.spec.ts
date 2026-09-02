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

  it('resolveBbox deduplicates concurrent requests for the same bbox_url', async () => {
    let resolveFetch: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = service.resolveBbox(source);
    const second = service.resolveBbox(source);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(source.bbox_url);

    resolveFetch({
      ok: true,
      json: async () => ({ bbox: [3, 50, 7, 54] }),
    });

    const [bboxA, bboxB] = await Promise.all([first, second]);
    expect(bboxA).toEqual([3, 50, 7, 54]);
    expect(bboxB).toEqual([3, 50, 7, 54]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prefetchFrame deduplicates requests for the same image_url', () => {
    fetchMock.mockResolvedValue({ ok: true });

    service.prefetchFrame(source.image_url);
    service.prefetchFrame(source.image_url);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(source.image_url);
  });
});
