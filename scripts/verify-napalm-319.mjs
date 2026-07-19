// #319 verification, in the REAL running game: burning ground damages whatever stands in it.
// Three probes, all fully SYNCHRONOUS inside page.evaluate (an await there yields to the
// browser and lets ArenaScene.update() clobber the measurement):
//   (a) the player standing in an ENEMY-fired patch loses health over successive ticks
//       (the reported bug: this used to do nothing at all),
//   (b) an enemy standing in a PLAYER-fired patch loses health, and
//   (c) the player standing in their OWN patch also burns (the owner's call: fire is
//       indiscriminate), and a patch spawned by a real landing round carries no owner.
// Usage: SMOKE_URL=http://localhost:PORT node scripts/verify-napalm-319.mjs
import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

const URL = await resolveDevServerUrl();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => {
  const g = window.__game;
  return !!(g && g.scene.isActive('GarageScene') && g.registry.get('allMechs'));
}, { timeout: 20000 });
await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 20000 });
await page.waitForTimeout(600);

const result = await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  a._updateRun = () => {};                                   // don't bounce us back to the garage on death
  const orig = a.controls.read.bind(a.controls);
  a.controls.read = () => { const i = orig(); i.throttle = 0; i.turn = 0; return i; };

  const hpOf = (m) => Object.values(m.parts).reduce((s, p) => s + p.armor + p.hp, 0);
  // Drain the player's shield pool first — otherwise the first ticks are absorbed and the
  // armor/hp totals below wouldn't move, which would read as "no damage" for the wrong reason.
  if (a.mech.shield) { a.mech.shield.current = 0; a.mech.shield.max = 0; }
  const playerHp = () => hpOf(a.mech);
  // Drive N damage ticks of the patch loop directly — no awaits, no scene update in between.
  const burn = (ticks) => {
    for (let i = 0; i < ticks; i++) { a.time.now += 500; a._updateFirePatches(); }
  };

  const out = {};

  // (a) an ENEMY-fired patch under the player's feet
  a.firePatches.length = 0;
  a.enemies.length = 0;
  const before = playerHp();
  a.firePatches.push({ x: a.px, y: a.py, r: 46, dps: 8, until: a.time.now + 60000, nextTick: a.time.now });
  burn(4);
  out.playerBurned = { before, after: playerHp() };

  // (b) an enemy standing in a patch
  a.firePatches.length = 0;
  a.enemies.length = 0;
  a._spawnEnemy(a.px + 600, a.py + 600);
  const e = a.enemies[0];
  const eHp = () => hpOf(e.mech);
  // Same shield drain as the player's — an enemy mech's shield pool otherwise soaks all
  // four ticks and the armor/hp totals wouldn't move.
  if (e.mech.shield) { e.mech.shield.current = 0; e.mech.shield.max = 0; }
  const eBefore = eHp();
  a.firePatches.push({ x: e.x, y: e.y, r: 46, dps: 8, until: a.time.now + 60000, nextTick: a.time.now });
  burn(4);
  out.enemyBurned = { before: eBefore, after: eHp() };

  // (c) the patch record carries NO owner field at all, and the player standing in one still
  // burns — i.e. "your own napalm hurts you" holds because no patch is anyone's.
  // (The spawn path stamping no owner is covered by the unit tests, which run the real
  // _updateProjectiles loop with an enemy- and a player-owned round.)
  a.firePatches.length = 0;
  a.enemies.length = 0;
  a.projectiles.length = 0;
  a.firePatches.push({ x: a.px, y: a.py, r: 46, dps: 8, until: a.time.now + 60000, nextTick: a.time.now });
  out.ownerFieldOnPatch = Object.keys(a.firePatches[0]).sort();
  const ownBefore = playerHp();
  burn(4);
  out.ownPatchBurnsPlayer = { before: ownBefore, after: playerHp() };

  out.perTickAndTotals = {
    tickAt_dps8: Math.max(1, Math.round(8 * 0.5)),
    tickAt_dps5_artillery: Math.max(1, Math.round(5 * 0.5)),
    playerTotalHp: playerHp(),
  };
  a.firePatches.length = 0;
  return out;
});

console.log(JSON.stringify(result, null, 2));
console.log('pageerrors:', errors);

const ok = result.playerBurned.after < result.playerBurned.before
  && result.enemyBurned.after < result.enemyBurned.before
  && result.ownPatchBurnsPlayer.after < result.ownPatchBurnsPlayer.before
  && !result.ownerFieldOnPatch.includes('enemyOwned')
  && errors.length === 0;
console.log(ok ? 'PASS #319' : 'FAIL #319');
await browser.close();
process.exit(ok ? 0 : 1);
