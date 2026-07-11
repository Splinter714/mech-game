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
import { WEAPONS } from '../src/data/weapons.js';

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
    const orderBeforeUnlock = sc.list.cards.map((c) => c.id);
    // Fund the purchase, buy it, and confirm: SCRAP is spent, the id is now unlocked, AND it
    // can now actually be mounted (the lock, not just a UI skin, gated it).
    sc.registry.set(RUN_CURRENCY_KEY, 500);
    sc._pickItem('shotgun');
    const purchased = sc.unlocked.has('shotgun') && sc.registry.get(RUN_CURRENCY_KEY) < 500;
    // #78 follow-up: the instant-unlock repaint must NOT reorder the list out from under the
    // player — refreshLocks() only repaints the lock scrim in place. The card set should be
    // untouched (same ids, same order) right after the purchase completes...
    const orderRightAfterUnlock = sc.list.cards.map((c) => c.id);
    const noReorderOnUnlock = JSON.stringify(orderRightAfterUnlock) === JSON.stringify(orderBeforeUnlock);
    // ...but the NEXT natural rebuild (setIds — e.g. reselecting the slot) re-sorts against the
    // live lock state, so the newly-unlocked item settles into its canonical unlocked position.
    sc.list.setIds(sc._eligibleIds(sc.selected));
    const orderAfterRebuild = sc.list.cards.map((c) => c.id);
    const reordersOnNextRebuild = orderAfterRebuild.indexOf('shotgun') < orderRightAfterUnlock.indexOf('shotgun');
    sc._pickItem('shotgun');   // now unlocked — this click mounts it into the still-selected slot
    const unlockedMounts = mech.mounts.rightArm.includes('shotgun');
    mech.unmount('rightArm', 0);
    mech.mount('rightArm', 'autocannon');   // restore for the rest of the smoke run

    // #84: mounting an already-mounted weapon into a NEW slot MOVES it — mouse flow. rightArm
    // holds 'autocannon' (restored above); mounting it into leftTorso via the same click-to-mount
    // path (_selectSlot + _pickItem) must empty rightArm, not leave it duplicated in both. Save
    // whatever leftTorso held so the default build's completeness is restored afterward.
    const leftTorsoWas = mech.mounts.leftTorso[0] ?? null;
    sc._selectSlot('leftTorso');
    sc._pickItem('autocannon');
    const moveMouseNewSlot = mech.mounts.leftTorso.includes('autocannon');
    const moveMouseOldSlotEmptied = !mech.mounts.rightArm.includes('autocannon');

    // #84: pad quick-mount flow — highlighting a catalog item already mounted (leftTorso) and
    // pressing a DIFFERENT slot's bind (_quickMount) must move it there too, never duplicate.
    sc._quickMount('rightArm', 'autocannon');
    const moveQuickNewSlot = mech.mounts.rightArm.includes('autocannon');
    const moveQuickOldSlotEmptied = !mech.mounts.leftTorso.includes('autocannon');
    // Exactly one slot holds it across the whole build, never two.
    const onlyOneSlotHoldsIt = Object.values(mech.mounts).filter((arr) => arr.includes('autocannon')).length === 1;
    // Restore leftTorso's original occupant (autocannon's move displaced it) so the rest of the
    // smoke run still sees the default, complete build.
    if (leftTorsoWas && !mech.mounts.leftTorso.includes(leftTorsoWas)) mech.mount('leftTorso', leftTorsoWas);

    return {
      chassis: mech.chassisId,
      weaponMount,
      headRejectsWeapon,
      dollBuilt,
      buildValid: mech.validate().ok,
      deployable: mech.isComplete(),
      lockedRejectsMount,
      purchased,
      noReorderOnUnlock,
      reordersOnNextRebuild,
      unlockedMounts,
      moveMouseNewSlot,
      moveMouseOldSlotEmptied,
      moveQuickNewSlot,
      moveQuickOldSlotEmptied,
      onlyOneSlotHoldsIt,
    };
  }, RUN_CURRENCY_KEY);
  await page.screenshot({ path: '/tmp/mech-garage.png' });

  // Deploy → arena.
  await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
  await page.waitForFunction(() => {
    const g = window.__game;
    return g.scene.isActive('ArenaScene') && g.scene.isActive('HudScene') && g.registry.get('dummyMech');
  }, { timeout: 20000 });

  const arena = await page.evaluate(({ dummyPx, homingWeapon }) => {
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

    // #77 / #77-followup: a homing missile CONNECTS with a MOVING target AND keeps tracking it
    // live rather than steering at where it was when fired. Fire through the REAL lock system —
    // a full (red), non-blind lock on e0, exactly what `_lockAimPoint()` reads in real play —
    // instead of handing `_spawnProjectile` the live enemy object directly via `seekOverride`;
    // that shortcut would exercise the round's tracking machinery but never the lock→seekTarget
    // wiring where the actual bug lived (`_lockAimPoint()` was returning a frozen `{x,y}` snapshot
    // taken at spawn instead of the live enemy handle, so every homing round flew at the target's
    // launch-instant position and increasingly missed a moving target — no amount of good turn-rate/
    // intercept math could compensate for steering at a stale point). With the derived turn rate +
    // intercept lead + swept hit detection + live-tracked lock aimpoint, the round must curve onto
    // the target's CURRENT position each frame and land damage. arc/maxDist are overridden to
    // isolate the SEEKER from the lob-apex distance gate (feel of the arc is playtest).
    let homingHit = false;
    {
      const hp0 = totalHp();
      const bearing = Math.atan2(e0.y - a.py, e0.x - a.px);
      const px = e0.x, py = e0.y;                 // remember to restore for later tests
      e0.vx = Math.cos(bearing + Math.PI / 2) * 70;   // strafe across the missile's path
      e0.vy = Math.sin(bearing + Math.PI / 2) * 70;
      a.projectiles.length = 0;
      a.lock.enemy = e0; a.lock.progress = 1; a.lock.maintain = 3; a.lock.blind = false;
      const m = a._spawnProjectile({ weapon: homingWeapon }, a.px, a.py, bearing, 'player');
      m.arc = false; m.maxDist = 6000;
      // seekTarget must be the LIVE enemy handle (carries `.mech`), never a detached {x,y} copy —
      // this is the exact shape distinction _updateProjectiles uses to decide "keep following it"
      // vs. "steer at this fixed point," so asserting it here guards the fix directly.
      const seekIsLiveHandle = m.seekTarget === e0 && !!m.seekTarget.mech;
      for (let i = 0; i < 240 && a.projectiles.length; i++) {
        e0.x += e0.vx * 0.016; e0.y += e0.vy * 0.016;
        a._updateProjectiles(0.016);
      }
      homingHit = seekIsLiveHandle && totalHp() < hp0;
      a._dropLock();
      e0.x = px; e0.y = py; e0.vx = 0; e0.vy = 0;      // restore the dummy for the tests below
      a.projectiles.length = 0;
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

    // #87 (corrected per playtest 2026-07-10): a kill must tear its corpse down and prune it
    // out of `this.enemies` the SAME tick — no lingering delayed removal — and its death
    // explosion must be sized to the enemy (drone small, heavy mech noticeably bigger).
    // Intercept `_acquireImpactCircle` (the pooled burst-circle primitive `_deathFx` draws
    // through) to record the radii requested, kill a lightweight drone then a heavy mech
    // (chassisId 'heavy' — see data/enemies.js `sniper`), and compare.
    const deathFx = { droneRemovedSameTick: false, droneMaxR: 0, heavyMaxR: 0 };
    {
      const origAcquire = a._acquireImpactCircle.bind(a);
      let recorded = [];
      a._acquireImpactCircle = (x, y, r, col, alpha, stroke) => {
        recorded.push(r);
        return origAcquire(x, y, r, col, alpha, stroke);
      };

      const drone = a._spawnKind(-500, -500, 'drone');
      const beforeLen = a.enemies.length;
      recorded = [];
      a._damageEnemyAt(drone, drone.x, drone.y, 99999, 0xffffff);
      deathFx.droneRemovedSameTick =
        a.enemies.length === beforeLen - 1 && a.enemies.indexOf(drone) === -1 && drone._tornDown === true;
      deathFx.droneMaxR = recorded.length ? Math.max(...recorded) : 0;

      const heavy = a._spawnEnemy(-500, -520, 'sniper');
      recorded = [];
      a._damageEnemyAt(heavy, heavy.x, heavy.y, 99999, 0xffffff);
      deathFx.heavyMaxR = recorded.length ? Math.max(...recorded) : 0;

      a._acquireImpactCircle = origAcquire;
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
    // #81 (organic growth rewrite): snapshot the terrain + the player's exact position BEFORE
    // the stage advance so we can prove (a) the new growth lobe actually added SOME fresh
    // terrain, (b) everywhere already explored — specifically far BEHIND the player, opposite
    // the chosen growth direction — stayed byte-identical (the "doesn't pop in around you"
    // fix), (c) the TOTAL explored hex count is strictly LARGER afterward (the core "map gets
    // bigger" proof this pass replaces the old fixed-footprint reshuffle with), and (d) the
    // player was never teleported (px/py untouched — they keep driving from wherever they
    // finished).
    const terrainBefore = [...a.terrain.entries()];
    const hexCountBeforeAdvance = a.terrain.size;
    const pxBefore = a.px, pyBefore = a.py;
    a._advanceRun();
    const stageAdvanced = a.run?.stageIndex === 1 && a.run?.status === 'active';
    // _advanceRun scheduled _startNextStage on a timer; fire it immediately so the smoke test
    // doesn't need to sleep, then confirm a fresh (bigger) squad + a fresh active mission exist.
    a._startNextStage();
    const newStageHasMission = a.mission?.status === 'active';
    const newStageHasSquad = a.enemies.length > 0;
    // #81 (organic growth rewrite): this is additive growth, so — unlike the old reshuffle —
    // every hex that existed BEFORE the advance must come back byte-identical (a), while the
    // TOTAL hex count strictly increases because a whole new lobe of hexes that didn't exist
    // before got added on top (b, the core "map gets bigger" proof). (c) a spot directly
    // BEHIND the chosen growth direction stays completely unchanged (nothing pops in
    // around/behind the player), and (d) the player's position stays untouched (no teleport)
    // on terrain that isn't impassable (the safe-clear zone follows them).
    const terrainAfter = new Map(a.terrain);
    let terrainDiffs = 0;
    for (const [k, id] of terrainBefore) if (terrainAfter.get(k) !== id) terrainDiffs++;
    const oldTerrainPreserved = terrainDiffs === 0;
    const hexCountAfterAdvance = a.terrain.size;
    const mapGrewLarger = hexCountAfterAdvance > hexCountBeforeAdvance;
    // A hex straight behind the growth direction, well past a buffer, must be untouched.
    // Pixel → axial hex, inlined (mirrors data/hexgrid.js pixelToHex/cubeRound exactly) — the
    // Node-side import isn't reachable from this page-context callback.
    const behindAngle = a._lastGrowthAngle + Math.PI;
    const SIZE = 48, RT3 = Math.sqrt(3);
    const behindX = pxBefore + Math.cos(behindAngle) * 8 * SIZE;
    const behindY = pyBefore + Math.sin(behindAngle) * 8 * SIZE;
    const qf = (RT3 / 3 * behindX - 1 / 3 * behindY) / SIZE;
    const rf = (2 / 3 * behindY) / SIZE;
    const xf = qf, zf = rf, yf = -qf - rf;
    let bx = Math.round(xf), by = Math.round(yf), bz = Math.round(zf);
    const bdx = Math.abs(bx - xf), bdy = Math.abs(by - yf), bdz = Math.abs(bz - zf);
    if (bdx > bdy && bdx > bdz) bx = -by - bz; else if (bdy > bdz) by = -bx - bz; else bz = -bx - by;
    const behindKey = `${bx},${bz}`;
    const beforeMap = new Map(terrainBefore);
    const behindHexUnchanged = !beforeMap.has(behindKey) || a.terrain.get(behindKey) === beforeMap.get(behindKey);
    const playerPositionUnchanged = a.px === pxBefore && a.py === pyBefore;
    const playerNotStranded = !a._blocked(a.px, a.py) && !a._isWall(a.px, a.py);

    // #72: soft cover — own-hex transparency + destructible/burnable trees, end to end.
    // Plant the biome's soft-cover terrain (forest/scrub/…) on known-clear ground near the
    // origin, stand a fresh enemy INSIDE it, and prove a real travelling round fired from open
    // ground hits the occupant instead of detonating at the hex edge (the old un-hittable bug).
    const s72 = {};
    {
      const SIZE = 48, RT3 = Math.sqrt(3);
      const hexPx = (q, r) => ({ x: SIZE * RT3 * (q + r / 2), y: SIZE * 1.5 * r });
      const coverId = a.biome.cover;
      const FK = '0,2', FP = hexPx(0, 2);      // world centre is cleared ground (radius 3)
      a.terrain.set(FK, coverId);
      a.coverHp.set(FK, 40);
      const texBefore = a.tileImages.get(FK).texture.key;
      const fe = a._spawnMech(FP.x, FP.y, 'raider');
      fe.x = FP.x; fe.y = FP.y; fe.vx = fe.vy = 0;
      a.px = 0; a.py = 0; a.vx = a.vy = 0;
      a.turretAngle = Math.atan2(FP.y, FP.x); a.aimX = FP.x; a.aimY = FP.y;
      const shoot = () => {
        a.projectiles.length = 0;
        a.fireWeapon(slug);
        for (let i = 0; i < 120 && a.projectiles.length; i++) a._updateProjectiles(0.016);
      };
      // (a) A unit standing IN soft cover is hittable from outside.
      const feHp0 = sumHp(fe.mech);
      shoot();
      s72.occupantHit = sumHp(fe.mech) < feHp0;
      // (b) Firing OUT of soft cover: stand the PLAYER inside a second planted cover hex and
      // fire at the same enemy — the round must not self-detonate on the muzzle's own hex.
      const PK = '0,-2', PP = hexPx(0, -2);
      a.terrain.set(PK, coverId);
      a.coverHp.set(PK, 40);
      a.px = PP.x; a.py = PP.y;
      a.turretAngle = Math.atan2(FP.y - PP.y, FP.x - PP.x); a.aimX = FP.x; a.aimY = FP.y;
      const feHp1 = sumHp(fe.mech);
      shoot();
      s72.firedOutOfCover = sumHp(fe.mech) < feHp1;
      // (c) The reverse direction: an ENEMY round fired at the player hiding in soft cover
      // must also reach its occupant.
      const pHp0 = sumHp(a.mech);
      a.projectiles.length = 0;
      a._spawnProjectile(slug, FP.x, FP.y, Math.atan2(PP.y - FP.y, PP.x - FP.x), 'enemy');
      for (let i = 0; i < 120 && a.projectiles.length; i++) a._updateProjectiles(0.016);
      s72.enemyHitPlayerInCover = sumHp(a.mech) < pHp0;
      // (d) Gunfire CHIPS an unoccupied soft-cover hex: kill the occupant, step the player
      // back to open ground, and fire into the forest hex — the round detonates on it now
      // (no occupant exemption) and bites its HP.
      fe.mech.applyDamage('centerTorso', 9999);
      a.px = 0; a.py = 0;
      a.turretAngle = Math.atan2(FP.y, FP.x); a.aimX = FP.x; a.aimY = FP.y;
      const cHp0 = a.coverHp.get(FK);
      shoot();
      s72.gunfireChips = (a.coverHp.get(FK) ?? 0) < cHp0;
      // (e) Burning ground cooks soft cover FAST: a napalm-sized patch on the hex burns the
      // rest of its HP off in a couple of ticks, flattening it to passable, no-cover ground
      // with a visibly swapped tile texture.
      a.firePatches.push({ x: FP.x, y: FP.y, r: 46, dps: 8, until: a.time.now + 60000, nextTick: 0 });
      for (let i = 0; i < 4 && a.coverHp.has(FK); i++) a._updateFirePatches();
      s72.fireFlattens = !a.coverHp.has(FK) && a.terrain.get(FK) !== coverId
        && !a._isWall(FP.x, FP.y) && !a._blocked(FP.x, FP.y)
        && a.tileImages.get(FK).texture.key !== texBefore;
      a.firePatches.length = 0;   // done burning; keep later full-update() frames deterministic
    }

    // Captured BEFORE the run-loop death test below deliberately destroys the player mech —
    // otherwise this would read 0 post-mortem instead of reflecting the earlier healthy state.
    const onlineWeapons = a.mech.onlineWeapons().length;

    // #88: a kill that drops BOTH a powerup and salvage must not stack them on the same pixel.
    // spawnPowerup has no drop-chance gate (that lives in _maybeDropPowerup) so it always
    // drops on call; _maybeDropSalvage does roll SALVAGE_DROP_CHANCE (0.35) so retry with real
    // randomness until it actually drops (near-certain within a handful of tries). Both draw
    // from the SAME exact origin — the #88 scatter (composed with the #73 reachable-ground
    // snap) must still separate them.
    a.powerups.length = 0;
    a.salvage.length = 0;
    const dropOriginX = a.px, dropOriginY = a.py;
    a.spawnPowerup(dropOriginX, dropOriginY);
    for (let i = 0; i < 200 && a.salvage.length === 0; i++) a._maybeDropSalvage(dropOriginX, dropOriginY);
    const pu = a.powerups[a.powerups.length - 1];
    const sv = a.salvage[a.salvage.length - 1];
    const dropsDistinct = !!pu && !!sv && (pu.x !== sv.x || pu.y !== sv.y);

    // #90: powerup drop chance now scales with the killed enemy's maxHp (difficulty) instead
    // of a flat roll — sanity-check the LIVE roll path (_maybeDropPowerup) over many trials:
    // a tough kill (base heavy mech, maxHp 616) should drop noticeably MORE often than a
    // trivial one (drone, maxHp 14). Stub spawnPowerup to a counter so this only exercises the
    // roll (no real sprite/art work), keeping a few hundred trials each effectively instant.
    const origSpawnPowerup = a.spawnPowerup.bind(a);
    let spawnCount = 0;
    a.spawnPowerup = () => { spawnCount++; return null; };
    const DROP_TRIALS = 400;
    spawnCount = 0;
    for (let i = 0; i < DROP_TRIALS; i++) a._maybeDropPowerup(0, 0, 14);
    const droneDropRate = spawnCount / DROP_TRIALS;
    spawnCount = 0;
    for (let i = 0; i < DROP_TRIALS; i++) a._maybeDropPowerup(0, 0, 616);
    const heavyDropRate = spawnCount / DROP_TRIALS;
    a.spawnPowerup = origSpawnPowerup;

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
      homingHit,
      collisionHolds,
      partDamaged: anyPartDamaged,
      dummyDead,
      spawnedExtra,
      extraDamaged,
      resetWorked,
      veh,
      deathFx,
      missionStartedActive,
      missionCompleted,
      runStartedAtStageZero,
      stageAdvanced,
      newStageHasMission,
      newStageHasSquad,
      oldTerrainPreserved,
      mapGrewLarger,
      behindHexUnchanged,
      playerPositionUnchanged,
      playerNotStranded,
      runEndedOnDeath,
      currencyBankedOnDeath,
      salvagePickedUp,
      dropsDistinct,
      droneDropRate,
      heavyDropRate,
      s72,
    };
  }, { dummyPx: DUMMY_PX, homingWeapon: WEAPONS.streakPod });
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
  // #78 follow-up: the lock-overlay repaint on purchase must not yank the card out from under
  // the player; the re-sort only happens on the next natural rebuild (setIds).
  if (!garage.noReorderOnUnlock) fail('#78 the catalog reordered the instant a purchase unlocked an item');
  if (!garage.reordersOnNextRebuild) fail('#78 the catalog never re-sorted a newly-unlocked item on the next rebuild');
  // #84: mounting an already-mounted weapon into a new slot MOVES it (old slot emptied), for
  // both the mouse click-to-mount flow and the pad quick-mount flow — never duplicated.
  if (!garage.moveMouseNewSlot) fail('#84 mouse-mounting an already-mounted weapon into a new slot did not move it there');
  if (!garage.moveMouseOldSlotEmptied) fail('#84 mouse-moving a weapon left it duplicated in its old slot');
  if (!garage.moveQuickNewSlot) fail('#84 pad quick-mount of an already-mounted weapon into a new slot did not move it there');
  if (!garage.moveQuickOldSlotEmptied) fail('#84 pad quick-mount move left the weapon duplicated in its old slot');
  if (!garage.onlyOneSlotHoldsIt) fail('#84 the same weapon id ended up mounted in more than one slot at once');
  if (!arena.hullTex || !arena.dummyTex) fail('arena mech textures missing');
  if (arena.onlineWeapons < 1) fail('player mech has no online weapons in the arena');
  if (!arena.projHit) fail('a travelling projectile did not cross the gap and damage the dummy');
  if (!arena.homingHit) fail('#77 a homing missile did not track and hit a moving target');
  if (!arena.collisionHolds) fail('the mech drove through a wall or off the arena disc');
  if (!arena.droveForward) fail('tank locomotion did not move the mech forward');
  if (!arena.partDamaged) fail('firing at the dummy did not apply per-part damage');
  if (!arena.spawnedExtra) fail('#39 spawn-enemy did not add a second enemy');
  if (!arena.extraDamaged) fail('#39 the newly spawned enemy could not be damaged');
  if (!arena.resetWorked) fail('#39 reset-enemies did not restore a destroyed enemy');
  if (!arena.dummyDead) fail('dummy did not register destruction on centre-torso kill');
  // #87 (corrected): the corpse must be gone from `this.enemies` (and torn down) the SAME
  // tick the kill lands — no delayed removal — and a heavy mech's death explosion must be
  // measurably bigger than a drone's.
  if (!arena.deathFx.droneRemovedSameTick) fail('#87 a killed enemy was not removed from this.enemies in the same tick');
  if (!(arena.deathFx.heavyMaxR > arena.deathFx.droneMaxR)) {
    fail(`#87 heavy mech death explosion (${arena.deathFx.heavyMaxR}) was not bigger than a drone's (${arena.deathFx.droneMaxR})`);
  }
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
  // #81 (organic growth rewrite): stage advance ADDS a fresh organically-shaped region of
  // terrain beyond the previously-explored edge (not just a new objective in the same
  // footprint, and not a same-size reshuffle), and the player continues from wherever they
  // finished — no teleport, and never stranded on impassable ground once the safe-clear zone
  // follows them to their actual position.
  // The growth must be ADDITIVE, not a whole-map swap — everywhere already explored before the
  // advance must come back byte-identical.
  if (!arena.oldTerrainPreserved) fail('#81 stage advance changed terrain that was already explored — growth must be additive, not a reshuffle');
  if (!arena.behindHexUnchanged) fail('#81 terrain behind the growth direction changed — the map should not pop in around/behind the player');
  // The core "map gets LARGER" proof (2026-07-10 correction): total explored hex count must
  // strictly increase, not just get reshuffled within the same fixed-size footprint.
  if (!arena.mapGrewLarger) fail('#81 stage advance did not increase the total explored hex count — the map must genuinely GROW, not just reshuffle');
  if (!arena.playerPositionUnchanged) fail('#81 stage advance moved the player (should continue from where they finished, no teleport)');
  if (!arena.playerNotStranded) fail('#81 the player ended up on impassable terrain after the map grew');
  if (!arena.runEndedOnDeath) fail('#64 player mech destruction did not end the run');
  if (!arena.currencyBankedOnDeath) fail('#64 run currency was not banked into the persistent registry value on run end');
  // #65: a salvage pickup adds straight into the live run currency total.
  if (!arena.salvagePickedUp) fail('#65 a salvage pickup did not increase the live run currency');
  // #88: a powerup and salvage dropped from the same kill point must scatter apart, not stack.
  if (!arena.dropsDistinct) fail('#88 a powerup and salvage dropped from the same point landed at the same position');
  // #90: powerup drop RATE over many trials must be clearly higher for a tough kill (heavy
  // mech, maxHp 616 → target 0.95) than a trivial one (drone, maxHp 14 → target 0.35).
  if (!(arena.heavyDropRate > arena.droneDropRate + 0.2)) {
    fail(`#90 heavy-mech drop rate (${arena.heavyDropRate}) was not clearly higher than drone drop rate (${arena.droneDropRate})`);
  }
  // #72: soft cover — own-hex transparency (both directions + firing out) and destructible/
  // burnable trees, exercised through the real projectile/fire-patch simulation.
  if (!arena.s72.occupantHit) fail('#72 a shot into the target\'s own soft-cover hex died at the hex edge instead of hitting');
  if (!arena.s72.firedOutOfCover) fail('#72 firing OUT of a soft-cover hex self-detonated at the muzzle');
  if (!arena.s72.enemyHitPlayerInCover) fail('#72 an enemy round could not hit the player standing in soft cover');
  if (!arena.s72.gunfireChips) fail('#72 gunfire detonating on an unoccupied soft-cover hex did not chip its HP');
  if (!arena.s72.fireFlattens) fail('#72 burning ground did not flatten the soft-cover hex to cleared terrain');

  if (!process.exitCode) console.log('SMOKE OK ✔  (screenshots: /tmp/mech-garage.png, /tmp/mech-arena.png)');
} catch (e) {
  fail(e.message + (errors.length ? '\nerrors:\n' + errors.join('\n') : ''));
} finally {
  await browser.close();
}
