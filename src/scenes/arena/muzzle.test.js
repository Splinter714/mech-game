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
});
