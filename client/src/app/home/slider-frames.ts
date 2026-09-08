import {
  NOWCAST_FORECAST_HOURS,
  OverlayMode,
  TimelineSlot,
} from '../radar/radar.service';

const HOUR_MS = 60 * 60 * 1000;

export function framesForSliderMode(
  frames: TimelineSlot[],
  mode: OverlayMode,
): TimelineSlot[] {
  if (mode !== 'intensity') {
    return frames;
  }

  const originMs = lastObservedMs(frames);
  const cutoffMs =
    originMs === null ? null : originMs + NOWCAST_FORECAST_HOURS * HOUR_MS;

  return frames.filter((slot) => {
    if (slot.intensity === null) {
      return false;
    }
    if (cutoffMs === null) {
      return true;
    }
    return new Date(slot.valid_at).getTime() <= cutoffMs;
  });
}

function lastObservedMs(frames: TimelineSlot[]): number | null {
  for (let index = frames.length - 1; index >= 0; index--) {
    if (frames[index].kind === 'observed') {
      return new Date(frames[index].valid_at).getTime();
    }
  }
  return null;
}
