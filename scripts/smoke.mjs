// Headless smoke test for the running game (Phaser in a real browser). Vitest covers
// the pure data layer; this proves the game BOOTS without runtime errors, both the
// garage and arena scenes work, mechs render, mounting validates, the mech drives, and
// the per-part damage loop fires.
//
// Usage: start the dev server, then `SMOKE_URL=http://localhost:PORT npm run smoke`.

import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';
import { hexToPixel } from '../src/data/hexgrid.js';

// Enemies now spawn OFF-SCREEN and walk in (#44), so `enemies[0]` at boot is far out of
// weapon range with terrain possibly between it and the origin. For the deterministic
// firing tests we teleport the target onto DUMMY_HEX (3,-1) — a spot the world generator
// explicitly clears back to open grass with clear line-of-sight from the origin (0,0),
// and ~220px out, inside every weapon's range.
const DUMMY_PX = hexToPixel(3, -1);

// `?canvas` (added by the resolver) forces Phaser's Canvas renderer — headless
// Chromium lacks WebGL framebuffers, and the logic we assert on is renderer-agnostic.
const URL = await resolveDevServerUrl();
const fail = (msg) => { console.error('SMOKE FAIL:', msg); process.exitCode = 1; };

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 20000 });

  // Garage boots with the saved roster.
  await page.waitForFunction(() => {
    const g = window.__game;
    return !!(g && g.scene.isActive('GarageScene') && g.registry.get('allMechs'));
  }, { timeout: 20000 });

  const garage = await page.evaluate(() => {
    const g = window.__game;
    const sc = g.scene.getScene('GarageScene');
    const mech = g.registry.get('allMechs').mech1;
    // Mount/unmount works in a weapon slot...
    mech.unmount('rightArm', 0);
    sc._selectSlot('rightArm');
    sc._pickItem('autocannon');
    const weaponMount = mech.mounts.rightArm.includes('autocannon');
    // ...and the head is not a skill slot at all (#31), so it rejects a weapon.
    const headRejectsWeapon = !mech.mount('head', 'pulseLaser').ok;
    const dollBuilt = sc.doll.list.length > 0;
    // The default roster leaves centreTorso (the ability slot) empty; fill it with an ability
    // via the same catalog path so the build is COMPLETE — deploy() no-ops on an incomplete mech.
    if (!mech.mounts.centerTorso.length) { sc._selectSlot('centerTorso'); sc._pickItem('jumpJet'); }
    return {
      chassis: mech.chassisId,
      weaponMount,
      headRejectsWeapon,
      dollBuilt,
      buildValid: mech.validate().ok,
      deployable: mech.isComplete(),
    };
  });
  await page.screenshot({ path: '/tmp/mech-garage.png' });

  // Deploy → arena.
  await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
  await page.waitForFunction(() => {
    const g = window.__game;
    return g.scene.isActive('ArenaScene') && g.scene.isActive('HudScene') && g.registry.get('dummyMech');
  }, { timeout: 20000 });

  const arena = await page.evaluate((dummyPx) => {
    const g = window.__game;
    const a = g.scene.getScene('ArenaScene');
    const e0 = a.enemies[0];        // the first (and at boot, only) enemy
    const em = e0.mech;

    // Tank locomotion: holding throttle should drive the mech forward (up = -y).
    const y0 = a.py;
    a.controls.keys.W.isDown = true;
    for (let i = 0; i < 8; i++) a.update(0, 16);
    a.controls.keys.W.isDown = false;
    const droveForward = a.py < y0 - 0.5;

    // Collision: shoving into the world for a long time must never end up inside a wall
    // hex or outside the arena disc.
    a.controls.keys.D.isDown = true;
    let everInWall = false;
    for (let i = 0; i < 300; i++) { a.update(0, 16); if (a._isWall(a.px, a.py)) everInWall = true; }
    a.controls.keys.D.isDown = false;
    const collisionHolds = !everInWall && !a._blocked(a.px, a.py);
    // Put the player at the origin and the target on DUMMY_HEX (clear grass, clear LOS,
    // in range) for the deterministic firing tests. e0's real spawn is off-screen (#44),
    // far out of range, so it can't be fired on from the origin without driving in first.
    a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
    e0.x = dummyPx.x; e0.y = dummyPx.y; e0.vx = 0; e0.vy = 0;
    e0.spawnX = e0.x; e0.spawnY = e0.y;   // so _resetEnemies restores it here, not off-screen

    // Per-part damage loop: point the turret at the enemy and fire each ready weapon;
    // its centre torso (nearest part to the ray) must lose health, and over-damage
    // must destroy it. Weapons fire along turretAngle at the reticle distance (#40).
    a.turretAngle = Math.atan2(e0.y - a.py, e0.x - a.px);
    a.aimX = e0.x; a.aimY = e0.y;

    // Projectile travel: fire ONLY a travelling round (the slug, not the hitscan laser)
    // at the pristine enemy and let it fly — it must cross the gap and deal damage.
    const totalHp = () => Object.values(em.parts).reduce((s, p) => s + p.armor + p.structure, 0);
    const slug = a.mech.weapons().find((w) => w.weapon.delivery.hit === 'projectile');
    let projHit = false;
    if (slug) {
      const hp0 = totalHp();
      a.projectiles.length = 0;
      a.fireWeapon(slug);
      const spawned = a.projectiles.length > 0;
      for (let i = 0; i < 60 && a.projectiles.length; i++) a._updateProjectiles(0.016);
      projHit = spawned && totalHp() < hp0;
    }

    // Then fire everything and confirm per-part damage lands + destruction works.
    // Spread/multi-weapon fire + muzzle offsets scatter hits across the enemy's body, so
    // assert that SOME part lost health (per-part damage applied), not one fixed location.
    a.aimX = e0.x; a.aimY = e0.y;   // re-aim (the steps above advance the sim)
    const partFracs = () => Object.keys(em.parts).map((k) => em.partHealthFraction(k));
    const partsBefore = partFracs();
    for (const w of a.mech.readyWeapons()) a.fireWeapon(w);
    for (let i = 0; i < 30; i++) a._updateProjectiles(0.016);
    const partsAfter = partFracs();
    const anyPartDamaged = partsAfter.some((f, i) => f < partsBefore[i]);

    em.applyDamage('centerTorso', 999);
    const dummyDead = em.isDestroyed();

    // #39: spawn an extra enemy, confirm the arena tracks N and can damage the new one,
    // then reset restores every enemy to full health in place.
    const sumHp = (m) => Object.values(m.parts).reduce((s, p) => s + p.armor + p.structure, 0);
    a._spawnEnemyDebug();
    const spawnedExtra = a.enemies.length >= 2;
    const e1 = a.enemies[a.enemies.length - 1];
    const e1Hp0 = sumHp(e1.mech);
    a._damageEnemyAt(e1, e1.x, e1.y, 30, 0xffffff);
    const extraDamaged = sumHp(e1.mech) < e1Hp0;
    a._resetEnemies();
    // em was just killed (centre-torso overkill above); reset must bring it back to life.
    const resetWorked = !em.isDestroyed();

    return {
      droveForward,
      hullTex: g.textures.exists('playerMech_hull_0'),
      dummyTex: g.textures.exists('enemy0_turret'),
      onlineWeapons: a.mech.onlineWeapons().length,
      projHit,
      collisionHolds,
      partDamaged: anyPartDamaged,
      dummyDead,
      spawnedExtra,
      extraDamaged,
      resetWorked,
    };
  }, DUMMY_PX);
  await page.screenshot({ path: '/tmp/mech-arena.png' });

  console.log(JSON.stringify({ garage, arena }, null, 2));

  if (errors.length) fail('runtime errors:\n' + errors.join('\n'));
  if (garage.chassis !== 'medium') fail(`expected medium chassis, got ${garage.chassis}`);
  if (!garage.weaponMount) fail('mounting a weapon into a weapon slot did not take');
  if (!garage.headRejectsWeapon) fail('the head (not a skill slot) wrongly accepted a weapon');
  if (!garage.dollBuilt) fail('garage paper-doll did not render any slot cards');
  if (!garage.buildValid) fail('default build is invalid (slots over capacity)');
  if (!garage.deployable) fail('build is not complete (an empty skill slot blocks deploy)');
  if (!arena.hullTex || !arena.dummyTex) fail('arena mech textures missing');
  if (arena.onlineWeapons < 1) fail('player mech has no online weapons in the arena');
  if (!arena.projHit) fail('a travelling projectile did not cross the gap and damage the dummy');
  if (!arena.collisionHolds) fail('the mech drove through a wall or off the arena disc');
  if (!arena.droveForward) fail('tank locomotion did not move the mech forward');
  if (!arena.partDamaged) fail('firing at the dummy did not apply per-part damage');
  if (!arena.spawnedExtra) fail('#39 spawn-enemy did not add a second enemy');
  if (!arena.extraDamaged) fail('#39 the newly spawned enemy could not be damaged');
  if (!arena.resetWorked) fail('#39 reset-enemies did not restore a destroyed enemy');
  if (!arena.dummyDead) fail('dummy did not register destruction on centre-torso kill');

  if (!process.exitCode) console.log('SMOKE OK ✔  (screenshots: /tmp/mech-garage.png, /tmp/mech-arena.png)');
} catch (e) {
  fail(e.message + (errors.length ? '\nerrors:\n' + errors.join('\n') : ''));
} finally {
  await browser.close();
}
