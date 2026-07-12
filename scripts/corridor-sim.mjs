// #169 corridor sizing simulation — mirrors the live `_buildWorld` geometry (scenes/arena/world.js)
// against the REAL GAMEPLAY_ZOOM=1.3 camera rectangle to derive CORRIDOR_HALF_WIDTH_PX, and to
// confirm the safe-zone invariant, single-connected non-self-intersecting spine, side-boundary
// visibility (at spawn AND along the whole spine), and monotonic objective progression down the
// spine. Same spirit/rigor as the #158 sweep. Run: `node scripts/corridor-sim.mjs`.
import {
  mulberry32, generateSpine, corridorHexSet, spineProgressHexOf, boundaryRingKeys,
  safeZoneKeys, pickStageObjective, MIN_SPAWN_BOUNDARY_HEX_DIST, FAR_OBJECTIVE_MIN_DIST,
  CORRIDOR_LENGTH_PX, CORRIDOR_REAR_PAD_PX, CORRIDOR_CURVINESS, CORRIDOR_WAVELENGTH_PX,
} from '../src/data/worldgen.js';
import { axialKey, hexToPixel, neighbors } from '../src/data/hexgrid.js';
import { lateFraction, STAGE_COUNT } from '../src/data/run.js';

const GAMEPLAY_ZOOM = 1.3;
const VIEWPORT_W = 1280, VIEWPORT_H = 720;
const HALF_W = (VIEWPORT_W / 2) / GAMEPLAY_ZOOM;   // ≈492px
const HALF_H = (VIEWPORT_H / 2) / GAMEPLAY_ZOOM;   // ≈277px

function buildCorridor(seed, halfWidth) {
  const shapeRng = mulberry32(seed);
  const startAngle = shapeRng() * Math.PI * 2;
  const spine = generateSpine(shapeRng, { startAngle });
  const safe = safeZoneKeys({ q: 0, r: 0 }, 3);
  const includedKeys = corridorHexSet(spine.points, halfWidth, safe);
  return { spine, includedKeys, startAngle };
}

// Does any boundary-ring hex fall inside the real camera rectangle centred at (cx, cy)?
function boundaryOnScreen(ring, cx, cy) {
  for (const k of ring) {
    const [q, r] = k.split(',').map(Number);
    const { x, y } = hexToPixel(q, r);
    if (x >= cx - HALF_W && x <= cx + HALF_W && y >= cy - HALF_H && y <= cy + HALF_H) return true;
  }
  return false;
}

// Safe-zone invariant: no boundary hex within hex-distance MIN_SPAWN_BOUNDARY_HEX_DIST of origin.
function safeZoneOk(ring) {
  const D = MIN_SPAWN_BOUNDARY_HEX_DIST;
  for (const k of ring) {
    const [q, r] = k.split(',').map(Number);
    if ((Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2 <= D) return false;
  }
  return true;
}

// Single connected component (no accidental split), a sanity proxy for "one continuous corridor".
function singleComponent(includedKeys) {
  const start = [...includedKeys][0];
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const [q, r] = stack.pop().split(',').map(Number);
    for (const n of neighbors(q, r)) {
      const nk = axialKey(n.q, n.r);
      if (includedKeys.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
    }
  }
  return seen.size === includedKeys.size;
}

function sweep(halfWidth, seeds = 4000) {
  let spawnVis = 0, safeOk = 0, connected = 0;
  let alongVisChecks = 0, alongVisHits = 0;
  for (let seed = 0; seed < seeds; seed++) {
    const { spine, includedKeys } = buildCorridor(seed, halfWidth);
    const ring = boundaryRingKeys(null, { insideKeys: includedKeys, ringWidth: 8 });
    if (boundaryOnScreen(ring, 0, 0)) spawnVis++;
    if (safeZoneOk(ring)) safeOk++;
    if (singleComponent(includedKeys)) connected++;
    // Visibility from several vantage points along the spine (every ~600px of main axis).
    for (let u = 0; u <= CORRIDOR_LENGTH_PX; u += 600) {
      const p = spine.points.reduce((best, pt) => (Math.abs(pt.u - u) < Math.abs(best.u - u) ? pt : best), spine.points[0]);
      alongVisChecks++;
      if (boundaryOnScreen(ring, p.x, p.y)) alongVisHits++;
    }
  }
  return {
    halfWidth,
    spawnVis: (100 * spawnVis / seeds).toFixed(1),
    safeOk: (100 * safeOk / seeds).toFixed(1),
    connected: (100 * connected / seeds).toFixed(1),
    alongVis: (100 * alongVisHits / alongVisChecks).toFixed(1),
  };
}

console.log('== half-width sweep (4000 seeds each) ==');
console.log('halfW  spawnVis%  safeOk%  connected%  alongSpineVis%');
for (const hw of [180, 200, 220, 240, 250, 260, 275, 300]) {
  const r = sweep(hw);
  console.log(`${String(r.halfWidth).padEnd(6)} ${r.spawnVis.padStart(8)}  ${r.safeOk.padStart(6)}  ${r.connected.padStart(9)}  ${r.alongVis.padStart(12)}`);
}

// Objective progression down the spine, at the chosen 250px width. Build a realistic outpost
// candidate spread by sampling hexes along the corridor, then confirm stage 0 < mid < final in
// spine-progress terms, across many seeds.
console.log('\n== objective progression along spine (250px, 300 seeds) ==');
let mono = 0, checked = 0;
let sum0 = 0, sumMid = 0, sumFinal = 0, sumMaxProg = 0;
const mid = Math.floor(STAGE_COUNT / 2);
for (let seed = 0; seed < 300; seed++) {
  const { spine, includedKeys } = buildCorridor(seed, 250);
  const progOf = (q, r) => spineProgressHexOf(spine, q, r);
  // Candidate outposts: every ~4th included hex, keyed — a dense stand-in for generated outposts.
  const candidates = [...includedKeys].filter((_, i) => i % 4 === 0);
  const from = { q: 0, r: 0 };
  const distOf = (k) => { const [q, r] = k.split(',').map(Number); return progOf(q, r); };
  const p0 = distOf(pickStageObjective(candidates, from, lateFraction(0), FAR_OBJECTIVE_MIN_DIST, null, progOf));
  const pM = distOf(pickStageObjective(candidates, from, lateFraction(mid), FAR_OBJECTIVE_MIN_DIST, null, progOf));
  const pF = distOf(pickStageObjective(candidates, from, lateFraction(STAGE_COUNT - 1), FAR_OBJECTIVE_MIN_DIST, null, progOf));
  const maxProg = Math.max(...candidates.map(distOf));
  checked++;
  if (p0 < pM && pM < pF) mono++;
  sum0 += p0; sumMid += pM; sumFinal += pF; sumMaxProg += maxProg;
}
console.log(`monotonic stage0<mid<final: ${(100 * mono / checked).toFixed(1)}%`);
console.log(`avg progress (hexes down spine)  stage0=${(sum0 / checked).toFixed(1)}  mid=${(sumMid / checked).toFixed(1)}  final=${(sumFinal / checked).toFixed(1)}  maxAvail=${(sumMaxProg / checked).toFixed(1)}`);
console.log(`\nconstants: LENGTH=${CORRIDOR_LENGTH_PX} REAR_PAD=${CORRIDOR_REAR_PAD_PX} CURVINESS=${CORRIDOR_CURVINESS} WAVELENGTH=${CORRIDOR_WAVELENGTH_PX}`);
