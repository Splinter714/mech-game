// Friendly Drone Launcher (#497) — a summoned drone SQUAD, reworked per fresh playtest feedback
// ("should work MUCH more like actual enemy drones; same weapons as enemy drones, maybe a bit
// less squishy, deploy 3-5 at a time, dark metal body, and they shouldn't just orbit me, they
// should move similarly to how the enemy versions do, but they should hang kinda close to player
// except they should attack/focus on the player's target"). Still deliberately NOT a full Mech/
// HpBody — no collision, no damage-intake path (nothing currently targets a player's pet), just
// position + a simple fixed-cadence direct-damage zap per drone — but it now borrows its numbers
// (weapon, range, cadence, movement feel) straight from the enemy Recon Drone's own data
// (data/enemyKinds.js `drone`) instead of ad hoc constants, and its per-frame decisions (spawn
// count, movement, targeting) are pure/unit-tested helpers in data/friendlyDroneAI.js.
//
// Lifecycle rides the SAME abilityState burst window every other ability uses (data/abilities.js
// `droneLauncher`) — `_spawnFriendlyDrone`/`_despawnFriendlyDrone` are called from
// scenes/arena/abilities.js's activate/deactivate edges, so there's no separate lifetime timer
// here at all. One SQUAD per player at a time: summoning again while one is alive is already a
// no-op at the ability layer (canActivate gates on the state still being active), but
// `_spawnFriendlyDrone` also defensively replaces rather than duplicates, matching the #84 "an
// item only ever occupies one slot" convention used elsewhere.
//
// #497 follow-up (owner playtest): the summon originally drew as a plain flat-coloured circle —
// its own distinct "new" design instead of reading as a drone at all. It now reuses the EXACT
// Recon Drone airframe (art/vehicles/drone.js `drawDrone`, the same builder + geometry/scale the
// hostile swarm enemy uses) rendered through a dark, player-owned palette
// (art/vehicles/palette.js `vehicleDarkPalette`) instead of the enemy's pale ceramic one — the
// same "same silhouette, recoloured for ownership" trick mechPrims.js's player/enemy mech themes
// already use, tinted with the owner's own PLAYER_COLORS accent so two players' drones (co-op)
// are told apart the same way their mechs are. Deliberately built by hand here (sprite/container,
// not `EnemiesMixin._makeVehicleView`) so this stays the standalone system the header above
// describes, rather than reaching into hostile-enemy scene wiring for a friendly pet.
import { DEPTH, ARENA_MECH_SCALE } from './shared.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { getWeapon } from '../../data/weapons.js';
import { buildVehicleTextures } from '../../art/index.js';
import { vehicleDarkPalette } from '../../art/vehicles/palette.js';
import { randomDroneCount, stepFriendlyDroneOrbit, pickFriendlyDroneTarget } from '../../data/friendlyDroneAI.js';

// #497 rework: "same weapons as enemy drones" — the friendly drone borrows the enemy Recon
// Drone's own weapon/range/cadence straight from its data entry rather than ad hoc constants, so
// retuning the enemy drone's loadout retunes the friendly one too.
const DRONE_WEAPON = getWeapon(ENEMY_KINDS.drone.weaponId);       // Plasma Lance, same as the enemy
const DRONE_DAMAGE = DRONE_WEAPON.damage;                          // identical per-bolt damage
const DRONE_CYCLE = (ENEMY_KINDS.drone.burstRestMs ?? 400) / 1000; // mirrors the enemy's own burst-rest cadence between bolts
export const DRONE_RANGE = ENEMY_KINDS.drone.fireRange;            // same engagement range as the enemy Recon Drone

// #497 rework ("a bit less squishy"): a real durability stat, where before there was none at all
// (the drone was simply invulnerable — no HpBody, nothing in the game currently fires AT a
// player's pet). Set well above the enemy Recon Drone's own total toughness (5 structure + 5
// shield = 10, enemyKinds.js) so the friendly version reads as tougher than the enemy it borrows
// its loadout from. Tracked on each drone so a future pass can wire real damage-intake onto it
// without another data change; nothing currently decrements it.
export const DRONE_HP = 16;

// #497 rework ("deploy 3-5 at a time"): a squad, not a single pet.
const DRONE_MOVE = ENEMY_KINDS.drone.move;      // same maxSpeed/accel feel as the enemy version
export const DRONE_ORBIT_RADIUS = 90;           // px — how close the squad hangs around its owner
export const DRONE_LEASH_RADIUS = 160;          // px — hard cap; mirrors data/leash.js's own "no rubber-band" rule
const DRONE_SEPARATION_RADIUS = 40;             // px — squadmate spacing so 3-5 drones don't stack
const DRONE_SEPARATION_WEIGHT = 1.5;
const DRONE_JITTER_MIN_MS = 300, DRONE_JITTER_MAX_MS = 700;   // re-pick cadence, matches droneBehavior

const ROTOR_SPIN_RATE = 40;       // rad/s — matches the hostile drone's own rotor-blur spin (enemies.js)
const DEFAULT_ACCENT = 0x5ec8e0;  // fallback owner tint if a test double/older caller has no player.color

// The shared (art, ownerColour) texture key — same "build once, every summon of this colour
// reuses it" convention `vehicleTextureKey` uses for hostile vehicle kinds (enemies.js).
function friendlyDroneTextureKey(accent) {
  return `friendlyDrone_${(accent ?? DEFAULT_ACCENT).toString(16)}`;
}

export const FriendlyDronesMixin = {
  _spawnFriendlyDrone(player) {
    this._despawnFriendlyDrone(player);
    const accent = player.color ?? DEFAULT_ACCENT;
    const key = friendlyDroneTextureKey(accent);
    if (!this.textures.exists(`${key}_turret`)) {
      // Same Recon Drone art builder + geometry the hostile swarm uses (art/vehicles/drone.js),
      // just with `themeColor`/`palette` swapped to the owner's dark player-tinted look.
      buildVehicleTextures(this, key, {
        ...ENEMY_KINDS.drone, themeColor: accent, palette: vehicleDarkPalette(accent),
      });
    }
    const scale = ARENA_MECH_SCALE * (ENEMY_KINDS.drone.scale ?? 1);
    const count = randomDroneCount();
    const drones = [];
    for (let i = 0; i < count; i++) {
      // Scatter the squad's spawn points around the owner instead of stacking them at one point
      // (they'll separate on their own once orbiting, but a fanned-out spawn avoids one frame of
      // total overlap for a 3-5-strong squad).
      const spawnAng = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const sx = player.x + Math.cos(spawnAng) * DRONE_ORBIT_RADIUS * 0.5;
      const sy = player.y + Math.sin(spawnAng) * DRONE_ORBIT_RADIUS * 0.5;
      const shadow = this.add.ellipse(0, 0, 34 * scale, 18 * scale, 0x000000, 0.28);
      const hull = this.add.sprite(0, 0, `${key}_hull`).setScale(scale);
      const turret = this.add.sprite(0, 0, `${key}_turret`).setScale(scale);
      const view = this.add.container(sx, sy, [shadow, hull, turret]);
      view.setDepth(DEPTH.FLYING_UNITS);
      view.hull = hull;
      view.turret = turret;
      drones.push({
        x: sx, y: sy, vx: 0, vy: 0, angle: 0,
        orbitAng: Math.random() * Math.PI * 2, orbitR: DRONE_ORBIT_RADIUS,
        jitterAt: 0, handed: Math.random() < 0.5 ? 1 : -1,
        hp: DRONE_HP, fireCd: 0, rotorSpin: Math.random() * Math.PI * 2, view,
      });
    }
    player.friendlyDrones = drones;
  },

  _despawnFriendlyDrone(player) {
    for (const d of player.friendlyDrones ?? []) d.view?.destroy();
    player.friendlyDrones = null;
  },

  // Called once per frame from ArenaScene.update(), after enemies have moved for the frame.
  _updateFriendlyDrones(dt) {
    for (const player of this.players ?? []) {
      const drones = player.friendlyDrones;
      if (!drones || !drones.length) continue;
      // A drone squad whose owner just died has no ability-state deactivate edge coming (the
      // whole ability system freezes for a dead player, same as Dash/Sprint) — despawn it
      // explicitly rather than leaving it hovering over a corpse.
      if (player.dead) { this._despawnFriendlyDrone(player); continue; }

      const enemies = this.enemies.filter((e) => !e.mech.isDestroyed());
      // #497 rework ("attack/focus on the player's target"): `player.aimEnemy` is the SAME live
      // pick direct-fire convergence/the reticle/the HUD already use (scenes/arena/targeting.js)
      // — null unless it's a currently-live enemy. Re-checked against this frame's own live-enemy
      // list (targeting.js runs earlier in the frame, before enemies/combat update) so a target
      // that died later this same frame isn't chased into nothing.
      const lockedTarget = player.aimEnemy && enemies.includes(player.aimEnemy) ? player.aimEnemy : null;

      for (const d of drones) {
        const siblings = drones.filter((o) => o !== d);
        const stepped = stepFriendlyDroneOrbit(d, player.x, player.y, dt, {
          maxSpeed: DRONE_MOVE.maxSpeed, accel: DRONE_MOVE.accel, orbitRadius: DRONE_ORBIT_RADIUS,
          leashRadius: DRONE_LEASH_RADIUS, separationRadius: DRONE_SEPARATION_RADIUS,
          separationWeight: DRONE_SEPARATION_WEIGHT, jitterMin: DRONE_JITTER_MIN_MS, jitterMax: DRONE_JITTER_MAX_MS,
        }, siblings);
        d.x = stepped.x; d.y = stepped.y; d.vx = stepped.vx; d.vy = stepped.vy;
        d.orbitAng = stepped.orbitAng; d.orbitR = stepped.orbitR; d.jitterAt = stepped.jitterAt;
        d.angle = stepped.angle;
        // Nose the airframe toward its current travel direction (same rotation convention
        // `_makeVehicleView` uses: sprite art points -y at rotation 0, so heading + PI/2 aligns
        // it) rather than leaving it facing a fixed direction while it orbits.
        if (d.view.hull) d.view.hull.rotation = d.angle + Math.PI / 2;
        d.view.setPosition(d.x, d.y);
        d.rotorSpin += dt * ROTOR_SPIN_RATE;
        if (d.view.turret) d.view.turret.rotation = d.rotorSpin;

        d.fireCd = Math.max(0, d.fireCd - dt);
        if (d.fireCd > 0) continue;
        const target = pickFriendlyDroneTarget(d.x, d.y, DRONE_RANGE, enemies, lockedTarget);
        if (!target) continue;
        this._damageEnemyAt(target, target.x, target.y, DRONE_DAMAGE, 0x5ec8e0, false, {});
        d.fireCd = DRONE_CYCLE;
      }
    }
  },
};
