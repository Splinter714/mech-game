import { describe, it, expect } from 'vitest';
import { dominantDir, DirRepeater, stepIndex, scrollToShow, slotBindAction, REPEAT_INITIAL, REPEAT_INTERVAL } from './padNav.js';

describe('dominantDir', () => {
  it('returns null inside the deadzone', () => {
    expect(dominantDir(0, 0)).toBeNull();
    expect(dominantDir(0.3, 0.3)).toBeNull();   // hypot ≈ 0.42 < 0.55
  });

  it('picks the dominant axis', () => {
    expect(dominantDir(1, 0.2)).toBe('right');
    expect(dominantDir(-1, 0.2)).toBe('left');
    expect(dominantDir(0.2, 1)).toBe('down');
    expect(dominantDir(0.2, -1)).toBe('up');
  });

  it('respects a custom deadzone', () => {
    expect(dominantDir(0.4, 0, 0.3)).toBe('right');
    expect(dominantDir(0.4, 0, 0.5)).toBeNull();
  });
});

describe('DirRepeater', () => {
  it('steps immediately on a new direction', () => {
    const r = new DirRepeater();
    expect(r.step('down', 1000)).toBe('down');
  });

  it('holds through the initial delay, then repeats on the interval', () => {
    const r = new DirRepeater();
    expect(r.step('down', 0)).toBe('down');                       // instant first step
    expect(r.step('down', REPEAT_INITIAL - 1)).toBeNull();        // still in initial delay
    expect(r.step('down', REPEAT_INITIAL)).toBe('down');          // first repeat
    expect(r.step('down', REPEAT_INITIAL + REPEAT_INTERVAL - 1)).toBeNull();
    expect(r.step('down', REPEAT_INITIAL + REPEAT_INTERVAL)).toBe('down');
  });

  it('a direction change steps instantly and resets the timer', () => {
    const r = new DirRepeater();
    r.step('down', 0);
    expect(r.step('up', 50)).toBe('up');                          // flip fires immediately
    expect(r.step('up', 50 + REPEAT_INITIAL - 1)).toBeNull();     // full initial delay again
    expect(r.step('up', 50 + REPEAT_INITIAL)).toBe('up');
  });

  it('release resets, so re-pressing the same direction steps instantly', () => {
    const r = new DirRepeater();
    r.step('down', 0);
    expect(r.step(null, 100)).toBeNull();
    expect(r.step('down', 120)).toBe('down');
  });

  it('honours custom timings', () => {
    const r = new DirRepeater({ initial: 100, interval: 40 });
    r.step('left', 0);
    expect(r.step('left', 99)).toBeNull();
    expect(r.step('left', 100)).toBe('left');
    expect(r.step('left', 139)).toBeNull();
    expect(r.step('left', 140)).toBe('left');
  });
});

describe('stepIndex', () => {
  it('wraps around by default (the tile row)', () => {
    expect(stepIndex(0, -1, 5)).toBe(4);
    expect(stepIndex(4, 1, 5)).toBe(0);
    expect(stepIndex(2, 1, 5)).toBe(3);
  });

  it('clamps when wrap is off (the catalog list)', () => {
    expect(stepIndex(0, -1, 5, { wrap: false })).toBe(0);
    expect(stepIndex(4, 1, 5, { wrap: false })).toBe(4);
    expect(stepIndex(1, 1, 5, { wrap: false })).toBe(2);
  });

  it('returns -1 for an empty collection', () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
    expect(stepIndex(0, -1, 0, { wrap: false })).toBe(-1);
  });
});

describe('slotBindAction (catalog-first pad quick-mount, never clears — #70)', () => {
  it('mounts the highlighted item into an empty slot', () => {
    expect(slotBindAction(null, 'autocannon')).toBe('mount');
  });

  it('mounts the highlighted item over a different existing mount (replace)', () => {
    expect(slotBindAction('laser', 'autocannon')).toBe('mount');
  });

  it('is a no-op (never clears) when the slot already holds exactly the highlighted item', () => {
    expect(slotBindAction('autocannon', 'autocannon')).toBe('none');
  });

  it('works the same way for any other weapon id (generic string logic, no item lookup)', () => {
    expect(slotBindAction(null, 'beamLaser')).toBe('mount');
    expect(slotBindAction('beamLaser', 'beamLaser')).toBe('none');   // re-press keeps it mounted
  });

  it('does nothing when nothing is highlighted', () => {
    expect(slotBindAction(null, null)).toBe('none');
    expect(slotBindAction('autocannon', null)).toBe('none');
  });
});

describe('scrollToShow', () => {
  // viewport 300 tall, content items 96 tall
  it('leaves the scroll alone when the item is already visible', () => {
    expect(scrollToShow(100, 150, 96, 300, 1000)).toBe(100);
  });

  it('scrolls up just enough when the item is above the viewport', () => {
    expect(scrollToShow(400, 150, 96, 300, 1000)).toBe(150);
  });

  it('scrolls down just enough when the item is below the viewport', () => {
    // item bottom 496 > view bottom 300 → scroll = 496 - 300 = 196
    expect(scrollToShow(0, 400, 96, 300, 1000)).toBe(196);
  });

  it('clamps to [0, maxScroll]', () => {
    expect(scrollToShow(50, -20, 96, 300, 1000)).toBe(0);        // top item → 0
    expect(scrollToShow(0, 950, 96, 300, 700)).toBe(700);        // deep item → maxScroll
    expect(scrollToShow(0, 100, 96, 300, 0)).toBe(0);            // content shorter than view
  });
});
