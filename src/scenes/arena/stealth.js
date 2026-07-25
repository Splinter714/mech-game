// Stealth (#500 Cloak, #507 Smoke Screen) — both grant the SAME underlying effect, "suppress
// noise-aggro" (data/awareness.js NOISE_AGGRO_RANGE — the only detection channel independent of
// line-of-sight), just delivered two different ways: Cloak is personal and mobile, Smoke Screen
// is a stationary area any live player can stand in. Neither hides the player from an enemy
// that's already engaged — that would mean reaching into the awareness/targeting state machine
// enemies.js already drives, a much bigger change than either issue asked for. This is "go
// quiet," not true invisibility.
import { DEPTH } from './shared.js';
import { hasActiveEffect } from './abilities.js';

// True if `player`'s position is currently covered by stealth — their own Cloak, or ANY live
// player's Smoke Screen cloud (co-op cover, not scoped to whoever cast it). `firing.js` calls
// this before latching noise-aggro's `_lastFireAt` so a stealthed shot doesn't give the shooter
// away to a dormant enemy nearby.
export function isPlayerStealthed(scene, player) {
  if (hasActiveEffect(player, 'cloak')) return true;
  for (const pl of scene.players ?? []) {
    const cloud = pl.smokeCloud;
    if (cloud && Math.hypot(player.x - cloud.x, player.y - cloud.y) < cloud.radius) return true;
  }
  return false;
}

export const StealthMixin = {
  // #507: a static cloud at the player's CURRENT position when cast — deliberately doesn't
  // follow them (it's cover you drop and leave, not a personal bubble; that's what Cloak is
  // for). Re-casting replaces the caster's own cloud rather than stacking a second one. `radius`
  // comes from the ability registry (data/abilities.js `smokeScreen.radius`) — the caller passes
  // it rather than this module reading the registry itself, same as burstAoeAt's radius/damage.
  _spawnSmokeCloud(player, radius) {
    this._despawnSmokeCloud(player);
    const view = this.add.circle(player.x, player.y, radius, 0xc8d2dd, 0.28)
      .setStrokeStyle(1.5, 0xc8d2dd, 0.4)
      .setDepth(DEPTH.GROUND_FX);
    player.smokeCloud = { x: player.x, y: player.y, radius, view };
  },

  _despawnSmokeCloud(player) {
    player.smokeCloud?.view?.destroy();
    player.smokeCloud = null;
  },
};
