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
import { describe, it, expect, vi } from 'vitest';
import { rotateToward } from './shared.js';
// enemies.js has a vestigial top-level `import Phaser` whose device-detection touches `navigator`
// and throws under the node test env — stub it out (same as enemyFireAngle.test.js) so the
// exported #398 tuning constant can be imported.
vi.mock('phaser', () => ({ default: {} }));
import { ENEMY_MECH_TURRET_SLEW } from './enemies.js';

// #398 — enemy mechs felt "floaty" because their turret snapped to the player's bearing every
// frame at the chassis's own fast turretSlew (1.9–4.2 rad/s). The fix caps enemy-mech aim
// tracking to ENEMY_MECH_TURRET_SLEW so the gun LAGS and swings toward the player like a heavy
// machine. These prove the cap is a genuine slow-down (below every chassis slew) and that the
// capped step is a proper rad/s tracking step — advances toward the target at the capped rate,
// never overshoots, and lags a laterally-moving target instead of snapping onto it. The enemy
// mech's turret update is literally `rotateToward(e.turret, bearing, ENEMY_MECH_TURRET_SLEW, dt)`
// (enemies.js), so exercising rotateToward with the exported constant tests the real aim step.
describe('enemy-mech capped turret slew (#398)', () => {
  const CHASSIS_SLEWS = [1.9, 2.9, 4.2]; // heavy / medium / light turretSlew

  it('is slower than every chassis turretSlew (so it always bites)', () => {
    for (const s of CHASSIS_SLEWS) expect(ENEMY_MECH_TURRET_SLEW).toBeLessThan(s);
    expect(ENEMY_MECH_TURRET_SLEW).toBeGreaterThan(0);
  });

  it('advances the aim toward the target at exactly the capped rad/s (no snapping)', () => {
    const dt = 1 / 60;
    // Player far off to one side: a full frame moves the turret by exactly slew*dt, not onto it.
    const got = rotateToward(0, Math.PI, ENEMY_MECH_TURRET_SLEW, dt);
    expect(got).toBeCloseTo(ENEMY_MECH_TURRET_SLEW * dt, 10);
    expect(got).toBeLessThan(Math.PI); // did NOT snap to the target
  });

  it('never overshoots the aim once the step would pass it', () => {
    const target = 0.01; // tiny remaining gap
    const got = rotateToward(0, target, ENEMY_MECH_TURRET_SLEW, 1); // slew*dt ≫ gap
    expect(got).toBeCloseTo(target, 10);
  });

  it('lags a laterally strafing player rather than tracking perfectly', () => {
    // Turret starts on target; the player then jumps 0.6 rad to the side each frame (fast lateral
    // strafe). With the cap, the turret can only claw back a slice per frame, so a steady gap
    // persists — that gap IS the aim lag the fix is for. At the old chassis slew it would close.
    const dt = 1 / 60;
    let turret = 0;
    let bearing = 0;
    let maxGap = 0;
    for (let i = 0; i < 20; i++) {
      bearing += 0.6; // player keeps moving sideways
      turret = rotateToward(turret, bearing, ENEMY_MECH_TURRET_SLEW, dt);
      maxGap = Math.max(maxGap, Math.abs(bearing - turret));
    }
    // A perfect tracker would have gap ~0.6 (one frame behind) or less; the capped turret falls
    // much further behind because slew*dt (≈0.023 rad) ≪ the 0.6 rad/frame the player moves.
    expect(maxGap).toBeGreaterThan(1.0);
  });
});

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
