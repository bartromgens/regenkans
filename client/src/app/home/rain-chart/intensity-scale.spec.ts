import { describe, expect, it } from 'vitest';

import { axisDecimalFor, snapAxisMax, tickValuesFor } from './intensity-scale';

describe('rain intensity scale', () => {
  it('keeps light rain visible next to a heavy peak', () => {
    const max = snapAxisMax(40);

    // On a linear axis 1 mm/u would sit at 1/50 of the plot height, a few
    // pixels in a 220px chart.
    expect(axisDecimalFor(1, 0, max)).toBeGreaterThan(0.1);
  });

  it('maps the axis bounds to the full height', () => {
    expect(axisDecimalFor(0, 0, 10)).toBe(0);
    expect(axisDecimalFor(10, 0, 10)).toBe(1);
  });

  it('stays monotonic and treats negatives as dry', () => {
    expect(axisDecimalFor(0.1, 0, 10)).toBeLessThan(axisDecimalFor(1, 0, 10));
    expect(axisDecimalFor(1, 0, 10)).toBeLessThan(axisDecimalFor(5, 0, 10));
    expect(axisDecimalFor(-1, 0, 10)).toBe(0);
  });

  it('collapses to the bottom when the range is empty', () => {
    expect(axisDecimalFor(5, 0, 0)).toBe(0);
  });

  it('snaps the axis maximum to fixed steps', () => {
    expect(snapAxisMax(0)).toBe(2.5);
    expect(snapAxisMax(2.5)).toBe(2.5);
    expect(snapAxisMax(3)).toBe(5);
    expect(snapAxisMax(40)).toBe(50);
    expect(snapAxisMax(120)).toBe(150);
  });

  it('labels the band boundaries that fit', () => {
    expect(tickValuesFor(0, 2.5)).toEqual([0, 0.1, 1, 2.5]);
    expect(tickValuesFor(0, 10)).toEqual([0, 0.1, 1, 5, 10]);
  });

  it('drops ticks that would overlap once the axis grows', () => {
    // 0.1 sits ~4% up a 0-50 axis, too close to the zero label.
    expect(tickValuesFor(0, 50)).toEqual([0, 1, 5, 10, 25, 50]);
  });
});
