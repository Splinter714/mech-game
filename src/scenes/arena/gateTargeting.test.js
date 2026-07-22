// #427 (supersedes #412's aim pip) — a gate is TWO ADJACENT LEAVES, each its OWN real span. A leaf's
// DOOR MATERIAL is always solid to fire — a round aimed at the door detonates on it and routes to THAT
// leaf's HP pool. But an OPEN leaf visually RETRACTS toward its hinge post (Jackson 2026-07-22, "I
// should be able to shoot through the OPEN PART of an open gate"), so a round crossing only the central
// gap the leaves parted from now PASSES clean through — the door near the post still stops it. A SHUT
// leaf is solid across its whole span. Units still DRIVE the whole open mouth (movement uses
// `blocksSpan`). Driven against the REAL mixins on a minimal fake ArenaScene so it pins the wired
// behaviour, not a re-implementation.
import { describe, it, expect, vi } from 'vitest';
import { WorldMixin } from './world.js';
import { ProjectilesMixin } from './projectiles.js';
import { makeWallEdgeSet, gateEdges, setGateOpen, spanFireSegment } from '../../data/wallEdges.js';
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
// #427: the middle of the leaf's live SOLID stub (retracted door material near the hinge post) — the
// point a shot must cross to hit an OPEN leaf.
const solidMid = (e) => mid(spanFireSegment(e));
// The shared meeting vertex the two leaves part away from — the centre of the OPEN passage. Both
// leaves retract off it, so a round aimed here crosses only open air.
const meetVertex = (e) => (e.gateHingeEnd === 1 ? { x: e.x0, y: e.y0 } : { x: e.x1, y: e.y1 });

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

describe('#427 shooting an OPEN gate: the door material stops rounds, the parted gap passes them', () => {
  it('a round aimed at an open leaf\'s SOLID DOOR detonates on that leaf and chips its HP', () => {
    const s = makeScene();
    const leaf = leaves(s)[0];
    setGateOpen(s.wallEdges, leaf, true);
    const before = leaf.hp;
    const round = fireAt(s, solidMid(leaf));
    expect(round.dead).toBe(true);
    expect(leaf.hp).toBeLessThan(before);
    expect(s._impactFx).toHaveBeenCalled();
  });

  it('a round aimed through the OPEN GAP passes clean through — NEITHER leaf is touched', () => {
    const s = makeScene();
    const [l0, l1] = leaves(s);
    setGateOpen(s.wallEdges, l0, true);
    setGateOpen(s.wallEdges, l1, true);
    const b0 = l0.hp, b1 = l1.hp;
    fireAt(s, meetVertex(l0));            // dead centre of the parted passage — open air
    expect(l0.hp).toBe(b0);
    expect(l1.hp).toBe(b1);
    expect(l0.destroyed).toBe(false);
    expect(l1.destroyed).toBe(false);
  });

  it('EACH leaf is independently hittable on its door — firing at leaf 1 chips leaf 1, not leaf 0', () => {
    const s = makeScene();
    const [l0, l1] = leaves(s);
    setGateOpen(s.wallEdges, l0, true);
    setGateOpen(s.wallEdges, l1, true);
    const b0 = l0.hp, b1 = l1.hp;
    fireAt(s, solidMid(l1));
    expect(l1.hp).toBeLessThan(b1);
    expect(l0.hp).toBe(b0);
  });

  it('a round fired PAST an open leaf\'s door (aimed beyond it) still hits it — the door never sails through', () => {
    const s = makeScene();
    const leaf = leaves(s)[0];
    setGateOpen(s.wallEdges, leaf, true);
    const before = leaf.hp;
    const m = solidMid(leaf);
    const round = fireAt(s, { x: m.x * 3, y: m.y * 3 });   // aimed well past the door, crossing it
    expect(round.dead).toBe(true);
    expect(leaf.hp).toBeLessThan(before);
  });

  it('sustained fire on the door DESTROYS an open leaf outright', () => {
    const s = makeScene();
    setGateOpen(s.wallEdges, leaves(s)[0], true);
    for (let n = 0; n < 40 && !leaves(s)[0].destroyed; n++) {
      const leaf = leaves(s)[0];
      if (leaf.destroyed) break;
      fireAt(s, solidMid(leaf));
    }
    expect(leaves(s)[0].destroyed).toBe(true);
  });

  it('a SHUT leaf blocks across its WHOLE span — a round at its full midpoint detonates (control)', () => {
    const s = makeScene();   // left shut
    const leaf = leaves(s)[0];
    const before = leaf.hp;
    const m = mid(leaf);
    const round = fireAt(s, { x: m.x * 3, y: m.y * 3 });
    expect(round.dead).toBe(true);
    expect(leaf.hp).toBeLessThan(before);
  });
});
