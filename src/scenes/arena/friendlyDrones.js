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
import { DEPTH } from './shared.js';
import { nearestInterceptTarget } from '../../data/interceptor.js';

const DRONE_ORBIT_RADIUS = 90;    // px around its owner
const DRONE_ORBIT_RATE = 1.4;     // rad/s — how fast it circles
const DRONE_SPEED = 260;          // px/s — how fast it eases toward its current orbit point
const DRONE_RANGE = 260;          // px — how far it can zap
const DRONE_DAMAGE = 4;
const DRONE_CYCLE = 0.4;          // seconds between zaps

export const FriendlyDronesMixin = {
  _spawnFriendlyDrone(player) {
    this._despawnFriendlyDrone(player);
    const view = this.add.circle(player.x, player.y, 7, player.color ?? 0x5ec8e0)
      .setStrokeStyle(1.5, 0xffffff, 0.85)
      .setDepth(DEPTH.GROUND_UNITS);
    player.friendlyDrone = {
      x: player.x, y: player.y, phase: Math.random() * Math.PI * 2, fireCd: 0, view,
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
      }
      d.view.setPosition(d.x, d.y);

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
