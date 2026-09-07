import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { TimelinePanel } from './timeline-panel';
import { TimelineSlot } from '../../radar/radar.service';

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

describe('TimelinePanel play button', () => {
  let fixture: ComponentFixture<TimelinePanel>;
  let panel: TimelinePanel;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TimelinePanel],
    }).compileComponents();

    fixture = TestBed.createComponent(TimelinePanel);
    panel = fixture.componentInstance;
    fixture.componentRef.setInput('frames', [makeFrame(0), makeFrame(1)]);
    fixture.detectChanges();
  });

  function playButton(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('.timeline-play-button');
  }

  it('shows a "play" label and emits playToggle on click', () => {
    let emitted = 0;
    panel.playToggle.subscribe(() => emitted++);

    const button = playButton();
    expect(button.getAttribute('aria-label')).toBe('Speel animatie af');
    expect(button.getAttribute('aria-pressed')).toBe('false');

    button.click();
    expect(emitted).toBe(1);
  });

  it('switches to a "pause" label when playing', () => {
    fixture.componentRef.setInput('playing', true);
    fixture.detectChanges();

    const button = playButton();
    expect(button.getAttribute('aria-label')).toBe('Pauzeer animatie');
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('disables the button when there is nothing to animate', () => {
    fixture.componentRef.setInput('frames', [makeFrame(0)]);
    fixture.detectChanges();

    expect(playButton().disabled).toBe(true);
  });
});

describe('TimelinePanel time labels', () => {
  let fixture: ComponentFixture<TimelinePanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TimelinePanel],
    }).compileComponents();

    fixture = TestBed.createComponent(TimelinePanel);
    fixture.componentRef.setInput('frames', [makeFrame(14)]);
    fixture.componentRef.setInput('selectedIndex', 0);
    fixture.componentRef.setInput('currentLabel', 'zo 30 aug 16:00');
    fixture.detectChanges();
  });

  it('keeps the full date label and a time-only label for the selected frame', () => {
    const full = fixture.nativeElement.querySelector('.timeline-label--full');
    const time = fixture.nativeElement.querySelector('.timeline-label--time');

    expect(full.textContent.trim()).toBe('zo 30 aug 16:00');
    expect(time.textContent.trim()).toBe(
      new Intl.DateTimeFormat('nl-NL', {
        timeZone: 'Europe/Amsterdam',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date('2026-08-30T14:00:00Z')),
    );
  });
});
