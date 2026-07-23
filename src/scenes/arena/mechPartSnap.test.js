// #455 — "the mech's components jostle/jiggle whenever the torso turns."
//
// TWO causes, same mechanism. Phaser's MultiPipeline.batchSprite floors a textured game object's
// own x/y before building its quad:
//
//     if (camera.roundPixels) { gx = Math.floor(gameObject.x); gy = Math.floor(gameObject.y); }
//
// For a CONTAINER CHILD that x/y is its LOCAL offset. A mech view is six sprites in one container:
// hull and turret-body sit at local (0,0) and never quantize, but the four pivoting parts (both
// arms, both side torsos) sit at local offsets that sweep continuously with the turret angle
// (partSpriteTransform's dx/dy). Each of those four crosses its own integer boundary at its own
// turret angle, so a smooth slew pops each arm/shoulder a whole world pixel against a body that
// has not moved.
//
// Pass 1 turned that off in the GAME CONFIG (`pixelArt: true` → explicit `roundPixels: false`,
// main.js; pinned by renderConfig.guard.test.js). It did not fix the bug, because pass 2's cause
// undid it: `Camera.startFollow(target, roundPixels, …)` ASSIGNS its second argument onto the
// camera (`this.roundPixels = roundPixels`), and the arena passed `true` — re-enabling the exact
// per-child flooring for the only camera that renders mechs. Note this is `camera.roundPixels`,
// NOT the integer-zoom-gated `renderRoundPixels`, so the arena's non-integer zoom did not save it.
//
// The first block below is the measurement that made the cost concrete; the second is the guard on
// the call site that regressed.
import { describe, it, expect, vi } from 'vitest';

vi.mock('phaser', () => ({ default: {} }));

import { partSpriteTransform, PIVOT_LOCATIONS } from '../../art/mechArt.js';
import { Mech } from '../../data/Mech.js';
import { CHASSIS } from '../../data/chassis/index.js';
import { ARENA_MECH_SCALE } from './shared.js';
import { CoopMixin } from './coop.js';
import { makePlayer } from '../../data/players.js';

// Sweep a part's local offset through a full turret revolution at a fine step, returning the
// biggest single-step move of the TRUE offset and of the FLOORED offset, plus the angles (deg) at
// which the floored offset jumped.
function sweepPart(mech, loc, steps = 2000) {
  let prev = null, maxTrue = 0, maxFloored = 0;
  const jumpAngles = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const t = partSpriteTransform(mech, loc, a, ARENA_MECH_SCALE);
    const cur = { x: t.dx, y: t.dy, fx: Math.floor(t.dx), fy: Math.floor(t.dy) };
    if (prev) {
      maxTrue = Math.max(maxTrue, Math.hypot(cur.x - prev.x, cur.y - prev.y));
      const df = Math.hypot(cur.fx - prev.fx, cur.fy - prev.fy);
      maxFloored = Math.max(maxFloored, df);
      if (df > 0) jumpAngles.push((a * 180) / Math.PI);
    }
    prev = cur;
  }
  return { maxTrue, maxFloored, jumpAngles };
}

describe('#455 why per-object pixel snapping wrecks a mech (measured)', () => {
  const mech = new Mech({ chassis: CHASSIS.medium });

  it('moves each pivoting part smoothly and sub-pixel as the turret slews', () => {
    for (const loc of PIVOT_LOCATIONS) {
      // 2000 samples/revolution is finer than any real slew step, so the true motion per step is
      // a small fraction of a pixel everywhere — there is no discontinuity in the pivot math.
      expect(sweepPart(mech, loc).maxTrue).toBeLessThan(0.2);
    }
  });

  it('but flooring that offset pops it a WHOLE pixel, many times per revolution', () => {
    for (const loc of PIVOT_LOCATIONS) {
      const { maxTrue, maxFloored, jumpAngles } = sweepPart(mech, loc);
      expect(maxFloored).toBeGreaterThanOrEqual(1);
      expect(maxFloored).toBeGreaterThan(maxTrue * 10);
      expect(jumpAngles.length).toBeGreaterThan(100);
    }
  });

  it('and the four parts jump at DIFFERENT angles — which is why it reads as misalignment', () => {
    // If all four snapped together the mech would merely judder as a unit. They don't: each part
    // sits at its own lateral/forward offset, so their integer crossings interleave and the arms
    // and shoulders visibly slide against the body and against each other.
    const firstJump = PIVOT_LOCATIONS.map((loc) => sweepPart(mech, loc).jumpAngles[0]);
    expect(new Set(firstJump.map((a) => a.toFixed(3))).size).toBeGreaterThan(1);
  });
});

// A stand-in for Phaser's Camera that reproduces the one line that matters:
//   startFollow: function (target, roundPixels, …) {
//     if (roundPixels === undefined) { roundPixels = false; }
//     this.roundPixels = roundPixels;   // ← overwrites whatever the game config set
//   }
function fakeCamera() {
  return {
    roundPixels: false,          // the game config's value (main.js sets false)
    startFollow(target, roundPixels = false) { this.roundPixels = roundPixels; return this; },
  };
}

function coopScene() {
  const player = makePlayer({ id: 0, mech: new Mech({ chassis: CHASSIS.medium }), x: 100, y: 200 });
  const cam = fakeCamera();
  const scene = {
    players: [player],
    cameras: { main: cam },
    add: {
      container: (x, y) => ({ x, y }),
      graphics: () => ({ setDepth: () => ({}) }),
    },
    input: { gamepad: { getAll: () => [] } },
    registry: { get: () => undefined },
  };
  return Object.assign(scene, CoopMixin);
}

describe('#455 the arena camera must not re-enable rounding via startFollow', () => {
  it('leaves camera.roundPixels false after the arena starts following its anchor', () => {
    const scene = coopScene();
    scene._initCoop();
    // Truthy here = every mech part in the arena floors its local offset again (see the measured
    // cost above). This is the line that silently undid the game-config fix.
    expect(scene.cameras.main.roundPixels).toBe(false);
  });
});
