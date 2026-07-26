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

// #507 THIRD visual pass (owner playtest, after the second pass's 11-cluster/sub-blob rework:
// "still reads as blobs, not smoke texture"). Both prior passes drew every puff with Phaser
// `Graphics.fillCircle` — no matter how many circles, how varied their size, or how much drift/
// breathing animation is layered on, a `fillCircle` has a hard geometric edge (even at low alpha
// the boundary is still a perfect circle), so it structurally cannot read as soft haze. That
// needed a different rendering technique, not another iteration on "more circles."
//
// This pass switches to the SAME technique every other texture in this game uses (art/_frames.js
// header, mechArt.js `desaturateTexture`): bake a texture once, then stamp cheap GameObject
// instances of it at runtime. The bake itself uses real Canvas 2D radial gradients
// (`createRadialGradient` — see `bakeSmokePuffTexture` below) instead of a flat fill: a gradient
// fades smoothly from an opaque-ish core to fully-transparent at the rim, which has no edge at
// all to read as a shape. `scaledGraphics`/`gen()` can't do this (Graphics has no gradient
// primitive), so this bakes straight onto a Phaser `CanvasTexture`'s own 2D context, exactly like
// `desaturateTexture` already does for Cloak's greyscale bake — same API, same guard pattern for
// hand-rolled test scenes.
//
// `this.add.particles` (Phaser's built-in emitter) was considered and rejected: this codebase has
// deliberately never used a live particle system anywhere (checked), every other FX/texture is a
// baked-texture-plus-manually-animated-GameObject (muzzle flashes, glow overlays, drone views,
// the death fireball), and introducing the first-ever particle emitter for one effect would add a
// whole second animation paradigm (its own update loop, its own tween-vs-emitter-config split)
// for no benefit over just tweening stamped Image instances the same way every other ambient FX
// in this file already does. Staying with hand-stamped sprites keeps smoke consistent with the
// rest of the game's "bake once, animate a plain GameObject" convention.
//
// The scatter/cluster geometry (loose "clusters" of a few overlapping sub-blobs, sqrt-biased
// toward the centre) is UNCHANGED from the second pass — that part was never the problem, only
// what got drawn at each position. Each sub-blob is now one stamped Image of a baked puff
// texture (randomly one of SMOKE_TEX_VARIANT_COUNT mottled variants, so instances don't look
// identical when overlapping) instead of a `Graphics` circle. The same two staggered, endlessly-
// repeating tweens as before ride on top — a slow positional "drift" wander and a scale/alpha
// "breathe" cycle — neither ever touches `ox`/`oy`, which is only read at spawn time and has
// nothing to do with the LOS/stand-in-cloud checks above (those key off `cloud.x/y/radius`,
// untouched by this pass).
const SMOKE_CLUSTER_COUNT = 11;         // loose "clusters" scattered through the cloud
const SMOKE_SUBBLOBS_MIN = 2;           // each cluster is 2-3 overlapping sub-blobs, not one circle
const SMOKE_SUBBLOBS_MAX = 3;
const SMOKE_PUFF_MIN_FRAC = 0.2;        // a cluster's own radius, as a fraction of the cloud's radius
const SMOKE_PUFF_MAX_FRAC = 0.5;
const SMOKE_SCATTER_FRAC = 0.7;         // cluster centres land within this fraction of the cloud radius
const SMOKE_SUBBLOB_JITTER_FRAC = 0.4;  // sub-blob offset from its cluster centre, as a frac of cluster radius
const SMOKE_COLOR = 0xc8d2dd;
const SMOKE_COLOR_DARK = 0x9aa3ad;      // a second, slightly darker tint mixed into the gradient bake

// --- Baked puff texture (the actual fix) -----------------------------------------------------
// Bake resolution: a puff instance's on-screen radius `r` is achieved by scaling this texture,
// never by redrawing it, so one bake covers every size the scatter logic produces.
const SMOKE_TEX_SIZE = 256;
// A few mottled variants so overlapping instances never look like the same stamp repeated.
const SMOKE_TEX_VARIANT_COUNT = 3;
export const SMOKE_TEX_KEYS = Array.from({ length: SMOKE_TEX_VARIANT_COUNT }, (_, i) => `smokePuff${i}`);

function smokeRgba(hex, a) {
  return `rgba(${(hex >> 16) & 0xff},${(hex >> 8) & 0xff},${hex & 0xff},${a})`;
}

// Bake ONE soft smoke-puff texture onto a Phaser CanvasTexture's real 2D context. A big central
// gradient (opaque-ish core → fully transparent at its own radius, no stroke, no hard edge of any
// kind) plus 4-6 smaller offset "wisp" gradients — mixed SMOKE_COLOR/SMOKE_COLOR_DARK, randomized
// position/size/alpha/squash — blended on top so the silhouette is mottled and asymmetric rather
// than a smooth disc. Idempotent (no-ops if `key` already exists), same as `gen()`.
function bakeSmokePuffTexture(scene, key) {
  if (scene.textures.exists(key)) return key;
  if (typeof scene.textures.createCanvas !== 'function') return key;
  const size = SMOKE_TEX_SIZE;
  const tex = scene.textures.createCanvas(key, size, size);
  const ctx = tex?.context;
  if (!ctx) return key;
  const cx = size / 2, cy = size / 2;
  const coreR = size * 0.39;

  const blob = (ox, oy, r, color, alpha, sx, sy) => {
    ctx.save();
    ctx.translate(cx + ox, cy + oy);
    ctx.scale(sx, sy);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, smokeRgba(color, alpha));
    g.addColorStop(0.55, smokeRgba(color, alpha * 0.5));
    g.addColorStop(1, smokeRgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // Main body: one dominant soft core, very slightly squashed so even the base shape isn't a
  // perfect circle before any wisps land on it.
  blob(0, 0, coreR, SMOKE_COLOR, 0.65, 1, 0.88 + Math.random() * 0.18);
  const wisps = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < wisps; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * coreR * 0.5;
    const wr = coreR * (0.3 + Math.random() * 0.4);
    const color = Math.random() < 0.5 ? SMOKE_COLOR_DARK : SMOKE_COLOR;
    blob(Math.cos(a) * d, Math.sin(a) * d, wr, color, 0.22 + Math.random() * 0.2,
      0.75 + Math.random() * 0.5, 0.75 + Math.random() * 0.5);
  }
  tex.refresh();
  return key;
}

// Bake every puff variant once. Guarded for hand-rolled test scenes that stub `textures.exists`
// to always report true (same pattern as friendlyDrones.test.js) so real canvas/graphics work is
// never exercised in unit tests — those assert spawn/despawn orchestration, not the pixel bake,
// which has no meaningful assertable output of its own and is otherwise verified live.
export function ensureSmokeTextures(scene) {
  if (typeof scene.textures?.exists !== 'function') return;
  for (const key of SMOKE_TEX_KEYS) bakeSmokePuffTexture(scene, key);
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
        // stacking exactly — that overlap-of-offset-textures is what breaks up the silhouette.
        const sa = Math.random() * Math.PI * 2;
        const sd = Math.random() * clusterR * SMOKE_SUBBLOB_JITTER_FRAC;
        const ox = cx + Math.cos(sa) * sd, oy = cy + Math.sin(sa) * sd;
        const r = clusterR * (0.45 + Math.random() * 0.6);
        const texKey = SMOKE_TEX_KEYS[Math.floor(Math.random() * SMOKE_TEX_KEYS.length)];
        const baseAlpha = 0.5 + Math.random() * 0.32;
        const scale = (r * 2) / SMOKE_TEX_SIZE;
        const view = this.add.image(player.x + ox, player.y + oy, texKey)
          .setDepth(DEPTH.GROUND_FX)
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

        // Staggered breathing size/alpha, independent per sub-blob — the "billowing" read.
        this.tweens?.add({
          targets: view,
          scale: { from: scale * 0.8, to: scale * 1.3 }, alpha: { from: baseAlpha, to: baseAlpha * 0.4 },
          duration: 1000 + Math.random() * 1100, delay: Math.random() * 800,
          yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
      }
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
