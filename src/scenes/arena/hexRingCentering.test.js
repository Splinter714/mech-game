// #280 playtest follow-up ("the new hexagon rings render offset toward the top-left of the
// hex, instead of centered on it"). Root cause: both rings used to be `Phaser.GameObjects.
// Polygon` shapes built from `hexCorners()` — a point set already centered on (0,0)
// (symmetric, -radius..+radius on both axes). `Polygon`'s renderer draws every point as
// `point - displayOrigin`, where `displayOrigin` is derived from the polygon's own bounding
// box under the assumption the points span 0..width/0..height (a top-left-origin box, like a
// rectangle's corner list) — feeding it an already-centered point set double-subtracts that
// centering, so the whole shape renders shifted by exactly `-radius` on both axes: up and to
// the left of the intended centre, at ANY radius (the live-resizing ring's `setTo()` *does*
// correctly recompute width/height/origin on every resize — the offset isn't a stale-cache
// bug, it's there from frame one regardless of radius). The previous round's tests only
// asserted that `add.polygon`/`setStrokeStyle` were CALLED, never checked where the resulting
// shape actually sits, so this shipped uncaught.
//
// Both rings are now drawn with `Graphics` + `strokeHexRing` (shared.js) instead: `hexCorners`'
// points are stroked as literal LOCAL points on a `Graphics` object that is itself positioned
// (via `setPosition`, or as a child of an already-positioned `container`) at the ring's real
// world centre — no origin-guessing step exists to get wrong. These tests are geometry-level:
// they compute the ABSOLUTE centroid of whatever point set actually gets stroked (graphics'
// own position + each local point) and assert it lands exactly on the target hex position, for
// both the static objective marker (built once) and the live-resizing alert-tower ring
// (redrawn every tick, checked at multiple radii/fractions) — a fake `Polygon`-based mock that
// merely recorded "was `setStrokeStyle` called" would NOT have caught the original bug; only
// checking where the points actually land does.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../audio/index.js', () => ({ Audio: { alertPulse: vi.fn() } }));

import { MissionMixin } from './mission.js';
import { BasesMixin } from './bases.js';
import { hexToPixel, axialKey } from '../../data/hexgrid.js';

// A fake `Phaser.GameObjects.Graphics` that records exactly what a real one would need to
// render: its own position (`setPosition`) and the last point set actually stroked
// (`strokePoints`). Every other call (`clear`, `lineStyle`, `setDepth`, `setStrokeStyle`) is a
// chainable no-op — this mock exists purely to let the tests reconstruct where the drawn
// hexagon's points actually end up, not to assert Phaser call shapes.
function fakeGraphics() {
  const g = {
    x: 0, y: 0, lastPoints: null,
    setPosition(x, y) { g.x = x; g.y = y; return g; },
    setDepth: () => g,
    setStrokeStyle: () => g,
    clear: () => g,
    lineStyle: () => g,
    strokePoints(points) { g.lastPoints = points; return g; },
    destroy: () => {},
  };
  return g;
}

// The absolute centroid of whatever a `Graphics` mock actually stroked: its own world position
// plus the mean of its last local point set. For a container CHILD, `containerXY` is the
// container's own position (the child graphics itself is left at local (0,0), same as the real
// `_makeObjectiveMarker` code) — passed in explicitly since a bare object mock has no real
// parent-transform chain to walk.
function absoluteCentroid(graphics, containerXY = { x: 0, y: 0 }) {
  const pts = graphics.lastPoints;
  expect(pts).toBeTruthy();
  expect(pts.length).toBeGreaterThan(0);
  const sum = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return {
    x: containerXY.x + graphics.x + sum.x / pts.length,
    y: containerXY.y + graphics.y + sum.y / pts.length,
  };
}

describe('#280: the static objective-marker hexagon rings are centered on the objective hex', () => {
  function fakeScene(bases) {
    const registryStore = new Map();
    const graphicsMocks = [];
    return Object.assign({
      add: {
        graphics: () => { const g = fakeGraphics(); graphicsMocks.push(g); return g; },
        text: () => { const t = { setOrigin: () => t, setColor: () => t, setText: () => t }; return t; },
        container: (x, y, list) => Object.assign({ x, y, list }, { setDepth() { return this; }, destroy() {}, setVisible() { return this; } }),
      },
      tweens: { add: () => {}, killTweensOf: () => {} },
      registry: { get: (k) => registryStore.get(k), set: (k, v) => registryStore.set(k, v) },
      bases, enemies: [],
      _graphicsMocks: graphicsMocks,
    }, MissionMixin);
  }

  it('all three concentric rings (halo/outline/amber) land exactly on the target hex, not offset up-left', () => {
    const q = 3, r = -2;
    const bases = [{ id: 'base0', center: { q, r }, docks: [], turrets: [] }];
    const scene = fakeScene(bases);
    scene._initMission();

    const target = hexToPixel(q, r);
    expect(scene._graphicsMocks.length).toBe(3);   // haloRing, outlineRing, ring

    for (const g of scene._graphicsMocks) {
      const centroid = absoluteCentroid(g, { x: scene._objectiveMarker.x, y: scene._objectiveMarker.y });
      expect(centroid.x).toBeCloseTo(target.x, 6);
      expect(centroid.y).toBeCloseTo(target.y, 6);
    }
    // The marker container itself must actually sit at the hex's real pixel position too —
    // otherwise a coincidentally-symmetric local point set could mask a container-level offset.
    expect(scene._objectiveMarker.x).toBeCloseTo(target.x, 6);
    expect(scene._objectiveMarker.y).toBeCloseTo(target.y, 6);
  });

  it('stays centered after the mission completes and the amber ring is recolored', () => {
    const q = -5, r = 4;
    const bases = [{ id: 'base0', center: { q, r }, docks: [], turrets: [] }];
    const scene = fakeScene(bases);
    scene._initMission();
    scene._onMissionComplete();

    const target = hexToPixel(q, r);
    const ring = scene._objectiveMarker.list[2];
    const centroid = absoluteCentroid(ring, { x: scene._objectiveMarker.x, y: scene._objectiveMarker.y });
    expect(centroid.x).toBeCloseTo(target.x, 6);
    expect(centroid.y).toBeCloseTo(target.y, 6);
  });
});

describe('#280: the live-resizing alert-tower ring stays centered on the tower at every radius', () => {
  function fakeScene() {
    const graphicsMocks = [];
    return Object.assign({
      add: { graphics: () => { const g = fakeGraphics(); graphicsMocks.push(g); return g; } },
      px: 0, py: 0,
      _alertTowerFx: new Map(),
      _graphicsMocks: graphicsMocks,
    }, BasesMixin);
  }

  it('is centered on the tower the instant it is created (fraction 0, minimum radius)', () => {
    const key = axialKey(2, 1);
    const { x, y } = hexToPixel(2, 1);
    const scene = fakeScene();
    scene._updateAlertFx(key, x, y, { countingDown: true, fraction: 0 }, 16);

    const g = scene._graphicsMocks[0];
    const centroid = absoluteCentroid(g);
    expect(centroid.x).toBeCloseTo(x, 6);
    expect(centroid.y).toBeCloseTo(y, 6);
  });

  it('stays centered after resizing to a larger radius near the end of the countdown', () => {
    const key = axialKey(-3, 6);
    const { x, y } = hexToPixel(-3, 6);
    const scene = fakeScene();
    scene._updateAlertFx(key, x, y, { countingDown: true, fraction: 0 }, 16);
    // Simulate several ticks of the countdown climbing toward completion — the SAME graphics
    // object is reused and re-stroked at a growing radius each time (never recreated).
    for (const fraction of [0.25, 0.5, 0.75, 0.99]) {
      scene._updateAlertFx(key, x, y, { countingDown: true, fraction }, 16);
      const g = scene._graphicsMocks[0];
      expect(scene._graphicsMocks.length).toBe(1);   // never recreated, only redrawn
      const centroid = absoluteCentroid(g);
      expect(centroid.x).toBeCloseTo(x, 6);
      expect(centroid.y).toBeCloseTo(y, 6);
    }
  });

  it('is torn down (not left dangling off-centre) once the countdown cancels', () => {
    const key = axialKey(1, 1);
    const { x, y } = hexToPixel(1, 1);
    const scene = fakeScene();
    scene._updateAlertFx(key, x, y, { countingDown: true, fraction: 0.5 }, 16);
    expect(scene._alertTowerFx.has(key)).toBe(true);

    scene._updateAlertFx(key, x, y, { countingDown: false }, 16);
    expect(scene._alertTowerFx.has(key)).toBe(false);
  });
});
