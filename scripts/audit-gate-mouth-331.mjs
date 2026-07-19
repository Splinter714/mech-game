// #331 — can a ground unit's BODY actually get through an OPEN gate mouth?
//
// Playtest (Jackson, 2026-07-19): "the gate opening is working right, but I'm not seeing the tanks
// able to get through". #309 measured that woken garrisons mostly don't leave, and read it as a
// behaviour problem. This checks the OTHER hypothesis first, because "won't" and "can't" need
// opposite fixes: if a unit's collision body physically cannot fit the mouth, no route exists and
// the unit never approaches at all — which looks identical from outside.
//
// Drives the REAL geometry: worldgen's ring/gate placement plus wallEdges.js's swept collision with
// the real per-kind `wallCollideRadius`, i.e. the exact predicate the movement integrators use.
//
// Per gate it reports:
//   freeWidthPx — the widest contiguous run along the gate span's own line where a body centre of
//                 radius R is NOT inside any standing span's inflated capsule. This is the mouth.
//   through/N   — of a fan of approach bearings x lateral offsets, how many swept traversals
//                 (`wallEdgeCrossing(radius)`) actually get from the inner hex centre to the outer.
//
// Run: node scripts/audit-gate-mouth-331.mjs
import { generateTerrain } from '../src/data/worldgen.js';
import { BIOMES } from '../src/data/biomes.js';
import { makeWallEdgeSet, setGateOpen, gateEdges, blocksSpan, wallEdgeAt, wallEdgeCrossing, WALL_THICKNESS_PX } from '../src/data/wallEdges.js';
import { findHexPath } from '../src/data/hexRoute.js';
import { isPassable } from '../src/data/terrain.js';
import { hexToPixel, axialKey, range } from '../src/data/hexgrid.js';
import { ENEMY_KINDS } from '../src/data/enemyKinds.js';

const VEH = 24;   // ENEMY_COLLIDE_RADIUS_VEHICLE
const MECH = 28;  // ENEMY_COLLIDE_RADIUS_MECH
const CAP = 20;   // WALL_COLLIDE_RADIUS_MAX
const wallR = (r) => Math.min(r, CAP);

const KINDS = [
  ...Object.entries(ENEMY_KINDS)
    .filter(([, v]) => !v.flying)
    .map(([id, v]) => ({ id, r: wallR(VEH * (v.scale ?? 1)) })),
  { id: 'mech (enemy/player)', r: wallR(MECH) },
].sort((a, b) => a.r - b.r);

const SEEDS = [1, 7, 42, 1337, 90210, 555];
const BIOME = BIOMES.grassland ?? Object.values(BIOMES)[0];

// Widest run along the gate span's line where a centre of radius R is free of every standing span.
function freeWidth(set, gate, R) {
  const dx = gate.x1 - gate.x0, dy = gate.y1 - gate.y0;
  const len = Math.hypot(dx, dy);
  const N = 400;
  let best = 0, run = 0;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = gate.x0 + dx * t, y = gate.y0 + dy * t;
    if (wallEdgeAt(set, x, y, WALL_THICKNESS_PX, null, R)) run = 0;
    else { run += len / N; if (run > best) best = run; }
  }
  return best;
}

// Fan of real swept traversals through the mouth: inner hex centre → outer hex centre, offset
// laterally along the span and skewed by approach bearing.
function traversals(set, gate, R) {
  const mid = { x: (gate.x0 + gate.x1) / 2, y: (gate.y0 + gate.y1) / 2 };
  const a = hexToPixel(gate.a.q, gate.a.r), b = hexToPixel(gate.b.q, gate.b.r);
  const dx = gate.x1 - gate.x0, dy = gate.y1 - gate.y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;              // along the span
  let ok = 0, tot = 0;
  for (const off of [-12, -6, -3, 0, 3, 6, 12]) {  // lateral offset of the aim point in the mouth
    const tx = mid.x + ux * off, ty = mid.y + uy * off;
    for (const skew of [-0.5, -0.25, 0, 0.25, 0.5]) {  // approach bearing: slide the start along the span
      const sx = a.x + ux * skew * len, sy = a.y + uy * skew * len;
      const ex = b.x + ux * skew * len * 0.5, ey = b.y + uy * skew * len * 0.5;
      tot++;
      // two legs: approach to the mouth point, then out the far side
      const leg1 = wallEdgeCrossing(set, sx, sy, tx, ty, WALL_THICKNESS_PX, null, R);
      const leg2 = wallEdgeCrossing(set, tx, ty, ex, ey, WALL_THICKNESS_PX, null, R);
      if (!leg1 && !leg2) ok++;
    }
  }
  return { ok, tot };
}

const agg = new Map(KINDS.map((k) => [k.id, { minFree: Infinity, sumFree: 0, n: 0, ok: 0, tot: 0, blockedGates: 0 }]));
let gateCount = 0;

for (const seed of SEEDS) {
  const { wallEdges } = generateTerrain({ seed, worldRadius: 26, biome: BIOME });
  const set = makeWallEdgeSet(wallEdges);
  const gates = gateEdges(set);
  for (const g of gates) setGateOpen(set, g, true);   // every gate standing WIDE OPEN
  for (const g of gates) {
    gateCount++;
    for (const k of KINDS) {
      const w = freeWidth(set, g, k.r);
      const t = traversals(set, g, k.r);
      const a = agg.get(k.id);
      a.minFree = Math.min(a.minFree, w); a.sumFree += w; a.n++;
      a.ok += t.ok; a.tot += t.tot;
      if (t.ok === 0) a.blockedGates++;
    }
  }
}

console.log(`#331 gate-mouth passability — ${SEEDS.length} worlds, ${gateCount} open gates\n`);
console.log('kind                   wallR   freeWidth(min/avg)   traversals    gates w/ NO route');
for (const k of KINDS) {
  const a = agg.get(k.id);
  console.log(
    k.id.padEnd(22),
    k.r.toFixed(1).padStart(5),
    `${a.minFree.toFixed(1)}/${(a.sumFree / a.n).toFixed(1)}`.padStart(20),
    `${a.ok}/${a.tot}`.padStart(12),
    `${a.blockedGates}/${gateCount}`.padStart(18),
  );
}
console.log('\nA body of radius R needs freeWidth > 0 to have any centre position in the mouth at all.');

// ── Part 2: does the ROUTER produce a way out? ─────────────────────────────────────────────
// Geometry fitting is necessary but not sufficient — if A* refused the gate edge, no unit would
// ever plan toward it. Runs the real `findHexPath` with the same canStep the scene builds
// (`_canEnemyStep`: destination tile passable AND the shared span not blocking).
console.log('\n#331 route-out — real A* from every interior hex to a goal 12 hexes outside the base\n');
for (const gatesOpen of [false, true]) {
  let tot = 0, complete = 0;
  for (const seed of SEEDS) {
    const { terrain, bases, wallEdges } = generateTerrain({ seed, worldRadius: 26, biome: BIOME });
    const set = makeWallEdgeSet(wallEdges);
    for (const g of gateEdges(set)) setGateOpen(set, g, gatesOpen);
    const canStep = (from, to) => {
      if (!isPassable(terrain.get(axialKey(to.q, to.r)))) return false;
      const spans = set.byHex.get(axialKey(from.q, from.r));
      if (!spans) return true;
      for (const e of spans) {
        if ((e.a.q === to.q && e.a.r === to.r) || (e.b.q === to.q && e.b.r === to.r)) return !blocksSpan(e);
      }
      return true;
    };
    for (const base of bases) {
      const goal = { q: base.center.q + 12, r: base.center.r };
      if (!isPassable(terrain.get(axialKey(goal.q, goal.r)))) continue;
      for (const h of range(base.center, 2)) {
        if (!isPassable(terrain.get(axialKey(h.q, h.r)))) continue;
        tot++;
        if (findHexPath(h, goal, canStep).complete) complete++;
      }
    }
  }
  console.log(`  gates ${gatesOpen ? 'OPEN ' : 'SHUT '}: ${complete}/${tot} interior hexes have a COMPLETE route out (${(100 * complete / tot).toFixed(0)}%)`);
}
