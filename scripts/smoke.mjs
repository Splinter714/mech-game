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
import { WEAPONS, WEAPON_IDS } from '../src/data/weapons.js';
import { INFANTRY_MOB_SIZE } from '../src/data/enemyKinds.js';

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

  const garage = await page.evaluate(({ runCurrencyKey, weaponIds }) => {
    const g = window.__game;
    const sc = g.scene.getScene('GarageScene');
    const RUN_CURRENCY_KEY = runCurrencyKey;
    const mech = g.registry.get('allMechs').mech1;
    // #118: Plasma Lance graduated off the shelved list — confirm it's actually in the
    // garage's player-mountable catalog (not just in WEAPONS data), and that it can be
    // purchased (it's shop-gated like beamLaser/shotgun, not in STARTING_UNLOCKED) and
    // then mounted into a weapon slot.
    const plasmaLanceInCatalog = sc.catalogIds.includes('plasmaLance') && weaponIds.includes('plasmaLance');
    sc._selectSlot('rightArm');
    sc.registry.set(RUN_CURRENCY_KEY, 500);
    sc._pickItem('plasmaLance');   // first click purchases (locked-by-default, like beamLaser)
    sc._pickItem('plasmaLance');   // second click mounts it, now unlocked
    const plasmaLanceMounts = mech.mounts.rightArm.includes('plasmaLance');
    mech.unmount('rightArm', 0);
    mech.mount('rightArm', 'autocannon');   // restore default build before the rest of the run
    sc._selectSlot('rightArm');   // _selectSlot toggles — deselect so state matches a fresh garage load
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
    // #124: dev builds (this smoke server included) start every catalog id pre-unlocked as a
    // playtest convenience — reset 'shotgun' back to locked and force a real resort (setIds,
    // not the in-place refreshLocks) so the #65/#78 block below still exercises the real
    // purchase/lock/re-sort mechanic from a genuinely-locked starting position.
    sc.unlocked.delete('shotgun');
    sc.list.setIds(sc._eligibleIds(sc.selected));
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
      plasmaLanceInCatalog,
      plasmaLanceMounts,
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
  }, { runCurrencyKey: RUN_CURRENCY_KEY, weaponIds: WEAPON_IDS });
  await page.screenshot({ path: '/tmp/mech-garage.png' });

  // Deploy → arena.
  await page.evaluate(() => window.__game.scene.getScene('GarageScene').deploy());
  await page.waitForFunction(() => {
    const g = window.__game;
    return g.scene.isActive('ArenaScene') && g.scene.isActive('HudScene') && g.registry.get('dummyMech');
  }, { timeout: 20000 });

  const arena = await page.evaluate(({ dummyPx, homingWeapon, infantryMobSize, hitscanWeapon }) => {
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

    // #77: "tracking missiles should not fire unless there is a lock" — a homing weapon held
    // with NO active/full lock must not fire at all (no dumbfire fallback): no round spawned,
    // no ammo spent. Fire through the real per-slot `fireWeapon` (the actual trigger→shot path),
    // not `_spawnProjectile` directly, so this exercises the fire gate itself.
    let noLockNoFire = false;
    {
      a._dropLock();
      const mount = a.mech.weapons()[0];
      const fakeSlot = { ...mount, weapon: homingWeapon };
      const ammoBefore = a.mech.ammo[fakeSlot.location][fakeSlot.index];
      a.projectiles.length = 0;
      a.fireWeapon(fakeSlot);
      const noProjectiles = a.projectiles.length === 0;
      const ammoUnchanged = a.mech.ammo[fakeSlot.location][fakeSlot.index] === ammoBefore;
      noLockNoFire = noProjectiles && ammoUnchanged;
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

    // #128: centerTorso is no longer damage-tracked (cosmetic only) — the kill condition is
    // now both side torsos destroyed, so overkill those instead of the old one-hit centerTorso.
    em.applyDamage('leftTorso', 999);
    em.applyDamage('rightTorso', 999);
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
    // em was just killed (both-side-torso overkill above); reset must bring it back to life.
    const resetWorked = !em.isDestroyed();

    // #68: NON-MECH kinds spawn, render (their own vehicle textures), take damage through the
    // SAME body interface (isDestroyed/applyDamage/partHealthFraction), and die — and a FLYER
    // ignores ground cover. Spawn one of each kind at the origin and exercise all of that.
    const veh = { spawned: 0, textured: 0, damaged: 0, killed: 0, flyerIgnoresWall: false };
    for (const kind of ['turret', 'tank', 'drone', 'helicopter', 'infantry', 'quadruped']) {
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
        if (a._isWall(wx, wy)) {
          // #134: snap to the wall HEX'S TRUE CENTER, not the raw radial sample point. The raw
          // sample can land arbitrarily close to a hex edge (e.g. an angle near a multiple of
          // π/2 puts x/y within float epsilon of 0, which is exactly the seam between two hex
          // columns/rows) — close enough that even a flyer's own sub-pixel AI drift during the
          // single `_updateVehicle` tick below (it becomes aware and starts easing toward a
          // strafe waypoint; accel-limited, but still nonzero) can cross into the NEIGHBOURING
          // hex, which may not be a wall. That made `_isWall` disagree between placement and the
          // post-tick check ~1/15 runs despite the flyer correctly ignoring collision the whole
          // time. The hex's true center sits a half-hex-width (tens of px) from every edge, so
          // one tick's worth of drift can never cross out of it.
          const SIZE = 48, RT3 = Math.sqrt(3);
          const [wq, wr] = a._hexKeyAt(wx, wy).split(',').map(Number);
          wallPt = { x: SIZE * RT3 * (wq + wr / 2), y: SIZE * (3 / 2) * wr };
          break;
        }
      }
    }
    if (wallPt) {
      heli.x = wallPt.x; heli.y = wallPt.y;   // sit it ON the wall hex (its true center)
      // A flyer sitting on a wall is fine (it's above it); a ground unit would never be placed
      // there by its own movement. Assert the flyer flag + that it isn't force-ejected.
      a._updateVehicle(heli, 0.016, 16);
      veh.flyerIgnoresWall = heli.flying === true && a._isWall(heli.x, heli.y);
    } else {
      veh.flyerIgnoresWall = heli.flying === true;   // no wall handy; flag still records it flies
    }
    // #127 flake fix: this `heli` is scratch-only for the check above — whether or not a wall
    // was found (and it often isn't; the search radius is small and depends on the map's random
    // feature layout), it's left behind at whatever point it last sat, which is `(0,0)` — THE
    // ORIGIN — in the common no-wall-found case. Every later test in this file that fires FROM
    // the origin (e.g. #72's soft-cover tests below) resolves its target via `_nearestEnemy`,
    // which picks whichever living enemy is nearest the ROUND's current position each frame —
    // so a stray helicopter sitting exactly at the muzzle intercepts the shot before it ever
    // reaches the test's real, deliberately-placed target, making the round appear to miss for
    // no visible reason. This was a LATENT test-isolation bug (confirmed reproducible on the
    // commit before #127 too, at a similar ~15% rate — the map-shape change didn't introduce it,
    // it just got caught by more repeated smoke runs during #127 verification). Clean it up now
    // that this check is done, same as `enemyDelivery`'s `sniper` a bit further down already does.
    a._removeEnemy(heli);

    // #97: 'infantryMob' expands into a LARGE volume of infantry troopers (bigger than the drone
    // swarm) — confirm the whole mob spawns, renders, takes damage, and dies through the normal
    // death path (same body interface + removal as every other kind).
    const infMob = (() => {
      const before = a.enemies.length;
      const last = a._spawnEnemy(600, 600, 'infantryMob');
      const spawnedCount = a.enemies.length - before;
      const matchesMobSize = spawnedCount === infantryMobSize;
      const textured = g.textures.exists(last.key + '_hull') && g.textures.exists(last.key + '_turret');
      const one = a.enemies[a.enemies.length - 5];   // an arbitrary trooper from the mob, not just the last
      const hpBefore = one.mech.partHealthFraction(one.mech.locations()[0]);
      a._damageEnemyAt(one, one.x, one.y, 2, 0xffffff);
      const damaged = one.mech.partHealthFraction(one.mech.locations()[0]) < hpBefore;
      const beforeLen = a.enemies.length;
      a._damageEnemyAt(one, one.x, one.y, 9999, 0xffffff);
      const diedAndRemoved = a.enemies.length === beforeLen - 1 && a.enemies.indexOf(one) === -1;
      return { spawnedCount, matchesMobSize, textured, damaged, diedAndRemoved };
    })();

    // #130: the Broodwalker (quadruped) — a slow tanky ground unit that fires its turret AND
    // periodically deploys a drone/infantry trooper near itself while alive+aware. Park the
    // player within its fireRange/detect range, force it AWARE (mirrors the #103 awareness test's
    // direct-flag approach — this isolates the deploy/fire mechanic from the detection timing
    // already covered by that test), and drive real `_updateVehicle` ticks covering several of
    // its (deliberately short-circuited) deploy cooldowns.
    const quad = (() => {
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
      const q = a._spawnKind(150, 0, 'quadruped');
      q.awareness = 'aware';
      q.deployCd = 50;               // short-circuit the first deploy so this test doesn't need
                                      // thousands of ticks to reach the real ~8s cadence
      const spawnedBefore = a.enemies.length;
      a.projectiles.length = 0;
      let deployedAtLeastOnce = false;
      for (let i = 0; i < 4 && !deployedAtLeastOnce; i++) {
        // Run one deploy-interval's worth of ticks, then re-shortcut the next cooldown so a
        // handful of loop iterations reliably exercises multiple deploys without simulating the
        // full real-world cadence.
        for (let t = 0; t < 40; t++) a._updateVehicle(q, 0.016, 16);
        if (a.enemies.length > spawnedBefore) deployedAtLeastOnce = true;
        else q.deployCd = 50;
      }
      const deployedCount = a.enemies.length - spawnedBefore;
      const deployedUnitsAreDroneOrInfantry = a.enemies.slice(spawnedBefore)
        .every((e) => e.kind === 'drone' || e.kind === 'infantry');
      const firedTurret = a.projectiles.some((p) => p.owner === 'enemy');
      // Cap respected: deployCount tracked on the nest itself never exceeds its def.deployCap.
      const capRespected = q.deployCount <= q.kindDef.deployCap;
      // Kill the nest and confirm its previously-deployed drones/infantry are NOT orphaned:
      // they're independent enemies.js entries with no parent link, so the nest's own death/
      // teardown must remove ONLY the nest, leaving its spawned children alive and untouched.
      const childrenBefore = a.enemies.slice(spawnedBefore).filter((e) => e !== q);
      const beforeLen = a.enemies.length;
      a._damageEnemyAt(q, q.x, q.y, 99999, 0xffffff);
      const nestDiedAndRemoved = a.enemies.length === beforeLen - 1 && !a.enemies.includes(q) && q._tornDown === true;
      const childrenSurvivedNestDeath = childrenBefore.every((e) => a.enemies.includes(e) && !e.mech.isDestroyed());
      for (const e of a.enemies.slice(spawnedBefore)) a._removeEnemy(e);   // cleanup
      a.projectiles.length = 0;
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
      return {
        deployedAtLeastOnce, deployedCount, deployedUnitsAreDroneOrInfantry, firedTurret,
        capRespected, nestDiedAndRemoved, childrenSurvivedNestDeath,
      };
    })();

    // #98: air-enemy shadow base ellipse was bumped from 26x14 to 34x18 (still × kindDef.scale,
    // per #93). Confirm a fresh drone/helicopter's shadow reflects the NEW, bigger base — i.e.
    // it's noticeably larger than what the #93-era 26x14 base would have produced.
    const shadowCheck = (() => {
      const ARENA_MECH_SCALE = 0.34;   // scenes/arena/shared.js — mirrored here, not imported
      const d = a._spawnKind(700, 700, 'drone');
      const h = a._spawnKind(750, 750, 'helicopter');
      const droneVs = ARENA_MECH_SCALE * d.kindDef.scale;
      const heliVs = ARENA_MECH_SCALE * h.kindDef.scale;
      return {
        droneShadowW: d.view.shadow?.width,
        droneOldW: 26 * droneVs,
        droneNewExpectedW: 34 * droneVs,
        heliShadowW: h.view.shadow?.width,
        heliOldW: 26 * heliVs,
        heliNewExpectedW: 34 * heliVs,
      };
    })();

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

      // #128: killing a mech now needs BOTH side torsos destroyed (a single centre-mass hit no
      // longer kills). Pre-destroy rightTorso directly (engine-level, no FX) so the mech is one
      // torso from dead, then land the real _damageEnemyAt hit dead-centre — the nearest-part
      // tie-break always resolves a centre hit to leftTorso (still alive), so this single call
      // both destroys the last torso AND is the call that flips isDestroyed(), landing the death
      // FX exactly where the real game would trigger it.
      const heavy = a._spawnEnemy(-500, -520, 'sniper');
      heavy.mech.applyDamage('rightTorso', 99999);
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
    // #81 follow-up (playtest 2026-07-10 point 4): the FIRST stage's objective must also require
    // real travel — capture its distance from spawn (world origin) BEFORE anything else touches
    // `a.objectiveHex` (the stage-advance below reassigns it). Axial hex distance, inlined (mirrors
    // data/hexgrid.js `distance`) since this callback runs in the page context.
    let firstObjectiveDistFromSpawn = null;
    if (a.objectiveHex) {
      const [foq, for_] = a.objectiveHex.split(',').map(Number);
      firstObjectiveDistFromSpawn = (Math.abs(foq) + Math.abs(for_) + Math.abs(foq + for_)) / 2;
    }
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
    // call the internal advance directly (mirrors how _updateRun would trigger it).
    const runStartedAtStageZero = a.run?.stageIndex === 0 && a.run?.status === 'active';
    const enemyCountBeforeAdvance = a.enemies.length;
    // #111: the whole run's terrain is now built ONCE at deploy — stage advance must NEVER
    // touch it. Snapshot the terrain + the player's exact position BEFORE the stage advance so
    // we can prove (a) the terrain map is BYTE-IDENTICAL afterward (not just "mostly
    // preserved" — the old #81 incremental-growth invariant), and (b) the player was never
    // teleported (px/py untouched — they keep driving from wherever they finished).
    const terrainBefore = new Map(a.terrain);
    const pxBefore = a.px, pyBefore = a.py;
    a._advanceRun();
    const stageAdvanced = a.run?.stageIndex === 1 && a.run?.status === 'active';
    // #111 follow-up (playtest 2026-07-10 point 3, corrected): the new objective/mission still
    // happen SYNCHRONOUSLY inside `_advanceRun` (via `_pickNextStageObjective`) — confirm the
    // new mission is already live BEFORE ever firing the still-deferred squad spawn below,
    // proving the objective pick isn't gated behind the transition delay. Unlike the old #81
    // model, this is now a pure re-pick within the SAME already-built terrain, not a rebuild.
    const newStageHasMission = a.mission?.status === 'active';
    const newObjectiveAssigned = !!a.objectiveHex;
    // Only the squad spawn still waits for the short readability beat (see run.js
    // `_spawnNextStageSquad`) — fire it immediately so the smoke test doesn't need to sleep,
    // then confirm a fresh (bigger) squad exists.
    a._spawnNextStageSquad();
    const newStageHasSquad = a.enemies.length > 0;
    // #105 (playtest 2026-07-10): clearing the objective must NOT wipe enemies still alive from
    // the just-finished stage — e0 was repaired back to full health by `_resetEnemies()` above,
    // so it must still be in `a.enemies`, still alive, its view/textures untouched, after the
    // stage advance, with the new squad ADDED on top of it rather than replacing it.
    const survivorCarriedOver =
      a.enemies.includes(e0) && !e0.mech.isDestroyed() &&
      e0.view.active && g.textures.exists(e0.key + '_turret');
    const squadAddedOnTopOfSurvivors = a.enemies.length > enemyCountBeforeAdvance;
    // #111: terrain is now STATIC after the initial build — stage advance changes only the
    // objective/mission and the enemy squad, never a single terrain hex. This replaces the old
    // #81 "additive growth" invariants (mapGrewLarger/behindHexUnchanged) with the simpler,
    // stronger claim the new architecture actually guarantees.
    const terrainAfter = a.terrain;
    let terrainDiffs = 0;
    if (terrainAfter.size !== terrainBefore.size) terrainDiffs = Infinity;
    else for (const [k, id] of terrainBefore) if (terrainAfter.get(k) !== id) terrainDiffs++;
    const terrainUnchangedByStageAdvance = terrainDiffs === 0;
    const playerPositionUnchanged = a.px === pxBefore && a.py === pyBefore;
    const playerNotStranded = !a._blocked(a.px, a.py) && !a._isWall(a.px, a.py);

    // #110: the biome's reserved "deep" terrain must appear as the boundary ring around the
    // OUTER edge of the whole pre-built area — never as an in-map feature near the player's
    // starting area. `a._boundaryRing` (set by `_buildWorld`) is the exact Set of hex keys the
    // boundary was stamped onto; confirm at least one exists, that it really does carry the
    // biome's `deep` id, and that `deep` is ABSENT from a generous radius around spawn.
    const boundary = {};
    {
      const ringKeys = [...(a._boundaryRing ?? [])];
      boundary.ringExists = ringKeys.length > 0;
      boundary.ringUsesDeepId = ringKeys.length > 0 && ringKeys.every((k) => a.terrain.get(k) === a.biome.deep);
      boundary.deepAbsentNearSpawn = true;
      const SIZE = 48, RT3 = Math.sqrt(3);
      for (let q = -20; q <= 20 && boundary.deepAbsentNearSpawn; q++) {
        for (let r = -20; r <= 20; r++) {
          if (Math.abs(q) + Math.abs(r) + Math.abs(q + r) > 40) continue;
          const k = `${q},${r}`;
          if (a.terrain.get(k) === a.biome.deep) { boundary.deepAbsentNearSpawn = false; break; }
        }
      }
      // A ground-blocking spot check: `_blocked` must read the boundary ring as impassable for
      // ground units, exactly like any other impassable terrain.
      if (ringKeys.length) {
        const [rq, rr] = ringKeys[0].split(',').map(Number);
        const bx = SIZE * RT3 * (rq + rr / 2), by = SIZE * (3 / 2) * rr;
        boundary.groundBlockedAtRing = a._blocked(bx, by);
      } else boundary.groundBlockedAtRing = false;
    }

    // Flying enemies must ignore the boundary the same way they ignore every other terrain
    // (the coordinator's follow-up: "as we change from black off-map to stuff like deep
    // water... we should still allow flying enemies to go out there"). `_updateVehicle`
    // (scenes/arena/enemies.js) only gates GROUND units on `_blocked` (`if (!e.flying &&
    // this._blocked(nx, ny))`) — a `flying: true` kind (helicopter/drone) skips that gate
    // entirely. Mirrors the existing #68 `flyerIgnoresWall` check (which pins a helicopter
    // directly onto a wall hex and confirms it isn't force-ejected) but against the NEW
    // boundary terrain specifically, re-pinning position each frame the same way the #92
    // flyerDoesNotBlock check does, so real AI-driven drift can't make this nondeterministic.
    const flyOverBoundary = { tested: false, groundBlockedThere: false, flyerCrossedThere: false };
    if (a._boundaryRing && a._boundaryRing.size) {
      const SIZE = 48, RT3 = Math.sqrt(3);
      const [rq, rr] = [...a._boundaryRing][0].split(',').map(Number);
      const bx = SIZE * RT3 * (rq + rr / 2), by = SIZE * (3 / 2) * rr;
      flyOverBoundary.tested = true;
      flyOverBoundary.groundBlockedThere = a._blocked(bx, by);
      const flyer = a._spawnKind(bx, by, 'helicopter');
      for (let i = 0; i < 20; i++) { a._updateVehicle(flyer, 0.016, 16); flyer.x = bx; flyer.y = by; flyer.vx = 0; flyer.vy = 0; }
      // Still sitting exactly on the (ground-impassable) boundary spot after repeated updates —
      // a ground unit would never be placed/kept there by its own movement (see `groundBlocks`/
      // `groundBlockedAtRing` above); a flyer is fine sitting right on it because it's above it.
      flyOverBoundary.flyerCrossedThere = flyer.flying === true && flyer.x === bx && flyer.y === by;
      a._removeEnemy(flyer);
    }

    // #102: off-screen spawn points are biased toward the OBJECTIVE's direction rather than
    // scattered uniformly around the player. Sample the real picker many times (against the
    // freshly-advanced stage's live objective) and confirm the large majority land within the
    // tuned bias arc of the player→objective bearing (a little slack over the raw arc: the
    // blocked-terrain nudge scales a candidate toward world origin, not the player, which can
    // drift the bearing slightly on a real generated map).
    const spawnBias = { total: 0, withinSpread: 0, objAngle: null, hasObjective: !!a.objectiveHex };
    if (a.objectiveHex) {
      const objAngle = a._objectiveAngle();
      spawnBias.objAngle = objAngle;
      const SPREAD = Math.PI / 2.4;   // mirrors data/spawnBias.js SPAWN_BIAS_SPREAD
      const wrapDiff = (x) => { const d = Math.abs(x) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; };
      for (let i = 0; i < 40; i++) {
        const p = a._offscreenSpawnPoint();
        const ang = Math.atan2(p.y - a.py, p.x - a.px);
        spawnBias.total++;
        if (wrapDiff(ang - objAngle) <= SPREAD + 0.35) spawnBias.withinSpread++;
      }
    }

    // #103: an enemy far from the player starts UNAWARE — it idles near its own spawn point
    // (no beelining) and never fires — until the player comes within detection range, at which
    // point it flips to AWARE (permanently) and engages normally.
    const awareness = {};
    {
      a._lastFireAt = null;   // clear any earlier player-fire noise so it can't leak in here
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
      const far = a._spawnMech(2000, 0, 'raider');   // ~2000px — well beyond any detection range
      awareness.startsUnaware = far.awareness === 'unaware';
      const distBefore = Math.hypot(far.x - a.px, far.y - a.py);
      a.projectiles.length = 0;
      for (let i = 0; i < 120; i++) a._updateEnemy(far, 0.016, 16);   // ~2s of sim time
      const distAfterFar = Math.hypot(far.x - a.px, far.y - a.py);
      awareness.stayedUnawareFarAway = far.awareness === 'unaware';
      // An idle enemy only loiters within a small radius of its spawn; a beelining (aware)
      // enemy at this chassis speed would close well over 150px of a 2s window.
      awareness.didNotBeeline = distAfterFar > distBefore - 150;
      awareness.noFireWhileUnaware = a.projectiles.length === 0;
      // Bring the player within detection range — it must become (and stay) AWARE, and then
      // actually engage (fire) once close enough.
      far.x = 80; far.y = 0;
      a.projectiles.length = 0;
      for (let i = 0; i < 90; i++) a._updateEnemy(far, 0.016, 16);
      awareness.becameAware = far.awareness === 'aware';
      awareness.engagedAfterAware = a.projectiles.some((p) => p.owner === 'enemy');
      a._removeEnemy(far);
      a.projectiles.length = 0;
    }

    // #114/#115 bounds checks below spawn+remove their own throwaway enemies and must not leak
    // any state into the tests that follow (s72/s92/s94 etc. assume specific player position and
    // `a.enemies` contents) — save/restore the player transform and always clean up every enemy
    // spawned here (via the real `_removeEnemy` teardown) before moving on.
    const savedPlayer = { px: a.px, py: a.py, vx: a.vx, vy: a.vy };

    // #114: a turret-cluster spawn must always land all 3 turrets on valid, in-bounds,
    // unoccupied-by-forest/water hexes — never off-map or stacked on impassable terrain. Spawn
    // several clusters at varied raw points (near the origin, on any known wall/water hex from
    // the #68 vehicle-kind check above, and just past the map's edge) and check every turret.
    const turretClusterBounds = (() => {
      let trials = 0, allValid = true, allCentered = true;
      const spawnedNow = [];
      // Just beyond the world's actual generated extent (organic boundary), not an extreme
      // multiple of the MAX_WORLD_RADIUS bounding cap — mirrors how a real raw spawn point can
      // land just past the map edge, not thousands of hexes away.
      let edgeR = 0;
      for (const h of a.terrain.keys()) {
        const [q, r] = h.split(',').map(Number);
        edgeR = Math.max(edgeR, Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)));
      }
      const edgePx = (edgeR + 3) * 48 * Math.sqrt(3);   // a few hexes past the farthest real tile
      const rawPoints = [
        { x: 0, y: 0 },
        ...(wallPt ? [wallPt] : []),
        { x: edgePx, y: 0 },
        { x: 0, y: -edgePx },
      ];
      for (const p of rawPoints) {
        const startLen = a.enemies.length;
        a._spawnTurretCluster(p.x, p.y);
        const cluster = a.enemies.slice(startLen);
        spawnedNow.push(...cluster);
        trials++;
        if (cluster.length !== 3) allValid = false;
        for (const t of cluster) {
          if (a._blocked(t.x, t.y)) allValid = false;
        }
        // Every turret should be within a couple hex-steps of the cluster's own centre (2 rings
        // ≈ up to ~2*83px plus some slack for the hex-centre snap).
        if (cluster.length === 3) {
          const cx = cluster.reduce((s, t) => s + t.x, 0) / cluster.length;
          const cy = cluster.reduce((s, t) => s + t.y, 0) / cluster.length;
          for (const t of cluster) {
            if (Math.hypot(t.x - cx, t.y - cy) > 260) allCentered = false;
          }
        }
      }
      const spawnedTotal = spawnedNow.length;
      for (const t of spawnedNow) a._removeEnemy(t);
      return { trials, allValid, allCentered, spawnedTotal };
    })();

    // #115: infantry (idle-wander AND advance-toward-player) must never end up outside the
    // playable map. Spawn a couple infantry mobs — including one right at the map's actual edge
    // — then run real AI ticks (a mix of UNAWARE idle-wander and AWARE advance/mill) and confirm
    // every trooper stays in-bounds the whole time, not just at spawn.
    const infantryBounds = (() => {
      let edgeR = 0;
      for (const h of a.terrain.keys()) {
        const [q, r] = h.split(',').map(Number);
        edgeR = Math.max(edgeR, Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)));
      }
      const edgePx = (edgeR + 2) * 48 * Math.sqrt(3);
      const rawPoints = [{ x: 0, y: 0 }, { x: edgePx, y: 0 }];
      const mob = [];
      for (const p of rawPoints) {
        const startLen = a.enemies.length;
        a._spawnInfantryMob(p.x, p.y);
        mob.push(...a.enemies.slice(startLen));
      }
      const spawnAllValid = mob.every((t) => !a._blocked(t.x, t.y));
      // Half the mob stays UNAWARE (idle-wander near spawn); the other half goes AWARE and
      // advances toward a nearby player — exercises both movement paths in the same pass, using
      // a scratch player position local to this check (restored below).
      a.px = mob[0].x + 40; a.py = mob[0].y; a.vx = 0; a.vy = 0;
      for (let i = 0; i < mob.length; i++) if (i % 2 === 0) mob[i].awareness = 'aware';
      for (let i = 0; i < 240; i++) for (const t of mob) a._updateVehicle(t, 0.016, 16);
      const movedAllValid = mob.every((t) => !a._blocked(t.x, t.y));
      for (const t of mob) a._removeEnemy(t);
      return { spawnedCount: mob.length, spawnAllValid, movedAllValid };
    })();

    a.px = savedPlayer.px; a.py = savedPlayer.py; a.vx = savedPlayer.vx; a.vy = savedPlayer.vy;

    // #117: enemy MECHS used to unconditionally spawn EVERY weapon as a travelling projectile,
    // ignoring delivery type entirely. The enemy fire loop now runs the same planEmissions
    // decision the player's fireWeapon does, so a hitscan weapon routes to _fireHitscan (a beam)
    // and a contact/melee weapon to _melee, both with owner: 'enemy' so damage lands on the
    // player — only genuinely-projectile weapons still spawn a travelling round.
    // Per Jackson's playtest call (2026-07-10) the pre-#117 accidental "enemy beamLaser fires as
    // a slow plasma bolt" look is being KEPT on purpose, formalized as its own new weapon
    // (plasmaLance, mounted by the sniper/artillery in place of beamLaser) rather than "fixed" to
    // a beam. So this proves two things: (a) the sniper's actual mounted weapon still fires as a
    // travelling projectile (the look is preserved), and (b) the general hitscan/melee dispatch
    // machinery itself works for an enemy-owned shot — exercised directly against a real catalog
    // hitscan weapon (Pulse Laser) and a synthetic contact/melee fixture, since no currently-
    // mounted enemy loadout uses either.
    const enemyDelivery = {};
    {
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
      const sniper = a._spawnMech(100, 0, 'sniper');   // mounts plasmaLance + clusterRocket
      sniper.awareness = 'aware';
      a.projectiles.length = 0; a.beams.length = 0;
      for (let i = 0; i < 200 && a.projectiles.length === 0 && a.beams.length === 0; i++) a._updateEnemy(sniper, 0.016, 16);
      enemyDelivery.plasmaLanceStillFiresAsProjectile =
        a.projectiles.some((p) => p.owner === 'enemy') && a.beams.length === 0;
      a._removeEnemy(sniper);
      a.projectiles.length = 0; a.beams.length = 0;

      // (b) Directly exercise the general enemy-owned hitscan/contact dispatch — a real catalog
      // hitscan weapon (Pulse Laser) and a synthetic contact/melee fixture — since no LIVE enemy
      // loadout currently mounts either. Muzzle placed so the player (at the origin) sits
      // squarely on the firing ray.
      const hpBeforeHitscan = sumHp(a.mech);
      const hitscanSlot = { weapon: hitscanWeapon, location: 'testHitscan', index: 0 };
      a._fireHitscan(hitscanSlot, -40, 0, 0, 'enemy', 'testEnemy');
      enemyDelivery.hitscanFiresBeamNotProjectile = a.beams.length > 0 && a.projectiles.length === 0;
      enemyDelivery.hitscanDamagedPlayer = sumHp(a.mech) < hpBeforeHitscan;
      a.beams.length = 0; a.projectiles.length = 0;

      const hpBeforeMelee = sumHp(a.mech);
      const meleeSlot = {
        weapon: { id: 'testMelee', category: 'ballistic', damage: 12, range: { min: 0, opt: 32, max: 32 } },
        location: 'testMelee', index: 0,
      };
      a._melee(meleeSlot, -20, 0, 0, 'enemy');   // reach 32 > the 20px muzzle-to-player distance
      enemyDelivery.meleeDamagedPlayer = sumHp(a.mech) < hpBeforeMelee;
    }

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
      // (no occupant exemption) and bites its HP. #128: centerTorso is no longer damage-
      // tracked/lethal — kill via both side torsos instead.
      fe.mech.applyDamage('leftTorso', 9999);
      fe.mech.applyDamage('rightTorso', 9999);
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

    // #94: the sentry turret is now an artillery emplacement — an arcing siege shell fired at
    // an INSANE range with no line-of-sight requirement at all (unlike the tank, which still
    // needs a direct-fire lane). Plant a real solid wall hex directly between the player and a
    // turret parked far out (well beyond every weapon's old max range and the old turret's
    // 380 fireRange), drive the real turret AI (_updateVehicle → turretBehavior) + real
    // projectile flight together for several seconds, and confirm the player takes damage
    // anyway despite the wall.
    const s94 = {};
    {
      const turretDist = 1600;             // far beyond autocannon's old 380 fireRange/max range
      const wallDist = turretDist / 2;     // sits squarely on the firing line between them
      const wallKey = a._hexKeyAt(wallDist, 0);
      const coverId = a.biome.cover;
      a.terrain.set(wallKey, coverId);
      a.coverHp.set(wallKey, 999999);      // don't let the shell chip/flatten it mid-test
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
      s94.wallBlocksLos = a._isWall(wallDist, 0);   // sanity: this really is a solid obstruction
      const t94 = a._spawnKind(turretDist, 0, 'turret');
      a.projectiles.length = 0;
      const pHp0 = sumHp(a.mech);
      let everFired = false;
      // Run well past the turret's own fireEveryMs cadence (multiple shots) — its very first
      // shot can land a bit long/short while the turret is still slewing onto an exact bearing
      // (rotateToward converges over a few frames), but a stationary turret vs. a stationary
      // player locks to a dead-on bearing well before the SECOND shot, so a multi-cycle window
      // reliably lands at least one hit if the no-LOS/insane-range fix works at all.
      for (let i = 0; i < 500; i++) {
        a._updateVehicle(t94, 0.016, 16);
        if (a.projectiles.length > 0) everFired = true;
        a._updateProjectiles(0.016);
      }
      s94.turretFiredAtInsaneRange = everFired;
      s94.playerHitThroughWallAtRange = sumHp(a.mech) < pHp0;
      // Cleanup so later terrain-diff / stage-advance assertions aren't thrown off by this hex.
      a.terrain.delete(wallKey);
      a.coverHp.delete(wallKey);
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

    // #90 (updated #106): powerup drop chance scales with the killed enemy's maxHp (difficulty)
    // instead of a flat roll — sanity-check the LIVE roll path (_maybeDropPowerup) over many
    // trials: a tough kill (base heavy mech, maxHp 616) should drop noticeably MORE often than
    // a trivial one (drone, maxHp 14), and #106 lowered the drone-tier floor from ~0.35 to ~0.05
    // (a coin-flip-adjacent floor read as way too generous for trivial kills), so the drone rate
    // itself should now read as rare. Stub spawnPowerup to a counter so this only exercises the
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

    // #92: tank independent turret movement, player-vs-ground-enemy collision, and tank crush.
    // Run LAST — these drive the player around a lot of real update() frames, and the player
    // mech is already dead/run-ended by this point (harmless: `_drive` doesn't gate on mech
    // death), so it can't perturb the mission/run assertions captured above.
    const s92 = {};
    {
      // (b) A ground unit (a stationary turret — won't itself relocate, isolating the collision
      // check from any AI movement) directly ahead of the player blocks it from driving through
      // — position must never pass the blocker's centre, mirroring terrain collision.
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
      const blocker = a._spawnKind(140, 0, 'turret');
      a.controls.keys.D.isDown = true;
      for (let i = 0; i < 200; i++) a.update(0, 16);
      a.controls.keys.D.isDown = false;
      s92.groundBlocks = a.px < blocker.x - 5;
      a._removeEnemy(blocker);

      // (a) Tank hull faces travel, turret tracks the player independently. Placed at its exact
      // standoff range from the player, the tank's only commanded motion (inside the standoff
      // band) is a lateral strafe (perpendicular to the player bearing) — so its hull (which now
      // faces travel, #92) should end up roughly perpendicular to its turret (which keeps
      // tracking the bearing straight at the player via aimAndFire's independent slew).
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
      const tank = a._spawnKind(300, 0, 'tank');
      for (let i = 0; i < 180; i++) a._updateVehicle(tank, 0.016, 16);
      const wrap = (ang) => { let x = ang; while (x > Math.PI) x -= Math.PI * 2; while (x < -Math.PI) x += Math.PI * 2; return x; };
      s92.hullTurretDiverge = Math.abs(wrap(tank.angle - tank.turret)) > 1.0;

      // (c) Contact with a TANK is an INSTANT kill (corrected per playtest 2026-07-10: the
      // original gradual multi-second crush read as "stuck/blocked" rather than "destroying the
      // tank") — pin it directly in the player's path (bypassing its own standoff AI, which would
      // otherwise dodge/retreat and make "drive straight into it" nondeterministic) and drive
      // into it for exactly ONE contact frame; it must die THAT SAME frame through the NORMAL
      // death path (explosion FX, removed from this.enemies / torn down) — not require sustained
      // multi-frame pressing.
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
      const tankX = 80, tankY = 0;
      tank.x = tankX; tank.y = tankY;
      const beforeCount = a.enemies.length;
      a.controls.keys.D.isDown = true;
      // A handful of frames to close the remaining gap and make contact — the tank must be dead
      // by the time this short budget runs out. Deliberately far too small a budget for the OLD
      // gradual crush (160 HP / 55 DPS ≈ 2.9s of sustained full-contact pressing, on top of the
      // travel time to close the gap first) to have finished — so this budget only passes if the
      // kill happens on/near the very first contact frame, not via a multi-second grind.
      for (let i = 0; i < 90 && a.enemies.includes(tank); i++) {
        a.update(0, 16);
        if (a.enemies.includes(tank)) { tank.x = tankX; tank.y = tankY; tank.vx = 0; tank.vy = 0; }
      }
      a.controls.keys.D.isDown = false;
      s92.tankCrushed = !a.enemies.includes(tank) && a.enemies.length === beforeCount - 1 && tank._tornDown === true;

      // (c2) #104: infantry get the SAME instant-crush-on-contact treatment as tanks (playtest:
      // infantry — the weakest unit in the game — "should be stompable"). Pin a trooper directly
      // in the player's path exactly like the tank check above and confirm it dies on contact
      // through the normal death path. Infantry's collision radius is much smaller than a tank's
      // (groundEnemyRadius scales by the kind's own `scale`, and infantry's 0.38 is the smallest
      // in the game), so closing the gap all the way to actual contact takes a few more frames of
      // travel than the tank check above at the same start distance — by this point in the smoke
      // run the player mech has already been force-killed (the run-death test above), degrading
      // its move speed, so the budget here is deliberately generous rather than reusing the
      // tank check's tight 90-frame one (that tightness was specifically about disproving the
      // OLD gradual multi-second crush, which infantry never had).
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
      const trooperX = 80, trooperY = 0;
      const trooper = a._spawnKind(trooperX, trooperY, 'infantry');
      trooper.x = trooperX; trooper.y = trooperY;
      const beforeCountInf = a.enemies.length;
      a.controls.keys.D.isDown = true;
      for (let i = 0; i < 240 && a.enemies.includes(trooper); i++) {
        a.update(0, 16);
        if (a.enemies.includes(trooper)) { trooper.x = trooperX; trooper.y = trooperY; trooper.vx = 0; trooper.vy = 0; }
      }
      a.controls.keys.D.isDown = false;
      s92.infantryCrushed = !a.enemies.includes(trooper) && a.enemies.length === beforeCountInf - 1 && trooper._tornDown === true;
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;

      // (c3) #112 (playtest: "the stomp hitbox needs to be bigger" — the player had to line up
      // almost exactly to trigger a stomp): a trooper pinned OFF the player's straight-line path
      // (20px lateral offset — well outside the OLD tight radius, groundEnemyRadius for infantry
      // ≈9.1px, but inside the new crushTriggerRadius ≈35.1px) must still get crushed as the
      // player drives straight past it, without ever steering to line up dead-center.
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
      const looseX = 80, looseY = 20;
      const looseTrooper = a._spawnKind(looseX, looseY, 'infantry');
      looseTrooper.x = looseX; looseTrooper.y = looseY;
      const beforeCountLoose = a.enemies.length;
      a.controls.keys.D.isDown = true;   // straight drive along x=0..; never steers toward looseY
      for (let i = 0; i < 240 && a.enemies.includes(looseTrooper); i++) {
        a.update(0, 16);
        if (a.enemies.includes(looseTrooper)) {
          looseTrooper.x = looseX; looseTrooper.y = looseY; looseTrooper.vx = 0; looseTrooper.vy = 0;
        }
      }
      a.controls.keys.D.isDown = false;
      s92.looseCrushTrigger = !a.enemies.includes(looseTrooper)
        && a.enemies.length === beforeCountLoose - 1 && looseTrooper._tornDown === true;
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;

      // (d) A FLYING enemy (helicopter) pinned directly in the player's path must NOT block —
      // flyers narratively pass over ground obstacles. Re-pin its position every frame so it
      // stays a fixed obstacle in the path rather than strafing away under its own AI.
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
      const heliX = 140, heliY = 0;
      const heli2 = a._spawnKind(heliX, heliY, 'helicopter');
      a.controls.keys.D.isDown = true;
      for (let i = 0; i < 200; i++) {
        a.update(0, 16);
        heli2.x = heliX; heli2.y = heliY; heli2.vx = 0; heli2.vy = 0;
      }
      a.controls.keys.D.isDown = false;
      s92.flyerDoesNotBlock = a.px > heliX + 5;
      a._removeEnemy(heli2);
      a.px = 0; a.py = 0; a.vx = 0; a.vy = 0;
    }

    // #113: ALL ground units (mech, tank, turret, infantry) must render BELOW the player
    // (DEPTH.GROUND_UNITS < DEPTH.UNITS); flying units (helicopter, drone) stay at the player's
    // own tier. Check one of each real view kind against the live player view's depth.
    const s113 = {};
    {
      // Spawn a FRESH enemy mech directly rather than trusting `a.enemies[0]` — by this point in
      // the run the squad has rotated/advanced stages, so enemies[0] could just as easily be a
      // flying kind (drone/helicopter) depending on the random squad composition, which would
      // correctly share the player's depth and give a false failure here.
      const enemyMech = a._spawnMech(480, 480);
      const tank113 = a._spawnKind(500, 500, 'tank');
      const turret113 = a._spawnKind(520, 520, 'turret');
      const trooper113 = a._spawnKind(540, 540, 'infantry');
      const heli113 = a._spawnKind(560, 560, 'helicopter');
      const drone113 = a._spawnKind(580, 580, 'drone');
      s113.playerAboveMech = enemyMech.view.depth < a.playerView.depth;
      s113.playerAboveTank = tank113.view.depth < a.playerView.depth;
      s113.playerAboveTurret = turret113.view.depth < a.playerView.depth;
      s113.playerAboveInfantry = trooper113.view.depth < a.playerView.depth;
      s113.flyerSharesPlayerDepth = heli113.view.depth === a.playerView.depth
        && drone113.view.depth === a.playerView.depth;
      a._removeEnemy(enemyMech);
      a._removeEnemy(tank113); a._removeEnemy(turret113); a._removeEnemy(trooper113);
      a._removeEnemy(heli113); a._removeEnemy(drone113);
    }

    return {
      droveForward,
      hullTex: g.textures.exists('playerMech_hull_0'),
      dummyTex,
      // #105: the stage advance above must NOT tear down a still-alive survivor's view/textures
      // — it carries over into the new stage instead of being wiped (superseded #71 behavior,
      // which tore down the WHOLE squad here; that corpse-leak concern is now handled the
      // instant a kill registers by #87's synchronous `_removeEnemy`, not at stage-advance time).
      survivorCarriedOver,
      squadAddedOnTopOfSurvivors,
      onlineWeapons,
      projHit,
      homingHit,
      noLockNoFire,
      collisionHolds,
      partDamaged: anyPartDamaged,
      dummyDead,
      spawnedExtra,
      extraDamaged,
      resetWorked,
      veh,
      infMob,
      quad,
      shadowCheck,
      deathFx,
      missionStartedActive,
      missionCompleted,
      firstObjectiveDistFromSpawn,
      runStartedAtStageZero,
      stageAdvanced,
      newObjectiveAssigned,
      newStageHasMission,
      newStageHasSquad,
      terrainUnchangedByStageAdvance,
      playerPositionUnchanged,
      playerNotStranded,
      boundary,
      flyOverBoundary,
      runEndedOnDeath,
      currencyBankedOnDeath,
      salvagePickedUp,
      dropsDistinct,
      droneDropRate,
      heavyDropRate,
      s72,
      s92,
      s94,
      s113,
      spawnBias,
      awareness,
      turretClusterBounds,
      infantryBounds,
      enemyDelivery,
    };
  }, { dummyPx: DUMMY_PX, homingWeapon: WEAPONS.streakPod, infantryMobSize: INFANTRY_MOB_SIZE, hitscanWeapon: WEAPONS.pulseLaser });
  await page.screenshot({ path: '/tmp/mech-arena.png' });

  console.log(JSON.stringify({ garage, arena }, null, 2));

  if (errors.length) fail('runtime errors:\n' + errors.join('\n'));
  if (garage.chassis !== 'medium') fail(`expected medium chassis, got ${garage.chassis}`);
  // #118: Plasma Lance is now player-mountable — must show up in the garage catalog and
  // actually mount into a skill slot, not just exist in the WEAPONS data.
  if (!garage.plasmaLanceInCatalog) fail('#118 Plasma Lance is not in the player-mountable weapon catalog');
  if (!garage.plasmaLanceMounts) fail('#118 Plasma Lance did not mount into a weapon slot from the garage catalog');
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
  if (!arena.noLockNoFire) fail('#77 a homing weapon fired (or spent ammo) with no active lock — should be a no-op');
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
  // #68/#97/#130: the six non-mech kinds (turret/tank/drone/helicopter/infantry/quadruped)
  // spawn, render their own textures, take damage, and die.
  if (arena.veh.spawned !== 6) fail(`#68 expected 6 non-mech kinds spawned, got ${arena.veh.spawned}`);
  if (arena.veh.textured !== 6) fail('#68 a non-mech kind is missing its hull/turret textures');
  if (arena.veh.damaged !== 6) fail('#68 a non-mech kind did not take damage via the body interface');
  if (arena.veh.killed !== 6) fail('#68 a non-mech kind did not register destruction');
  if (!arena.veh.flyerIgnoresWall) fail('#68 a flyer did not ignore ground cover');
  // #97: an 'infantryMob' spawn drops the full large-volume mob, and any one trooper renders,
  // takes damage, and dies through the normal death path (removed + torn down).
  if (!arena.infMob.matchesMobSize) fail(`#97 infantryMob spawned ${arena.infMob.spawnedCount} troopers, expected INFANTRY_MOB_SIZE`);
  if (!arena.infMob.textured) fail('#97 an infantry trooper is missing its hull/turret textures');
  if (!arena.infMob.damaged) fail('#97 an infantry trooper did not take damage via the body interface');
  if (!arena.infMob.diedAndRemoved) fail('#97 an infantry trooper did not die + get removed through the normal death path');
  // #130: the Broodwalker (quadruped) fires its turret, deploys drones/infantry while aware,
  // respects its deploy cap, and dying doesn't orphan/remove its already-deployed units.
  if (!arena.quad.deployedAtLeastOnce) fail('#130 the quadruped never deployed a drone/infantry trooper while alive and aware');
  if (!arena.quad.deployedUnitsAreDroneOrInfantry) fail('#130 the quadruped deployed something other than a drone/infantry trooper');
  if (!arena.quad.firedTurret) fail('#130 the quadruped never fired its turret at the player');
  if (!arena.quad.capRespected) fail(`#130 the quadruped deployed more than its own deployCap (deployed ${arena.quad.deployedCount})`);
  if (!arena.quad.nestDiedAndRemoved) fail('#130 the quadruped did not die + get removed through the normal death path');
  if (!arena.quad.childrenSurvivedNestDeath) fail('#130 the quadruped\'s already-deployed drones/infantry were orphaned/killed when the nest died');
  // #98: the air-enemy shadow base ellipse was bumped from 26x14 to 34x18 (still × kindDef.scale
  // per #93) — a fresh drone/helicopter's shadow width must reflect the bigger base.
  if (!(arena.shadowCheck.droneShadowW > arena.shadowCheck.droneOldW)) {
    fail(`#98 drone shadow width (${arena.shadowCheck.droneShadowW}) is not bigger than the old #93 base (${arena.shadowCheck.droneOldW})`);
  }
  if (!(arena.shadowCheck.heliShadowW > arena.shadowCheck.heliOldW)) {
    fail(`#98 helicopter shadow width (${arena.shadowCheck.heliShadowW}) is not bigger than the old #93 base (${arena.shadowCheck.heliOldW})`);
  }
  // #66: mission starts active on the assault objective, and destroying the objective hex
  // (via the same _damageBuildingAt path weapon fire uses) completes it.
  if (!arena.missionStartedActive) fail('#66 mission did not start active with the assault objective');
  if (!arena.missionCompleted) fail('#66 destroying the objective hex did not complete the mission');
  // #81 follow-up (playtest 2026-07-10 point 4): the very FIRST stage's objective must also
  // require real travel from spawn, same as every later stage-advance objective.
  if (!(arena.firstObjectiveDistFromSpawn >= 6)) {
    fail(`#81 the first stage's objective was only ${arena.firstObjectiveDistFromSpawn} hexes from spawn — it must require real travel`);
  }
  // #64: run loop — a fresh deploy starts at stage 0, mission-complete advances the run to the
  // next stage with a fresh mission + squad in the SAME arena session, and player death ends
  // the run + banks its currency into the persistent registry value the garage reads.
  if (!arena.runStartedAtStageZero) fail('#64 run did not start active at stage 0 on deploy');
  if (!arena.stageAdvanced) fail('#64 mission-complete did not advance the run to the next stage');
  // #111 follow-up (was playtest 2026-07-10 point 3): the new objective/mission must be live
  // immediately on mission-complete, not gated behind the full transition-delay beat — this no
  // longer involves rebuilding terrain (see #111 below), just re-picking within the same map.
  if (!arena.newObjectiveAssigned) fail('#111 stage advance did not assign a new objective');
  if (!arena.newStageHasMission) fail('#64 the next stage did not start with a fresh active mission');
  if (!arena.newStageHasSquad) fail('#64 the next stage did not spawn a fresh squad');
  if (!arena.survivorCarriedOver) fail('#105 stage advance destroyed/removed a still-alive survivor instead of carrying it over');
  if (!arena.squadAddedOnTopOfSurvivors) fail('#105 the new squad did not get added on top of the surviving enemies');
  // #111: the whole run's terrain is built ONCE upfront — stage advance must NEVER touch a
  // single terrain hex (this replaces the old #81 "additive growth" invariants entirely: there
  // is no more growth to prove additive, just a static map that never changes underfoot). The
  // player continues from wherever they finished — no teleport — and is never stranded on
  // impassable ground (irrelevant now that terrain is static, but still asserted for safety).
  if (!arena.terrainUnchangedByStageAdvance) fail('#111 stage advance changed the terrain — the whole run\'s map must be built once upfront and never rebuilt');
  if (!arena.playerPositionUnchanged) fail('#111 stage advance moved the player (should continue from where they finished, no teleport)');
  if (!arena.playerNotStranded) fail('#111 the player ended up on impassable terrain after a stage advance');
  // #110: the biome's reserved "deep" terrain must exist as a boundary ring around the outer
  // edge of the pre-built area, and must NOT appear as an in-map feature near player spawn.
  if (!arena.boundary.ringExists) fail('#110 no boundary ring hexes were found around the pre-built area');
  if (!arena.boundary.ringUsesDeepId) fail('#110 the boundary ring is not stamped with the biome\'s reserved "deep" terrain id');
  if (!arena.boundary.deepAbsentNearSpawn) fail('#110 the biome\'s "deep" terrain appeared as an in-map feature near spawn — it must be boundary-only');
  if (!arena.boundary.groundBlockedAtRing) fail('#110 the boundary ring did not block ground movement like any other impassable terrain');
  // Flying enemies must ignore the new boundary terrain, same as they ignore every other
  // terrain (helicopter/drone narratively fly over ground obstacles) — coordinator follow-up.
  if (arena.flyOverBoundary.tested) {
    if (!arena.flyOverBoundary.groundBlockedThere) fail('#110 test setup: the sampled boundary hex did not actually block ground movement');
    if (!arena.flyOverBoundary.flyerCrossedThere) fail('#110 a flying enemy (helicopter) was blocked by the boundary terrain — flyers must ignore it');
  }
  if (!arena.runEndedOnDeath) fail('#64 player mech destruction did not end the run');
  if (!arena.currencyBankedOnDeath) fail('#64 run currency was not banked into the persistent registry value on run end');
  // #65: a salvage pickup adds straight into the live run currency total.
  if (!arena.salvagePickedUp) fail('#65 a salvage pickup did not increase the live run currency');
  // #88: a powerup and salvage dropped from the same kill point must scatter apart, not stack.
  if (!arena.dropsDistinct) fail('#88 a powerup and salvage dropped from the same point landed at the same position');
  // #90/#106: powerup drop RATE over many trials must be clearly higher for a tough kill (heavy
  // mech, maxHp 616 → target 0.95) than a trivial one (drone, maxHp 14 → target 0.05 as of #106).
  if (!(arena.heavyDropRate > arena.droneDropRate + 0.2)) {
    fail(`#90 heavy-mech drop rate (${arena.heavyDropRate}) was not clearly higher than drone drop rate (${arena.droneDropRate})`);
  }
  // #106: the drone-tier (weakest in-tree enemy) floor came down from ~0.35 to ~0.05 — verify
  // the LIVE roll actually reads as rare now, not just "lower than heavy".
  if (!(arena.droneDropRate < 0.15)) {
    fail(`#106 drone drop rate (${arena.droneDropRate}) should read as rare (<0.15) after the floor was lowered`);
  }
  // #72: soft cover — own-hex transparency (both directions + firing out) and destructible/
  // burnable trees, exercised through the real projectile/fire-patch simulation.
  if (!arena.s72.occupantHit) fail('#72 a shot into the target\'s own soft-cover hex died at the hex edge instead of hitting');
  if (!arena.s72.firedOutOfCover) fail('#72 firing OUT of a soft-cover hex self-detonated at the muzzle');
  if (!arena.s72.enemyHitPlayerInCover) fail('#72 an enemy round could not hit the player standing in soft cover');
  if (!arena.s72.gunfireChips) fail('#72 gunfire detonating on an unoccupied soft-cover hex did not chip its HP');
  if (!arena.s72.fireFlattens) fail('#72 burning ground did not flatten the soft-cover hex to cleared terrain');
  // #92: tank independent turret movement, player-vs-ground-enemy collision, tank crush.
  if (!arena.s92.groundBlocks) fail('#92 a ground enemy unit did not block the player from driving through it');
  if (!arena.s92.hullTurretDiverge) fail("#92 a tank's hull and turret did not diverge — they still look rigidly linked");
  if (!arena.s92.tankCrushed) fail('#92 sustained collision with a tank did not crush/destroy it through the normal death path');
  if (!arena.s92.infantryCrushed) fail('#104 driving into an infantry trooper did not crush/destroy it through the normal death path');
  if (!arena.s92.flyerDoesNotBlock) fail('#92 a flying enemy (helicopter) wrongly blocked the player\'s movement');
  // #112: the crush trigger radius is now looser than plain blocking — an off-path trooper still gets stomped.
  if (!arena.s92.looseCrushTrigger) fail('#112 a trooper 20px off the player\'s straight path was not crushed — the stomp trigger is still too tight');

  // #113: ground units (mech/tank/turret/infantry) render below the player; flyers share its tier.
  if (!arena.s113.playerAboveMech) fail('#113 an enemy mech\'s depth is not below the player\'s');
  if (!arena.s113.playerAboveTank) fail('#113 a tank\'s depth is not below the player\'s');
  if (!arena.s113.playerAboveTurret) fail('#113 a turret\'s depth is not below the player\'s');
  if (!arena.s113.playerAboveInfantry) fail('#113 an infantry trooper\'s depth is not below the player\'s');
  if (!arena.s113.flyerSharesPlayerDepth) fail('#113 a flying unit (helicopter/drone) does not share the player\'s depth tier');

  // #94: turret rework — artillery-style indirect fire, no LOS needed, insane range.
  if (!arena.s94.wallBlocksLos) fail('#94 test setup: the planted wall hex did not actually block LOS');
  if (!arena.s94.turretFiredAtInsaneRange) fail('#94 the turret never fired at long range with a wall between it and the player');
  if (!arena.s94.playerHitThroughWallAtRange) fail('#94 a turret\'s arcing siege shell did not hit the player through a wall at long range');

  // #102: enemy spawn points are biased toward the objective's direction, not scattered
  // uniformly around the player.
  if (!arena.spawnBias.hasObjective) fail('#102 test setup: no live objective to bias spawns toward');
  else if (arena.spawnBias.total === 0 || arena.spawnBias.withinSpread / arena.spawnBias.total < 0.8) {
    fail(`#102 spawn points were not biased toward the objective direction (${arena.spawnBias.withinSpread}/${arena.spawnBias.total} within the bias arc)`);
  }

  // #103: enemy awareness — starts UNAWARE (idles, doesn't beeline or fire) until the player is
  // detected, then flips to AWARE (permanently) and engages.
  if (!arena.awareness.startsUnaware) fail('#103 a freshly spawned enemy was not UNAWARE');
  if (!arena.awareness.stayedUnawareFarAway) fail('#103 an enemy far from the player became AWARE with no detection trigger');
  if (!arena.awareness.didNotBeeline) fail('#103 an UNAWARE enemy beelined toward a distant player instead of idling near its spawn');
  if (!arena.awareness.noFireWhileUnaware) fail('#103 an UNAWARE enemy fired at the player');
  if (!arena.awareness.becameAware) fail('#103 an enemy within detection range never became AWARE');
  if (!arena.awareness.engagedAfterAware) fail('#103 an AWARE enemy in range never engaged (fired at) the player');
  if (!arena.enemyDelivery.plasmaLanceStillFiresAsProjectile) fail('#117 the sniper\'s Plasma Lance did not fire as a travelling projectile (the kept look regressed)');
  if (!arena.enemyDelivery.hitscanFiresBeamNotProjectile) fail('#117 an enemy-owned hitscan shot did not produce a beam (or produced a projectile instead)');
  if (!arena.enemyDelivery.hitscanDamagedPlayer) fail('#117 an enemy-owned hitscan beam did not damage the player');
  if (!arena.enemyDelivery.meleeDamagedPlayer) fail('#117 an enemy-owned melee/contact swing did not damage the player');

  // #114: a turret-cluster spawn must always land all 3 turrets on valid, in-bounds,
  // unoccupied-by-forest/water hexes, centred as one tight nest — across many raw spawn points,
  // including some deliberately off-map or on top of blocked terrain.
  if (arena.turretClusterBounds.spawnedTotal !== arena.turretClusterBounds.trials * 3) {
    fail(`#114 a turret cluster did not spawn exactly 3 turrets every time (got ${arena.turretClusterBounds.spawnedTotal} across ${arena.turretClusterBounds.trials} trials)`);
  }
  if (!arena.turretClusterBounds.allValid) fail('#114 a turret cluster placed a turret on invalid (off-map/blocked) terrain');
  if (!arena.turretClusterBounds.allCentered) fail('#114 a turret cluster\'s turrets were not tightly centred on a single hex');

  // #115: infantry must never end up outside the playable map — neither at spawn (mirrors
  // #114's mob-ring-offset bug) nor after real idle-wander/advance AI movement.
  if (arena.infantryBounds.spawnedCount === 0) fail('#115 test setup: no infantry spawned for the bounds check');
  if (!arena.infantryBounds.spawnAllValid) fail('#115 an infantry mob spawned a trooper on invalid (off-map/blocked) terrain');
  if (!arena.infantryBounds.movedAllValid) fail('#115 infantry ended up off the playable map after idle-wander/advance movement');

  if (!process.exitCode) console.log('SMOKE OK ✔  (screenshots: /tmp/mech-garage.png, /tmp/mech-arena.png)');
} catch (e) {
  fail(e.message + (errors.length ? '\nerrors:\n' + errors.join('\n') : ''));
} finally {
  await browser.close();
}
