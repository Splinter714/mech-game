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
    sc.selected = 'head';
    sc.tryMount('mediumLaser'); // head has 1 free slot on the medium chassis
    return {
      chassis: mech.chassisId,
      headMounted: mech.mounts.head.includes('mediumLaser'),
      turretTex: g.textures.exists('garageMech_turret'),
      tonnageOk: mech.validate().ok,
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

    // Tank locomotion: holding throttle should drive the mech forward (up = -y).
    const y0 = a.py;
    a.keys.W.isDown = true;
    for (let i = 0; i < 8; i++) a.update(0, 16);
    a.keys.W.isDown = false;
    const droveForward = a.py < y0 - 0.5;

    // Per-part damage loop: aim at the dummy centre and fire — its centre torso (the
    // nearest part to the aim) must lose health, and over-damage must destroy it.
    a.input.activePointer.worldX = a.dx;
    a.input.activePointer.worldY = a.dy;
    const ctBefore = a.dummy.partHealthFraction('centerTorso');
    a.fire();
    const ctAfter = a.dummy.partHealthFraction('centerTorso');

    a.dummy.applyDamage('centerTorso', 999);
    const dummyDead = a.dummy.isDestroyed();

    return {
      droveForward,
      hullTex: g.textures.exists('playerMech_hull_0'),
      dummyTex: g.textures.exists('dummyMech_turret'),
      onlineWeapons: a.mech.onlineWeapons().length,
      ctDamaged: ctAfter < ctBefore,
      dummyDead,
    };
  });
  await page.screenshot({ path: '/tmp/mech-arena.png' });

  console.log(JSON.stringify({ garage, arena }, null, 2));

  if (errors.length) fail('runtime errors:\n' + errors.join('\n'));
  if (garage.chassis !== 'medium') fail(`expected medium chassis, got ${garage.chassis}`);
  if (!garage.headMounted) fail('mounting a weapon into the head did not take');
  if (!garage.turretTex) fail('garageMech turret texture missing');
  if (!garage.tonnageOk) fail('default build is over budget');
  if (!arena.hullTex || !arena.dummyTex) fail('arena mech textures missing');
  if (arena.onlineWeapons < 1) fail('player mech has no online weapons in the arena');
  if (!arena.droveForward) fail('tank locomotion did not move the mech forward');
  if (!arena.ctDamaged) fail('firing at the dummy did not damage its centre torso');
  if (!arena.dummyDead) fail('dummy did not register destruction on centre-torso kill');

  if (!process.exitCode) console.log('SMOKE OK ✔  (screenshots: /tmp/mech-garage.png, /tmp/mech-arena.png)');
} catch (e) {
  fail(e.message + (errors.length ? '\nerrors:\n' + errors.join('\n') : ''));
} finally {
  await browser.close();
}
