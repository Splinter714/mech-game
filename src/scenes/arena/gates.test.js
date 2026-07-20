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

import { BasesMixin, GATE_DEMAND_MAX_NODES } from './bases.js';
import { WorldMixin } from './world.js';
import { makeWallEdgeSet, gateEdges, WALL_EDGE_HP } from '../../data/wallEdges.js';
import { axialKey, neighbors, hexToPixel } from '../../data/hexgrid.js';
import { AWARE, DORMANT } from '../../data/awareness.js';
import { findHexPath, ROUTE_MAX_NODES } from '../../data/hexRoute.js';
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
    kind: 'tank', kindDef: { move: { maxSpeed: 52 } },   // a real tank's speed, for ETA
    mech: { isDestroyed: () => false }, ...over,
  };
}

// #355: the base's objective hex. It is "alive" while it has an entry in `buildingHp`; deleting
// that entry is exactly what destroying it does in the real game.
const OBJECTIVE_HEX = { q: 0, r: -2 };

// A ring of six spans fully enclosing the origin hex, with `NB[3]`'s span as the gate by default.
// The unit inside has exactly one possible way out, which is what makes the demand query's answer
// unambiguous.

function makeScene({
  enemies = [garrison()], impassableRing = false,
  // #355/#354: which of the six ring spans are gates. Defaults to the single original gate;
  // the fail-open tests pass several, since a ring now carries 2-5.
  gateAt = [3], objectiveAlive = null,
} = {}) {
  const terrain = new Map();
  for (let q = -6; q <= 6; q++) for (let r = -6; r <= 6; r++) terrain.set(axialKey(q, r), 'grass');
  // The "genuinely sealed in" variant: ring the origin with impassable terrain so that even with
  // every gate hypothetically open there is no route out at all.
  if (impassableRing) for (const n of NB) terrain.set(axialKey(n.q, n.r), 'lava');

  // Only the fail-open tests declare a base at all; every other test leaves `bases` empty, which
  // makes `_failedOpenBases()` empty and the gate logic identical to before #355.
  const buildingHp = new Map();
  const bases = objectiveAlive == null ? []
    : [{ id: 'base0', objectiveHex: OBJECTIVE_HEX, center: A }];
  if (objectiveAlive) buildingHp.set(axialKey(OBJECTIVE_HEX.q, OBJECTIVE_HEX.r), 200);

  const scene = Object.assign({}, WorldMixin, BasesMixin, {
    terrain,
    wallEdges: makeWallEdgeSet(NB.map((n, i) => ({
      a: A, b: n, baseId: 'base0', ...(gateAt.includes(i) ? { role: 'gate' } : {}),
    }))),
    buildingHp, coverHp: new Map(),
    enemies, bases,
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

  // ── PLAYTEST 2 REGRESSION (2026-07-19) ───────────────────────────────────────────────
  // "I don't see the gates actually opening for the tanks when they seem to be wanting it."
  //
  // Cause: the demand search shared the movement router's `ROUTE_MAX_NODES` (400), which #312
  // lowered from 1200 for performance. That is fine for MOVEMENT, which degrades gracefully — an
  // incomplete search still yields a useful partial route. It is not fine for DEMAND, whose result
  // is binary: a search that hits the cap returns `complete: false`, the scan skips it, and a unit
  // that genuinely wants out registers nothing. Measured in six real worlds, this silently swallowed
  // roughly a quarter of all demand, tanks included.
  //
  // This test builds a world where the route out is genuinely longer than the movement cap can
  // follow, proves the regime is real (the same search IS incomplete at ROUTE_MAX_NODES), and then
  // asserts the gate opens anyway.
  describe('a garrison whose route out is longer than the movement router can search', () => {
    // A one-hex-wide serpentine corridor leading away from the gate. One hex wide and winding, so
    // A* has no choice but to expand essentially every hex in it — which is how the test reaches a
    // node count above the movement cap without needing a huge map.
    //
    // It runs WESTWARD (decreasing q) from the gate's own neighbour, i.e. directly away from the
    // compound. That direction is load-bearing: an eastward corridor would run straight back
    // through the origin hex, and the ring's own wall spans would cut it there, so the route would
    // be blocked for a reason that has nothing to do with the node cap this test is about.
    function serpentine(from, width = 30, rows = 30) {
      const out = [];
      for (let row = 0; row <= rows; row++) {
        if (row % 2 === 0) {
          for (let i = 0; i <= width; i++) out.push({ q: from.q - i, r: from.r + row });
        } else {
          // The single step-across hex joining one run to the next, alternating ends.
          const i = ((row - 1) / 2) % 2 === 0 ? width : 0;
          out.push({ q: from.q - i, r: from.r + row });
        }
      }
      return out;
    }

    function makeCorridorScene() {
      const terrain = new Map();
      // Everything impassable by default, so the corridor is the ONLY way through.
      for (let q = -40; q <= 60; q++) for (let r = -40; r <= 60; r++) terrain.set(axialKey(q, r), 'lava');
      terrain.set(axialKey(A.q, A.r), 'grass');                       // the compound interior
      const corridor = serpentine(NB[3]);
      for (const h of corridor) terrain.set(axialKey(h.q, h.r), 'grass');
      const exit = corridor[corridor.length - 1];

      const scene = Object.assign({}, WorldMixin, BasesMixin, {
        terrain,
        wallEdges: makeWallEdgeSet(NB.map((n, i) => ({
          a: A, b: n, baseId: 'base0', ...(i === 3 ? { role: 'gate' } : {}),
        }))),
        buildingHp: new Map(), coverHp: new Map(),
        enemies: [garrison()], bases: [],
        px: hexToPixel(exit.q, exit.r).x, py: hexToPixel(exit.q, exit.r).y,
        _wokenBases: new Set(),
        time: { now: 0 },
        tweens: { add: (cfg) => { if (cfg.onComplete) cfg.onComplete(); return {}; } },
        add: { circle: () => fakeGameObject(), rectangle: () => fakeGameObject() },
        redraws: 0,
        _redrawWallEdges() { scene.redraws++; },
        _invalidateVisibility() {},
        _outpostCollapseFx() {},
      });
      scene._initGates();
      return { scene, exit };
    }

    // First: prove the test is actually in the regime it claims to be. If this ever stops being
    // true the regression test below has quietly stopped testing anything.
    it('is a route the MOVEMENT cap genuinely cannot complete', () => {
      const { scene, exit } = makeCorridorScene();
      const canStep = (a, b, k) => scene._canEnemyStepGatesOpen(a, b, k);
      const atMovementCap = findHexPath(A, exit, canStep, ROUTE_MAX_NODES);
      expect(atMovementCap.complete).toBe(false);          // this is the bug's regime
      const atDemandCap = findHexPath(A, exit, canStep, GATE_DEMAND_MAX_NODES);
      expect(atDemandCap.complete).toBe(true);             // …and the demand cap clears it
    });

    it('still opens the gate — the demand search gets its own, larger budget', () => {
      const { scene } = makeCorridorScene();
      scene._wokenBases.add('base0');
      run(scene, SURELY_OPEN_MS);
      expect(theGate(scene).open).toBe(true);
    });

    // The invariant behind the fix, stated directly: demand must never be searched on a smaller
    // budget than movement, or a unit can plan its way out and still fail to ask for the door.
    it('the demand budget is larger than the movement budget', () => {
      expect(GATE_DEMAND_MAX_NODES).toBeGreaterThan(ROUTE_MAX_NODES);
    });
  });

  // ── PLAYTEST 3 REGRESSION: JUST IN TIME ──────────────────────────────────────────────
  // "gates appear to be opening WAAAAAAY in advance of a ground unit needing to pass through it.
  // like it opens when the pathing is decided, but it should open at the last moment when it needs
  // to pass through instead."
  //
  // Cause: demand fired the moment a unit's route CROSSED a gate, with no notion of how far along
  // that route the unit actually was. So a unit deep in a compound opened the door immediately and
  // then walked to it while it stood wide open.
  //
  // These tests use a STRAIGHT corridor of known length so travel time is arithmetic rather than
  // guesswork, and they walk the unit down it at a real tank's speed.
  describe('just-in-time opening', () => {
    const CORRIDOR_HEXES = 16;
    const TANK_SPEED = 52 * 0.85;          // kindDef maxSpeed x the AI's speed fraction

    // A straight run of passable hexes leading away from the gate, with everything else impassable.
    // The player stands inside the compound, so a unit out in the corridor has a route to him that
    // crosses the gate — the same demand question as a garrison heading out, just mirrored, and it
    // lets the test control the unit's distance-to-door precisely.
    function makeCorridorScene() {
      const terrain = new Map();
      for (let q = -40; q <= 40; q++) for (let r = -40; r <= 40; r++) terrain.set(axialKey(q, r), 'lava');
      terrain.set(axialKey(A.q, A.r), 'grass');
      const corridor = [];
      for (let i = 0; i <= CORRIDOR_HEXES; i++) {
        const h = { q: NB[3].q - i, r: NB[3].r };
        corridor.push(h);
        terrain.set(axialKey(h.q, h.r), 'grass');
      }
      const scene = Object.assign({}, WorldMixin, BasesMixin, {
        terrain,
        wallEdges: makeWallEdgeSet(NB.map((n, i) => ({
          a: A, b: n, baseId: 'base0', ...(i === 3 ? { role: 'gate' } : {}),
        }))),
        buildingHp: new Map(), coverHp: new Map(),
        enemies: [], bases: [],
        px: hexToPixel(A.q, A.r).x, py: hexToPixel(A.q, A.r).y,   // the player, inside
        _wokenBases: new Set(['base0']),
        time: { now: 0 },
        tweens: { add: (cfg) => { if (cfg.onComplete) cfg.onComplete(); return {}; } },
        add: { circle: () => fakeGameObject(), rectangle: () => fakeGameObject() },
        _redrawWallEdges() {}, _invalidateVisibility() {}, _outpostCollapseFx() {},
      });
      scene._initGates();
      const gate = gateEdges(scene.wallEdges)[0];
      const mouth = { x: (gate.x0 + gate.x1) / 2, y: (gate.y0 + gate.y1) / 2 };
      return { scene, gate, mouth, corridor };
    }

    // THE BUG. A unit with a perfectly good route through the gate, but a long way from it, must
    // leave the door alone. Under the old behaviour this opened within about a second.
    it('a unit far down its route does NOT open the gate', () => {
      const { scene, gate, corridor } = makeCorridorScene();
      const far = corridor[corridor.length - 1];
      const p = hexToPixel(far.q, far.r);
      scene.enemies.push(garrison(A, { x: p.x, y: p.y }));
      run(scene, 30000);
      expect(gate.open).toBe(false);
      // …and it is genuinely wanting the door, not simply routeless — the intent exists, it is just
      // not close enough to be a request yet. Without this the test could pass for the wrong reason.
      expect(scene.enemies[0]._gateIntent?.key).toBe(gate.key);
    });

    // …and the same unit standing right outside opens it promptly.
    it('a unit right at its gate DOES open it', () => {
      const { scene, gate, mouth } = makeCorridorScene();
      scene.enemies.push(garrison(A, { x: mouth.x - 40, y: mouth.y }));
      run(scene, SURELY_OPEN_MS);
      expect(gate.open).toBe(true);
    });

    // THE MEASUREMENT. Walk the unit down the corridor at a real tank's speed and record how much
    // travel time is left when the doors finish opening. That lead should be positive (the door is
    // never late) but small (it is not opening "WAAAAAAY in advance").
    it('opens with a small positive lead — open before arrival, not long before', () => {
      const { scene, gate, mouth, corridor } = makeCorridorScene();
      const far = corridor[corridor.length - 1];
      const start = hexToPixel(far.q, far.r);
      const e = garrison(A, { x: start.x, y: start.y });
      scene.enemies.push(e);

      const totalPx = Math.hypot(mouth.x - start.x, mouth.y - start.y);
      const ux = (mouth.x - start.x) / totalPx, uy = (mouth.y - start.y) / totalPx;
      let openedAtMs = null, arrivedAtMs = null;
      for (let t = 0; t < 60000 && arrivedAtMs === null; t += 16) {
        const travelled = TANK_SPEED * (t / 1000);
        if (travelled < totalPx) { e.x = start.x + ux * travelled; e.y = start.y + uy * travelled; }
        else if (arrivedAtMs === null) arrivedAtMs = t;
        scene.time.now += 16;
        scene._updateGates(0.016);
        if (gate.open && openedAtMs === null) openedAtMs = t;
      }

      expect(openedAtMs).not.toBeNull();
      expect(arrivedAtMs).not.toBeNull();
      const leadMs = arrivedAtMs - openedAtMs;
      // Open BEFORE the unit gets there — never late, which is the worse failure.
      expect(leadMs).toBeGreaterThan(0);
      // …but only just. The whole complaint was a door standing open for many seconds; the lead is
      // budgeted at GATE_OPEN_LEAD_MS (2200ms) minus the 1400ms the doors take to react and travel,
      // so a couple of seconds of slack is the ceiling. A corridor this long (16 hexes, ~17s of
      // walking) would have opened at t=0 under the old behaviour, i.e. a lead of ~17000ms.
      expect(leadMs).toBeLessThan(3500);
    });
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

// ── #355: the whole ring fails open when the objective dies ────────────────────────────
// Scene-level half of the terminal state proved pure in data/gateCycle.test.js. The point of
// testing it here is MULTIPLICITY: #354 made a ring carry 2-5 gates, so "the base is beaten" has to
// reach every one of them, not just the one a garrison unit happened to be routing through.
describe('#355 gates lock open once the objective is destroyed', () => {
  const FOUR_GATES = [0, 2, 3, 5];
  const allGates = (s) => gateEdges(s.wallEdges);

  it('opens EVERY gate on the ring, with no garrison and nobody asking', () => {
    const s = makeScene({ gateAt: FOUR_GATES, objectiveAlive: false, enemies: [] });
    expect(allGates(s).length).toBe(4);
    run(s, GATE_OPENING_MS + 200);
    for (const g of allGates(s)) {
      expect(g.open).toBe(true);
      expect(g.openFrac).toBe(1);
    }
  });

  it('keeps them shut while the objective still stands, garrison or not', () => {
    const s = makeScene({ gateAt: FOUR_GATES, objectiveAlive: true, enemies: [] });
    s._wokenBases.add('base0');
    run(s, 60000);
    for (const g of allGates(s)) expect(g.open).toBe(false);
  });

  it('opens mid-run the moment the objective hex dies, and never shuts again', () => {
    const s = makeScene({ gateAt: FOUR_GATES, objectiveAlive: true, enemies: [] });
    s._wokenBases.add('base0');
    run(s, 5000);
    for (const g of allGates(s)) expect(g.open).toBe(false);
    s.buildingHp.delete(axialKey(OBJECTIVE_HEX.q, OBJECTIVE_HEX.r));   // the player blows it up
    run(s, GATE_OPENING_MS + 200);
    for (const g of allGates(s)) expect(g.open).toBe(true);
    run(s, 180000);
    for (const g of allGates(s)) expect(g.open).toBe(true);
  });

  // The trigger is the objective ALONE — docks and garrison still alive and shooting is exactly
  // the case the owner described.
  it('fails open with the garrison still alive and fighting', () => {
    const s = makeScene({ gateAt: FOUR_GATES, objectiveAlive: false });
    s._wokenBases.add('base0');
    run(s, GATE_OPENING_MS + 200);
    expect(s.enemies.length).toBe(1);
    for (const g of allGates(s)) expect(g.open).toBe(true);
  });

  // A gate the player SHOT OUT before beating the base stays a permanent breach; fail-open must
  // not resurrect a cycle for it.
  it('leaves an already-destroyed gate span alone', () => {
    const s = makeScene({ gateAt: FOUR_GATES, objectiveAlive: false, enemies: [] });
    const dead = allGates(s)[1];
    dead.destroyed = true;
    run(s, GATE_OPENING_MS + 200);
    expect(s._gateStates.has(dead.key)).toBe(false);
    expect(s._gateStates.size).toBe(3);
  });

  // A dormant base whose objective got sniped from outside still fails open — there is nothing
  // left inside to keep the doors shut for.
  it('fails open even if the base was never woken', () => {
    const s = makeScene({ gateAt: FOUR_GATES, objectiveAlive: false, enemies: [] });
    run(s, GATE_OPENING_MS + 200);
    for (const g of allGates(s)) expect(g.open).toBe(true);
  });
});
