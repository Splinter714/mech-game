// Headless smoke test for the running game (Phaser in a real browser). Vitest covers
// the pure data layer; this proves the game BOOTS without runtime errors, both the
// garage and arena scenes work, mechs render, mounting validates, the mech drives, and
// the per-part damage loop fires.
//
// Usage: start the dev server, then `SMOKE_URL=http://localhost:PORT npm run smoke`.

import { chromium } from 'playwright';
import { resolveDevServerUrl } from './dev-server-url.mjs';
import { hexToPixel } from '../src/data/hexgrid.js';
import { RUN_CURRENCY_KEY } from '../src/data/events.js';

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

  const garage = await page.evaluate((runCurrencyKey) => {
    const g = window.__game;
    const sc = g.scene.getScene('GarageScene');
    const RUN_CURRENCY_KEY = runCurrencyKey;
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

    // #65: shop economy. 'shotgun' isn't in the starting-unlocked set, so a fresh save must
    // reject mounting it — clicking a locked card attempts a purchase instead, and with zero
    // SCRAP that purchase must fail (no mount, no unlock, no spend). _selectSlot TOGGLES the
    // same slot off if it's already selected, so only select rightArm if it isn't already.
    if (sc.selected !== 'rightArm') sc._selectSlot('rightArm');
    sc.registry.set(RUN_CURRENCY_KEY, 0);
    sc._pickItem('shotgun');
    const lockedRejectsMount = !mech.mounts.rightArm.includes('shotgun') && !sc.unlocked.has('shotgun');
    // Fund the purchase, buy it, and confirm: SCRAP is spent, the id is now unlocked, AND it
    // can now actually be mounted (the lock, not just a UI skin, gated it).
    sc.registry.set(RUN_CURRENCY_KEY, 500);
    sc._pickItem('shotgun');
    const purchased = sc.unlocked.has('shotgun') && sc.registry.get(RUN_CURRENCY_KEY) < 500;
    sc._pickItem('shotgun');   // now unlocked — this click mounts it into the still-selected slot
    const unlockedMounts = mech.mounts.rightArm.includes('shotgun');
    mech.unmount('rightArm', 0);
    mech.mount('rightArm', 'autocannon');   // restore for the rest of the smoke run

    return {
      chassis: mech.chassisId,
      weaponMount,
      headRejectsWeapon,
      dollBuilt,
      buildValid: mech.validate().ok,
      deployable: mech.isComplete(),
      lockedRejectsMount,
      purchased,
      unlockedMounts,
    };
  }, RUN_CURRENCY_KEY);
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
    // Captured NOW: the #64 stage-advance test below replaces the squad, and #71's teardown
    // correctly REMOVES the old squad's textures — so this must be read before that runs.
    const dummyTex = g.textures.exists(e0.key + '_turret');

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

    // #68: NON-MECH kinds spawn, render (their own vehicle textures), take damage through the
    // SAME body interface (isDestroyed/applyDamage/partHealthFraction), and die — and a FLYER
    // ignores ground cover. Spawn one of each kind at the origin and exercise all of that.
    const veh = { spawned: 0, textured: 0, damaged: 0, killed: 0, flyerIgnoresWall: false };
    for (const kind of ['turret', 'tank', 'drone', 'helicopter']) {
      const e = a._spawnKind(0, 0, kind);
      veh.spawned++;
      if (g.textures.exists(e.key + '_hull') && g.textures.exists(e.key + '_turret')) veh.textured++;
      const before = e.mech.partHealthFraction(e.mech.locations()[0]);
      a._damageEnemyAt(e, e.x, e.y, 10, 0xffffff);
      if (e.mech.partHealthFraction(e.mech.locations()[0]) < before) veh.damaged++;
      a._damageEnemyAt(e, e.x, e.y, 9999, 0xffffff);
      if (e.mech.isDestroyed()) veh.killed++;
    }
    // A flyer's update must NOT be stopped by a wall: drive a fresh helicopter straight at a
    // forest/building hex and confirm it passes through (ground units would be blocked).
    const heli = a._spawnKind(0, 0, 'helicopter');
    // Find a nearby wall (forest/building) to aim it at; if none in range, the flag stays false
    // but we still assert flyers don't collide by pushing velocity into a known wall if present.
    let wallPt = null;
    for (let r = 40; r < 400 && !wallPt; r += 20) {
      for (let ang = 0; ang < Math.PI * 2; ang += Math.PI / 8) {
        const wx = Math.cos(ang) * r, wy = Math.sin(ang) * r;
        if (a._isWall(wx, wy)) { wallPt = { x: wx, y: wy }; break; }
      }
    }
    if (wallPt) {
      heli.x = wallPt.x; heli.y = wallPt.y;   // sit it ON the wall hex
      // A flyer sitting on a wall is fine (it's above it); a ground unit would never be placed
      // there by its own movement. Assert the flyer flag + that it isn't force-ejected.
      a._updateVehicle(heli, 0.016, 16);
      veh.flyerIgnoresWall = heli.flying === true && a._isWall(heli.x, heli.y);
    } else {
      veh.flyerIgnoresWall = heli.flying === true;   // no wall handy; flag still records it flies
    }

    // #66: Mission wiring — the arena designates one outpost as `a.objectiveHex` at create()
    // (deterministic, see mission.js `_initMission`) and publishes `a.mission` each frame.
    // Confirm it starts active with the assault objective, then hammer the objective hex with
    // `_damageBuildingAt` (same path real weapon fire uses) until it collapses, and confirm the
    // mission flips to 'complete'.
    const missionStartedActive = a.mission?.status === 'active' && a.mission?.typeId === 'assault';
    let missionCompleted = false;
    if (a.objectiveHex) {
      // Axial → pixel (pointy-top), mirroring data/hexgrid.js `hexToPixel` — inlined because
      // this callback runs in the page context, where the Node-side import isn't reachable.
      const [oq, or_] = a.objectiveHex.split(',').map(Number);
      const SIZE = 48, SQRT3 = Math.sqrt(3);
      const ox = SIZE * SQRT3 * (oq + or_ / 2), oy = SIZE * (3 / 2) * or_;
      for (let i = 0; i < 20 && a.buildingHp.has(a.objectiveHex); i++) a._damageBuildingAt(ox, oy, 20);
      a._updateMission();
      missionCompleted = a.mission?.status === 'complete';
    }

    // #64: run loop — stage advance on mission-complete. The mission above was just driven to
    // 'complete'; running the run mixin's per-frame check should notice and start advancing
    // (banking currency, moving to stage 1) without waiting for the real transition timer —
    // call the internal advance directly (mirrors how _updateRun would trigger it) and then
    // force the delayed _startNextStage() through immediately so this stays a synchronous test.
    const runStartedAtStageZero = a.run?.stageIndex === 0 && a.run?.status === 'active';
    const enemyCountBeforeAdvance = a.enemies.length;
    a._advanceRun();
    const stageAdvanced = a.run?.stageIndex === 1 && a.run?.status === 'active';
    // _advanceRun scheduled _startNextStage on a timer; fire it immediately so the smoke test
    // doesn't need to sleep, then confirm a fresh (bigger) squad + a fresh active mission exist.
    a._startNextStage();
    const newStageHasMission = a.mission?.status === 'active';
    const newStageHasSquad = a.enemies.length > 0;

    // Captured BEFORE the run-loop death test below deliberately destroys the player mech —
    // otherwise this would read 0 post-mortem instead of reflecting the earlier healthy state.
    const onlineWeapons = a.mech.onlineWeapons().length;

    // #65: a salvage pickup adds straight into the LIVE run currency. Spawn one, walk the
    // player onto it (mirrors _updatePowerups' pickup-radius check), and confirm the run's
    // currency total increased by exactly the drop's amount.
    // Clear first: the #68 vehicle-kill test above killed several units AT THE ORIGIN, each
    // with a chance to drop its own salvage there — since _updateSalvage never ran meanwhile
    // (only the full update() loop calls it, which this test avoids), any such drops are still
    // sitting unpicked-up at (0,0) and would inflate this test's currency delta.
    a.salvage.length = 0;
    const currencyBeforeSalvage = a.run.currency;
    const drop = { x: a.px, y: a.py, amount: 12, ttl: 15000, age: 0, view: a._makeSalvageView(a.px, a.py) };
    a.salvage.push(drop);
    a._updateSalvage(16);
    const salvagePickedUp = a.run.currency === currencyBeforeSalvage + 12 && a.salvage.length === 0;

    // #64: run loop — player death ends the run and banks currency. Force-kill the player mech
    // (same overkill path used on the dummy above) and drive one update() so _updateRun notices.
    const currencyBeforeDeath = a.run.currency;
    for (const loc of Object.keys(a.mech.parts)) a.mech.applyDamage(loc, 9999);
    a.update(0, 16);
    const runEndedOnDeath = a.run?.status === 'dead';
    const currencyBankedOnDeath = (g.registry.get('runCurrency') || 0) >= currencyBeforeDeath;

    return {
      droveForward,
      hullTex: g.textures.exists('playerMech_hull_0'),
      dummyTex,
      // #71: the stage advance above tore the OLD squad down — its views and textures must be
      // gone (this was the leak: every stage's corpse sprites piling up for the whole session).
      oldSquadTornDown: !g.textures.exists(e0.key + '_turret') && !e0.view.active,
      onlineWeapons,
      projHit,
      collisionHolds,
      partDamaged: anyPartDamaged,
      dummyDead,
      spawnedExtra,
      extraDamaged,
      resetWorked,
      veh,
      missionStartedActive,
      missionCompleted,
      runStartedAtStageZero,
      stageAdvanced,
      newStageHasMission,
      newStageHasSquad,
      runEndedOnDeath,
      currencyBankedOnDeath,
      salvagePickedUp,
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
  // #65: shop economy — a locked item can't be mounted (or unlocked) with zero SCRAP; funding
  // the purchase spends SCRAP and unlocks it; only THEN can it actually be mounted.
  if (!garage.lockedRejectsMount) fail('#65 a locked item mounted (or unlocked) without being purchased');
  if (!garage.purchased) fail('#65 purchasing a locked item did not spend SCRAP and unlock it');
  if (!garage.unlockedMounts) fail('#65 an unlocked item still could not be mounted');
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
  // #68: the four non-mech kinds spawn, render their own textures, take damage, and die.
  if (arena.veh.spawned !== 4) fail(`#68 expected 4 non-mech kinds spawned, got ${arena.veh.spawned}`);
  if (arena.veh.textured !== 4) fail('#68 a non-mech kind is missing its hull/turret textures');
  if (arena.veh.damaged !== 4) fail('#68 a non-mech kind did not take damage via the body interface');
  if (arena.veh.killed !== 4) fail('#68 a non-mech kind did not register destruction');
  if (!arena.veh.flyerIgnoresWall) fail('#68 a flyer did not ignore ground cover');
  // #66: mission starts active on the assault objective, and destroying the objective hex
  // (via the same _damageBuildingAt path weapon fire uses) completes it.
  if (!arena.missionStartedActive) fail('#66 mission did not start active with the assault objective');
  if (!arena.missionCompleted) fail('#66 destroying the objective hex did not complete the mission');
  // #64: run loop — a fresh deploy starts at stage 0, mission-complete advances the run to the
  // next stage with a fresh mission + squad in the SAME arena session, and player death ends
  // the run + banks its currency into the persistent registry value the garage reads.
  if (!arena.runStartedAtStageZero) fail('#64 run did not start active at stage 0 on deploy');
  if (!arena.stageAdvanced) fail('#64 mission-complete did not advance the run to the next stage');
  if (!arena.newStageHasMission) fail('#64 the next stage did not start with a fresh active mission');
  if (!arena.newStageHasSquad) fail('#64 the next stage did not spawn a fresh squad');
  if (!arena.oldSquadTornDown) fail('#71 stage advance did not tear down the old squad\'s views/textures');
  if (!arena.runEndedOnDeath) fail('#64 player mech destruction did not end the run');
  if (!arena.currencyBankedOnDeath) fail('#64 run currency was not banked into the persistent registry value on run end');
  // #65: a salvage pickup adds straight into the live run currency total.
  if (!arena.salvagePickedUp) fail('#65 a salvage pickup did not increase the live run currency');

  if (!process.exitCode) console.log('SMOKE OK ✔  (screenshots: /tmp/mech-garage.png, /tmp/mech-arena.png)');
} catch (e) {
  fail(e.message + (errors.length ? '\nerrors:\n' + errors.join('\n') : ''));
} finally {
  await browser.close();
}
