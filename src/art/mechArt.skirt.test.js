// #438 follow-up: the hip skirt plates must FOLLOW THE LEGS. They used to be hard-coded
// fractions of bodyWid, so when the player's stance widened (legSpread 1 -> 1.4) each plate
// stayed at the default width and no longer sat over the leg it covers. These pin the plate's
// outer edge to the leg's own outer edge (as computed by `mechLayout`, i.e. legSpread/legW), so a
// future stance change carries the skirts along. The INNER edge stays pinned to the pelvis — the
// plate stretches rather than sliding out, which is what keeps the "leg tucks UNDER the body" read.
import { describe, it, expect } from 'vitest';
import { buildMechTextures, mechLayout } from './mechArt.js';
import { ART_SCALE } from './_frames.js';
import { CENTER } from './mechPrims.js';
import { Mech } from '../data/Mech.js';

// A fake scene that records every fillPoints polygon per generated texture key, in DESIGN-space
// local coords (undoing scaledGraphics' CENTER offset + ART_SCALE super-sampling).
function recordingScene() {
  const polysByKey = {};
  let pending = [];
  const g = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'fillPoints') {
        return (pts) => pending.push(pts.map((p) => ({
          x: p.x / ART_SCALE - CENTER,
          y: p.y / ART_SCALE - CENTER,
        })));
      }
      if (prop === 'generateTexture') return (key) => { polysByKey[key] = pending; pending = []; };
      if (prop === 'destroy') return () => { pending = []; };
      return () => {};
    },
  });
  return {
    polysByKey,
    make: { graphics: () => g },
    textures: { exists: () => false },
  };
}

// The two skirt plates are the only FOUR-point polygons in the hull (plates chamfer to 8).
// Each is drawn three times (halo / outline / face); we want the un-inset face pass, which is
// the innermost — i.e. the smallest outer extent.
function skirtOuterEdge(mech, theme) {
  const scene = recordingScene();
  buildMechTextures(scene, 'k', mech, { theme });
  const quads = (scene.polysByKey.k_hull_0 ?? []).filter((p) => p.length === 4);
  expect(quads.length).toBeGreaterThan(0);
  const rightSide = quads.filter((q) => q.some((p) => p.x > 0));
  const extents = rightSide.map((q) => Math.max(...q.map((p) => p.x)));
  return Math.min(...extents);
}

function skirtInnerEdge(mech, theme) {
  const scene = recordingScene();
  buildMechTextures(scene, 'k', mech, { theme });
  const quads = (scene.polysByKey.k_hull_0 ?? []).filter((p) => p.length === 4);
  const rightSide = quads.filter((q) => q.some((p) => p.x > 0));
  // Inner edge = the smallest x on the plate; take the outermost (least inset) of the three passes.
  return Math.max(...rightSide.map((q) => Math.min(...q.map((p) => p.x))));
}

const legOuterEdge = (mech) => {
  const lay = mechLayout(mech);
  return Math.abs(lay.rightLeg.x) + lay.rightLeg.w / 2;
};

const mechOf = (chassisId) => new Mech({ chassisId, mounts: {} });

describe('hip skirt plates follow legSpread (#438 follow-up)', () => {
  // The player's wide stance (legSpread 1.4) and the enemy chassis that share this hull art.
  const cases = [
    ['mediumPlayer', 'player'],
    ['medium', 'enemy'],
    ['light', 'enemy'],
    ['heavy', 'enemy'],
  ];

  for (const [chassisId, theme] of cases) {
    it(`${chassisId}: the plate's outer edge tracks the leg's outer edge`, () => {
      const mech = mechOf(chassisId);
      const outer = skirtOuterEdge(mech, theme);
      const leg = legOuterEdge(mech);
      // Just INSIDE the leg's outer edge (a fixed 0.02·bodyWid inset), never winging out past it.
      expect(outer).toBeLessThan(leg);
      expect(outer).toBeCloseTo(leg - mech.chassis.art.bodyWid * 0.02, 4);
    });

    it(`${chassisId}: the plate stays anchored to the pelvis (no gap at the inner edge)`, () => {
      const mech = mechOf(chassisId);
      const inner = skirtInnerEdge(mech, theme);
      const pelvisHalf = mech.chassis.art.bodyWid * 0.25;   // pelvis block is bodyWid*0.5 wide
      expect(inner).toBeLessThan(pelvisHalf);
      expect(inner).toBeCloseTo(mech.chassis.art.bodyWid * 0.02, 4);
    });
  }

  it('a wider stance pushes the plate further out (player 1.4 vs the default 1.0)', () => {
    const wide = mechOf('mediumPlayer');       // legSpread 1.4
    const stock = mechOf('medium');            // no shape overrides -> legSpread 1
    expect(mechLayout(wide).rightLeg.x / wide.chassis.art.bodyWid)
      .toBeGreaterThan(mechLayout(stock).rightLeg.x / stock.chassis.art.bodyWid);
    expect(skirtOuterEdge(wide, 'player') / wide.chassis.art.bodyWid)
      .toBeGreaterThan(skirtOuterEdge(stock, 'enemy') / stock.chassis.art.bodyWid);
  });

  it('the enemy medium (legSpread 1) is unchanged: outer-top still 0.27·bodyWid', () => {
    const mech = mechOf('medium');
    expect(skirtOuterEdge(mech, 'enemy')).toBeCloseTo(mech.chassis.art.bodyWid * 0.27, 4);
  });
});
