// #309 — scene-level coverage for the wall-GATE wiring (`_initGates` / `_updateGateDemand` /
// `_updateGates` in scenes/arena/bases.js). The cycle itself is proved pure in
// data/gateCycle.test.js and the SEAL is proved in wallEdgeWorld.test.js; what's pinned here is the
// glue — and, since the 2026-07-19 playtest, the DEMAND QUERY, which is the part that actually
// answers the owner's complaint ("gates seem to open on a timer instead of based on enemy
// proximity; let them open when an enemy needs it, not on a timer").
//
// So the harness is a real enclosure now, not two loose spans: a ring of six wall spans around the
// origin hex with one of them a gate, a garrison unit inside it, and the player outside. That is
// the smallest world in which "does a unit need this gate" has a meaningful answer, because the
// unit's only route out is through the door.
//
// Same hand-rolled harness style as dockResupply.test.js: a plain object with the mixins assigned
// and a minimal Phaser-shaped `add`/`tweens`/`time` stand-in.
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));

import { BasesMixin } from './bases.js';
import { WorldMixin } from './world.js';
import { makeWallEdgeSet, gateEdges, WALL_EDGE_HP } from '../../data/wallEdges.js';
import { axialKey, neighbors, hexToPixel } from '../../data/hexgrid.js';
import { AWARE, DORMANT } from '../../data/awareness.js';
import {
  GATE_REACTION_MS, GATE_OPENING_MS, GATE_MIN_OPEN_MS, GATE_CLOSING_MS, GATE_STAGGER_MAX_MS,
} from '../../data/gateCycle.js';

// A gate's reaction is staggered by a random per-gate offset (`GATE_STAGGER_MAX_MS`), and demand is
// sampled on a 250ms scan rather than every frame, so these tests step by BOUNDS rather than by an
// exact time — the same approach dockResupply.test.js takes to #311's per-dock jitter.
// `SURELY_OPEN_MS` is past the latest a wanted gate can possibly be open by; `SURELY_SHUT_MS` is
// short of the earliest any gate can possibly have started moving.
const SURELY_OPEN_MS = GATE_REACTION_MS + GATE_STAGGER_MAX_MS + GATE_OPENING_MS + 600;
const SURELY_SHUT_MS = GATE_REACTION_MS - 300;

function fakeGameObject() {
  const obj = {};
  for (const m of ['setDepth', 'setScale', 'setStrokeStyle', 'setRadius']) obj[m] = () => obj;
  obj.destroy = () => {};
  return obj;
}

const A = { q: 0, r: 0 };
const NB = neighbors(A.q, A.r);

// A live garrison unit: awake, alive, on the ground, and able to move — the shape
// `_isGateDemandUnit` accepts.
function garrison(hex = A, over = {}) {
  const p = hexToPixel(hex.q, hex.r);
  return {
    x: p.x, y: p.y, baseId: 'base0', awareness: AWARE, flying: false,
    mech: { isDestroyed: () => false }, ...over,
  };
}

// A ring of six spans fully enclosing the origin hex, with `NB[3]`'s span as the gate. The unit
// inside has exactly one possible way out, which is what makes the demand query's answer
// unambiguous.
function makeScene({ enemies = [garrison()], impassableRing = false } = {}) {
  const terrain = new Map();
  for (let q = -6; q <= 6; q++) for (let r = -6; r <= 6; r++) terrain.set(axialKey(q, r), 'grass');
  // The "genuinely sealed in" variant: ring the origin with impassable terrain so that even with
  // every gate hypothetically open there is no route out at all.
  if (impassableRing) for (const n of NB) terrain.set(axialKey(n.q, n.r), 'lava');

  const scene = Object.assign({}, WorldMixin, BasesMixin, {
    terrain,
    wallEdges: makeWallEdgeSet(NB.map((n, i) => ({
      a: A, b: n, baseId: 'base0', ...(i === 3 ? { role: 'gate' } : {}),
    }))),
    buildingHp: new Map(), coverHp: new Map(),
    enemies, bases: [],
    // The player, outside the ring and reachable on open ground — so a unit inside has a real
    // route to him the moment a door is (hypothetically) open.
    px: hexToPixel(0, 3).x, py: hexToPixel(0, 3).y,
    _wokenBases: new Set(),
    time: { now: 0 },
    tweens: { add: (cfg) => { if (cfg.onComplete) cfg.onComplete(); return {}; } },
    add: { circle: () => fakeGameObject(), rectangle: () => fakeGameObject() },
    redraws: 0,
    _redrawWallEdges() { scene.redraws++; },
    _invalidateVisibility() { scene.invalidations = (scene.invalidations ?? 0) + 1; },
    _outpostCollapseFx() {},
  });
  scene._initGates();
  return scene;
}

const theGate = (s) => gateEdges(s.wallEdges)[0];

// Advance in real 16ms frames.
function run(s, ms) {
  for (let t = 0; t < ms; t += 16) { s.time.now += 16; s._updateGates(0.016); }
}

describe('#309 gate wiring', () => {
  it('builds one cycle per gate span and leaves it shut', () => {
    const s = makeScene();
    expect(s._gateStates.size).toBe(1);          // the five plain spans get no cycle
    expect(theGate(s).open).toBe(false);
    expect(theGate(s).openFrac).toBe(0);
  });

  // ── The precondition ─────────────────────────────────────────────────────────────────
  // A base the player has not woken keeps its gates shut forever, even with a garrison that would
  // otherwise be asking for the door. The sortie is a REACTION to the alarm, so it cannot precede
  // it.
  it('a dormant base never opens its gate, however long the run goes', () => {
    const s = makeScene({ enemies: [garrison(A, { awareness: DORMANT })] });
    run(s, 120000);
    expect(theGate(s).open).toBe(false);
    expect(s.redraws).toBe(0);
  });

  // ── THE ISSUE ────────────────────────────────────────────────────────────────────────
  // The test that would have caught the reported bug. An AWAKE base with nobody who needs the door
  // must never open it — no clock, no metronome, no sortie the player did not provoke.
  it('an awake base with an EMPTY garrison never opens its gate — no timer', () => {
    const s = makeScene({ enemies: [] });
    s._wokenBases.add('base0');
    run(s, 120000);
    expect(theGate(s).open).toBe(false);
    expect(s._gateStates.get(theGate(s).key).sorties).toBe(0);
  });

  // The same, with a garrison that exists but cannot use the door: flyers go over the wall and
  // wall turrets are bolted down. Neither should ever cause a gate to crank.
  it('a garrison of only flyers and wall turrets never opens the gate', () => {
    const s = makeScene({ enemies: [
      garrison(A, { flying: true }),
      garrison(A, { behavior: 'turret' }),
    ] });
    s._wokenBases.add('base0');
    run(s, 60000);
    expect(theGate(s).open).toBe(false);
  });

  // The sealed-in case the issue calls out by name: if no gate can help — here because impassable
  // terrain rings the unit — the demand query must find no route and open nothing, rather than
  // cranking a door pointlessly.
  it('a genuinely sealed-in garrison does not trigger the gate', () => {
    const s = makeScene({ impassableRing: true });
    s._wokenBases.add('base0');
    run(s, 60000);
    expect(theGate(s).open).toBe(false);
  });

  // ── The positive case: it opens because a unit needs out ──────────────────────────────
  it('opens because a garrison unit needs out, a reaction beat after waking', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    run(s, SURELY_SHUT_MS);
    expect(theGate(s).open).toBe(false);          // still cranking up
    run(s, SURELY_OPEN_MS);
    expect(theGate(s).open).toBe(true);
    expect(theGate(s).openFrac).toBe(1);
  });

  // …and it shuts again once the demand goes away — here by the garrison being wiped out, which is
  // the ordinary way a sortie ends.
  it('shuts again once nothing needs it, and the span goes solid with it', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    run(s, SURELY_OPEN_MS);
    expect(theGate(s).open).toBe(true);
    s.enemies.length = 0;                         // the garrison is dead; nobody wants the door
    run(s, GATE_MIN_OPEN_MS + GATE_CLOSING_MS + 2000);
    expect(theGate(s).open).toBe(false);
    expect(theGate(s).openFrac).toBe(0);
  });

  // Anti-flicker at the SCENE level: a unit whose route churns (here, teleporting in and out of
  // the compound every few frames) must not make the door stutter. The grace window in
  // gateDemand.js plus the minimum-open floor absorb it — the gate opens once and stays open.
  it('does not stutter when a unit route churns', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    const e = s.enemies[0];
    const inside = hexToPixel(A.q, A.r);
    const outside = hexToPixel(0, 5);
    let transitions = 0;
    let prev = theGate(s).open;
    for (let t = 0; t < 20000; t += 16) {
      s.time.now += 16;
      // Churn the unit's position — and therefore its route — on a fast cycle.
      const here = Math.floor(t / 300) % 2 === 0 ? inside : outside;
      e.x = here.x; e.y = here.y;
      s._updateGates(0.016);
      if (theGate(s).open !== prev) { transitions++; prev = theGate(s).open; }
    }
    // At most one open and one close across 20 seconds of churn — never a stutter.
    expect(transitions).toBeLessThanOrEqual(2);
  });

  // The leaves have to be SEEN to move — a gate that teleports between shut and open reads as a
  // span popping out of existence, which is exactly the breach it must not be confused with.
  it('animates the leaves through intermediate positions rather than snapping', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    const seen = new Set();
    for (let t = 0; t < SURELY_OPEN_MS; t += 16) {
      s.time.now += 16; s._updateGates(0.016);
      seen.add(Math.round(theGate(s).openFrac * 10) / 10);
    }
    // Genuinely partial positions, not just 0 and 1.
    expect([...seen].filter((f) => f > 0 && f < 1).length).toBeGreaterThan(3);
  });

  // Sight is cached (#306) and routes are cached (#312), so a gate opening or shutting must
  // invalidate both — otherwise the player would not see the units that just became visible
  // through the opening, and they would not know they can now walk through it.
  it('invalidates the cached field of view when the gate opens and when it shuts', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    run(s, SURELY_OPEN_MS);
    s.enemies.length = 0;
    run(s, GATE_MIN_OPEN_MS + GATE_CLOSING_MS + 2000);
    expect(s.invalidations).toBeGreaterThanOrEqual(2);
  });

  // A blown gate is just a breach. It must never re-close, re-open, or keep ticking — the player
  // has permanently taken one of the base's sally ports away from it.
  it('drops a DESTROYED gate out of the cycle permanently', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    const gate = theGate(s);
    s._damageWallEdge(gate, WALL_EDGE_HP);
    expect(gate.destroyed).toBe(true);
    run(s, SURELY_OPEN_MS + 60000);
    expect(s._gateStates.size).toBe(0);
    expect(gate.open).toBe(false);
    // And the hole it left is a real hole — solid to nobody, player included.
    const m = { x: (gate.x0 + gate.x1) / 2, y: (gate.y0 + gate.y1) / 2 };
    expect(s._blocked(m.x, m.y)).toBe(false);
  });

  // ── The playtest's other change ──────────────────────────────────────────────────────
  // "Player should be able to pass through the gate when it's open, it just shouldn't open FOR the
  // player." Both halves, on the same span, at the same moment.
  it('an open gate is passable to the player as well as to the garrison', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    run(s, SURELY_OPEN_MS);
    const gate = theGate(s);
    const m = { x: (gate.x0 + gate.x1) / 2, y: (gate.y0 + gate.y1) / 2 };
    expect(gate.open).toBe(true);
    expect(s._blocked(m.x, m.y)).toBe(false);
    // A swept drive straight through the mouth crosses nothing solid.
    expect(s._blockedAlongSegment(hexToPixel(A.q, A.r).x, hexToPixel(A.q, A.r).y,
      hexToPixel(NB[3].q, NB[3].r).x, hexToPixel(NB[3].q, NB[3].r).y)).toBe(false);
  });

  // …but the PLAYER cannot cause one to open. He is not a garrison unit, so parking on the mouth
  // of a shut gate — the most obvious thing a player would try — achieves exactly nothing.
  it('the player standing on a shut gate never makes it open', () => {
    const s = makeScene({ enemies: [] });
    s._wokenBases.add('base0');
    const gate = theGate(s);
    s.px = (gate.x0 + gate.x1) / 2; s.py = (gate.y0 + gate.y1) / 2;
    run(s, 60000);
    expect(gate.open).toBe(false);
  });
});
