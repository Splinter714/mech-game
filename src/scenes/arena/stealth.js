// Stealth (#500 Cloak, #507 Smoke Screen) — both grant the SAME underlying effect, "suppress
// noise-aggro" (data/awareness.js NOISE_AGGRO_RANGE — the only detection channel independent of
// line-of-sight), delivered two different ways: Cloak is personal and mobile, Smoke Screen is a
// stationary area any live player can stand in.
//
// #500 follow-up (owner design decision): Cloak now ALSO blocks the real per-enemy firing-lane
// raycast, same as Smoke Screen — full invisibility, not just "go quiet." An already-aware/
// engaged enemy can no longer see or hit a cloaked player either. Cloak has no spatial extent of
// its own to sample a ray through the way a smoke cloud does (it isn't an area you can walk out
// of — it's anchored to whichever player is wearing it), so it's checked once against the ray's
// TARGET endpoint (`cloakBlocksTarget` below, consumed by world.js's `_wallDistanceLos` via
// `_cloakBlocksSight`) rather than per-8px-sample like `smokeBlocksPoint`. An enemy with a stale
// lock from before Cloak activated keeps it for up to one LOS refresh window (~120ms,
// `LOS_REFRESH_MS`) — identical latency to ducking behind a wall or into smoke.
//
// Smoke Screen (#507 follow-up, owner playtest: "not sure if it blocks LOS though... it should
// truly obscure stuff"): a real deployed obscurant SHOULD stop an already-engaged enemy's shot,
// not just avoid drawing new attention — so its cloud is wired into the real per-enemy
// firing-lane raycast (`smokeBlocksPoint` below, consumed by world.js's `_wallDistanceLos`), the
// same one solid walls/hard cover already use.
import { DEPTH } from './shared.js';
import { hasActiveEffect } from './abilities.js';
// #534 moved the puff bake + cloud scatter into src/art/ (unchanged) so the garage catalog's
// animated ability preview can stamp the REAL smoke instead of approximating it — see that
// module's header for the full "why a baked gradient texture, not fillCircle / not particles"
// history that used to live here.
import { ensureSmokeTextures, smokePuffLayout, smokePuffScale, SMOKE_BREATHE } from '../../art/smokePuff.js';

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

// #500: is the ray's TARGET endpoint (x, y) a live, currently-cloaked player? Cloak is anchored
// to a specific player's own live position rather than a fixed-radius area, so this matches the
// endpoint outright instead of sampling a radius the way `smokeBlocksPoint` does — every real
// caller passes that target player's own `x`/`y` straight through with no intervening arithmetic
// (`_cachedLosToPlayer`/`_wallDistanceLos`'s `x1, y1` is always `tp.x, tp.y` for an enemy-vs-
// player raycast), so an exact match reliably identifies "this ray's target is this player."
// A raycast whose endpoint ISN'T a player (e.g. visibility.js's player-looking-OUT-at-an-enemy
// check, or enemies.js's cover-point search) simply never matches here, so Cloak correctly has
// no effect on those.
export function cloakBlocksTarget(players, x, y) {
  for (const pl of players ?? []) {
    if (pl.x === x && pl.y === y && hasActiveEffect(pl, 'cloak')) return true;
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
    ensureSmokeTextures(this);
    const puffs = [];
    // The cloud's SHAPE comes from the shared layout (art/smokePuff.js) — the same one the
    // garage catalog card builds its preview cloud from, so the two can't drift. This side owns
    // only the Phaser stamping + the two endlessly-repeating tweens on top.
    for (const { ox, oy, r, texKey, baseAlpha } of smokePuffLayout(radius)) {
      const scale = smokePuffScale(r);
      // #628: DEPTH.SMOKE (5.5), not GROUND_FX (1) — a cloud you can't see through has to draw
      // over the units/projectiles/impacts inside it, and stops just below WORLD_UI so the
      // objective/powerup markers and damage numbers stay readable. See that constant's comment.
      const view = this.add.image(player.x + ox, player.y + oy, texKey)
        .setDepth(DEPTH.SMOKE)
        .setScale(scale)
        .setRotation(Math.random() * Math.PI * 2)
        .setAlpha(baseAlpha);
      puffs.push({ ox, oy, view });

      // Slow independent drift — wanders out and back over several seconds so the cloud
      // visibly roils rather than reading as a scatter of puffs glued in place. Purely
      // cosmetic (never touches ox/oy, which is what the LOS/stand-in-cloud checks care about).
      const driftDist = r * (0.5 + Math.random() * 0.6);
      const driftAngle = Math.random() * Math.PI * 2;
      this.tweens?.add({
        targets: view,
        x: player.x + ox + Math.cos(driftAngle) * driftDist,
        y: player.y + oy + Math.sin(driftAngle) * driftDist,
        duration: 2200 + Math.random() * 2000, delay: Math.random() * 900,
        yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });

      // Staggered breathing size/alpha, independent per sub-blob — the "billowing" read. The
      // bounds are `SMOKE_BREATHE` (art/smokePuff.js) so the catalog card's sine-driven version of
      // the same motion can't drift from this one; `alphaFloorFrac` is also a real density dial —
      // see that constant's comment before lowering it.
      this.tweens?.add({
        targets: view,
        scale: { from: scale * SMOKE_BREATHE.scaleMin, to: scale * SMOKE_BREATHE.scaleMax },
        alpha: { from: baseAlpha, to: baseAlpha * SMOKE_BREATHE.alphaFloorFrac },
        duration: 1000 + Math.random() * 1100, delay: Math.random() * 800,
        yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
    }
    player.smokeCloud = { x: player.x, y: player.y, radius, puffs };
  },

  _despawnSmokeCloud(player) {
    for (const p of player.smokeCloud?.puffs ?? []) {
      this.tweens?.killTweensOf?.(p.view);
      p.view.destroy();
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

  // #500: the Cloak equivalent of `_smokeBlocksSight` — called from world.js's
  // `_wallDistanceLos` against the ray's TARGET endpoint (not per-sample; see `cloakBlocksTarget`
  // above for why) so an already-aware enemy loses its firing lane the instant a player cloaks,
  // exactly like ducking behind a wall or into smoke.
  _cloakBlocksSight(x, y) {
    return cloakBlocksTarget(this.players, x, y);
  },
};
