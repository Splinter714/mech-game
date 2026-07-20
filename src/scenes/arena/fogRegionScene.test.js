// #337 v2 — the SCENE WIRING of the compound-interior fog. The pure model's own tests live in
// data/fogRegions.test.js; what matters here is the plumbing and the one state transition.
//
// The v1 version of this file asserted the open-world block cadence ("does NOT rebuild while the
// player moves within a region", "DOES rebuild when he crosses into another"). Those thresholds were
// exactly what popped as he drove, and they no longer exist — the open world is never fogged, so
// there is nothing to rebuild out there at all.
import { describe, it, expect } from 'vitest';
import { VisibilityMixin } from './visibility.js';
import { axialKey, hexToPixel, pixelToHex, neighbors, range } from '../../data/hexgrid.js';
import { SPAN_ROLE_GATE } from '../../data/wallEdges.js';

const view = { width: 1280, height: 800 };

// NOTE: the counters live on a mutable object rather than behind a getter — `Object.assign` COPIES a
// getter's current value rather than the getter itself, so a getter here would freeze at 0.
function makeScene({ bases = [], wallEdges = null, terrain = new Map(), enemies = [] } = {}) {
  const counts = { fills: 0, strokes: 0 };
  const graphics = () => ({
    setDepth() { return this; }, clear() {}, fillStyle() {}, fillPoints() { counts.fills++; },
    lineStyle() {}, strokePoints() { counts.strokes++; },
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
    // v3: the WHOLE 37-hex footprint, outline ring included (that ring being un-fogged was the
    // "first ring inside the wall isn't blacked out" bug). Everything beyond it is alpha 0, skipped.
    expect(s.counts.fills).toBe(37);
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

// The compound's real wall ring, built the way `placeBaseWalls` builds it (#288): one span per
// footprint-hex/outside-hex boundary, with `a` on the base side. `mutate` can breach or open one.
function ringEdges(centre, rad, mutate = () => {}) {
  const fp = new Set(range(centre, rad).map((h) => axialKey(h.q, h.r)));
  const edges = new Map();
  let i = 0;
  for (const h of range(centre, rad)) {
    for (const n of neighbors(h.q, h.r)) {
      if (fp.has(axialKey(n.q, n.r))) continue;
      const e = {
        key: `e${i++}`, baseId: 'a', destroyed: false, role: 'wall', open: false,
        a: { q: h.q, r: h.r }, b: { q: n.q, r: n.r },
      };
      mutate(e);
      edges.set(e.key, e);
    }
  }
  return { edges };
}
// Breach/open only the span between the two named hexes, leaving the rest of the ring standing.
const onSpan = (a, b, apply) => (e) => {
  if (e.a.q === a.q && e.a.r === a.r && e.b.q === b.q && e.b.r === b.r) apply(e);
};

describe('breach peek: the one hex behind a nearby opening', () => {
  const bases = [compound('a', { q: 0, r: 0 }, 3)];
  const INNER = { q: 3, r: 0 }, OUTER = { q: 4, r: 0 };   // the span facing +x
  const breached = () => ringEdges({ q: 0, r: 0 }, 3, onSpan(INNER, OUTER, (e) => { e.destroyed = true; }));
  const K = (q, r) => axialKey(q, r);

  it('reveals nothing while every span stands', () => {
    const s = makeScene({ bases, wallEdges: ringEdges({ q: 0, r: 0 }, 3) });
    Object.assign(s, at(5, 0));
    s._updateVisibility(view);
    expect(s._peeked.size).toBe(0);
  });

  it('reveals exactly ONE hex through a breach he is standing at', () => {
    const s = makeScene({ bases, wallEdges: breached() });
    Object.assign(s, at(5, 0));
    s._updateVisibility(view);
    expect([...s._peeked]).toEqual([K(3, 0)]);
    const p = hexToPixel(3, 0);
    expect(s._peekVisible(p.x, p.y)).toBe(true);
    expect(s._pointVisible(p.x, p.y)).toBe(true);          // …and it is targetable
  });

  it('leaves the rest of the yard dark — it is a peek through a hole, not a view of it', () => {
    const s = makeScene({ bases, wallEdges: breached() });
    Object.assign(s, at(5, 0));
    s._updateVisibility(view);
    const yard = range({ q: 0, r: 0 }, 3).filter((h) => !(h.q === 3 && h.r === 0));
    for (const h of yard) {
      const p = hexToPixel(h.q, h.r);
      expect(s._pointVisible(p.x, p.y)).toBe(false);
    }
  });

  it('cuts the peeked hex out of the drawn fill — one fewer than the full footprint', () => {
    const s = makeScene({ bases, wallEdges: breached() });
    Object.assign(s, at(5, 0));
    s._updateVisibility(view);
    expect(s.counts.fills).toBe(36);
  });

  it('treats an OPEN GATE identically to a breach — one code path, no branch', () => {
    const gated = ringEdges({ q: 0, r: 0 }, 3,
      onSpan(INNER, OUTER, (e) => { e.role = SPAN_ROLE_GATE; e.open = true; }));
    const s = makeScene({ bases, wallEdges: gated });
    Object.assign(s, at(5, 0));
    s._updateVisibility(view);
    expect([...s._peeked]).toEqual([K(3, 0)]);
  });

  // Still position-dependent, which is what v1 got wrong (it unioned over every exterior angle and
  // lit nearly the whole yard from one hole). At one hex of depth the reveal simply closes as he
  // walks away from the hole.
  it('closes again once he moves off the opening', () => {
    const s = makeScene({ bases, wallEdges: breached() });
    Object.assign(s, at(9, 0));                            // too far out
    s._updateVisibility(view);
    expect(s._peeked.size).toBe(0);
    Object.assign(s, at(4, -6));                           // near the wall, but at a different face
    s._updateVisibility(view);
    expect(s._peeked.size).toBe(0);
  });

  it('stops peeking once he is inside — the compound is simply lit', () => {
    const s = makeScene({ bases, wallEdges: breached() });
    Object.assign(s, at(0, 0));
    s._updateVisibility(view);
    expect(s._peeked.size).toBe(0);
    expect(s.foggedHexes.size).toBe(0);
  });

  it('shows a garrison enemy standing in the peeked hex, and only there', () => {
    const seen = hexToPixel(3, 0), hidden = hexToPixel(0, 0);
    const mk = (p) => ({ x: p.x, y: p.y, view: { visible: true, setVisible(v) { this.visible = v; } } });
    const inPeek = mk(seen), deep = mk(hidden);
    const s = makeScene({ bases, wallEdges: breached(), enemies: [inPeek, deep] });
    Object.assign(s, at(5, 0));
    s._updateVisibility(view);
    s._syncEnemyFogVisibility();
    expect(inPeek.view.visible).toBe(true);
    expect(deep.view.visible).toBe(false);
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
