// #167 micro-benchmark: the per-enemy LOS/firing-lane raycast, OLD vs NEW, at the enemy
// populations #164 measured live (75 / 160 / 273). Exercises the REAL world.js methods against a
// minimal ArenaScene-shaped `this` (no Phaser needed — WorldMixin only reads `this.terrain` /
// `this.time` + pure hex/terrain helpers), so this measures exactly the code the game runs.
//
//   OLD path  = `_wallDistance(x,y,angle,dist, _losTransparency(...))` EVERY frame per enemy
//               (a fresh 2-key Set per call + a hex-key string per 8px step).
//   NEW path  = `_cachedLosToPlayer(e, ...)` — staggered ~120ms cache over the allocation-free
//               `_wallDistanceLos` (memoized same-hex steps, no per-call Set, no per-step string).
//
// Run: node scripts/bench-los-167.mjs
import { WorldMixin, LOS_REFRESH_MS } from '../src/scenes/arena/world.js';
import { hexToPixel, axialKey, HEX_SIZE } from '../src/data/hexgrid.js';

const FRAMES = 900;            // 15s @ 60fps
const FRAME_MS = 1000 / 60;
const ENGAGE_PX = 620;         // enemies fight within ~this radius of the player
const POPULATIONS = [75, 160, 273];

// A realistic arena patch: a hex disc (radius 26 ≈ 2100px across) that's mostly clear ground with
// scattered forest (soft cover) + building (solid) clusters, ~18% blocking — the kind of
// cover density the LOS raycast actually threads through in a fight.
function buildTerrain(seed = 1) {
  let s = seed >>> 0;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  const R = 26;
  const t = new Map();
  for (let q = -R; q <= R; q++) {
    for (let r = -R; r <= R; r++) {
      if (Math.abs(q + r) > R) continue;
      const roll = rng();
      const id = roll < 0.10 ? 'building' : roll < 0.18 ? 'forest' : (rng() < 0.5 ? 'grass' : 'grassB');
      t.set(axialKey(q, r), id);
    }
  }
  return t;
}

// Spread N enemies on passable hexes within the engagement ring around the player at origin.
function seedEnemies(terrain, n, seed = 99) {
  let s = seed >>> 0;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 50) {
    const ang = rng() * Math.PI * 2;
    const d = 120 + rng() * (ENGAGE_PX - 120);
    const x = Math.cos(ang) * d, y = Math.sin(ang) * d;
    out.push({ x, y, vx: (rng() - 0.5) * 90, vy: (rng() - 0.5) * 90 });
  }
  return out;
}

function runOld(scene, enemies, player) {
  for (let f = 0; f < FRAMES; f++) {
    stepWorld(enemies, player, f);
    for (const e of enemies) {
      const dxp = player.x - e.x, dyp = player.y - e.y;
      const dist = Math.hypot(dxp, dyp) || 1;
      const bearing = Math.atan2(dyp, dxp);
      // exactly the old per-enemy call site
      scene._wallDistance(e.x, e.y, bearing, dist, scene._losTransparency(e.x, e.y, player.x, player.y));
    }
  }
}

function runNew(scene, enemies, player) {
  for (let f = 0; f < FRAMES; f++) {
    stepWorld(enemies, player, f);
    for (const e of enemies) {
      const dxp = player.x - e.x, dyp = player.y - e.y;
      const dist = Math.hypot(dxp, dyp) || 1;
      const bearing = Math.atan2(dyp, dxp);
      scene._cachedLosToPlayer(e, FRAME_MS, e.x, e.y, bearing, dist, player.x, player.y);
    }
  }
}

// Drift enemies + player each frame so LOS genuinely changes over the run (bounce inside the ring).
function stepWorld(enemies, player, f) {
  player.x = Math.cos(f * 0.011) * 60;
  player.y = Math.sin(f * 0.013) * 60;
  for (const e of enemies) {
    e.x += e.vx * (FRAME_MS / 1000);
    e.y += e.vy * (FRAME_MS / 1000);
    const d = Math.hypot(e.x, e.y);
    if (d > ENGAGE_PX || d < 90) { e.vx = -e.vx; e.vy = -e.vy; }
  }
}

function median(xs) { const a = [...xs].sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; }

function timeIt(fn, reps = 5) {
  const runs = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    runs.push(performance.now() - t0);
  }
  return median(runs);
}

console.log(`#167 LOS raycast micro-benchmark — ${FRAMES} frames, real world.js methods`);
console.log(`cache window LOS_REFRESH_MS=${LOS_REFRESH_MS}ms, HEX_SIZE=${HEX_SIZE}px\n`);
console.log('  pop |    OLD ms/frame |    NEW ms/frame | speedup | OLD raycasts/f | NEW raycasts/f');
console.log('  ----+-----------------+-----------------+---------+----------------+---------------');

for (const pop of POPULATIONS) {
  const terrain = buildTerrain();

  // OLD: count is definitionally 1 raycast/enemy/frame.
  {
    const scene = Object.assign({ terrain, time: { now: 0 } }, WorldMixin);
    const enemies = seedEnemies(terrain, pop);
    const player = { x: 0, y: 0 };
    // warm up
    runOld(scene, enemies.map((e) => ({ ...e })), { ...player });
    const ms = timeIt(() => runOld(scene, enemies.map((e) => ({ ...e })), { ...player }));
    const oldPerFrame = ms / FRAMES;

    // NEW: instrument _wallDistanceLos to count actual recomputes.
    const scene2 = Object.assign({ terrain, time: { now: 0 } }, WorldMixin);
    let casts = 0;
    const realLos = scene2._wallDistanceLos.bind(scene2);
    scene2._wallDistanceLos = (...a) => { casts++; return realLos(...a); };
    const enemies2 = enemies.map((e) => ({ ...e }));
    runNew(scene2, enemies2.map((e) => ({ ...e })), { x: 0, y: 0 });   // warm
    casts = 0;
    const ms2 = timeIt(() => { casts = 0; runNew(scene2, enemies2.map((e) => ({ ...e })), { x: 0, y: 0 }); });
    const newPerFrame = ms2 / FRAMES;
    const newCastsPerFrame = casts / FRAMES;

    console.log(
      `  ${String(pop).padStart(3)} | ${oldPerFrame.toFixed(4).padStart(15)} | ${newPerFrame.toFixed(4).padStart(15)} | ` +
      `${(oldPerFrame / newPerFrame).toFixed(1).padStart(6)}x | ${pop.toFixed(1).padStart(14)} | ${newCastsPerFrame.toFixed(1).padStart(13)}`);
  }
}
