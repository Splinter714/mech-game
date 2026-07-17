// #109 — enemy shots should spawn from a real per-weapon muzzle, not a fixed near-centre
// offset. partMuzzle() is the pure geometry both the player's locomotion `_muzzle(loc)` and
// enemies.js (mech fire keyed off w.location, and non-mech KIND fire keyed off the kind's
// gun/barrel/etc. part) now share. Pure math, no Phaser/scene.
import { describe, it, expect } from 'vitest';
import { partMuzzle } from './shared.js';

describe('partMuzzle (#109)', () => {
  it('places a centred part (x:0) straight ahead at the front edge, facing +x', () => {
    // part centred on the mech's axis, forward half-extent 10 design units, disp 2 (px/unit).
    const part = { x: 0, y: -4, w: 6, h: 12 };
    // f = (-part.y + h/2) * disp = (4 + 6) * 2 = 20
    const m = partMuzzle(part, 0, 0, 0, 2);
    expect(m.x).toBeCloseTo(20, 10);
    expect(m.y).toBeCloseTo(0, 10);
  });

  it('offsets a lateral part (e.g. a right arm) to the side, not the centre', () => {
    const rightArm = { x: 8, y: 0, w: 4, h: 8 };
    const centre = { x: 0, y: 0, w: 4, h: 8 };
    const disp = 3;
    const armM = partMuzzle(rightArm, 0, 0, 0, disp);
    const centreM = partMuzzle(centre, 0, 0, 0, disp);
    // Facing +x, "right" is -y in this convention (r rotated by sin/cos) — either way the two
    // must differ meaningfully in the lateral (y) axis, proving location actually matters.
    expect(Math.abs(armM.y - centreM.y)).toBeGreaterThan(5);
  });

  it('rotates the offset by the facing angle, translated to the given world position', () => {
    const part = { x: 0, y: -5, w: 0, h: 10 }; // front edge f = (5 + 10/2) * 1 = 10, r = 0
    const worldX = 100, worldY = 50;
    const facing = Math.PI / 2; // facing +y
    const m = partMuzzle(part, worldX, worldY, facing, 1);
    expect(m.x).toBeCloseTo(worldX, 10);
    expect(m.y).toBeCloseTo(worldY + 10, 10);
  });

  it('two different locations on the same body produce meaningfully different spawn points', () => {
    // Mirrors the arena's actual concern: an enemy mech firing from its left arm vs. its right
    // torso must NOT collapse to the same (or near-identical) point regardless of location.
    const leftArm = { x: -18, y: 6, w: 10, h: 20 };
    const rightTorso = { x: 10, y: -2, w: 8, h: 16 };
    const disp = 1.36 * 4; // ARENA_MECH_SCALE-ish × ART_SCALE, same order of magnitude as arena use
    const a = partMuzzle(leftArm, 200, 200, 1.1, disp);
    const b = partMuzzle(rightTorso, 200, 200, 1.1, disp);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(15);
  });

  // #233: "projectiles should originate from the tip of the weapon muzzle art" — before this,
  // every caller implicitly used tipOffset 0 (the part's bare front edge), which is the BASE of
  // a mounted weapon's drawn barrel, not its tip. `tipOffset` lets a caller push the spawn point
  // further forward (or, for the one vehicle kind whose box overshoots its own art, pull it back)
  // to match wherever the real muzzle art actually ends.
  describe('tipOffset (#233)', () => {
    it('defaults to 0 — unchanged behaviour for callers that omit it', () => {
      const part = { x: 0, y: -4, w: 6, h: 12 };
      const withDefault = partMuzzle(part, 0, 0, 0, 2);
      const explicitZero = partMuzzle(part, 0, 0, 0, 2, 0);
      expect(withDefault).toEqual(explicitZero);
    });

    it('pushes the muzzle further forward, scaled by disp, same as the box geometry is', () => {
      const part = { x: 0, y: -4, w: 6, h: 12 };
      const disp = 2;
      const base = partMuzzle(part, 0, 0, 0, disp);
      const tipped = partMuzzle(part, 0, 0, 0, disp, 5);
      // Facing 0 (+x): forward is +x, so the tip sits further along +x by tipOffset * disp.
      expect(tipped.x - base.x).toBeCloseTo(5 * disp, 10);
      expect(tipped.y).toBeCloseTo(base.y, 10);
    });

    it('a negative tipOffset pulls the spawn point back (the quadruped-kind case, #233)', () => {
      const part = { x: 0, y: -22, w: 6, h: 20 };
      const disp = 1;
      const base = partMuzzle(part, 0, 0, 0, disp);
      const pulledBack = partMuzzle(part, 0, 0, 0, disp, -4);
      expect(pulledBack.x).toBeLessThan(base.x);
      expect(base.x - pulledBack.x).toBeCloseTo(4, 10);
    });

    it('rotates the tip offset by facing just like the box-edge offset', () => {
      const part = { x: 0, y: -5, w: 0, h: 10 }; // front edge f = 10, r = 0
      const facing = Math.PI / 2; // facing +y
      const m = partMuzzle(part, 100, 50, facing, 1, 6);
      // f_total = 10 + 6 = 16, rotated to face +y ⇒ all forward distance lands in y.
      expect(m.x).toBeCloseTo(100, 10);
      expect(m.y).toBeCloseTo(50 + 16, 10);
    });
  });

  // #233 follow-up — playtest: "projectiles coming from tip of barrel is mostly working, but
  // it's not matching up with the arm/torso tilt that happens with convergence tuning." A
  // pivoting part (arm/side-torso) rotates around its OWN joint (pivotFrac of the way toward
  // the part's rear — mirrors mechArt.js's PART_PIVOT/partSpriteTransform), not the mech centre:
  // the joint stays fixed relative to the centre (only ever rotated by the base `angle`), but
  // the muzzle tip is out past the joint and swings with the part's LIVE orientation
  // (`angle + tilt`). These cases pin that behaviour down; the earlier tests above all pass
  // tilt 0 (or omit it), which — by construction — must still match the pre-#233-follow-up
  // formula regardless of pivotFrac (proven by the first case below).
  describe('tilt/pivotFrac (#233 follow-up)', () => {
    const part = { x: 8, y: -10, w: 4, h: 20 }; // an off-centre (arm-like) mount
    const disp = 2;

    it('tilt 0 reproduces the untilted formula for ANY pivotFrac (the split is linear)', () => {
      const untilted = partMuzzle(part, 0, 0, 0.3, disp, 5);
      for (const pivotFrac of [0, 0.3, 0.42, 0.9]) {
        const m = partMuzzle(part, 0, 0, 0.3, disp, 5, 0, pivotFrac);
        expect(m.x).toBeCloseTo(untilted.x, 10);
        expect(m.y).toBeCloseTo(untilted.y, 10);
      }
    });

    it('a non-zero tilt rotates the tip AROUND THE JOINT, not the mech centre', () => {
      const angle = 0.3, tilt = 0.5, pivotFrac = 0.42, tipOffset = 5;
      const m = partMuzzle(part, 0, 0, angle, disp, tipOffset, tilt, pivotFrac);

      // Hand-computed expected value from the joint/tip decomposition described above.
      const jointF = -(part.y + part.h * pivotFrac) * disp;
      const jointR = part.x * disp;
      const jointX = jointF * Math.cos(angle) - jointR * Math.sin(angle);
      const jointY = jointF * Math.sin(angle) + jointR * Math.cos(angle);
      const tipF = (part.h * (0.5 + pivotFrac) + tipOffset) * disp;
      const expected = {
        x: jointX + tipF * Math.cos(angle + tilt),
        y: jointY + tipF * Math.sin(angle + tilt),
      };
      expect(m.x).toBeCloseTo(expected.x, 10);
      expect(m.y).toBeCloseTo(expected.y, 10);

      // And it must differ meaningfully from just rotating the whole thing by `angle` alone
      // (the bug: computing the tip as if the part were still at its neutral/rest orientation).
      const neutral = partMuzzle(part, 0, 0, angle, disp, tipOffset);
      expect(Math.hypot(m.x - neutral.x, m.y - neutral.y)).toBeGreaterThan(1);
    });

    it('the joint itself never moves with tilt — only rotates with the base angle', () => {
      const angle = 1.1, pivotFrac = 0.3;
      // tipOffset -> -(part.h*(0.5+pivotFrac)) makes tipF collapse to 0, isolating the joint.
      const tipOffset = -(part.h * (0.5 + pivotFrac));
      const atJointNoTilt = partMuzzle(part, 0, 0, angle, disp, tipOffset, 0, pivotFrac);
      const atJointTilted = partMuzzle(part, 0, 0, angle, disp, tipOffset, 1.3, pivotFrac);
      expect(atJointTilted.x).toBeCloseTo(atJointNoTilt.x, 10);
      expect(atJointTilted.y).toBeCloseTo(atJointNoTilt.y, 10);
    });
  });
});
