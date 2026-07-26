// Stealth (#500 Cloak, #507 Smoke Screen) — both grant the SAME underlying effect, "suppress
// noise-aggro" (data/awareness.js NOISE_AGGRO_RANGE — the only detection channel independent of
// line-of-sight), delivered two different ways: Cloak is personal and mobile, Smoke Screen is a
// stationary area any live player can stand in. Cloak does NOT hide the player from an enemy
// that's already engaged — reaching into the awareness/targeting state machine enemies.js
// already drives for a purely visual personal effect was ruled out as a much bigger change than
// #500 asked for. This is "go quiet," not true invisibility.
//
// Smoke Screen is the exception (#507 follow-up, owner playtest: "not sure if it blocks LOS
// though... it should truly obscure stuff"): a real deployed obscurant SHOULD stop an
// already-engaged enemy's shot, not just avoid drawing new attention — so unlike Cloak, its
// cloud is wired into the real per-enemy firing-lane raycast (`smokeBlocksPoint` below, consumed
// by world.js's `_wallDistanceLos`), the same one solid walls/hard cover already use. An enemy
// with a stale lock from before the cloud dropped keeps it for up to one LOS refresh window
// (~120ms, `LOS_REFRESH_MS`) — identical latency to ducking behind a wall.
import { DEPTH } from './shared.js';
import { hasActiveEffect } from './abilities.js';

// #507 follow-up (owner playtest: "not sure if it blocks LOS though"). Pure predicate — is
// world point (x, y) inside ANY live player's Smoke Screen cloud? Shared by two very different
// callers: `isPlayerStealthed` below (noise-aggro cover) and world.js's `_wallDistanceLos` (the
// SAME per-enemy firing-lane raycast walls/hard cover already use — see `_smokeBlocksSight`
// below), so a cloud is one geometric fact, not two independent checks that could drift apart.
export function smokeBlocksPoint(players, x, y) {
  for (const pl of players ?? []) {
    const cloud = pl.smokeCloud;
    if (cloud && Math.hypot(x - cloud.x, y - cloud.y) < cloud.radius) return true;
  }
  return false;
}

// True if `player`'s position is currently covered by stealth — their own Cloak, or ANY live
// player's Smoke Screen cloud (co-op cover, not scoped to whoever cast it). `firing.js` calls
// this before latching noise-aggro's `_lastFireAt` so a stealthed shot doesn't give the shooter
// away to a dormant enemy nearby.
export function isPlayerStealthed(scene, player) {
  if (hasActiveEffect(player, 'cloak')) return true;
  return smokeBlocksPoint(scene.players, player.x, player.y);
}

// #507 (owner playtest: "looks horrible... it should be more like it launches puffs of smoke
// truly obscuring stuff"): the old visual was ONE flat translucent circle with a hairline
// stroke — unmistakably a UI radius indicator, not smoke. Now a scatter of several overlapping
// discrete puff circles (denser near the middle, thinning toward the edge — a soft, ragged
// silhouette instead of a hard-edged disc), each gently breathing size/alpha on its own
// staggered loop so the cloud visibly billows rather than sitting there as a static sticker.
// Same "simple procedural shapes, not a baked sprite" language the rest of this game's ambient
// FX uses (ground fire decals, impact bursts) — just built from plain `add.circle`s rather than
// a `gen()` texture bake, since the cloud is a live gameplay volume (its radius/position drive
// the real LOS check above) rather than a fire-and-forget cosmetic.
const SMOKE_PUFF_COUNT = 7;          // enough overlap to read as one billowing mass, not confetti
const SMOKE_PUFF_MIN_FRAC = 0.32;    // smallest puff radius, as a fraction of the cloud's own radius
const SMOKE_PUFF_MAX_FRAC = 0.58;
const SMOKE_SCATTER_FRAC = 0.68;     // puff centres land within this fraction of the cloud radius
const SMOKE_COLOR = 0xc8d2dd;

export const StealthMixin = {
  // #507: a static cloud at the player's CURRENT position when cast — deliberately doesn't
  // follow them (it's cover you drop and leave, not a personal bubble; that's what Cloak is
  // for). Re-casting replaces the caster's own cloud rather than stacking a second one. `radius`
  // comes from the ability registry (data/abilities.js `smokeScreen.radius`) — the caller passes
  // it rather than this module reading the registry itself, same as burstAoeAt's radius/damage.
  _spawnSmokeCloud(player, radius) {
    this._despawnSmokeCloud(player);
    const puffs = [];
    for (let i = 0; i < SMOKE_PUFF_COUNT; i++) {
      // sqrt(random) biases toward the centre (uniform-AREA scatter, not uniform-radius, which
      // would over-cluster near the middle) while still thinning out toward the rim.
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * radius * SMOKE_SCATTER_FRAC;
      const ox = Math.cos(a) * d, oy = Math.sin(a) * d;
      const r = radius * (SMOKE_PUFF_MIN_FRAC + Math.random() * (SMOKE_PUFF_MAX_FRAC - SMOKE_PUFF_MIN_FRAC));
      const circle = this.add.circle(player.x + ox, player.y + oy, r, SMOKE_COLOR, 0.34)
        .setStrokeStyle(1, SMOKE_COLOR, 0.16)
        .setDepth(DEPTH.GROUND_FX);
      puffs.push({ ox, oy, circle });
      // A slow, per-puff-staggered breathing tween — the "billowing" read. Purely cosmetic
      // (never touches ox/oy, which is what the LOS/stand-in-cloud checks care about).
      this.tweens?.add({
        targets: circle, scale: { from: 0.9, to: 1.18 }, alpha: { from: 0.36, to: 0.2 },
        duration: 1300 + Math.random() * 900, delay: Math.random() * 500,
        yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
    }
    player.smokeCloud = { x: player.x, y: player.y, radius, puffs };
  },

  _despawnSmokeCloud(player) {
    for (const p of player.smokeCloud?.puffs ?? []) {
      this.tweens?.killTweensOf?.(p.circle);
      p.circle.destroy();
    }
    player.smokeCloud = null;
  },

  // #507: the actual LOS gate — called from world.js's `_wallDistanceLos` (the same per-enemy
  // firing-lane raycast walls/hard cover already use, via optional chaining so a hand-rolled
  // test double without StealthMixin behaves exactly as it did before this existed). A ray
  // sampled inside any live cloud is blocked, same as it would be by a solid wall.
  _smokeBlocksSight(x, y) {
    return smokeBlocksPoint(this.players, x, y);
  },
};
