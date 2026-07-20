// #337 v2 — the SCENE WIRING of the compound-interior fog. The pure model's own tests live in
// data/fogRegions.test.js; what matters here is the plumbing and the one state transition.
//
// The v1 version of this file asserted the open-world block cadence ("does NOT rebuild while the
// player moves within a region", "DOES rebuild when he crosses into another"). Those thresholds were
// exactly what popped as he drove, and they no longer exist — the open world is never fogged, so
// there is nothing to rebuild out there at all.
import { describe, it, expect } from 'vitest';
import { VisibilityMixin } from './visibility.js';
import { axialKey, hexToPixel, pixelToHex, range } from '../../data/hexgrid.js';
import { SPAN_ROLE_GATE } from '../../data/wallEdges.js';

const view = { width: 1280, height: 800 };

// NOTE: the counters live on a mutable object rather than behind a getter — `Object.assign` COPIES a
// getter's current value rather than the getter itself, so a getter here would freeze at 0.
function makeScene({ bases = [], wallEdges = null, terrain = new Map(), enemies = [] } = {}) {
  const counts = { fills: 0, strokes: 0, setMask: 0, clearMask: 0 };
  const graphics = () => ({
    setDepth() { return this; }, clear() {}, fillStyle() {}, fillPoints() { counts.fills++; },
    lineStyle() {}, strokePoints() { counts.strokes++; },
    createGeometryMask() { return { setInvertAlpha() { return this; } }; },
    setMask() { counts.setMask++; }, clearMask() { counts.clearMask++; },
  });
  const s = Object.assign(Object.create(VisibilityMixin), {
    px: 0, py: 0, bases, wallEdges, terrain, enemies,
    _hexKeyAt(x, y) { const h = pixelToHex(x, y); return axialKey(h.q, h.r); },
    add: { graphics },
    make: { graphics },
    counts,
  });
  s._initVisibility();
  return s;
}

const at = (q, r) => { const p = hexToPixel(q, r); return { px: p.x, py: p.y }; };
const compound = (id, c, rad) => ({ id, footprint: range(c, rad) });

describe('the open world is never fogged', () => {
  it('draws no fog at all when there are no compounds', () => {
    const s = makeScene();
    s._updateVisibility(view);
    expect(s.foggedHexes.size).toBe(0);
    expect(s.counts.fills).toBe(0);            // nothing drawn over the open world, ever
    expect(s._pointVisible(0, 0)).toBe(true);
    expect(s._pointVisible(9e4, 9e4)).toBe(true);
  });

  it('leaves open ground lit while a compound elsewhere stays dark', () => {
    const s = makeScene({ bases: [compound('a', { q: 30, r: 0 }, 3)] });
    s._updateVisibility(view);
    const inside = hexToPixel(30, 0);
    expect(s._pointVisible(0, 0)).toBe(true);              // open ground: always
    expect(s._pointVisible(inside.x, inside.y)).toBe(false); // unentered interior: dark
  });

  it('draws fog for a compound in view but never for the ground around it', () => {
    const s = makeScene({ bases: [compound('a', { q: 4, r: 0 }, 3)] });
    s._updateVisibility(view);
    // 19 interior hexes, all within the ~13-ring draw radius; the outline and everything beyond it
    // is alpha 0 and skipped.
    expect(s.counts.fills).toBe(19);
  });
});

describe('entering a compound reveals it ONCE, for the run', () => {
  const bases = [compound('a', { q: 0, r: 0 }, 3), compound('b', { q: 40, r: 0 }, 3)];

  it('lights the interior on entry and keeps it lit after leaving', () => {
    const s = makeScene({ bases });
    Object.assign(s, at(20, 0));                 // out in the open
    s._updateVisibility(view);
    expect(s.foggedHexes.has(axialKey(0, 0))).toBe(true);

    Object.assign(s, at(0, 0));                  // drive in
    s._updateVisibility(view);
    expect(s.enteredCompounds.has('a')).toBe(true);
    expect(s.foggedHexes.has(axialKey(0, 0))).toBe(false);
    const lit = s.foggedHexes;

    Object.assign(s, at(20, 0));                 // drive back out — it STAYS lit
    s._updateVisibility(view);
    expect(s.foggedHexes.has(axialKey(0, 0))).toBe(false);
    expect(s.foggedHexes).toBe(lit);             // same Set object: not recomputed
    const p = hexToPixel(0, 0);
    expect(s._pointVisible(p.x, p.y)).toBe(true);
  });

  it('reveals only the compound entered, not its neighbour', () => {
    const s = makeScene({ bases });
    Object.assign(s, at(0, 0));
    s._updateVisibility(view);
    expect(s.foggedHexes.has(axialKey(40, 0))).toBe(true);
    expect(s.enteredCompounds.has('b')).toBe(false);
  });

  it('counts the wall ring as entered — the only way onto it is through the wall line', () => {
    const s = makeScene({ bases });
    Object.assign(s, at(3, 0));                  // an outline hex
    s._updateVisibility(view);
    expect(s.enteredCompounds.has('a')).toBe(true);
  });

  it('recomputes nothing while driving around the open world', () => {
    const s = makeScene({ bases });
    Object.assign(s, at(20, 0));
    s._updateVisibility(view);
    const first = s.foggedHexes;
    for (const [q, r] of [[21, 0], [22, 1], [23, 2], [24, 0]]) {
      Object.assign(s, at(q, r));
      s._updateVisibility(view);
    }
    expect(s.foggedHexes).toBe(first);           // identity: no rebuild, so nothing can pop
  });
});

// A ring of spans around a small compound, one of which can be knocked out or opened.
function ringEdges(centre, rad, mutate = () => {}) {
  const edges = new Map();
  const c = hexToPixel(centre.q, centre.r);
  const R = rad * 90;
  const N = 24;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
    const e = {
      key: `e${i}`, baseId: 'a', destroyed: false, role: 'wall', open: false,
      x0: c.x + R * Math.cos(a0), y0: c.y + R * Math.sin(a0),
      x1: c.x + R * Math.cos(a1), y1: c.y + R * Math.sin(a1),
    };
    mutate(e, i);
    edges.set(e.key, e);
  }
  return { edges };
}

describe('breach peek: a raycast from where the player is standing', () => {
  const bases = [compound('a', { q: 0, r: 0 }, 3)];
  // Span 12 is the one on the far side from +x; span 0 faces +x. Breach span 0.
  const breached = () => ringEdges({ q: 0, r: 0 }, 3, (e, i) => { if (i === 0) e.destroyed = true; });

  it('does not mask the fog at all while every span stands', () => {
    const s = makeScene({ bases, wallEdges: ringEdges({ q: 0, r: 0 }, 3) });
    Object.assign(s, at(9, 0));
    s._updateVisibility(view);
    expect(s._peekSegments).toBe(null);
    expect(s.counts.setMask).toBe(0);
    expect(s.counts.clearMask).toBeGreaterThan(0);
  });

  it('masks a peek polygon through a breach', () => {
    const s = makeScene({ bases, wallEdges: breached() });
    Object.assign(s, at(9, 0));
    s._updateVisibility(view);
    expect(s._peekSegments).not.toBe(null);
    expect(s.counts.setMask).toBeGreaterThan(0);
  });

  it('treats an OPEN GATE identically to a breach — one code path, no branch', () => {
    const gated = ringEdges({ q: 0, r: 0 }, 3, (e, i) => {
      if (i === 0) { e.role = SPAN_ROLE_GATE; e.open = true; }
    });
    const s = makeScene({ bases, wallEdges: gated });
    Object.assign(s, at(9, 0));
    s._updateVisibility(view);
    expect(s._peekSegments).not.toBe(null);
    expect(s.counts.setMask).toBeGreaterThan(0);
  });

  // THE point of the redesign. v1 unioned over every exterior angle and lit nearly the whole yard
  // from one hole; here the slice you get depends on where you stand, and it is always partial.
  it('reveals a DIFFERENT, always-partial slice from each vantage point', () => {
    const yard = range({ q: 0, r: 0 }, 2).map((h) => hexToPixel(h.q, h.r));
    const sliceFrom = (q, r) => {
      const s = makeScene({ bases, wallEdges: breached() });
      Object.assign(s, at(q, r));
      s._updateVisibility(view);
      return yard.filter((p) => s._peekVisible(p.x, p.y)).map((p) => `${p.x | 0},${p.y | 0}`);
    };
    const east = sliceFrom(9, 0);
    const northeast = sliceFrom(7, -5);
    expect(east.length).toBeGreaterThan(0);
    expect(east.length).toBeLessThan(yard.length);        // PARTIAL, not near-total
    expect(northeast.length).toBeLessThan(yard.length);
    expect(east.join()).not.toBe(northeast.join());       // and it swings as he moves
  });

  it('stops peeking once he is inside — the compound is simply lit', () => {
    const s = makeScene({ bases, wallEdges: breached() });
    Object.assign(s, at(0, 0));
    s._updateVisibility(view);
    expect(s._peekSegments).toBe(null);
    expect(s.foggedHexes.size).toBe(0);
  });
});

describe('the fog feeds drawing and targeting through one gate', () => {
  const bases = [compound('a', { q: 0, r: 0 }, 3)];

  it('hides a garrison enemy, and the same call is what targeting asks', () => {
    const p = hexToPixel(0, 0);
    const e = { x: p.x, y: p.y, view: { visible: true, setVisible(v) { this.visible = v; } } };
    const s = makeScene({ bases, enemies: [e] });
    Object.assign(s, at(9, 0));
    s._updateVisibility(view);
    s._syncEnemyFogVisibility();
    expect(e.view.visible).toBe(false);
    expect(s._enemyVisible(e)).toBe(false);
  });

  it('shows it by symmetry the moment it has a lane on him', () => {
    const p = hexToPixel(0, 0);
    const e = { x: p.x, y: p.y, _losClear: true, awareness: 'alert', view: { setVisible() {} } };
    const s = makeScene({ bases, enemies: [e] });
    Object.assign(s, at(9, 0));
    s._updateVisibility(view);
    expect(s._enemyVisible(e)).toBe(true);
  });

  it('shows every enemy once he has entered', () => {
    const p = hexToPixel(0, 0);
    const e = { x: p.x, y: p.y, view: { setVisible() {} } };
    const s = makeScene({ bases, enemies: [e] });
    Object.assign(s, at(0, 0));
    s._updateVisibility(view);
    expect(s._enemyVisible(e)).toBe(true);
  });
});
