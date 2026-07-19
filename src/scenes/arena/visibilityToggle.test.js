// #306 (2026-07-19 playtest): the dimming overlay is toggled OFF via `LOS_DIM_ENABLED`
// (arena/visibility.js) while the owner decides whether he likes it — "I'm not sure if I like it
// or not, but don't remove the code yet".
//
// The ONE way that change can go wrong is by taking the GAMEPLAY sight gate down with it. #316
// ("let's let cover be actual cover") made `computeVisibleHexes` decide what targeting/convergence
// may lock, and that is a separate decision the owner has NOT reversed. So these tests pin the
// SPLIT rather than the flag's value: whatever `LOS_DIM_ENABLED` is set to, `_updateVisibility`
// must still populate `visibleHexes` and `_pointVisible` must still gate on real cover.
//
// They deliberately do not import or assert the flag — flipping it back on is meant to be a
// one-line change with no test edits, so nothing here may depend on which way it points.
import { describe, it, expect } from 'vitest';
import { VisibilityMixin } from './visibility.js';
import { axialKey, pixelToHex, hexToPixel } from '../../data/hexgrid.js';

const view = { width: 800, height: 600 };

// Minimal ArenaScene stand-in. `add.graphics` is counted so we can tell whether the overlay layer
// was created at all — with the feature off it must not be, which is what "zero cost" means here.
function makeScene(terrain = new Map()) {
  let graphicsMade = 0;
  const s = Object.assign(Object.create(VisibilityMixin), {
    px: 0, py: 0,
    terrain,
    wallEdges: null,
    add: {
      graphics() {
        graphicsMade++;
        return { setDepth() { return this; }, clear() {}, fillStyle() {}, fillPoints() {} };
      },
    },
    get graphicsMade() { return graphicsMade; },
  });
  s._initVisibility();
  return s;
}

// `alertTower` is HARD cover (terrain.js `coverTier`), so it blocks a mech's sight line
// unconditionally — the same terrain id data/visibility.test.js uses for this.
const blocker = (q, r) => [axialKey(q, r), 'alertTower'];

describe('#306 overlay toggle: the GAMEPLAY sight gate is unaffected', () => {
  it('_updateVisibility still populates visibleHexes', () => {
    const s = makeScene();
    expect(s.visibleHexes).toBe(null);
    s._updateVisibility(view);
    expect(s.visibleHexes).toBeInstanceOf(Set);
    expect(s.visibleHexes.size).toBeGreaterThan(0);
    // The player's own hex is always sighted.
    expect(s.visibleHexes.has(axialKey(0, 0))).toBe(true);
  });

  it('_pointVisible still reports open ground as visible', () => {
    const s = makeScene();
    s._updateVisibility(view);
    const p = hexToPixel(3, 0);
    expect(s._pointVisible(p.x, p.y)).toBe(true);
  });

  it('CRITICAL: a point behind hard cover is still NOT visible — cover is still cover', () => {
    const terrain = new Map([blocker(2, 0)]);   // a tower two hexes out along +q
    const s = makeScene(terrain);
    s._updateVisibility(view);

    const hidden = hexToPixel(4, 0);            // directly behind it
    expect(s._pointVisible(hidden.x, hidden.y)).toBe(false);
    // ...while the blocker itself, and open ground the other way, remain visible — so this isn't
    // just "everything went dark".
    const behindPlayer = hexToPixel(-4, 0);
    expect(s._pointVisible(behindPlayer.x, behindPlayer.y)).toBe(true);
  });

  it('the FOV recomputes when the player crosses into a new hex', () => {
    const s = makeScene();
    s._updateVisibility(view);
    const first = s.visibleHexes;
    const p = hexToPixel(5, 0);
    s.px = p.x; s.py = p.y;
    s._updateVisibility(view);
    expect(s.visibleHexes).not.toBe(first);
    expect(s.visibleHexes.has(axialKey(pixelToHex(p.x, p.y).q, pixelToHex(p.x, p.y).r))).toBe(true);
  });

  it('_invalidateVisibility forces a recompute in place (cover collapsing buys sight)', () => {
    const terrain = new Map([blocker(2, 0)]);
    const s = makeScene(terrain);
    s._updateVisibility(view);
    const hidden = hexToPixel(4, 0);
    expect(s._pointVisible(hidden.x, hidden.y)).toBe(false);

    terrain.clear();                 // the wall collapses
    s._invalidateVisibility();
    s._updateVisibility(view);       // same position, no hex crossing
    expect(s._pointVisible(hidden.x, hidden.y)).toBe(true);
  });
});

describe('#306 overlay toggle: the RENDER path costs nothing when off', () => {
  it('creates no Graphics layer, and ticking never touches one, when disabled', () => {
    const s = makeScene();
    // Whichever way the flag points, at most the one overlay layer is ever created — and when it
    // is not created, `fogFx` stays null and every draw path must be skipped rather than no-op'd.
    expect(s.graphicsMade).toBeLessThanOrEqual(1);
    if (s.fogFx === null) {
      for (let i = 0; i < 5; i++) { s.px += 40; s._updateVisibility(view); }
      expect(s.fogFx).toBe(null);
      expect(s.graphicsMade).toBe(0);
      // The dirty flag is still consumed, so an invalidation can't accumulate unbounded work
      // waiting for a renderer that will never run.
      s._invalidateVisibility();
      s._updateVisibility(view);
      expect(s._fogDirty).toBe(false);
    }
  });

  it('_updateShadowPolygon is a no-op with no overlay layer', () => {
    const s = makeScene();
    if (s.fogFx === null) {
      expect(() => s._updateShadowPolygon(view, 10)).not.toThrow();
      expect(s._shadowSegs).toBe(0);
    }
  });
});
