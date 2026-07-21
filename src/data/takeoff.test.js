// #415 — pure takeoff-beat timing for a flyer launching from a dock: fades alpha 0→1 over the fade
// window, holds full-visible through the rest of the hover, then reports `done` (release to AI).
import { describe, it, expect } from 'vitest';
import { makeTakeoff, stepTakeoff, TAKEOFF_FADE_MS, TAKEOFF_HOVER_MS } from './takeoff.js';

describe('takeoff', () => {
  it('starts invisible and fully faded-in only after the fade window', () => {
    const st = makeTakeoff();
    // t=0: essentially invisible.
    expect(stepTakeoff({ elapsed: 0 }, 0).alpha).toBe(0);
    // Halfway through the fade → ~half alpha, not done.
    const half = stepTakeoff(st, TAKEOFF_FADE_MS / 2);
    expect(half.alpha).toBeGreaterThan(0.4);
    expect(half.alpha).toBeLessThan(0.6);
    expect(half.done).toBe(false);
  });

  it('reaches full alpha by the end of the fade but keeps hovering until the beat completes', () => {
    const st = makeTakeoff();
    const atFade = stepTakeoff(st, TAKEOFF_FADE_MS);
    expect(atFade.alpha).toBe(1);        // fully visible…
    expect(atFade.done).toBe(false);     // …but still hovering (fade < hover)
  });

  it('completes (done, alpha 1) once the hover beat elapses', () => {
    const st = makeTakeoff();
    const end = stepTakeoff(st, TAKEOFF_HOVER_MS);
    expect(end.done).toBe(true);
    expect(end.alpha).toBe(1);
  });

  it('accumulates across multiple partial ticks', () => {
    const st = makeTakeoff();
    let out;
    for (let i = 0; i < 10; i++) out = stepTakeoff(st, TAKEOFF_HOVER_MS / 10);
    expect(out.done).toBe(true);
  });

  it('has a fade window no longer than the whole hover beat', () => {
    expect(TAKEOFF_FADE_MS).toBeLessThanOrEqual(TAKEOFF_HOVER_MS);
  });
});
