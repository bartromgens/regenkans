import { describe, expect, it } from 'vitest';

import { TimelineSlot } from '../radar/radar.service';
import { framesForSliderMode } from './slider-frames';

function makeFrame(index: number): TimelineSlot {
  return {
    valid_at: `2026-08-30T${String(index).padStart(2, '0')}:00:00Z`,
    kind: 'forecast',
    intensity: {
      issued_at: '2026-08-30T14:45:00Z',
      lead_minutes: index * 5,
      image_url: `/api/frame/${index}.png`,
      bbox_url: `/api/frame/${index}.bbox`,
      bbox: [3, 50, 7, 54],
    },
    probability: null,
    expected: null,
  };
}

describe('framesForSliderMode', () => {
  const observed = makeFrame(0);
  observed.kind = 'observed';
  observed.valid_at = '2026-08-30T12:00:00Z';

  const nowcast = makeFrame(1);
  nowcast.valid_at = '2026-08-30T13:30:00Z';

  const lateNowcast = makeFrame(2);
  lateNowcast.valid_at = '2026-08-30T14:30:00Z';

  const ensembleOnly = makeFrame(3);
  ensembleOnly.valid_at = '2026-08-30T15:30:00Z';
  ensembleOnly.intensity = null;
  ensembleOnly.probability = {
    issued_at: '2026-08-30T12:00:00Z',
    lead_minutes: 210,
    image_url: '/api/ensemble/3.png',
    bbox_url: '/api/ensemble/3.bbox',
    bbox: [3, 50, 7, 54],
  };

  const frames = [observed, nowcast, lateNowcast, ensembleOnly];

  it('keeps the full ensemble forecast in probability mode', () => {
    expect(framesForSliderMode(frames, 'probability')).toEqual(frames);
    expect(framesForSliderMode(frames, 'expected')).toEqual(frames);
  });

  it('limits the intensity slider to two hours of nowcast', () => {
    expect(framesForSliderMode(frames, 'intensity')).toEqual([observed, nowcast]);
  });
});
