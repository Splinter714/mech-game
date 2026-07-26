// Friendly Drone Launcher (#497) — a lightweight summoned pet. Deliberately NOT a full Mech/
// HpBody: no health pool of its own (a first-draft scope choice — it's a fire-and-forget
// escort, not something the player has to protect), just a position, an owner, and a simple
// fixed-cadence direct-damage zap at the nearest live enemy in range. The only prior precedent
// for a summoned unit in this codebase is the HOSTILE carrier-spawned drone (enemyBehaviors.js/
// enemyKinds.js) — that one rides the full enemy AI/Mech stack, which is far more machinery than
// a temporary player pet needs, so this is a standalone, much simpler system instead of trying
// to reuse it.
//
// Lifecycle rides the SAME abilityState burst window every other ability uses (data/abilities.js
// `droneLauncher`) — `_spawnFriendlyDrone`/`_despawnFriendlyDrone` are called from
// scenes/arena/abilities.js's activate/deactivate edges, so there's no separate lifetime timer
// here at all. One drone per player at a time: summoning again while one is alive is already a
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
import { nearestInterceptTarget } from '../../data/interceptor.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { buildVehicleTextures } from '../../art/index.js';
import { vehicleDarkPalette } from '../../art/vehicles/palette.js';

const DRONE_ORBIT_RADIUS = 90;    // px around its owner
const DRONE_ORBIT_RATE = 1.4;     // rad/s — how fast it circles
const DRONE_SPEED = 260;          // px/s — how fast it eases toward its current orbit point
const DRONE_RANGE = 260;          // px — how far it can zap
const DRONE_DAMAGE = 4;
const DRONE_CYCLE = 0.4;          // seconds between zaps
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
    const shadow = this.add.ellipse(0, 0, 34 * scale, 18 * scale, 0x000000, 0.28);
    const hull = this.add.sprite(0, 0, `${key}_hull`).setScale(scale);
    const turret = this.add.sprite(0, 0, `${key}_turret`).setScale(scale);
    const view = this.add.container(player.x, player.y, [shadow, hull, turret]);
    view.setDepth(DEPTH.FLYING_UNITS);
    view.hull = hull;
    view.turret = turret;
    player.friendlyDrone = {
      x: player.x, y: player.y, phase: Math.random() * Math.PI * 2, fireCd: 0,
      rotorSpin: Math.random() * Math.PI * 2, view,
    };
  },

  _despawnFriendlyDrone(player) {
    player.friendlyDrone?.view?.destroy();
    player.friendlyDrone = null;
  },

  // Called once per frame from ArenaScene.update(), after enemies have moved for the frame.
  _updateFriendlyDrones(dt) {
    for (const player of this.players ?? []) {
      const d = player.friendlyDrone;
      if (!d) continue;
      // A drone whose owner just died has no ability-state deactivate edge coming (the whole
      // ability system freezes for a dead player, same as Dash/Sprint) — despawn it explicitly
      // rather than leaving it orbiting a corpse.
      if (player.dead) { this._despawnFriendlyDrone(player); continue; }

      // Ease toward a point orbiting the owner — never snaps, so it reads as flying rather than
      // teleporting when the owner moves fast.
      const angle = (this.time.now / 1000) * DRONE_ORBIT_RATE + d.phase;
      const tx = player.x + Math.cos(angle) * DRONE_ORBIT_RADIUS;
      const ty = player.y + Math.sin(angle) * DRONE_ORBIT_RADIUS;
      const dx = tx - d.x, dy = ty - d.y, dist = Math.hypot(dx, dy);
      if (dist > 1) {
        const step = Math.min(dist, DRONE_SPEED * dt);
        d.x += (dx / dist) * step;
        d.y += (dy / dist) * step;
        // Nose the airframe toward its current travel direction (same rotation convention
        // `_makeVehicleView` uses: sprite art points -y at rotation 0, so heading + PI/2 aligns
        // it) rather than leaving it facing a fixed direction while it orbits.
        if (d.view.hull) d.view.hull.rotation = Math.atan2(dy, dx) + Math.PI / 2;
      }
      d.view.setPosition(d.x, d.y);
      d.rotorSpin += dt * ROTOR_SPIN_RATE;
      if (d.view.turret) d.view.turret.rotation = d.rotorSpin;

      d.fireCd = Math.max(0, d.fireCd - dt);
      if (d.fireCd > 0) continue;
      const enemies = this.enemies.filter((e) => !e.mech.isDestroyed());
      const target = nearestInterceptTarget(d.x, d.y, DRONE_RANGE, enemies);
      if (!target) continue;
      this._damageEnemyAt(target, target.x, target.y, DRONE_DAMAGE, 0x5ec8e0, false, {});
      d.fireCd = DRONE_CYCLE;
    }
  },
};
