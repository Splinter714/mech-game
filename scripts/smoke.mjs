// Headless smoke test for the running game (Phaser in a real browser). Vitest covers
// the pure data layer; this proves the game BOOTS without runtime errors, both the
// garage and arena scenes work, mechs render, mounting validates, the mech drives, and
// the per-part damage loop fires.
//
// Usage: start the dev server, then `SMOKE_URL=http://localhost:PORT npm run smoke`.

import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';

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
    sc.selected = 'rightArm';
    mech.unmount('rightArm', 0);
    sc.arm('autocannon');
    sc.placeOn('rightArm');
    const weaponMount = mech.mounts.rightArm.includes('autocannon');
    // ...and the head is an ability slot now, so it rejects a weapon.
    const headRejectsWeapon = !mech.mount('head', 'mediumLaser').ok;
    const dollBuilt = sc.doll.list.length > 0;
    return {
      chassis: mech.chassisId,
      weaponMount,
      headRejectsWeapon,
      dollBuilt,
      buildValid: mech.validate().ok,
    };
  });
  await page.screenshot({ path: '/tmp/mech-garage.png' });

  // Deploy → arena.
  await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
  await page.waitForFunction(() => {
    const g = window.__game;
    return g.scene.isActive('ArenaScene') && g.scene.isActive('HudScene') && g.registry.get('dummyMech');
  }, { timeout: 20000 });

  const arena = await page.evaluate(() => {
    const g = window.__game;
    const a = g.scene.getScene('ArenaScene');
    const ex0 = a.dx, ey0 = a.dy;   // enemy spawn (known clear line of sight from origin)

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
    // Reset both mechs to their spawn (clear LOS) for the deterministic firing tests.
    a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
    a.dx = ex0; a.dy = ey0; a.evx = 0; a.evy = 0;

    // Per-part damage loop: point the turret at the dummy and fire each ready weapon;
    // its centre torso (nearest part to the ray) must lose health, and over-damage
    // must destroy it.
    a.turretAngle = Math.atan2(a.dy - a.py, a.dx - a.px);
    a.aimX = a.dx; a.aimY = a.dy;   // weapons converge on the aim point

    // Projectile travel: fire ONLY a travelling round (the slug, not the hitscan laser)
    // at the pristine dummy and let it fly — it must cross the gap and deal damage.
    const totalHp = () => Object.values(a.dummy.parts).reduce((s, p) => s + p.armor + p.structure, 0);
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

    // Then fire everything and confirm overall damage + destruction.
    a.aimX = a.dx; a.aimY = a.dy;   // re-aim (the steps above advance the sim)
    const ctBefore = a.dummy.partHealthFraction('centerTorso');
    for (const w of a.mech.readyWeapons()) a.fireWeapon(w);
    for (let i = 0; i < 30; i++) a._updateProjectiles(0.016);
    const ctAfter = a.dummy.partHealthFraction('centerTorso');

    a.dummy.applyDamage('centerTorso', 999);
    const dummyDead = a.dummy.isDestroyed();

    return {
      droveForward,
      hullTex: g.textures.exists('playerMech_hull_0'),
      dummyTex: g.textures.exists('dummyMech_turret'),
      onlineWeapons: a.mech.onlineWeapons().length,
      projHit,
      collisionHolds,
      ctDamaged: ctAfter < ctBefore,
      dummyDead,
    };
  });
  await page.screenshot({ path: '/tmp/mech-arena.png' });

  console.log(JSON.stringify({ garage, arena }, null, 2));

  if (errors.length) fail('runtime errors:\n' + errors.join('\n'));
  if (garage.chassis !== 'medium') fail(`expected medium chassis, got ${garage.chassis}`);
  if (!garage.weaponMount) fail('mounting a weapon into a weapon slot did not take');
  if (!garage.headRejectsWeapon) fail('the head (ability slot) wrongly accepted a weapon');
  if (!garage.dollBuilt) fail('garage paper-doll did not render any slot cards');
  if (!garage.buildValid) fail('default build is invalid (slots over capacity)');
  if (!arena.hullTex || !arena.dummyTex) fail('arena mech textures missing');
  if (arena.onlineWeapons < 1) fail('player mech has no online weapons in the arena');
  if (!arena.projHit) fail('a travelling projectile did not cross the gap and damage the dummy');
  if (!arena.collisionHolds) fail('the mech drove through a wall or off the arena disc');
  if (!arena.droveForward) fail('tank locomotion did not move the mech forward');
  if (!arena.ctDamaged) fail('firing at the dummy did not damage its centre torso');
  if (!arena.dummyDead) fail('dummy did not register destruction on centre-torso kill');

  if (!process.exitCode) console.log('SMOKE OK ✔  (screenshots: /tmp/mech-garage.png, /tmp/mech-arena.png)');
} catch (e) {
  fail(e.message + (errors.length ? '\nerrors:\n' + errors.join('\n') : ''));
} finally {
  await browser.close();
}
