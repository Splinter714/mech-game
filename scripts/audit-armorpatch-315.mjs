// #315 live verification harness — drives the REAL running game (Phaser in headless Chromium),
// not a stub, to prove two things the unit tests can only assert about data:
//
//   1) Destroying a base's OBJECTIVE hex drops exactly one Armor Patch, in the live arena, via
//      the real `_damageBuildingAt` → `_onTerrainCollapsed` collapse path — and that ordinary
//      destructible hexes (docks, walls, cover) drop nothing.
//   2) The new achromatic Armor Patch collectible is clearly distinguishable from Shield's cyan
//      at pickup size, on a PALE biome ground (arctic snow / desert sand are the hard cases for
//      a light-coloured beacon). Writes side-by-side screenshots to /tmp for eyeballing.
//
// Usage: start the dev server, then `SMOKE_URL=http://localhost:PORT node scripts/audit-armorpatch-315.mjs`.
// Mirrors scripts/smoke.mjs's setup (the `?canvas` renderer forcing, the pageerror capture).

import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const OUT = process.env.AUDIT_OUT ?? '/tmp';
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`);
  if (!ok) failed = true;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// Boot into the arena on a chosen biome, pinned via the same `debugForceBiome` hook smoke.mjs uses.
async function bootArena(biomeId) {
  await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => {
    const g = window.__game;
    return !!(g && g.scene.isActive('GarageScene') && g.registry.get('allMechs'));
  }, { timeout: 20000 });
  await page.evaluate((b) => {
    const g = window.__game;
    g.registry.set('debugForceBiome', b);
    g.scene.getScene('GarageScene').deploy();
  }, biomeId);
  await page.waitForFunction(() => {
    const a = window.__game.scene.getScene('ArenaScene');
    return !!(a && a.scene.isActive() && a.terrain && a.bases && a.powerups);
  }, { timeout: 20000 });
  await page.waitForTimeout(600);
}

// ── 1) The objective drop, through the real collapse path ────────────────────────────────
console.log('\n#315 part 1 — objective destruction drops exactly one Armor Patch\n');
await bootArena('grassland');

const drop = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  const base = a.bases.find((b) => b.objectiveHex);
  if (!base) return { error: 'no base with an objectiveHex in this world' };
  const key = `${base.objectiveHex.q},${base.objectiveHex.r}`;

  const before = a.powerups.length;
  const objHp = a.buildingHp.get(key);
  // Drive the REAL damage entry point (world.js `_damageBuildingAt`) at the objective's world
  // position, in bites, exactly as weapon fire does — not a direct call to the reward method.
  // The hex's own rendered tile gives us its exact world centre without importing hexgrid here.
  const tile = a.tileImages.get(key);
  if (!tile) return { error: `no rendered tile for objective hex ${key}` };
  const px = tile.x, py = tile.y;
  let shots = 0;
  while (a.buildingHp.has(key) && shots < 500) { a._damageBuildingAt(px, py, 25); shots++; }

  const added = a.powerups.slice(before);

  // Now flatten a batch of NON-objective destructible hexes (docks, walls, turret bunkers) and
  // confirm none of them pays out. The objective keys of EVERY base are excluded — those are
  // supposed to pay, and are checked separately below.
  const objectiveKeys = new Set(a.bases.filter((b) => b.objectiveHex)
    .map((b) => `${b.objectiveHex.q},${b.objectiveHex.r}`));
  const afterObjective = a.powerups.length;
  let otherHexes = 0;
  for (const [k] of [...a.buildingHp]) {
    if (objectiveKeys.has(k) || otherHexes >= 20) continue;
    const img = a.tileImages.get(k);
    if (!img) continue;
    otherHexes++;
    let s = 0;
    while (a.buildingHp.has(k) && s < 500) { a._damageBuildingAt(img.x, img.y, 25); s++; }
  }
  const nonObjectiveDrops = a.powerups.slice(afterObjective).filter((p) => p.type === 'armorPatch').length;

  // ...and then flatten every REMAINING base objective: each must pay out exactly one more.
  const remaining = [...objectiveKeys].filter((k) => a.buildingHp.has(k));
  const beforeRest = a.powerups.length;
  for (const k of remaining) {
    const img = a.tileImages.get(k);
    if (!img) continue;
    let s = 0;
    while (a.buildingHp.has(k) && s < 500) { a._damageBuildingAt(img.x, img.y, 25); s++; }
  }
  const restDrops = a.powerups.slice(beforeRest).filter((p) => p.type === 'armorPatch').length;

  // And re-firing the collapse hook for the already-destroyed objective must not pay twice.
  const beforeRepeat = a.powerups.length;
  a._onTerrainCollapsed(key);
  a._onTerrainCollapsed(key);
  const repeatDrops = a.powerups.length - beforeRepeat;

  return {
    key, objHp, shots, otherHexes, nonObjectiveDrops, repeatDrops,
    restDrops, remaining: remaining.length, totalBases: a.bases.length,
    addedTypes: added.map((p) => p.type),
    objectiveGone: !a.buildingHp.has(key),
    // The drop must be somewhere the player can actually walk to.
    dropBlocked: added.length === 1 ? !!a._blocked?.(added[0].x, added[0].y) : null,
  };
});

if (drop.error) { check(false, drop.error); }
else {
  console.log(`  (objective hex ${drop.key}, ${drop.objHp} hp, took ${drop.shots} bites; ` +
              `also flattened ${drop.otherHexes} other destructible hexes)`);
  check(drop.objectiveGone, 'the objective hex actually collapsed');
  check(drop.addedTypes.length === 1, `exactly ONE powerup dropped (got ${drop.addedTypes.length}: ${drop.addedTypes})`);
  check(drop.addedTypes[0] === 'armorPatch', `and it is an armorPatch (got ${drop.addedTypes[0]})`);
  check(drop.nonObjectiveDrops === 0, `no armorPatch from any NON-objective hex (got ${drop.nonObjectiveDrops})`);
  check(drop.restDrops === drop.remaining,
    `each of the ${drop.remaining} remaining base objectives paid out exactly one more (got ${drop.restDrops})`);
  check(drop.repeatDrops === 0, `a repeated collapse signal awards nothing further (got ${drop.repeatDrops})`);
  check(drop.dropBlocked === false, 'the drop landed on reachable ground');
}

// A long spree of ordinary kills must never produce an armorPatch (the pool exclusion, live).
const spree = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  const before = a.powerups.length;
  for (let i = 0; i < 3000; i++) a.spawnPowerup(0, 0);   // the random-type entry point
  return a.powerups.slice(before).filter((p) => p.type === 'armorPatch').length;
});
check(spree === 0, `3000 random-type drops in the live scene yielded 0 armorPatch (got ${spree})`);

// ── 2) The colour, at pickup size, on pale ground ────────────────────────────────────────
console.log('\n#315 part 2 — the new colour vs Shield\'s cyan, on pale biome ground\n');
for (const biome of ['arctic', 'desert', 'grassland']) {
  await bootArena(biome);
  const shot = await page.evaluate(() => {
    const a = window.__game.scene.getScene('ArenaScene');
    // Clear the board, park the camera, and place the two pickups side by side on open ground
    // just off the spawn point so both sit on the biome's normal walkable terrain.
    for (const p of [...a.powerups]) p.view?.destroy();
    a.powerups.length = 0;
    for (const e of [...(a.enemies ?? [])]) e.view?.destroy?.();
    if (a.enemies) a.enemies.length = 0;
    const patch = a.spawnPowerup(a.px - 110, a.py - 150, 'armorPatch');
    const shield = a.spawnPowerup(a.px + 110, a.py - 150, 'shield');
    a.cameras.main.centerOn((patch.x + shield.x) / 2, (patch.y + shield.y) / 2);
    return {
      biome: a.biome.id, groundA: a.biome.groundA,
      patch: a.powerups.find((p) => p.type === 'armorPatch')?.type,
      shield: a.powerups.find((p) => p.type === 'shield')?.type,
    };
  });
  await page.waitForTimeout(900);   // let the beacons bob/pulse into a representative frame
  const file = `${OUT}/armorpatch-315-${biome}.png`;
  await page.screenshot({ path: file });
  check(shot.patch === 'armorPatch' && shot.shield === 'shield',
    `${biome} (${shot.groundA}): both pickups placed — screenshot ${file}`);
}

if (errors.length) check(false, `runtime errors: ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
console.log(failed ? '\n#315 AUDIT: FAIL\n' : '\n#315 AUDIT: PASS\n');
process.exitCode = failed ? 1 : 0;
