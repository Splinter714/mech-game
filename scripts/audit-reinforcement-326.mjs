// #326 — measurement harness: what does removing every dock reinforcement cap actually cost?
//
// The issue asks three things to be MEASURED rather than assumed: peak concurrent entities during
// a long base fight, worst-case bodies at a base fielding several swarm docks, and whether a
// sustained fight stays winnable. This boots the real game, deploys the real saved loadout, wakes
// every base, and then simulates a player GRINDING a base — periodically clearing the units around
// one base so its docks keep re-firing — while sampling live entity counts and frame time on the
// game's own clock.
//
// The grinding is the important part of the rig: with no cap, a dock's output is bounded by the
// `cleared` gate, which only lets it fire once its own previous wave is gone. So the worst case is
// NOT "stand still and let it pile up" (that plateaus immediately) — it is "keep killing", which is
// exactly what a player assaulting a base does.
//
// Usage: start a dev server, then `node scripts/audit-reinforcement-326.mjs`
//   AUDIT_SEED=...     pin the world layout (default 20260719)
//   AUDIT_TARGET=base0 which base to grind
//   AUDIT_SECONDS=100   how long to sustain the fight
//   AUDIT_URL=...       dev server (otherwise auto-detected)

import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = process.env.AUDIT_URL || await resolveDevServerUrl();
const SECONDS = Number(process.env.AUDIT_SECONDS || 100);
const SEED = Number(process.env.AUDIT_SEED || 20260719);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => {
  const g = window.__game;
  return !!(g && g.scene.isActive('GarageScene') && g.registry.get('allMechs'));
}, { timeout: 20000 });
// Pin the world seed so a BEFORE and an AFTER run assault the identical base layout — otherwise
// each run draws a fresh set of bases and the peak-entity numbers aren't comparable.
await page.evaluate((seed) => {
  const a = window.__game.scene.getScene('ArenaScene');
  const orig = a._buildWorld.bind(a);
  a._buildWorld = () => orig(seed);
}, SEED);
await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 20000 });

// ── Rig ──────────────────────────────────────────────────────────────────────────────────
// Keep the player alive and the run from ending; leave the DOCK RESUPPLY path completely intact,
// since that is the thing under measurement.
const setup = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  a._updateRun = () => {};
  a._damagePlayerAt = () => {};

  // Wake everything: the worst case for reinforcement pressure is every base contributing.
  for (const b of a.bases) a._wakeBase(b.id);

  const s = window.__a326 = {
    peakEnemies: 0, peakAtBase: {}, samples: 0, sumEnemies: 0,
    resupplies: 0, bodiesSpawned: 0, killed: 0,
    frames: 0, slowFrames: 0, worstFrameMs: 0, sumFrameMs: 0,
    perBasePeak: {}, dockKindsSeen: {},
  };

  // Count real resupplies and the bodies they deliver, through the real entry point.
  const origResupply = a._resupplyDock.bind(a);
  a._resupplyDock = (dockKey, meta, opts) => {
    const before = a.enemies.length;
    const r = origResupply(dockKey, meta, opts);
    s.resupplies++;
    const kind = a._dockResupplyMeta.get(dockKey)?.kindId;
    if (kind) s.dockKindsSeen[kind] = (s.dockKindsSeen[kind] || 0) + 1;
    // Bodies land on a delayed call, so count them on the next sample rather than here.
    s._pendingBefore = before;
    return r;
  };

  // Per-base composition, as generated. This is the "worst-case bodies at a base" number the
  // issue asks for, read off the real world rather than a model.
  const baseComposition = a.bases.map((b) => ({
    id: b.id,
    docks: b.docks.map((d) => ({ kindId: d.kindId, count: d.count })),
    openingBodies: b.docks.reduce((n, d) => n + d.count, 0),
    swarmDocks: b.docks.filter((d) => d.kindId === 'drone' || d.kindId === 'infantry').length,
  }));

  // Sample once per rendered frame. Phaser binds its own reference to `scene.update`, so wrapping
  // that property does nothing — rAF is both the honest frame clock and the one that keeps
  // sampling in lockstep with what the player actually sees.
  let last = performance.now();
  const sample = () => {
    const now = performance.now();
    const ms = now - last;
    last = now;
    s.frames++; s.sumFrameMs += ms;
    if (ms > s.worstFrameMs) s.worstFrameMs = ms;
    if (ms > 16.7) s.slowFrames++;
    s.samples++; s.sumEnemies += a.enemies.length;
    if (a.enemies.length > s.peakEnemies) s.peakEnemies = a.enemies.length;
    for (const b of a.bases) {
      const n = a.enemies.filter((e) => e.baseId === b.id).length;
      if (n > (s.perBasePeak[b.id] || 0)) s.perBasePeak[b.id] = n;
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  return { baseComposition, baseCount: a.bases.length, initialEnemies: a.enemies.length };
});

// ── The sustained assault ────────────────────────────────────────────────────────────────
// Grind base 0: every 1.5s, kill everything belonging to it, exactly as a player working through a
// base does. That keeps every one of its docks permanently `cleared`, which is the ONLY condition
// under which an uncapped dock can fire again — i.e. the true worst case.
const target = process.env.AUDIT_TARGET || 'base0';
const deadline = Date.now() + SECONDS * 1000;
const series = [];
const t0 = Date.now();
while (Date.now() < deadline) {
  await page.waitForTimeout(1500);
  const n = await page.evaluate((baseId) => {
    const a = window.__game.scene.getScene('ArenaScene');
    const s = window.__a326;
    const doomed = a.enemies.filter((e) => e.baseId === baseId);
    s.killed += doomed.length;
    for (const e of doomed) a._removeEnemy(e);
    return a.enemies.length;
  }, target);
  // The time series is the real answer to #321's accumulation worry: an uncapped system that
  // ACCUMULATES shows a rising line, one that self-limits shows a flat one.
  series.push([Math.round((Date.now() - t0) / 1000), n]);
}

const out = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  const s = window.__a326;
  return {
    ...s,
    avgEnemies: +(s.sumEnemies / Math.max(1, s.samples)).toFixed(1),
    avgFrameMs: +(s.sumFrameMs / Math.max(1, s.frames)).toFixed(2),
    slowFramePct: +(100 * s.slowFrames / Math.max(1, s.frames)).toFixed(1),
    liveAtEnd: a.enemies.length,
    retiredDocks: [...a._dockResupplyStates.values()].filter((v) => v.retired).length,
    totalDocks: a._dockResupplyStates.size,
    dockCounts: [...a._dockResupplyStates.values()].map((v) => v.count),
  };
});

console.log('=== #326 reinforcement audit ===');
console.log(`world: ${setup.baseCount} bases, ${setup.initialEnemies} enemies at deploy`);
for (const b of setup.baseComposition) {
  console.log(`  ${b.id}: ${b.docks.length} docks, ${b.swarmDocks} swarm, ${b.openingBodies} opening bodies` +
    `  [${b.docks.map((d) => `${d.kindId}x${d.count}`).join(', ')}]`);
}
console.log(`\nsustained fight on ${target} for ${SECONDS}s (cleared every 1.5s):`);
console.log(`  resupplies fired      ${out.resupplies}`);
console.log(`  enemies killed        ${out.killed}`);
console.log(`  PEAK concurrent       ${out.peakEnemies}`);
console.log(`  avg concurrent        ${out.avgEnemies}`);
console.log(`  per-base peak         ${JSON.stringify(out.perBasePeak)}`);
console.log(`  dock kinds resupplied ${JSON.stringify(out.dockKindsSeen)}`);
console.log(`  dock lifetime counts  ${JSON.stringify(out.dockCounts)}`);
console.log(`  docks retired         ${out.retiredDocks}/${out.totalDocks}`);
console.log(`\nperformance over ${out.frames} frames:`);
console.log(`  avg frame   ${out.avgFrameMs}ms`);
console.log(`  worst frame ${out.worstFrameMs.toFixed(1)}ms`);
console.log(`  frames >16.7ms  ${out.slowFramePct}%`);
const half = Math.floor(series.length / 2);
const mean = (xs) => xs.reduce((s, v) => s + v[1], 0) / Math.max(1, xs.length);
console.log('\nlive-entity time series (s, count):');
console.log('  ' + series.map(([t, n]) => t + 's:' + n).join('  '));
console.log('  first-half mean ' + mean(series.slice(0, half)).toFixed(1) + '  second-half mean ' + mean(series.slice(half)).toFixed(1) + '  (rising => accumulating, flat => self-limiting)');
if (errors.length) console.log(`\npage errors: ${errors.slice(0, 5).join(' | ')}`);

await browser.close();
