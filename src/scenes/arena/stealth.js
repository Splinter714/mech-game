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

// #507 second visual pass (owner playtest: "needs to still be way more smoke-like instead of
// just a few simple circular-ish shapes" — the first pass's 7 discrete puff circles still read
// as a handful of shapes, not smoke). This codebase has no true Phaser particle emitter
// anywhere; the closest established convention for "irregular volumetric FX from plain shapes"
// is combat.js's `_deathFx` fireball — several randomly-offset overlapping circle blobs instead
// of one clean circle. This pass leans into that idea much harder: instead of 7 lone circles,
// SMOKE_CLUSTER_COUNT loose "clusters" are scattered through the cloud (denser near the middle,
// same sqrt-biased scatter as before), and each cluster is itself several overlapping sub-blobs
// at randomized offsets/radii/alpha/tint — so the silhouette is ragged at every scale, not one
// layer of circles. No stroke anywhere (a hairline edge is what made the old version read as a
// UI shape rather than haze). Every sub-blob gets two independent, staggered, endlessly-
// repeating tweens: a slow positional "drift" wander (so puffs visibly roil instead of
// breathing in place) and a scale/alpha "breathe" cycle (the billowing read). Neither tween
// ever touches `ox`/`oy`, which is only ever read at spawn time and has nothing to do with the
// LOS/stand-in-cloud checks above (those key off `cloud.x/y/radius`, untouched by this pass).
const SMOKE_CLUSTER_COUNT = 11;         // loose "clusters" scattered through the cloud
const SMOKE_SUBBLOBS_MIN = 2;           // each cluster is 2-3 overlapping sub-blobs, not one circle
const SMOKE_SUBBLOBS_MAX = 3;
const SMOKE_PUFF_MIN_FRAC = 0.2;        // a cluster's own radius, as a fraction of the cloud's radius
const SMOKE_PUFF_MAX_FRAC = 0.5;
const SMOKE_SCATTER_FRAC = 0.7;         // cluster centres land within this fraction of the cloud radius
const SMOKE_SUBBLOB_JITTER_FRAC = 0.4;  // sub-blob offset from its cluster centre, as a frac of cluster radius
const SMOKE_COLOR = 0xc8d2dd;
const SMOKE_COLOR_DARK = 0x9aa3ad;      // a second, slightly darker tint mixed in for shading/depth

export const StealthMixin = {
  // #507: a static cloud at the player's CURRENT position when cast — deliberately doesn't
  // follow them (it's cover you drop and leave, not a personal bubble; that's what Cloak is
  // for). Re-casting replaces the caster's own cloud rather than stacking a second one. `radius`
  // comes from the ability registry (data/abilities.js `smokeScreen.radius`) — the caller passes
  // it rather than this module reading the registry itself, same as burstAoeAt's radius/damage.
  _spawnSmokeCloud(player, radius) {
    this._despawnSmokeCloud(player);
    const puffs = [];
    for (let ci = 0; ci < SMOKE_CLUSTER_COUNT; ci++) {
      // sqrt(random) biases toward the centre (uniform-AREA scatter, not uniform-radius, which
      // would over-cluster near the middle) while still thinning out toward the rim.
      const ca = Math.random() * Math.PI * 2;
      const cd = Math.sqrt(Math.random()) * radius * SMOKE_SCATTER_FRAC;
      const cx = Math.cos(ca) * cd, cy = Math.sin(ca) * cd;
      const clusterR = radius * (SMOKE_PUFF_MIN_FRAC + Math.random() * (SMOKE_PUFF_MAX_FRAC - SMOKE_PUFF_MIN_FRAC));
      const subCount = SMOKE_SUBBLOBS_MIN + Math.floor(Math.random() * (SMOKE_SUBBLOBS_MAX - SMOKE_SUBBLOBS_MIN + 1));
      for (let si = 0; si < subCount; si++) {
        // Sub-blobs jitter off their cluster's own centre so they overlap raggedly instead of
        // stacking exactly — that overlap-of-offset-circles is what breaks up the silhouette.
        const sa = Math.random() * Math.PI * 2;
        const sd = Math.random() * clusterR * SMOKE_SUBBLOB_JITTER_FRAC;
        const ox = cx + Math.cos(sa) * sd, oy = cy + Math.sin(sa) * sd;
        const r = clusterR * (0.45 + Math.random() * 0.6);
        const color = Math.random() < 0.6 ? SMOKE_COLOR : SMOKE_COLOR_DARK;
        const baseAlpha = 0.14 + Math.random() * 0.18;
        const circle = this.add.circle(player.x + ox, player.y + oy, r, color, baseAlpha)
          .setDepth(DEPTH.GROUND_FX);
        puffs.push({ ox, oy, circle });

        // Slow independent drift — wanders out and back over several seconds so the cloud
        // visibly roils rather than reading as a scatter of circles glued in place. Purely
        // cosmetic (never touches ox/oy, which is what the LOS/stand-in-cloud checks care about).
        const driftDist = r * (0.5 + Math.random() * 0.6);
        const driftAngle = Math.random() * Math.PI * 2;
        this.tweens?.add({
          targets: circle,
          x: player.x + ox + Math.cos(driftAngle) * driftDist,
          y: player.y + oy + Math.sin(driftAngle) * driftDist,
          duration: 2200 + Math.random() * 2000, delay: Math.random() * 900,
          yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });

        // Staggered breathing size/alpha, independent per sub-blob — the "billowing" read.
        this.tweens?.add({
          targets: circle,
          scale: { from: 0.8, to: 1.3 }, alpha: { from: baseAlpha, to: baseAlpha * 0.4 },
          duration: 1000 + Math.random() * 1100, delay: Math.random() * 800,
          yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
      }
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
