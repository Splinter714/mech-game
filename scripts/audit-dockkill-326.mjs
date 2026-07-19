// #326 — the other half of the measurement: is a base still WINNABLE, and does destroying a dock
// actually stop it? With every reinforcement cap gone, blowing the dome open is the player's only
// lever, so it has to work reliably.
//
// Phase 1  grind a base with the heaviest swarm presence in the world, measuring the worst-case
//          number of live bodies it ever presents.
// Phase 2  destroy every one of its docks through the REAL destructible-terrain path
//          (`_damageBuildingAt`, the same call the player's weapons make), then keep grinding.
//          If retirement works, the base must go permanently silent.
//
// Usage: start a dev server, then `node scripts/audit-dockkill-326.mjs`

import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = process.env.AUDIT_URL || await resolveDevServerUrl();
const SEED = Number(process.env.AUDIT_SEED || 20260719);
const GRIND_S = Number(process.env.AUDIT_GRIND_S || 60);

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
await page.evaluate((seed) => {
  const a = window.__game.scene.getScene('ArenaScene');
  const orig = a._buildWorld.bind(a);
  a._buildWorld = () => orig(seed);
}, SEED);
await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 20000 });

// Pick the base with the most swarm docks — the worst case #326 asks to have measured.
const target = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  a._updateRun = () => {};
  a._damagePlayerAt = () => {};
  const swarm = (d) => d.kindId === 'drone' || d.kindId === 'infantry';
  const best = [...a.bases].sort((x, y) =>
    (y.docks.filter(swarm).length - x.docks.filter(swarm).length)
    || (y.docks.reduce((n, d) => n + d.count, 0) - x.docks.reduce((n, d) => n + d.count, 0)))[0];
  for (const b of a.bases) a._wakeBase(b.id);
  window.__k = { peakAtBase: 0, resupplies: 0, afterKill: 0, killPhase: false };
  const orig = a._resupplyDock.bind(a);
  a._resupplyDock = (k, m, o) => {
    if (m.baseId === best.id) { window.__k.resupplies++; if (window.__k.killPhase) window.__k.afterKill++; }
    return orig(k, m, o);
  };
  return {
    id: best.id,
    docks: best.docks.map((d) => `${d.kindId}x${d.count}`),
    swarmDocks: best.docks.filter(swarm).length,
    openingBodies: best.docks.reduce((n, d) => n + d.count, 0),
  };
});

const grind = async (seconds, baseId) => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await page.waitForTimeout(1200);
    await page.evaluate((id) => {
      const a = window.__game.scene.getScene('ArenaScene');
      const n = a.enemies.filter((e) => e.baseId === id).length;
      if (n > window.__k.peakAtBase) window.__k.peakAtBase = n;
      for (const e of a.enemies.filter((e) => e.baseId === id)) a._removeEnemy(e);
    }, baseId);
  }
};

// ── Phase 1: sustained assault, docks intact ────────────────────────────────────────────
await grind(GRIND_S, target.id);
const phase1 = await page.evaluate(() => ({ ...window.__k }));

// ── Phase 2: blow every dock open, through the real damage path ─────────────────────────
const killed = await page.evaluate((baseId) => {
  const a = window.__game.scene.getScene('ArenaScene');
  window.__k.killPhase = true;
  window.__k.afterKill = 0;
  let n = 0;
  for (const [hexKey, meta] of a._dockResupplyMeta) {
    if (meta.baseId !== baseId) continue;
    // Seal it first if it is currently open (an open dock carries no HP — see terrain.js), then
    // pour damage through the SAME entry point a player's weapon uses, so this exercises the real
    // `_damageBuildingAt` -> `_onTerrainCollapsed` -> `spendDockResupply` chain.
    if (a.terrain.get(hexKey) !== 'dockClosed') a._closeDock(hexKey, meta);
    for (let i = 0; i < 40 && a.terrain.get(hexKey) === 'dockClosed'; i++) {
      a._damageBuildingAt(meta.x, meta.y, 50);
    }
    n++;
  }
  return {
    docksAttacked: n,
    retired: [...a._dockResupplyMeta].filter(([k, m]) => m.baseId === baseId)
      .filter(([k]) => a._dockResupplyStates.get(k)?.retired).length,
  };
}, target.id);

await grind(GRIND_S, target.id);
const phase2 = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  return {
    ...window.__k,
    liveAtBase: a.enemies.filter((e) => e.baseId === window.__targetId).length,
    totalLive: a.enemies.length,
  };
});

console.log('=== #326 dock-kill / winnability audit ===');
console.log(`target ${target.id}: ${target.swarmDocks} swarm dock(s), ${target.openingBodies} opening bodies`);
console.log(`  composition [${target.docks.join(', ')}]`);
console.log(`\nphase 1 — ${GRIND_S}s sustained assault, docks INTACT:`);
console.log(`  resupplies fired        ${phase1.resupplies}`);
console.log(`  WORST-CASE live bodies at this base  ${phase1.peakAtBase}`);
console.log(`\nphase 2 — every dock destroyed via the real damage path:`);
console.log(`  docks attacked          ${killed.docksAttacked}`);
console.log(`  docks now retired       ${killed.retired}/${killed.docksAttacked}`);
console.log(`  resupplies in the ${GRIND_S}s AFTER destruction  ${phase2.afterKill}   <- must be 0`);
console.log(`\nverdict: ${phase2.afterKill === 0 && killed.retired === killed.docksAttacked
  ? 'WINNABLE — destroying the docks permanently silences the base'
  : 'PROBLEM — the base kept reinforcing after its docks were destroyed'}`);
if (errors.length) console.log(`\npage errors: ${errors.slice(0, 5).join(' | ')}`);

await browser.close();
