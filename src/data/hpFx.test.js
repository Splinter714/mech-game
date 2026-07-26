// #495 follow-up, experimental HP-depletion visuals (flicker/static/sparks). Pure functions only
// — no Phaser, no timers — so every case here is a plain (t, seed, urgency) -> value check. The
// hash underneath is deterministic (a seeded sine hash, same idiom art/projectileArt.js's beam
// sparks use), so reproducibility itself is a real assertion, not an assumption.
import { describe, it, expect } from 'vitest';
import { hpUrgency, hpFlicker, hpStaticSpecks, hpSparks, hpCriticalFlash, HP_CRITICAL_FRAC } from './hpFx.js';

describe('hpUrgency', () => {
  it('is 0 at and above ~70% hp — a scratch never glitches', () => {
    expect(hpUrgency(1)).toBe(0);
    expect(hpUrgency(0.85)).toBe(0);
    expect(hpUrgency(0.7)).toBe(0);
  });

  it('is 1 at zero hp', () => {
    expect(hpUrgency(0)).toBe(1);
  });

  it('rises monotonically as hp drops below the 70% floor', () => {
    const u50 = hpUrgency(0.5), u30 = hpUrgency(0.3), u10 = hpUrgency(0.1);
    expect(u50).toBeGreaterThan(0);
    expect(u30).toBeGreaterThan(u50);
    expect(u10).toBeGreaterThan(u30);
  });

  it('the ramp is back-loaded — urgency at 35% hp is under half, not linear', () => {
    // Linear would give 0.5 at the midpoint of the 0..0.7 range (hp=0.35); the eased curve is
    // meant to stay well under that until hp is nearly gone.
    expect(hpUrgency(0.35)).toBeLessThan(0.5);
  });

  it('clamps out-of-range input', () => {
    expect(hpUrgency(-1)).toBe(1);
    expect(hpUrgency(1.5)).toBe(0);
    expect(hpUrgency(undefined)).toBe(1);
  });
});

describe('hpFlicker', () => {
  it('is exactly 1 (no jitter at all) once urgency is 0', () => {
    expect(hpFlicker(12.34, 2, 0)).toBe(1);
    expect(hpFlicker(0, 0, 0)).toBe(1);
  });

  it('stays within [1 - 0.6*urgency, 1 + 0.6*urgency] for any t/seed', () => {
    const urgency = 0.8;
    const amp = 0.6 * urgency;
    for (let i = 0; i < 40; i++) {
      const v = hpFlicker(i * 0.037, i, urgency);
      expect(v).toBeGreaterThanOrEqual(1 - amp - 1e-9);
      expect(v).toBeLessThanOrEqual(1 + amp + 1e-9);
    }
  });

  it('is deterministic — the same (t, seed, urgency) always reproduces the same value', () => {
    expect(hpFlicker(5.5, 3, 0.6)).toBe(hpFlicker(5.5, 3, 0.6));
  });

  it('two different seeds at the same instant generally disagree — tiles do not strobe in lockstep', () => {
    const a = hpFlicker(1.0, 0, 1);
    const b = hpFlicker(1.0, 1, 1);
    const c = hpFlicker(1.0, 2, 1);
    // Not a mathematical guarantee for arbitrary seeds, but true for this fixed, checked-in set —
    // regressing to "all seeds collide" would be a real bug in the per-tile seeding.
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });

  it('holds its value for a short run of nearby t within the same quantised step', () => {
    // At urgency 1 the re-roll rate is 4 + 16 = 20 steps/sec, i.e. a step is 50ms wide. Two
    // instants a millisecond apart must land in the same step and read identical.
    const t0 = 2.000;
    expect(hpFlicker(t0, 5, 1)).toBe(hpFlicker(t0 + 0.001, 5, 1));
  });
});

describe('hpStaticSpecks', () => {
  const rect = { x: 100, y: 200, w: 80, h: 80 };

  it('is empty at zero urgency', () => {
    expect(hpStaticSpecks(rect, 3, 1, 0)).toEqual([]);
  });

  it('speck count scales with urgency (up to 5 at full urgency)', () => {
    expect(hpStaticSpecks(rect, 1, 0, 1).length).toBe(5);
    expect(hpStaticSpecks(rect, 1, 0, 0.4).length).toBe(Math.round(5 * 0.4));
  });

  it('every speck lands inside the given rect', () => {
    const specks = hpStaticSpecks(rect, 7.7, 2, 1);
    for (const s of specks) {
      expect(s.x).toBeGreaterThanOrEqual(rect.x);
      expect(s.x).toBeLessThanOrEqual(rect.x + rect.w);
      expect(s.y).toBeGreaterThanOrEqual(rect.y);
      expect(s.y).toBeLessThanOrEqual(rect.y + rect.h);
      expect(s.size).toBeGreaterThan(0);
      expect(s.alpha).toBeGreaterThan(0);
      expect(s.alpha).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic and reshuffles on its own cadence — same t twice matches, a step later differs', () => {
    const a = hpStaticSpecks(rect, 4.0, 1, 1);
    const b = hpStaticSpecks(rect, 4.0, 1, 1);
    expect(a).toEqual(b);
    // One full reshuffle step at rate 18/sec is ~56ms.
    const c = hpStaticSpecks(rect, 4.2, 1, 1);
    expect(c).not.toEqual(a);
  });
});

describe('hpSparks', () => {
  const rect = { x: 0, y: 0, w: 92, h: 92 };

  it('never fires below the urgency floor (0.15) even given many t values', () => {
    for (let i = 0; i < 50; i++) expect(hpSparks(rect, i * 0.11, i, 0.1)).toEqual([]);
  });

  it('at full urgency, at least one sampled window actually produces a spark', () => {
    const hits = [];
    for (let i = 0; i < 60; i++) hits.push(...hpSparks(rect, i * 0.05, 7, 1));
    expect(hits.length).toBeGreaterThan(0);
    for (const s of hits) {
      expect(s.x).toBeGreaterThanOrEqual(rect.x);
      expect(s.x).toBeLessThanOrEqual(rect.x + rect.w);
      expect(s.y).toBeGreaterThanOrEqual(rect.y);
      expect(s.y).toBeLessThanOrEqual(rect.y + rect.h);
      expect(s.life).toBeGreaterThan(0);
      expect(s.life).toBeLessThanOrEqual(1);
      expect(s.angle).toBeGreaterThanOrEqual(0);
      expect(s.angle).toBeLessThan(Math.PI * 2 + 1e-9);
    }
  });

  it('is deterministic — replaying the same instant reproduces the same result', () => {
    expect(hpSparks(rect, 3.3, 4, 1)).toEqual(hpSparks(rect, 3.3, 4, 1));
  });

  it('never returns more than one spark per tile at once', () => {
    for (let i = 0; i < 60; i++) expect(hpSparks(rect, i * 0.05, 7, 1).length).toBeLessThanOrEqual(1);
  });
});

// #526-followup (point 3): a distinct red "critical" pulse, layered ALONGSIDE the flicker/static/
// sparks above (not replacing them), gated on genuinely low hp.
describe('hpCriticalFlash', () => {
  it('is exactly 0 above the critical threshold', () => {
    expect(hpCriticalFlash(1, 5)).toBe(0);
    expect(hpCriticalFlash(HP_CRITICAL_FRAC + 0.01, 5)).toBe(0);
  });

  it('is exactly 0 once the part is fully destroyed (hp 0) — that\'s the dead-cell fill\'s job', () => {
    expect(hpCriticalFlash(0, 5)).toBe(0);
  });

  it('is > 0 somewhere in the critical band and never negative', () => {
    for (let t = 0; t < 6; t += 0.3) {
      const v = hpCriticalFlash(HP_CRITICAL_FRAC * 0.5, t);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    const anyPositive = Array.from({ length: 20 }, (_, i) => hpCriticalFlash(HP_CRITICAL_FRAC * 0.5, i * 0.3))
      .some((v) => v > 0);
    expect(anyPositive).toBe(true);
  });

  it('pulses over time rather than sitting flat', () => {
    const samples = Array.from({ length: 20 }, (_, i) => hpCriticalFlash(0.05, i * 0.15));
    expect(Math.max(...samples)).toBeGreaterThan(Math.min(...samples));
  });

  it('is deterministic — replaying the same instant reproduces the same result', () => {
    expect(hpCriticalFlash(0.08, 2.71)).toBe(hpCriticalFlash(0.08, 2.71));
  });

  it('gets stronger the closer to zero hp, at a fixed instant', () => {
    const nearThreshold = hpCriticalFlash(HP_CRITICAL_FRAC - 0.01, 0);
    const nearZero = hpCriticalFlash(0.01, 0);
    expect(nearZero).toBeGreaterThan(nearThreshold);
  });
});
