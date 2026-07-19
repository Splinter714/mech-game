// #307 — audit harness: does Barrage VISIBLY double what leaves the muzzle, for every weapon?
//
// Boots the real game, deploys into the arena, and for each weapon in WEAPONS runs two
// real-time hold-the-trigger windows (Barrage OFF, then Barrage ON) against a pinned,
// immortal target. It samples the LIVE SIM STATE off the game's own rAF loop — max
// concurrent in-flight projectiles and max concurrent live beam objects — so a doubled
// emission plan that collapses into ONE rendered thing scores 1x, which is the whole point.
//
// Usage: start a dev server, then `SMOKE_URL=http://localhost:PORT node scripts/audit-barrage-307.mjs`

import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';
import { WEAPON_IDS } from '../src/data/weapons.js';

const URL = await resolveDevServerUrl();
const WINDOW_MS = Number(process.env.AUDIT_WINDOW_MS || 3000);

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

await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
await page.waitForFunction(() => window.__game.scene.isActive('ArenaScene'), { timeout: 20000 });

// One-time rig: pin an immortal target downrange, hold rightArm's trigger, never spend ammo,
// never end the run, and sample the live sim every rAF frame.
await page.evaluate(() => {
  const a = window.__game.scene.getScene('ArenaScene');
  window.__audit = { max: { proj: 0, beams: 0 }, created: { proj: 0, beams: 0 }, dmg: 0, hits: 0, on: false };

  a._updateRun = () => {};
  a.mech.consumeAmmo = () => {};                       // ammo is not what's under test
  a._damagePlayerAt = () => {};                        // the player must survive all 26 windows

  // Immortal target: swallow the damage (record it) so the dummy never dies and the whole
  // audit runs against one fixed geometry.
  a._damageEnemyAt = (target, x, y, dmg) => {
    if (window.__audit.on) { window.__audit.dmg += dmg; window.__audit.hits++; }
  };

  a.enemies.length = 0;
  a._spawnEnemy(a.px + 260, a.py, 'raider');
  const dummy = a.enemies[0];
  // Disarm the dummy: no return fire means no enemy-owned rounds polluting the projectile
  // count, and nothing that can kill the player mid-audit.
  for (const loc of Object.keys(dummy.mech.mounts || {})) dummy.mech.mounts[loc] = [];
  window.__auditDummy = dummy;
  // Freeze it in place so range falloff is constant across every weapon/run.
  setInterval(() => {
    if (!a.scene.isActive()) return;
    dummy.x = a.px + 260; dummy.y = a.py;
    dummy.mech.repairAll?.();
    a.mech.repairAll?.();
    if (a.enemies.length > 1) a.enemies.length = 1;
  }, 60);

  const origRead = a.controls.read.bind(a.controls);
  a.controls.read = () => {
    const intent = origRead();
    intent.aim = { mode: 'pointer', x: dummy.x, y: dummy.y };
    intent.throttle = 0; intent.turn = 0;
    for (const loc of Object.keys(intent.fire)) intent.fire[loc] = false;
    intent.fire.rightArm = true;
    return intent;
  };

  // Sample off the game's OWN loop, not a stepped update() — timed things (fire cadence,
  // burst delays, beam ttl) must elapse against the real Phaser clock.
  //
  // Two metrics, because the two failure modes look different:
  //  • `created` — DISTINCT entity objects that actually appeared in the live sim (tracked by
  //    object identity, so a re-pinned persistent beam is NOT recounted). This is the right
  //    metric for discrete weapons: rounds despawn on impact, so max-concurrent under-reports.
  //  • `maxLive` — peak simultaneous entities. This is the right metric for a SUSTAINED beam,
  //    which by design creates one persistent object per lane and re-pins it forever; the
  //    #307 bug is precisely that two lanes collapsed into one live object.
  // Identity tracking survives `this.beams = this.beams.filter(...)` reassigning the array.
  const seen = new WeakSet();
  const sample = () => {
    const A = window.__audit;
    if (A.on) {
      for (const p of a.projectiles) if (p.owner === 'player' && !seen.has(p)) { seen.add(p); A.created.proj++; }
      for (const b of a.beams) if (!seen.has(b)) { seen.add(b); A.created.beams++; }
      A.max.proj = Math.max(A.max.proj, a.projectiles.filter((p) => p.owner === 'player').length);
      A.max.beams = Math.max(A.max.beams, a.beams.length);
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
});

const runWindow = async (weaponId, barrage) => {
  await page.evaluate(({ weaponId, barrage }) => {
    const a = window.__game.scene.getScene('ArenaScene');
    // Clear the slot and remount the weapon under test.
    while (a.mech.mounts.rightArm.length) a.mech.unmount('rightArm', 0);
    a.mech.mount('rightArm', weaponId);
    a.mech.consumeAmmo = () => {};
    a.projectiles.length = 0; a.beams.length = 0; a.dyingBeams.length = 0;
    a.activePowerups = barrage ? { barrage: 999999 } : {};
    a._refreshBuffMods();
    window.__audit = { max: { proj: 0, beams: 0 }, created: { proj: 0, beams: 0 }, dmg: 0, hits: 0, on: false };
  }, { weaponId, barrage });

  // Let the first shots get airborne before the measurement window opens, so we sample a
  // steady state rather than the ramp-up.
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__audit.on = true; });
  await page.waitForTimeout(WINDOW_MS);
  return page.evaluate(() => {
    window.__audit.on = false;
    const A = window.__audit;
    return { maxProj: A.max.proj, maxBeams: A.max.beams, newProj: A.created.proj,
             newBeams: A.created.beams, dmg: Math.round(A.dmg), hits: A.hits };
  });
};

const rows = [];
for (const id of WEAPON_IDS) {
  const off = await runWindow(id, false);
  const on = await runWindow(id, true);
  const r = (a, b) => (a > 0 ? Number((b / a).toFixed(2)) : null);
  const row = {
    id,
    newProj: [off.newProj, on.newProj, r(off.newProj, on.newProj)],
    newBeams: [off.newBeams, on.newBeams, r(off.newBeams, on.newBeams)],
    maxBeams: [off.maxBeams, on.maxBeams, r(off.maxBeams, on.maxBeams)],
    dmg: [off.dmg, on.dmg, r(off.dmg, on.dmg)],
  };
  rows.push(row);
  const f = (k) => `${String(row[k][0]).padStart(3)}->${String(row[k][1]).padStart(3)} x${row[k][2] ?? '--'}`;
  console.log(`${id.padEnd(14)} newProj ${f('newProj')} | newBeams ${f('newBeams')} | maxBeams ${f('maxBeams')} | dmg ${f('dmg')}`);
}

console.log('\nJSON:', JSON.stringify(rows));
if (errors.length) console.log('\nPAGE ERRORS:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
