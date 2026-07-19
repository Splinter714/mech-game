// #337 — the SCENE WIRING of the region fog. (Replaces visibilityToggle.test.js, which pinned
// #306's per-hex raycast gate and its on/off flag; both are gone with the rework. The pure model's
// own tests live in data/fogRegions.test.js.)
//
// What matters here is the CADENCE and the plumbing, since that is what the rework is FOR:
// the lit set must be rebuilt on a threshold crossing and on a wall/gate event, and on nothing
// else — no per-frame recompute — and the fog must feed both drawing and targeting.
import { describe, it, expect } from 'vitest';
import { VisibilityMixin } from './visibility.js';
import { axialKey, hexToPixel, pixelToHex, range } from '../../data/hexgrid.js';
import { OPEN_CELL_SIZE } from '../../data/fogRegions.js';

// A realistic window: the drawn radius (~13 rings) must exceed the reveal radius or there would
// be no fog on screen to assert about.
const view = { width: 1280, height: 800 };

// NOTE: the fill counter lives on a mutable object rather than behind a getter — `Object.assign`
// COPIES a getter's current value rather than the getter itself, so a getter here would freeze at 0.
function makeScene({ bases = [], wallEdges = null, terrain = new Map(), enemies = [] } = {}) {
  const counts = { fills: 0 };
  const s = Object.assign(Object.create(VisibilityMixin), {
    px: 0, py: 0, bases, wallEdges, terrain, enemies,
    _hexKeyAt(x, y) { const h = pixelToHex(x, y); return axialKey(h.q, h.r); },
    add: {
      graphics() {
        return {
          setDepth() { return this; }, clear() {}, fillStyle() {}, fillPoints() { counts.fills++; },
        };
      },
    },
    counts,
  });
  s._initVisibility();
  return s;
}

const at = (q, r) => { const p = hexToPixel(q, r); return { px: p.x, py: p.y }; };

describe('#337 fog: the region threshold IS the recompute trigger', () => {
  it('computes a lit set on the first tick', () => {
    const s = makeScene();
    expect(s.visibleHexes).toBe(null);
    s._updateVisibility(view);
    expect(s.visibleHexes.size).toBeGreaterThan(0);
    expect(s._pointVisible(0, 0)).toBe(true);
  });

  // The whole point of the rework. Driving around inside one region must not rebuild anything.
  it('does NOT rebuild while the player moves within a region', () => {
    const s = makeScene();
    s._updateVisibility(view);
    const first = s.visibleHexes;
    Object.assign(s, at(1, 1));
    s._updateVisibility(view);
    Object.assign(s, at(2, 1));
    s._updateVisibility(view);
    expect(s.visibleHexes).toBe(first);   // same Set object — literally not recomputed
  });

  it('DOES rebuild when the player crosses into another region', () => {
    const s = makeScene();
    s._updateVisibility(view);
    const first = s.visibleHexes;
    Object.assign(s, at(OPEN_CELL_SIZE * 3, OPEN_CELL_SIZE * 3));
    s._updateVisibility(view);
    expect(s.visibleHexes).not.toBe(first);
  });

  it('rebuilds on a wall/gate event in place, with no movement at all', () => {
    const s = makeScene();
    s._updateVisibility(view);
    const first = s.visibleHexes;
    s._invalidateVisibility();
    s._updateVisibility(view);
    expect(s.visibleHexes).not.toBe(first);
    expect(s._fogDirty).toBe(false);
  });
});

describe('#337 fog: compounds are dark from outside, lit from inside', () => {
  const base = { id: 'base0', center: { q: 0, r: 0 }, footprint: range({ q: 0, r: 0 }, 2) };

  it('standing outside, the compound interior is fogged but its wall line is not', () => {
    const s = makeScene({ bases: [base] });
    Object.assign(s, at(14, 0));         // well outside, in the open
    s._updateVisibility(view);
    const inner = hexToPixel(0, 0);
    expect(s._pointVisible(inner.x, inner.y)).toBe(false);
  });

  it('standing inside, the whole compound is lit', () => {
    const s = makeScene({ bases: [base] });
    Object.assign(s, at(0, 0));
    s._updateVisibility(view);
    expect(s.fogRegion).toBe('base:base0');
    for (const h of base.footprint) {
      const p = hexToPixel(h.q, h.r);
      expect(s._pointVisible(p.x, p.y)).toBe(true);
    }
  });
});

describe('#337 fog: terrain persists for the run, enemies do not', () => {
  it('remembers ground once seen, even after walking away', () => {
    const s = makeScene();
    s._updateVisibility(view);
    const seen = [...s.visibleHexes][0];
    Object.assign(s, at(OPEN_CELL_SIZE * 8, OPEN_CELL_SIZE * 8));
    s._updateVisibility(view);
    expect(s.visibleHexes.has(seen)).toBe(false);   // no longer LIT
    expect(s.knownHexes.has(seen)).toBe(true);      // but still MAPPED
  });

  it('hides an enemy standing in fog and shows one in the lit region', () => {
    const far = hexToPixel(40, 0);
    const near = hexToPixel(0, 0);
    const enemies = [
      { x: far.x, y: far.y, view: mockView() },
      { x: near.x, y: near.y, view: mockView() },
    ];
    const s = makeScene({ enemies });
    s._updateVisibility(view);
    s._syncEnemyFogVisibility();
    expect(enemies[0].view.visible).toBe(false);
    expect(enemies[1].view.visible).toBe(true);
  });

  it('never hides an airborne enemy or a wall turret', () => {
    const far = hexToPixel(40, 0);
    const enemies = [
      { x: far.x, y: far.y, flying: true, view: mockView() },
      { x: far.x, y: far.y, spanKey: '1,1/2,1', view: mockView() },
    ];
    const s = makeScene({ enemies });
    s._updateVisibility(view);
    s._syncEnemyFogVisibility();
    expect(enemies[0].view.visible).toBe(true);
    expect(enemies[1].view.visible).toBe(true);
  });

  // Symmetric visibility — the rule that guarantees he is never shot by something invisible.
  it('shows an awake enemy that has a firing lane, however deep in the fog it sits', () => {
    const far = hexToPixel(40, 0);
    const e = { x: far.x, y: far.y, _losClear: true, awareness: 'aware', view: mockView() };
    const s = makeScene({ enemies: [e] });
    s._updateVisibility(view);
    s._syncEnemyFogVisibility();
    expect(e.view.visible).toBe(true);
    expect(s._enemyVisible(e)).toBe(true);
    // ...and a dormant one with the same clear lane stays hidden: fog conceals BEFORE the fight.
    e.awareness = 'dormant';
    expect(s._enemyVisible(e)).toBe(false);
  });
});

describe('#337 fog: the overlay draws, and only when it needs to', () => {
  it('fills fogged hexes on the first tick', () => {
    const s = makeScene();
    s._updateVisibility(view);
    expect(s.counts.fills).toBeGreaterThan(0);
  });

  it('skips the redraw while the camera has barely moved', () => {
    const s = makeScene();
    s._updateVisibility(view);
    const after = s.counts.fills;
    s.px += 2;
    s._updateVisibility(view);
    expect(s.counts.fills).toBe(after);
  });
});

function mockView() {
  return { visible: null, setVisible(v) { this.visible = v; return this; } };
}
