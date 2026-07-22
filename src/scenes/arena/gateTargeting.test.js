// #427 (supersedes #412's aim pip) — a gate is TWO ADJACENT LEAVES, each its OWN real span. A leaf,
// open or shut, is always SOLID TO FIRE: a round or beam aimed at it detonates on it and routes to
// THAT leaf's HP pool, rather than sailing through the mouth. Units still DRIVE through the central
// passage between the two leaves (movement uses `blocksSpan`, under which an open leaf is a
// doorway). Driven against the REAL mixins on a minimal fake ArenaScene so it pins the wired
// behaviour, not a re-implementation.
import { describe, it, expect, vi } from 'vitest';
import { WorldMixin } from './world.js';
import { ProjectilesMixin } from './projectiles.js';
import { makeWallEdgeSet, gateEdges, setGateOpen } from '../../data/wallEdges.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeProjectile } from '../../data/delivery.js';
import { axialKey, neighbors } from '../../data/hexgrid.js';

// A two-leaf gate off the origin so a round has room to travel to it: two consecutive outward faces
// of hex A (they share a corner — the passage centre), both flagged gate.
const A = { q: 2, r: 0 };
const NS = neighbors(A.q, A.r);

function makeScene() {
  const terrain = new Map();
  for (let q = -8; q <= 8; q++) for (let r = -8; r <= 8; r++) terrain.set(axialKey(q, r), 'grass');
  const scene = Object.assign({}, WorldMixin, ProjectilesMixin, {
    terrain, buildingHp: new Map(), coverHp: new Map(),
    wallEdges: makeWallEdgeSet([
      { a: A, b: NS[0], baseId: 'base0', role: 'gate' },
      { a: A, b: NS[1], baseId: 'base0', role: 'gate' },
    ]),
    enemies: [], projectiles: [], firePatches: [],
    px: 0, py: 0, turretAngle: 0,
    mech: { isDestroyed: () => false },
    time: { now: 0 },
    tileImages: new Map(), canopyImages: new Map(),
    projFx: { clear: vi.fn() },
    _impactFx: vi.fn(),
    _rangeFactor: () => 1,
    _redrawWallEdges() {}, _invalidateVisibility() {}, _invalidateRoutes() {}, _outpostCollapseFx() {},
  });
  scene._drawProjectile = vi.fn();   // pure canvas art, irrelevant here
  return scene;
}

const leaves = (s) => gateEdges(s.wallEdges);
const mid = (e) => ({ x: (e.x0 + e.x1) / 2, y: (e.y0 + e.y1) / 2 });

// Fire one player round from the origin straight at `to` and step it until it dies or runs out of
// travel. NO targetGate stamp — the #427 point is that a plain round now stops on an open leaf.
function fireAt(s, to) {
  const angle = Math.atan2(to.y, to.x);
  const round = makeProjectile(WEAPONS.autocannon, 0, 0, angle, { maxDist: 4000 });
  Object.assign(round, {
    owner: 'player', trail: [], seekTarget: null, targetHexKey: null,
    originHexes: [s._hexKeyAt(0, 0)], _lastHexKey: s._hexKeyAt(0, 0),
  });
  s.projectiles = [round];
  for (let i = 0; i < 300 && !round.dead; i++) s._updateProjectiles(0.016);
  return round;
}

describe('#427 a plain round aimed at an OPEN gate leaf stops on THAT leaf and chips its HP', () => {
  it('the round detonates on an open leaf (no special stamp) and damages that leaf', () => {
    const s = makeScene();
    const leaf = leaves(s)[0];
    setGateOpen(s.wallEdges, leaf, true);
    const before = leaf.hp;
    const round = fireAt(s, mid(leaf));
    expect(round.dead).toBe(true);
    expect(leaf.hp).toBeLessThan(before);
    expect(s._impactFx).toHaveBeenCalled();
  });

  it('EACH leaf is independently hittable — firing at leaf 1 chips leaf 1, not leaf 0', () => {
    const s = makeScene();
    const [l0, l1] = leaves(s);
    setGateOpen(s.wallEdges, l0, true);
    setGateOpen(s.wallEdges, l1, true);
    const b0 = l0.hp, b1 = l1.hp;
    fireAt(s, mid(l1));
    expect(l1.hp).toBeLessThan(b1);
    expect(l0.hp).toBe(b0);
  });

  it('a round fired THROUGH an open leaf (aimed past it) still hits it — it never sails through', () => {
    const s = makeScene();
    const leaf = leaves(s)[0];
    setGateOpen(s.wallEdges, leaf, true);
    const before = leaf.hp;
    const m = mid(leaf);
    const round = fireAt(s, { x: m.x * 3, y: m.y * 3 });   // aimed well past the leaf, crossing it
    expect(round.dead).toBe(true);
    expect(leaf.hp).toBeLessThan(before);
  });

  it('sustained fire DESTROYS an open leaf outright', () => {
    const s = makeScene();
    setGateOpen(s.wallEdges, leaves(s)[0], true);
    for (let n = 0; n < 40 && !leaves(s)[0].destroyed; n++) {
      const leaf = leaves(s)[0];
      if (leaf.destroyed) break;
      fireAt(s, mid(leaf));
    }
    expect(leaves(s)[0].destroyed).toBe(true);
  });

  it('a SHUT leaf behaves the same — a plain round detonates on the solid door (control)', () => {
    const s = makeScene();   // left shut
    const leaf = leaves(s)[0];
    const before = leaf.hp;
    const m = mid(leaf);
    const round = fireAt(s, { x: m.x * 3, y: m.y * 3 });
    expect(round.dead).toBe(true);
    expect(leaf.hp).toBeLessThan(before);
  });
});
