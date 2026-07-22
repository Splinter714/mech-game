// #427 (supersedes #412's aim pip) — an OPEN gate is TWO door leaves that part toward their posts
// but only retract ~70%, leaving a solid stub on each side. Kept as ONE logical edge, it is always
// SOLID TO FIRE: a round or beam aimed at it detonates on it and routes to its single HP pool,
// rather than sailing through the mouth. Units still DRIVE through the central passage (movement
// uses `blocksSpan`, under which an open gate is a doorway). Driven against the REAL mixins on a
// minimal fake ArenaScene so it pins the wired behaviour, not a re-implementation.
import { describe, it, expect, vi } from 'vitest';
import { WorldMixin } from './world.js';
import { ProjectilesMixin } from './projectiles.js';
import { makeWallEdgeSet, gateEdges, setGateOpen } from '../../data/wallEdges.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeProjectile } from '../../data/delivery.js';
import { axialKey } from '../../data/hexgrid.js';

// A gate span between two adjacent hexes, off the origin so a round has room to travel to it.
const A = { q: 2, r: 0 }, B = { q: 2, r: -1 };

function makeScene() {
  const terrain = new Map();
  for (let q = -8; q <= 8; q++) for (let r = -8; r <= 8; r++) terrain.set(axialKey(q, r), 'grass');
  const scene = Object.assign({}, WorldMixin, ProjectilesMixin, {
    terrain, buildingHp: new Map(), coverHp: new Map(),
    wallEdges: makeWallEdgeSet([{ a: A, b: B, baseId: 'base0', role: 'gate' }]),
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

const theGate = (s) => gateEdges(s.wallEdges)[0];
const mid = (e) => ({ x: (e.x0 + e.x1) / 2, y: (e.y0 + e.y1) / 2 });

// Fire one player round from the origin straight at `to` and step it until it dies or runs out of
// travel. NO targetGate stamp — the #427 point is that a plain round now stops on an open gate.
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

describe('#427 a plain round aimed at an OPEN gate now stops on it and chips its HP', () => {
  it('the round detonates on the open gate (no special stamp) and damages the span', () => {
    const s = makeScene();
    setGateOpen(s.wallEdges, theGate(s), true);
    const before = theGate(s).hp;
    const round = fireAt(s, mid(theGate(s)));
    expect(round.dead).toBe(true);
    expect(theGate(s).hp).toBeLessThan(before);
    expect(s._impactFx).toHaveBeenCalled();
  });

  it('a round fired THROUGH the open mouth (aimed past it) still hits the gate — it never sails through', () => {
    const s = makeScene();
    setGateOpen(s.wallEdges, theGate(s), true);
    const before = theGate(s).hp;
    const m = mid(theGate(s));
    const round = fireAt(s, { x: m.x * 3, y: m.y * 3 });   // aimed well past the gate, crossing it
    expect(round.dead).toBe(true);
    expect(theGate(s).hp).toBeLessThan(before);
  });

  it('sustained fire DESTROYS the open gate outright', () => {
    const s = makeScene();
    setGateOpen(s.wallEdges, theGate(s), true);
    for (let n = 0; n < 40 && !theGate(s).destroyed; n++) fireAt(s, mid(theGate(s)));
    expect(theGate(s).destroyed).toBe(true);
  });

  it('a SHUT gate behaves the same — a plain round detonates on the solid door (control)', () => {
    const s = makeScene();   // left shut
    const before = theGate(s).hp;
    const m = mid(theGate(s));
    const round = fireAt(s, { x: m.x * 3, y: m.y * 3 });
    expect(round.dead).toBe(true);
    expect(theGate(s).hp).toBeLessThan(before);
  });
});
