// #309 — scene-level coverage for the wall-GATE wiring (`_initGates`/`_updateGates` in
// scenes/arena/bases.js). The cycle itself is proved pure in data/gateCycle.test.js and the SEAL
// is proved in wallEdgeWorld.test.js; what's pinned here is the glue — that a gate only ever moves
// because its base woke, that the span's live `open` flag tracks the phase, that the door FX fire
// once per sortie, and that a destroyed gate drops out of the cycle for good.
//
// Same hand-rolled harness style as dockResupply.test.js: a plain object with the mixins assigned
// and a minimal Phaser-shaped `add`/`tweens`/`time` stand-in.
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));

import { BasesMixin } from './bases.js';
import { WorldMixin } from './world.js';
import { makeWallEdgeSet, gateEdges, WALL_EDGE_HP } from '../../data/wallEdges.js';
import { axialKey, neighbors, hexToPixel } from '../../data/hexgrid.js';
import {
  GATE_FIRST_SORTIE_MS, GATE_OPENING_MS, GATE_OPEN_HOLD_MS, GATE_CLOSING_MS, GATE_STAGGER_MAX_MS,
} from '../../data/gateCycle.js';

// A gate's first sortie is staggered by a random offset (`GATE_STAGGER_MAX_MS`), so these tests
// step by BOUNDS rather than by an exact time — the same approach dockResupply.test.js takes to
// #311's per-dock jitter. `SURELY_OPEN_MS` is past the latest any gate can possibly be open by;
// `SURELY_SHUT_MS` is short of the earliest any gate can possibly have started moving.
const SURELY_OPEN_MS = GATE_FIRST_SORTIE_MS + GATE_STAGGER_MAX_MS + GATE_OPENING_MS + 200;
const SURELY_SHUT_MS = GATE_FIRST_SORTIE_MS - 300;

function fakeGameObject() {
  const obj = {};
  for (const m of ['setDepth', 'setScale', 'setStrokeStyle', 'setRadius']) obj[m] = () => obj;
  obj.destroy = () => {};
  return obj;
}

const A = { q: 0, r: 0 };
const NB = neighbors(A.q, A.r);

// A tiny two-span "ring": one plain span and one gate, both hanging off the origin hex.
function makeScene() {
  const terrain = new Map();
  for (let q = -6; q <= 6; q++) for (let r = -6; r <= 6; r++) terrain.set(axialKey(q, r), 'grass');
  const scene = Object.assign({}, WorldMixin, BasesMixin, {
    terrain,
    wallEdges: makeWallEdgeSet([
      { a: A, b: NB[0], baseId: 'base0' },
      { a: A, b: NB[3], baseId: 'base0', role: 'gate' },
    ]),
    buildingHp: new Map(), coverHp: new Map(),
    enemies: [], bases: [], px: 9999, py: 9999,
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
    expect(s._gateStates.size).toBe(1);          // the plain span gets no cycle
    expect(theGate(s).open).toBe(false);
    expect(theGate(s).openFrac).toBe(0);
  });

  // THE TRIGGER, and the property that makes it legible: a base the player has not woken keeps its
  // gates shut forever. The sortie is a REACTION to the alarm, so it cannot precede it.
  it('a dormant base never opens its gate, however long the run goes', () => {
    const s = makeScene();
    run(s, 120000);
    expect(theGate(s).open).toBe(false);
    expect(s.redraws).toBe(0);
  });

  it('opens a beat after the base wakes', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    run(s, SURELY_SHUT_MS);
    expect(theGate(s).open).toBe(false);          // still cranking up
    run(s, GATE_STAGGER_MAX_MS + GATE_OPENING_MS + 500);
    expect(theGate(s).open).toBe(true);
    expect(theGate(s).openFrac).toBe(1);
  });

  it('shuts again after the sortie window, and the span goes solid with it', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    run(s, SURELY_OPEN_MS + GATE_OPEN_HOLD_MS + GATE_CLOSING_MS + 400);
    expect(theGate(s).open).toBe(false);
    expect(theGate(s).openFrac).toBe(0);
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

  // Sight is cached (#306), so a gate opening or shutting must invalidate it — otherwise the
  // player would not see the units that just became visible through the opening.
  it('invalidates the cached field of view when the gate opens and when it shuts', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    run(s, SURELY_OPEN_MS + GATE_OPEN_HOLD_MS + GATE_CLOSING_MS + 400);
    expect(s.invalidations).toBeGreaterThanOrEqual(2);
  });

  // A blown gate is just a breach. It must never re-close, re-open, or keep ticking — the player
  // has permanently taken one of the base's two sally ports away from it.
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

  // The player leaning on an OPEN gate's barrier field sparks — the beat that makes "open but you
  // cannot drive through" read as a screen holding him out rather than as a collision bug.
  it('sparks the barrier field while the player presses against an open gate', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    run(s, SURELY_OPEN_MS);
    const gate = theGate(s);
    expect(gate.open).toBe(true);
    let sparks = 0;
    const realFx = s._gateFieldFx.bind(s);
    s._gateFieldFx = (e) => { sparks++; return realFx(e); };
    // Park the player right on the gate's mouth.
    s.px = (gate.x0 + gate.x1) / 2; s.py = (gate.y0 + gate.y1) / 2;
    run(s, 1000);
    expect(sparks).toBeGreaterThan(2);
    // …and standing well clear of it sparks nothing.
    sparks = 0;
    s.px = 9999; s.py = 9999;
    run(s, 1000);
    expect(sparks).toBe(0);
  });

  it('does not spark off a gate that is merely SHUT — there is no field to lean on', () => {
    const s = makeScene();
    const gate = theGate(s);
    let sparks = 0;
    s._gateFieldFx = () => { sparks++; };
    s.px = (gate.x0 + gate.x1) / 2; s.py = (gate.y0 + gate.y1) / 2;
    run(s, 5000);   // base never woken, so the gate never opens
    expect(sparks).toBe(0);
  });

  // The whole point: while the gate stands open, its span is walkable for an enemy and solid for
  // the player, at the same instant, on the same span.
  it('the open gate is passable to enemies and impassable to the player at the same moment', () => {
    const s = makeScene();
    s._wokenBases.add('base0');
    run(s, SURELY_OPEN_MS);
    const gate = theGate(s);
    const m = { x: (gate.x0 + gate.x1) / 2, y: (gate.y0 + gate.y1) / 2 };
    expect(s._blockedForEnemy(m.x, m.y)).toBe(false);
    expect(s._blocked(m.x, m.y)).toBe(true);
    expect(s._blockedAlongSegment(hexToPixel(A.q, A.r).x, hexToPixel(A.q, A.r).y,
      hexToPixel(NB[3].q, NB[3].r).x, hexToPixel(NB[3].q, NB[3].r).y)).toBe(true);
  });
});
