import { FrameSource, OverlayMode, TimelineSlot } from '../radar/radar.service';

/**
 * The image a slot contributes in a given mode, or `null` when it has none.
 *
 * Observed slots fall back to their measured intensity in the forecast modes,
 * since there is nothing to forecast about a moment that already happened.
 */
export function sourceForMode(slot: TimelineSlot, mode: OverlayMode): FrameSource | null {
  if (mode === 'intensity') {
    return slot.intensity;
  }
  if (mode === 'expected') {
    if (slot.expected) {
      return slot.expected;
    }
    if (slot.kind === 'observed' && slot.intensity) {
      return slot.intensity;
    }
    return null;
  }
  if (slot.probability) {
    return slot.probability;
  }
  if (slot.kind === 'observed' && slot.intensity) {
    return slot.intensity;
  }
  return null;
}

export function unavailableMessage(mode: OverlayMode): string {
  if (mode === 'intensity') {
    return 'Intensiteit niet beschikbaar voor dit tijdstip.';
  }
  if (mode === 'expected') {
    return 'Verwachte intensiteit niet beschikbaar voor dit tijdstip.';
  }
  return 'Kans niet beschikbaar voor dit tijdstip.';
}
