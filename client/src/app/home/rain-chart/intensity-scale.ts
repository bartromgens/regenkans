import { LinearScale, LinearScaleOptions, Tick } from 'chart.js';

declare module 'chart.js' {
  interface CartesianScaleTypeRegistry {
    rainIntensity: {
      options: LinearScaleOptions;
    };
  }
}

export const RAIN_INTENSITY_SCALE_ID = 'rainIntensity';

// Rain intensity spans two orders of magnitude, so on a linear axis a single
// 40 mm/u peak flattens a steady 1 mm/u to a few pixels even though it is
// still rain that gets you wet. Square root keeps 0 mm/u representable (a log
// axis does not, and dry is the common case) and lifts 1 mm/u to about a sixth
// of the plot height on a 0-40 axis.
function toAxisSpace(value: number): number {
  return Math.sqrt(Math.max(value, 0));
}

// Snapping the top of the axis to fixed steps keeps the intensity bands from
// shifting on every refresh and keeps the ticks below on round values.
const AXIS_MAX_STEPS = [2.5, 5, 10, 25, 50] as const;
const AXIS_MAX_STEP_ABOVE_STEPS = 50;

const TICK_VALUES = [0.1, 1, 5, 10, 25, 50] as const;

// The ticks are unevenly spaced, so Chart.js' autoSkip (which drops every nth
// tick) cannot pull them apart; crowded ones are dropped here instead. The
// fraction is one label height on the shortest chart, the mobile overlay.
const MIN_TICK_GAP_FRACTION = 0.08;

export function snapAxisMax(dataMax: number): number {
  const step = AXIS_MAX_STEPS.find((candidate) => dataMax <= candidate);
  if (step !== undefined) {
    return step;
  }
  return (
    Math.ceil(dataMax / AXIS_MAX_STEP_ABOVE_STEPS) * AXIS_MAX_STEP_ABOVE_STEPS
  );
}

/** Position of `value` on the axis, 0 at the bottom and 1 at the top. */
export function axisDecimalFor(
  value: number,
  min: number,
  max: number,
): number {
  const start = toAxisSpace(min);
  const span = toAxisSpace(max) - start;
  if (span <= 0) {
    return 0;
  }
  return (toAxisSpace(value) - start) / span;
}

export function tickValuesFor(min: number, max: number): number[] {
  const span = toAxisSpace(max) - toAxisSpace(min);
  if (span <= 0) {
    return [min];
  }

  const candidates = [
    min,
    ...TICK_VALUES.filter((value) => value > min && value < max),
    max,
  ];

  const kept: number[] = [];
  for (const value of candidates) {
    const previous = kept[kept.length - 1];
    if (previous === undefined) {
      kept.push(value);
      continue;
    }
    const gap = (toAxisSpace(value) - toAxisSpace(previous)) / span;
    if (gap >= MIN_TICK_GAP_FRACTION) {
      kept.push(value);
    }
  }
  return kept;
}

export class RainIntensityScale extends LinearScale {
  static override id = RAIN_INTENSITY_SCALE_ID;

  override determineDataLimits(): void {
    super.determineDataLimits();
    if (!Number.isFinite(this.options.max)) {
      this.max = snapAxisMax(this.max);
    }
  }

  override buildTicks(): Tick[] {
    return tickValuesFor(this.min, this.max).map((value) => ({ value }));
  }

  override getPixelForValue(value: number): number {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return NaN;
    }
    return this.getPixelForDecimal(
      axisDecimalFor(value, this.min, this.max),
    );
  }

  override getValueForPixel(pixel: number): number {
    const start = toAxisSpace(this.min);
    const span = toAxisSpace(this.max) - start;
    const axisValue = start + this.getDecimalForPixel(pixel) * span;
    return axisValue * axisValue;
  }
}
