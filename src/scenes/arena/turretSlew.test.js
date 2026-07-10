// #86 — turret slew is dt-scaled rotation ("smoothly track the aim, at a rad/s rate, whatever
// the frame rate"), and the playtest complaint ("choppy/laggy aiming, feels like a low update
// frequency") turned out NOT to be a frame-rate/update-frequency bug (see scripts/profile-
// aim-idle.mjs — steady 60fps, sub-ms dt jitter during idle aiming) but the turretSlew tuning
// constants themselves being dialled too low in an earlier "feel" pass. `rotateToward` is the
// one shared rotation-step helper now used by the player's turret (locomotion.js), every enemy
// mech's turret + facing (enemies.js), and vehicle-behavior turret tracking (enemyBehaviors.js)
// — previously each had its own inline copy of the same expression. These tests prove it's
// properly dt-scaled (frame-rate independent) at both a low dt (a fast 144fps-ish frame) and a
// high dt (a slow/hitchy frame), and that it never overshoots past the target.
import { describe, it, expect } from 'vitest';
import { rotateToward } from './shared.js';

describe('rotateToward — dt-scaled turret/heading rotation (#86)', () => {
  it('advances by exactly radPerSec * dt at a small dt (no snapping/quantization)', () => {
    const slew = 2.0; // rad/s
    const dt = 1 / 144; // a fast frame
    const got = rotateToward(0, Math.PI, slew, dt);
    expect(got).toBeCloseTo(slew * dt, 10);
  });

  it('covers proportionally more ground at a larger dt — frame-rate independence', () => {
    const slew = 2.0;
    const target = Math.PI; // far away, so neither step snaps to it
    const stepAt = (dt) => rotateToward(0, target, slew, dt);
    const small = stepAt(1 / 240);
    const large = stepAt(1 / 30);
    // Both move the same DIRECTION, and the larger-dt step covers ~8x the angle (240/30),
    // matching radPerSec * dt scaling exactly — not a fixed "per frame" increment.
    expect(large).toBeCloseTo(small * 8, 6);
  });

  it('snaps exactly to the target once the step would overshoot it (no oscillation past it)', () => {
    const slew = 2.0;
    // A big dt (e.g. a hitch/low-fps frame): slew*dt far exceeds the remaining angle, so the
    // result must land exactly on the target rather than spinning past and back.
    const got = rotateToward(0, 0.05, slew, 1); // slew*dt = 2 rad step vs. a 0.05 rad gap
    expect(got).toBeCloseTo(0.05, 10);
  });

  it('produces identical motion across many small steps vs. one equivalent large step (dt accumulation is linear)', () => {
    const slew = 3.0;
    const target = 1.2;
    // 10 small steps of dt=0.01 should land at the same angle as one step of dt=0.1, as long
    // as neither reaches the target early (this is the "no frame-pacing jitter" guarantee: the
    // total rotation only depends on total elapsed time, not how it was chopped into frames).
    let stepped = 0;
    for (let i = 0; i < 10; i++) stepped = rotateToward(stepped, target, slew, 0.01);
    const oneShot = rotateToward(0, target, slew, 0.1);
    expect(stepped).toBeCloseTo(oneShot, 6);
  });

  it('takes the short way around the ±π wrap seam', () => {
    // From just past +π toward just past -π the short way is a small forward step, not
    // almost a full revolution the other way.
    const got = rotateToward(Math.PI - 0.01, -Math.PI + 0.01, 10, 0.001);
    // Step size is tiny (slew*dt = 0.01), so it should move a small amount further positive
    // (continuing to wrap forward through π), not jump negative.
    expect(Math.abs(got)).toBeGreaterThan(Math.PI - 0.02);
  });
});
