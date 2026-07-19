// #305: the gunship's three-phase attack cycle (data/gunshipCycle.js).
//
// Motion can't be unit-tested — that's confirmed by driving the real game — but the MACHINE can,
// and it's the part that carries the design: which phase follows which and on what trigger, that
// each phase wants a DIFFERENT facing, and that the weapon slot follows the facing (rockets
// nose-on, repeater broadside, guns cold on the break-off). That last one is the whole feature.
import { describe, it, expect } from 'vitest';
import {
  APPROACH, STRAFE, REPOSITION,
  FACE_PLAYER, FACE_BROADSIDE, FACE_TRAVEL,
  SLOT_NOSE, SLOT_FLANK,
  STANDOFF_MIN, STANDOFF_MAX, APPROACH_TIMEOUT_MS, STRAFE_MAX_MS, REPOSITION_TIMEOUT_MS,
  REPOSITION_ARRIVE_PX, REPOSITION_OUT_FRAC,
  initGunshipCycle, stepGunshipCycle, phasePlan,
} from './gunshipCycle.js';

// A deterministic rng that always returns the midpoint, so rolled durations/standoffs are exact.
const mid = () => 0.5;
const ctx = (over = {}) => ({ px: 0, py: 0, ex: 500, ey: 0, handed: 1, repoDist: Infinity, ...over });

describe('phasePlan — facing and weapon are chosen TOGETHER, per phase', () => {
  it('APPROACH is nose-on the player and pulls the NOSE slot (the dumbfire salvo)', () => {
    expect(phasePlan(APPROACH)).toEqual({ facing: FACE_PLAYER, slot: SLOT_NOSE });
  });

  it('STRAFE is BROADSIDE — not facing the player — and pulls the FLANK slot (the door gun)', () => {
    // This is the reversal Jackson made mid-conversation: he first said the strafe phase should
    // face the player, then chose broadside. Broadside is the live design; this test pins it.
    const p = phasePlan(STRAFE);
    expect(p.facing).toBe(FACE_BROADSIDE);
    expect(p.facing).not.toBe(FACE_PLAYER);
    expect(p.slot).toBe(SLOT_FLANK);
  });

  it('REPOSITION faces its own travel and holds fire (slot null)', () => {
    expect(phasePlan(REPOSITION)).toEqual({ facing: FACE_TRAVEL, slot: null });
  });

  it('all three phases want DIFFERENT facings, and the two firing phases DIFFERENT weapons', () => {
    const facings = [APPROACH, STRAFE, REPOSITION].map((p) => phasePlan(p).facing);
    expect(new Set(facings).size).toBe(3);
    expect(phasePlan(APPROACH).slot).not.toBe(phasePlan(STRAFE).slot);
  });
});

describe('initGunshipCycle', () => {
  it('starts on the approach run with a standoff rolled inside the band', () => {
    const st = initGunshipCycle(mid);
    expect(st.phase).toBe(APPROACH);
    expect(st.timer).toBe(APPROACH_TIMEOUT_MS);
    expect(st.standoff).toBe((STANDOFF_MIN + STANDOFF_MAX) / 2);
    expect(st.repoX).toBeNull();
  });

  it('rolls a DIFFERENT standoff per unit across the 240-400 band — a flight spreads out', () => {
    const rolls = Array.from({ length: 200 }, () => initGunshipCycle().standoff);
    for (const r of rolls) {
      expect(r).toBeGreaterThanOrEqual(STANDOFF_MIN);
      expect(r).toBeLessThanOrEqual(STANDOFF_MAX);
    }
    // Genuinely spread, not clustered on one radius the way the old flat 320 was.
    expect(new Set(rolls).size).toBeGreaterThan(150);
    expect(Math.max(...rolls) - Math.min(...rolls)).toBeGreaterThan(100);
  });
});

describe('stepGunshipCycle — transitions', () => {
  it('APPROACH → STRAFE once it has closed inside its standoff radius', () => {
    const st = initGunshipCycle(mid);
    stepGunshipCycle(st, 16, st.standoff * 3, ctx(), mid);
    expect(st.phase).toBe(APPROACH);              // still far out, still boring in
    stepGunshipCycle(st, 16, st.standoff * 0.9, ctx(), mid);
    expect(st.phase).toBe(STRAFE);
    expect(st.timer).toBeGreaterThan(0);
    expect(st.timer).toBeLessThanOrEqual(STRAFE_MAX_MS);
  });

  it('APPROACH → STRAFE on timeout even if it never closes (a player outrunning it)', () => {
    const st = initGunshipCycle(mid);
    stepGunshipCycle(st, APPROACH_TIMEOUT_MS + 1, 5000, ctx(), mid);
    expect(st.phase).toBe(STRAFE);
  });

  it('STRAFE → REPOSITION on its timer, re-rolling the standoff and picking a NEW angle of attack', () => {
    const st = initGunshipCycle(mid);
    stepGunshipCycle(st, 16, 10, ctx(), mid);          // → STRAFE
    const before = st.standoff;
    // Roll high so the new standoff is provably different from the midpoint one.
    stepGunshipCycle(st, STRAFE_MAX_MS + 1, 300, ctx(), () => 0.9);
    expect(st.phase).toBe(REPOSITION);
    expect(st.timer).toBe(REPOSITION_TIMEOUT_MS);
    expect(st.standoff).not.toBe(before);
    expect(st.standoff).toBeGreaterThanOrEqual(STANDOFF_MIN);
    expect(st.standoff).toBeLessThanOrEqual(STANDOFF_MAX);

    // The break-off point sits well BEYOND gun range (so the next approach is a real run in)…
    const r = Math.hypot(st.repoX - 0, st.repoY - 0);
    expect(r).toBeCloseTo(st.standoff * REPOSITION_OUT_FRAC, 6);
    expect(r).toBeGreaterThan(st.standoff);
    // …and at a genuinely different bearing from where the unit currently is (it was at +x).
    const bearing = Math.atan2(st.repoY, st.repoX);
    expect(Math.abs(bearing)).toBeGreaterThan(1.0);
  });

  it('REPOSITION → APPROACH once it arrives at the fresh attack point, clearing the point', () => {
    const st = { phase: REPOSITION, timer: REPOSITION_TIMEOUT_MS, standoff: 300, repoX: 9, repoY: 9 };
    stepGunshipCycle(st, 16, 900, ctx({ repoDist: REPOSITION_ARRIVE_PX + 50 }), mid);
    expect(st.phase).toBe(REPOSITION);                       // not there yet
    stepGunshipCycle(st, 16, 900, ctx({ repoDist: REPOSITION_ARRIVE_PX - 1 }), mid);
    expect(st.phase).toBe(APPROACH);
    expect(st.timer).toBe(APPROACH_TIMEOUT_MS);
    expect(st.repoX).toBeNull();
  });

  it('REPOSITION → APPROACH on timeout even if it never reaches the point', () => {
    const st = { phase: REPOSITION, timer: REPOSITION_TIMEOUT_MS, standoff: 300, repoX: 9, repoY: 9 };
    stepGunshipCycle(st, REPOSITION_TIMEOUT_MS + 1, 900, ctx(), mid);
    expect(st.phase).toBe(APPROACH);
  });

  it('APPROACH does NOT end early just because the unit is briefly near the player mid-approach —\n'
    + '     the standoff test is the trigger, so the approach always reads as a committed run', () => {
    const st = initGunshipCycle(mid);
    // Just outside the arrival band: still approaching.
    stepGunshipCycle(st, 16, st.standoff * 1.2, ctx(), mid);
    expect(st.phase).toBe(APPROACH);
  });

  it('runs the full cycle round and round — approach, strafe, break off, approach again', () => {
    const st = initGunshipCycle();
    const seen = [];
    let dist = 2000;
    for (let i = 0; i < 4000; i++) {
      // Crude stand-in for motion: close during approach, hold during strafe, open during break-off.
      if (st.phase === APPROACH) dist = Math.max(0, dist - 8);
      else if (st.phase === REPOSITION) dist += 8;
      const c = ctx({ repoDist: st.phase === REPOSITION ? Math.max(0, 900 - i % 900) : Infinity });
      const prev = st.phase;
      stepGunshipCycle(st, 16, dist, c);
      if (st.phase !== prev) seen.push(st.phase);
      if (seen.length >= 7) break;
    }
    // Strictly alternating in order, no phase ever skipped.
    expect(seen.slice(0, 6)).toEqual([STRAFE, REPOSITION, APPROACH, STRAFE, REPOSITION, APPROACH]);
  });

  it('the gunship is firing SOMETHING for most of the cycle but goes cold on the break-off', () => {
    const st = initGunshipCycle();
    let firing = 0, cold = 0, dist = 2000;
    for (let i = 0; i < 3000; i++) {
      if (st.phase === APPROACH) dist = Math.max(0, dist - 8);
      else if (st.phase === REPOSITION) dist += 8;
      stepGunshipCycle(st, 16, dist, ctx({ repoDist: st.phase === REPOSITION ? 200 : Infinity }));
      if (phasePlan(st.phase).slot == null) cold++; else firing++;
    }
    expect(cold).toBeGreaterThan(0);       // it really does break off and stop shooting
    expect(firing).toBeGreaterThan(cold);  // but the cycle is mostly an attack, not mostly a retreat
  });
});
