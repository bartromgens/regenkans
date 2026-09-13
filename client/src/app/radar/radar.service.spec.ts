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
    fetchMock.mockResolvedValue(okResponse());

    service.prefetchFrame(source.image_url);
    service.prefetchFrame(source.image_url);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(source.image_url, { priority: 'low' });
  });

  it('prefetchFrame reads the body so the transfer is not cancelled', async () => {
    const response = okResponse();
    fetchMock.mockResolvedValue(response);

    service.prefetchFrame(source.image_url);
    await vi.waitFor(() => expect(response.blob).toHaveBeenCalledTimes(1));
  });

  it('warmFrames keeps at most four requests in flight', async () => {
    const pending: Array<(value: unknown) => void> = [];
    fetchMock.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );

    service.warmFrames(frameUrls(10));

    expect(fetchMock).toHaveBeenCalledTimes(4);

    pending[0](okResponse());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
  });

  it('warmFrames queues behind nothing when prefetchFrame jumps the queue', async () => {
    const pending: Array<(value: unknown) => void> = [];
    fetchMock.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );

    service.warmFrames(frameUrls(10));
    service.prefetchFrame('/api/radar/frames/urgent.h5/0.png');

    pending[0](okResponse());
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/radar/frames/urgent.h5/0.png', {
        priority: 'low',
      }),
    );
  });

  it('warmFrames does nothing when the browser asks to save data', () => {
    vi.stubGlobal('navigator', { connection: { saveData: true } });
    fetchMock.mockResolvedValue(okResponse());

    service.warmFrames(frameUrls(10));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('warmFrames does nothing on a slow connection', () => {
    vi.stubGlobal('navigator', { connection: { effectiveType: '2g' } });
    fetchMock.mockResolvedValue(okResponse());

    service.warmFrames(frameUrls(10));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancelQueuedPrefetches drops frames that have not started', async () => {
    const pending: Array<(value: unknown) => void> = [];
    fetchMock.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );

    service.warmFrames(frameUrls(10));
    service.cancelQueuedPrefetches();

    pending[0](okResponse());
    pending[1](okResponse());

    // Only the four already in flight ever reach the network.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });

  it('cancelQueuedPrefetches lets a dropped frame be requested again', async () => {
    const pending: Array<(value: unknown) => void> = [];
    fetchMock.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );

    const dropped = frameUrls(6)[5];
    service.warmFrames(frameUrls(6));
    service.cancelQueuedPrefetches();
    service.prefetchFrame(dropped);

    // It still waits for a slot: the concurrency cap applies to urgent frames
    // too, and the frame on screen is loaded by the map, not by this queue.
    expect(fetchMock).toHaveBeenCalledTimes(4);

    pending[0](okResponse());
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(5, dropped, { priority: 'low' }),
    );
  });
});

function okResponse() {
  return { ok: true, blob: vi.fn().mockResolvedValue(new Blob()) };
}

function frameUrls(count: number): string[] {
  return Array.from(
    { length: count },
    (_value, index) => `/api/radar/frames/RAD.h5/${index}.png`,
  );
}
