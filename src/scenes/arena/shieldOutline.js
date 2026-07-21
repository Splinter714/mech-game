// Shared shield-outline visual (#302). ONE implementation of "a unit with a live shield pool
// wears a glowing rim hugging its own silhouette", driven by BOTH the player mech (the Shield
// powerup / the mech's native shield layer) and any shielded enemy (helicopter's 30, carrier's
// 50 — data/enemyKinds.js). #302's hard requirement: a future rework of the shield look must
// change player and enemies together in ONE edit, so the technique, the colour, the alpha curve
// and the hit-flash all live here and nothing outside this file knows how a shield is drawn.
//
// The technique (originally #205, on the player only): this repo's Phaser build can't rely on a
// WebGL-only postFX glow pipeline (the smoke/test harness can force the Canvas renderer via
// `?canvas`, where glow FX don't run), so the outline is the classic cheap 2D "duplicate" trick —
// for every sprite that makes up the unit's body, add a same-texture duplicate tinted solid
// shield-blue (`setTintFill`), scaled up slightly, stacked BEHIND all the real parts. The real
// artwork fully covers each duplicate except a thin rim at its silhouette edge, which reads as a
// glowing outline hugging the unit's actual shape.
//
// Per-unit-type difference, and why it's just a `keys` argument: the player (and any mech-kind
// enemy) is a `Mech` drawn as six pivoting part sprites, so its outline is six duplicates that
// re-pose every frame. A helicopter/carrier is an `HpBody` drawn as ONE hull + ONE turret
// sprite with a single unit-wide shield pool — so it gets a two-sprite outline, which reads as
// one shell around the whole vehicle. That matches the model: a vehicle's shield is one pool, not
// per-location, so a single shell (rather than per-part rims) is the honest depiction, and the
// same "hug the real silhouette" language carries across both.
//
// PERFORMANCE (#237, and #302's constraint): `updateShieldOutline` early-exits BEFORE touching a
// single sprite transform when the pool is empty — that is the locked-in property #237 checked
// and powerups.test.js regression-tests. Generalizing to N enemies keeps it two ways: (1) an
// enemy with no shield config never gets outline sprites built at all (`makeShieldOutline`
// returns null), so it has no per-frame call to make; (2) a shielded enemy whose pool is
// currently down pays only the same early-exit as the player's.
import Phaser from 'phaser';
import { POWERUPS } from '../../data/powerups.js';
import { mechLayout } from '../../art/mechArt.js';
import { ART_SCALE } from '../../art/_frames.js';

// One shield-blue for every unit in the game — the Shield powerup's own colour, so the player's
// glow and an enemy gunship's glow are self-evidently the same mechanic.
export const SHIELD_COLOR = POWERUPS.shield.color;

// The six mech part-sprite names on a mech view (locomotion.js `_makeMechView`) and the two on a
// vehicle view (enemies.js `_makeVehicleView`). Read fresh each frame since mech torso/arm
// sprites pivot (position + origin both change as they cant toward weapon convergence) and both
// hulls can swap texture through a walk cycle.
export const SHIELD_MECH_PART_KEYS = ['hull', 'torL', 'torR', 'armL', 'armR', 'turret'];
export const SHIELD_VEHICLE_PART_KEYS = ['hull', 'turret'];

// Which of a vehicle kind's sprites the outline should hug (#379). The default is both — for a
// gunship or the carrier, hull + turret ARE the unit's body, so one shell around the pair is the
// right read (see the note above). The exception is a kind whose second sprite isn't body at all:
// the DRONE's `turret` is a translucent spinning-rotor blur overlay, so shadowing it drew a
// glowing halo around four rotor discs — Jackson (#379): "remove the shield glow from their
// rotors, but keep it on their body". Rather than special-casing a kind id in scene code, the
// kind declares its own parts in `enemyKinds.js` (`shieldOutlineParts`); a kind that says nothing
// keeps the shared default byte-for-byte, so the player mech, helicopter and carrier are all
// untouched by this.
export function shieldPartKeys(def) {
  return def?.shieldOutlineParts ?? SHIELD_VEHICLE_PART_KEYS;
}

// #205 (playtest follow-up): how much bigger each outline duplicate is drawn than the real part
// it shadows — just enough for a bright rim to peek out from behind every edge of the actual
// silhouette, not a separate floating shape. The flash multiplier is the extra outward pop on an
// absorbed hit.
export const SHIELD_OUTLINE_SCALE_MULT = 1.14;
export const SHIELD_HIT_FLASH_MULT = 1.15;

// #397: the PLAYER shell is drawn tighter and with NORMAL (not ADD) blend — see the long note on
// `makeShieldOutline`'s `blend` param. A tighter hug ("hugs the mech more tightly") plus a crisp
// solid rim that the muzzle glow can no longer balloon. Enemies keep the default rim + ADD glow.
// #422 SUPERSEDES this scale multiplier for the player: a single % scale about the mech centre made
// the rim grow proportional to the distance-from-centre, so the wide axis (arm-to-arm) got a fatter
// rim than the shallow axis (front-to-back) and the shell looked stretched sideways. The player now
// passes SHIELD_PLAYER_OFFSET_PX instead (see `makeShieldOutline`'s `offsetPx`), so this constant is
// only a fallback for any player caller that hasn't supplied the offset+mech.
export const SHIELD_PLAYER_SCALE_MULT = 1.08;

// #422: the PLAYER shell's UNIFORM outward margin, in DISPLAY pixels — the same gap on every side of
// the mech silhouette (arm edges, nose, tail) rather than a width/depth-proportional multiplier. The
// shell duplicates all share one texture footprint centred on the mech, so a uniform margin is a
// non-uniform per-axis scale: each axis is scaled so its own half-extent grows by exactly this many
// display px (see `makeShieldOutline`). Landed between the old ~1.45px (front/back) and ~2.7px (sides)
// margins so the even shell reads close to the old shell's overall thickness. Tunable.
export const SHIELD_PLAYER_OFFSET_PX = 2.4;
// Optional-chained so the unit tests (which mock Phaser as `{}`) can import this module; the real
// Phaser build always has BlendModes.NORMAL (=== 0). Only read at real sprite construction time.
export const SHIELD_PLAYER_BLEND = Phaser.BlendModes?.NORMAL ?? 0;

// #381: how much the glow SWELLS per unit of temp-pool-to-base-capacity ratio. #397 dialled this
// WAY down (was 0.5): a full 150-temp pool on the player's 100 base (ratio 1.5) now grows the
// shell by only 1 + 0.2*1.5 = 1.3x on top of the tight 1.08x rim (was 1.75x on a loose 1.14x —
// "a bit too large after the shield powerup"). The powerup now reads as a tighter, punchier shell
// rather than a huge bubble. Enemies never carry a temp pool, so their outline is unchanged (growth ≡ 1).
export const SHIELD_TEMP_GROW_K = 0.2;

// ── Pure state/appearance logic (no Phaser — unit-tested in shieldOutline.test.js) ───────────

// Is the outline supposed to be showing right now? The ONLY rule: a live pool — base hp OR the
// #381 temporary pool. Regen brings it straight back, which is the whole point of #302 (a shielded
// enemy the player chipped but didn't burst down visibly re-shells itself).
export function shieldOutlineActive(shield) {
  return (shield?.hp || 0) + (shield?.temp || 0) > 0;
}

// #381: the outline's scale multiplier for a live temporary pool — 1 (no growth) whenever there is
// no temp, so every enemy and an un-buffed player stay exactly as before. Pure so the growth curve
// is unit-tested without any sprites.
export function shieldOutlineGrowth(shield) {
  const max = shield?.max || 0;
  const temp = shield?.temp || 0;
  if (max <= 0 || temp <= 0) return 1;
  return 1 + SHIELD_TEMP_GROW_K * (temp / max);
}

// #422: the mech silhouette's half-extents in TEXTURE pixels (half-width across, half-depth
// front-to-back), read from the same `mechLayout` boxes the art and hit-areas use. Every part
// duplicate is a full-canvas raster centred on the mech, so growing each duplicate's scale by
// `d` beyond the real scale pushes the widest silhouette point out by `halfW * d` display px and
// the deepest by `halfD * d`. To turn a desired UNIFORM outward margin (`offsetPx`, display px)
// into per-axis scales we need these half-extents; the max over all body boxes is the silhouette
// edge on each axis. Pure (no Phaser) so it's unit-testable.
export function mechHalfExtentPx(mech) {
  const lay = mechLayout(mech);
  let w = 0, d = 0;
  for (const box of Object.values(lay)) {
    if (!box) continue;
    w = Math.max(w, Math.abs(box.x || 0) + (box.w || 0) / 2);
    d = Math.max(d, Math.abs(box.y || 0) + (box.h || 0) / 2);
  }
  return { w: w * ART_SCALE, d: d * ART_SCALE };
}

// #422: the outline's per-axis base scales for a UNIFORM `offsetPx` display-px margin. Real parts
// draw at `scale`; scaling an axis to `scale + offsetPx / halfExtentPx` pushes that axis's silhouette
// edge out by exactly `offsetPx` display px (edge display distance = halfExtentPx × scale, so the
// added distance = halfExtentPx × (newScale − scale) = offsetPx). The shallower axis therefore gets
// the LARGER scale, which is the whole point: equal px on every side instead of equal percentage.
// Falls back to the uniform `scale × scaleMult` shell when no offset/extent is available (enemies,
// or a player caller that passed neither) so nothing else changes.
export function outlineBaseScales({ scale, scaleMult, offsetPx = 0, halfExtentPx = null }) {
  if (offsetPx > 0 && halfExtentPx && halfExtentPx.w > 0 && halfExtentPx.d > 0) {
    return { sx: scale + offsetPx / halfExtentPx.w, sy: scale + offsetPx / halfExtentPx.d };
  }
  const uniform = scale * scaleMult;
  return { sx: uniform, sy: uniform };
}

// Opacity for this frame: fades with the remaining FRACTION of the pool rather than a flat on/off,
// so the player gets an at-a-glance "how much is left" read (same spirit as the HUD sprint bar,
// drawn in-world since this is a persistent-on-the-unit indicator). A slow ambient hum keeps an
// idle glow reading as "live" rather than a flat decal. `t` is accumulated ms.
export function shieldOutlineAlpha(pool, cap, t) {
  const frac = Math.max(0.15, Math.min(1, pool / (cap || pool || 1)));
  const pulse = 0.5 + 0.5 * Math.sin(t * 0.0025);
  // #397: higher, tighter-swinging opacity so the shell reads MORE intensely ("more intense
  // without being so huge") — brighter floor, gentler ambient hum. Still clamped ≤ 1.
  return (0.5 + 0.4 * frac) * (0.9 + 0.2 * pulse);
}

// ── Phaser-side construction / per-frame upkeep ──────────────────────────────────────────────

// Build the outline duplicates for one unit's view and return its visual state. `scale` is the
// display scale of the real sprites (the outline is drawn slightly larger). Callers decide
// whether a unit gets one at all: the PLAYER always does (its shield capacity can appear later,
// when the Shield powerup grants a temporary pool to a zero-capacity chassis — Mech.grantTempShield), while an ENEMY only
// gets one if its kind data configures a shield (`shieldPresent`), so the great majority of
// enemies hold no outline sprites and make no per-frame call whatsoever.
// `scaleMult` (#397): how much bigger than the real part the rim is drawn — defaults to the shared
// enemy rim; the player passes SHIELD_PLAYER_SCALE_MULT for a tighter hug.
// `blend` (#397): the outline's blend mode. Enemies default to ADD — a soft additive glow rim.
// The PLAYER passes NORMAL, and this is the muzzle-glow FIX: an energy weapon bakes a big soft
// `glowDot` halo at the muzzle tip into its part texture, and `setTintFill` floods that faint halo
// to solid shield-blue. Under ADD blend that flooded halo accumulates into a big round bubble that
// balloons FORWARD off the gun (Jackson #397: "further expands the visual size of the shield
// overlay, which looks ridiculous"). Under NORMAL blend the soft halo copy sits harmlessly behind
// the real (also soft) glow and contributes almost nothing, while the SOLID body plating still
// throws a crisp blue rim over the ground — so the shell sizes off the MECH, never the muzzle FX,
// and reads even all around instead of stretched forward.
// `bodyOnly` (#397 follow-up): draw the shell from the BODY-ONLY `_shield` textures where they
// exist (mechArt.buildMechTextures bakes them for the player), so the shell hugs the mech's armor
// plating and leaves the mounted guns + their muzzle glow poking out UNshielded. Weapons are baked
// into each part texture, so this is the only clean cut — a filter on sprite keys would drop the
// whole arm/torso body, not just the gun. A part with no `_shield` variant (the hull, every enemy)
// falls back to its real texture, so nothing else changes. The real→shield key mapping is stored on
// the returned state so the per-frame driver keeps using the body-only texture (it never fights the
// walk-cycle frame-follow, since the hull — the only part that swaps frames — has no variant).
// `offsetPx` + `mech` (#422): the PLAYER passes these to get a UNIFORM outward margin (same display
// px on every side) instead of the width/depth-proportional `scaleMult`. With them the shell scales
// each axis independently (per `outlineBaseScales`), so the wide arm-to-arm axis and the shallow
// nose-to-tail axis grow by the SAME number of pixels rather than the same percentage. Omitting them
// (every enemy, or a player fallback) keeps the classic uniform `scale × scaleMult` shell.
export function makeShieldOutline(scene, view, {
  keys, scale, color = SHIELD_COLOR,
  scaleMult = SHIELD_OUTLINE_SCALE_MULT, blend = Phaser.BlendModes.ADD, bodyOnly = false,
  offsetPx = 0, mech = null,
}) {
  const halfExtentPx = offsetPx > 0 && mech ? mechHalfExtentPx(mech) : null;
  const { sx: baseSx, sy: baseSy } = outlineBaseScales({ scale, scaleMult, offsetPx, halfExtentPx });
  const baseScale = scale * scaleMult;   // retained for the flash/grow fallback + existing callers
  const outlines = {};
  const texMap = {};
  for (const key of keys) {
    const real = view[key];
    if (!real) continue;
    const realKey = real.texture.key;
    const shieldKey = bodyOnly && scene.textures?.exists?.(`${realKey}_shield`)
      ? `${realKey}_shield` : realKey;
    if (shieldKey !== realKey) texMap[realKey] = shieldKey;
    // #397 follow-up: the outline scales about its TEXTURE CENTRE (origin 0.5,0.5), never the
    // real part's origin. A side-torso/arm real origin is the convergence PIVOT — a joint set
    // toward the part's REAR (PART_PIVOT, mechArt.js). Growing a duplicate about that rear anchor
    // balloons it FORWARD (the front edge is far from the pivot, the back edge is right on it), so
    // the shell stuck out ahead of the mech. Anchored at the texture centre instead, every part
    // grows symmetrically front-to-back and the shell sits centred on the body. The per-frame
    // driver positions this at the real part's texture-centre so the two stay registered.
    const o = scene.add.sprite(real.x, real.y, shieldKey)
      .setOrigin(0.5, 0.5)
      .setScale(baseSx, baseSy)
      .setTintFill(color)
      .setBlendMode(blend)
      .setVisible(false);
    outlines[key] = o;
    // Behind everything already in the container (the real parts) — order among the outlines
    // themselves doesn't matter since they're additive-blended and fully hidden by the real art.
    view.addAt(o, 0);
  }
  return { outlines, active: false, t: 0, baseScale, baseSx, baseSy, grow: 1, texMap };
}

// Per-frame upkeep for ONE unit's outline. Shows/hides on the 0↔>0 edge (pickup / regen-back-up /
// break); while active, re-poses each outline onto its real part (texture/position/rotation/origin
// all move) and sets the fraction-driven alpha. Bails out before touching any sprite when the pool
// is empty — see the perf note in the header; powerups.test.js locks this in.
// Part keys come from the outline set itself, so this never needs to know which body type it's
// driving.
export function updateShieldOutline(sv, view, shield, delta) {
  if (!sv) return;
  // #381: the pool and cap include the temporary shield, so the alpha ("how much is left") reads
  // the full total. Temp is 0 for every enemy, so this is identical to the base pool for them.
  const pool = (shield?.hp || 0) + (shield?.temp || 0);
  const active = shieldOutlineActive(shield);
  const keys = Object.keys(sv.outlines);
  if (active !== sv.active) {
    for (const key of keys) sv.outlines[key].setVisible(active);
    sv.active = active;
    if (!active) sv.t = 0;
  }
  if (!active) return;
  sv.t += delta;
  const alpha = shieldOutlineAlpha(pool, (shield.max || 0) + (shield.temp || 0), sv.t);
  // #381: swell the shell with a live temp pool. Only re-scale when the growth factor CHANGES
  // (pickup / spend / expiry) so we don't fight the hit-flash tween every frame — and never for a
  // plain (temp-less) shield, where growth stays 1 and no setScale call is made at all.
  const grow = shieldOutlineGrowth(shield);
  if (sv.grow === undefined) sv.grow = 1;
  const growChanged = Math.abs(grow - sv.grow) > 1e-3;
  if (growChanged) sv.grow = grow;
  for (const key of keys) {
    const real = view[key];
    const o = sv.outlines[key];
    // #397: follow the real part's texture, but keep the body-only `_shield` variant for any part
    // that has one (the player's weapon-carrying parts). Parts with no mapping (hull frames, every
    // enemy) resolve straight back to the real key, so this is a no-op for them.
    const desired = sv.texMap?.[real.texture.key] ?? real.texture.key;
    if (o.texture.key !== desired) o.setTexture(desired);
    // Register the (centre-anchored) outline onto the real part's TEXTURE CENTRE, wherever the
    // real part's own origin sits. The real side-torso/arm origin is its rear convergence joint,
    // so its position is that joint, not the part centre — walk the origin→centre offset out
    // through the part's display size and rotation so the two silhouettes stay perfectly aligned
    // while the shell still grows symmetrically about the centre (see makeShieldOutline). Hull and
    // turret keep origin 0.5,0.5, so their offset is zero and this reduces to the real position.
    const ex = (0.5 - (real.originX ?? 0.5)) * (real.displayWidth || 0);
    const ey = (0.5 - (real.originY ?? 0.5)) * (real.displayHeight || 0);
    const rot = real.rotation || 0;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    o.setPosition(real.x + cos * ex - sin * ey, real.y + sin * ex + cos * ey);
    o.rotation = real.rotation;
    o.setAlpha(alpha);
    // #422: re-scale off the per-axis base (uniform-margin player shell) or the single uniform
    // baseScale (enemies / any state built before #422). When the two axes match this is the same
    // single-arg call as before.
    if (growChanged && o.setScale) {
      const sx = sv.baseSx ?? sv.baseScale;
      const sy = sv.baseSy ?? sv.baseScale;
      if (sx === sy) o.setScale(sx * grow);
      else o.setScale(sx * grow, sy * grow);
    }
  }
}

// A brief outward pulse the instant the shield actually absorbs a hit — reinforces the 'shielded'
// floating text (combat.js) with something ON the unit itself. Tween-driven like the impact
// `_burst` primitive, but reusing the outline sprites' own persistent shapes.
export function flashShieldOutline(scene, sv) {
  if (!sv || !sv.active) return;
  // #381/#422: flash relative to the current (possibly temp-swollen) shell size, settling back to
  // it. Per-axis so the uniform-margin player shell flashes evenly instead of snapping to a square.
  const g = sv.grow ?? 1;
  const restX = (sv.baseSx ?? sv.baseScale) * g;
  const restY = (sv.baseSy ?? sv.baseScale) * g;
  const targets = Object.values(sv.outlines);
  for (const o of targets) o.setScale(restX * SHIELD_HIT_FLASH_MULT, restY * SHIELD_HIT_FLASH_MULT);
  scene.tweens.add({
    targets, scaleX: restX, scaleY: restY, duration: 220, ease: 'Quad.out',
  });
}
