// #412 — an OPEN gate gets a targetable PIP. The complaint: a gate that has swung open is a
// doorway shots pass straight through (`wallEdgeCrossing` treats it as non-solid), so a round or
// beam aimed at it sails clean through the mouth and never lands — yet the span is perfectly
// LOCKABLE (a standing candidate whether open or shut), so the reticle grabs it and nothing you
// fire ever hurts it. The fix is a small targetable point at the mouth's midpoint whose hits route
// straight to the span's HP (`_damageWallEdge`). This is the gate analogue of #317's targeted-hex
// rule, and — like coverTargeting.test.js — it is driven against the REAL mixins on a minimal fake
// ArenaScene so it pins the wired behaviour, not a re-implementation.
import { describe, it, expect, vi } from 'vitest';
import { WorldMixin } from './world.js';
import { ProjectilesMixin } from './projectiles.js';
import { openGateOf, GATE_PIP_HIT_RADIUS } from './shared.js';
import { makeWallEdgeSet, gateEdges, setGateOpen, WALL_EDGE_HP } from '../../data/wallEdges.js';
import { drawWallEdges } from '../../art/wallArt.js';
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

// Fire one player round from the origin straight at `to`, optionally stamped with `targetGate`, and
// step it until it dies or runs out of travel. Returns the round.
function fireAt(s, to, targetGate = null) {
  const angle = Math.atan2(to.y, to.x);
  const round = makeProjectile(WEAPONS.autocannon, 0, 0, angle, { maxDist: 4000 });
  Object.assign(round, {
    owner: 'player', trail: [], seekTarget: null, targetHexKey: null, targetGate,
    originHexes: [s._hexKeyAt(0, 0)], _lastHexKey: s._hexKeyAt(0, 0),
  });
  s.projectiles = [round];
  for (let i = 0; i < 300 && !round.dead; i++) s._updateProjectiles(0.016);
  return round;
}

describe('#412 openGateOf — which lock picks expose a pip', () => {
  const gateEdge = (open) => ({ role: 'gate', open, destroyed: false, x0: 0, y0: 0, x1: 10, y1: 0 });

  it('returns the edge for a fully-OPEN, standing gate span target', () => {
    const e = gateEdge(true);
    expect(openGateOf({ x: 5, y: 0, edge: e })).toBe(e);
  });

  it('is null for a CLOSED gate — it is a solid door, hit anywhere already', () => {
    expect(openGateOf({ x: 5, y: 0, edge: gateEdge(false) })).toBe(null);
  });

  it('is null for a DESTROYED gate span (a permanent breach, nothing to shoot)', () => {
    expect(openGateOf({ x: 5, y: 0, edge: { role: 'gate', open: true, destroyed: true } })).toBe(null);
  });

  it('is null for a plain wall span, a hex, an enemy, and nothing', () => {
    expect(openGateOf({ x: 5, y: 0, edge: { role: 'wall', open: false } })).toBe(null);
    expect(openGateOf({ x: 5, y: 0, hexKey: '2,3' })).toBe(null);
    expect(openGateOf({ x: 5, y: 0, mech: {}, edge: gateEdge(true) })).toBe(null);
    expect(openGateOf(null)).toBe(null);
  });
});

describe('#412 a shot aimed at an OPEN gate impacts its pip and damages the span', () => {
  it('the BUG (control): an unstamped round sails clean through the open mouth', () => {
    const s = makeScene();
    setGateOpen(s.wallEdges, theGate(s), true);
    const before = theGate(s).hp;
    const round = fireAt(s, { x: mid(theGate(s)).x * 3, y: mid(theGate(s)).y * 3 });   // aimed past it
    expect(round.dead).toBeFalsy();                 // nothing stopped it
    expect(theGate(s).hp).toBe(before);             // …and the gate took nothing
  });

  it('a round stamped with the open gate stops at the pip and chips its HP', () => {
    const s = makeScene();
    setGateOpen(s.wallEdges, theGate(s), true);
    const before = theGate(s).hp;
    const round = fireAt(s, mid(theGate(s)), theGate(s));
    expect(round.dead).toBe(true);
    expect(theGate(s).hp).toBeLessThan(before);
    expect(s._impactFx).toHaveBeenCalled();
  });

  it('sustained fire at the pip DESTROYS the open gate outright', () => {
    const s = makeScene();
    setGateOpen(s.wallEdges, theGate(s), true);
    // The autocannon chips ~tens of HP a round; 200 HP falls in a handful of hits.
    for (let n = 0; n < 40 && !theGate(s).destroyed; n++) fireAt(s, mid(theGate(s)), theGate(s));
    expect(theGate(s).destroyed).toBe(true);
    // A blown gate is a real breach: the mouth is now passable to everyone (already was, while open)
    // and there is nothing left to lock — `openGateOf` reports null for the destroyed span.
    expect(openGateOf({ x: mid(theGate(s)).x, y: mid(theGate(s)).y, edge: theGate(s) })).toBe(null);
  });

  it('a CLOSED gate needs no pip — a plain round already detonates on the solid door (control)', () => {
    const s = makeScene();
    // left shut; not stamped, since a shut gate is solid and stops the round on its own
    const before = theGate(s).hp;
    const round = fireAt(s, { x: mid(theGate(s)).x * 3, y: mid(theGate(s)).y * 3 });
    expect(round.dead).toBe(true);                  // the shut door stopped it via `_wallEdgeHit`
    expect(theGate(s).hp).toBeLessThan(before);
  });
});

describe('#412 _targetGateDistance — the hitscan clamp geometry', () => {
  const s = makeScene();
  const gate = theGate(s);
  const m = mid(gate);

  it('clamps a beam that grazes the pip to the along-ray distance of the pip', () => {
    // Fire from well left of the gate, straight along +x through the midpoint's row.
    const t = s._targetGateDistance(m.x - 200, m.y, 0, 4000, gate);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(200 + GATE_PIP_HIT_RADIUS);
  });

  it('returns Infinity for a beam whose ray never comes within the pip radius', () => {
    const t = s._targetGateDistance(m.x - 200, m.y + GATE_PIP_HIT_RADIUS * 4, 0, 4000, gate);
    expect(t).toBe(Infinity);
  });

  it('returns Infinity when the pip is behind the muzzle within maxT', () => {
    const t = s._targetGateDistance(m.x + 200, m.y, 0, 4000, gate);   // firing away from it
    expect(t).toBe(Infinity);
  });
});

describe('#412 the pip is drawn only while the gate is fully OPEN', () => {
  // A recording Graphics stub: every fillCircle is logged so we can look for a mark at the midpoint.
  function recorder() {
    const circles = [];
    const g = {
      clear: () => g, fillStyle: () => g, fillPoints: () => g,
      fillCircle: (x, y, r) => { circles.push({ x, y, r }); return g; },
    };
    return { g, circles };
  }
  const HW = 7;
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1.5;

  it('draws a pip at the mouth midpoint when open, and none there when shut', () => {
    const s = makeScene();
    const gate = theGate(s);
    const m = mid(gate);

    const shut = recorder();
    drawWallEdges(shut.g, [gate], 14);
    expect(shut.circles.some((c) => near(c, m))).toBe(false);   // shut: nothing at the very centre

    setGateOpen(s.wallEdges, gate, true);
    gate.openFrac = 1;
    const open = recorder();
    drawWallEdges(open.g, [gate], 14);
    expect(open.circles.some((c) => near(c, m))).toBe(true);    // open: a mark lands on the midpoint
    void HW;
  });
});
