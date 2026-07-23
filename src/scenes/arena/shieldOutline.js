// Shared shield-outline visual (#302). ONE implementation of "a unit with a live shield pool
// wears a glowing rim hugging its own silhouette", driven by BOTH the player mech (the Shield
// powerup / the mech's native shield layer) and any shielded enemy (helicopter's 30 —
// data/enemyKinds.js; the carrier was shielded too until #436 moved it to pure armor). #302's
// hard requirement: a future rework of the shield look must
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
import { SHIELD_SHELL_SUFFIX } from '../../art/mechArt.js';

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

// #397/#422: the PLAYER shell no longer uses a scale multiplier AT ALL (the old
// SHIELD_PLAYER_SCALE_MULT is gone). A single % scale about the mech centre displaces each edge in
// proportion to its own distance from that centre, so a mech that is wider than it is deep
// necessarily wears a shell that is wider than it is deep — two passes of per-axis / per-part scale
// algebra could not fix that, because the silhouette isn't a rectangle. The shell is now a BAKED
// DILATION of the body art (mechArt.SHIELD_SHELL_PAD, `drawDilated`) drawn at the mech's EXACT
// display scale — a constant outward distance on every side by construction. `dilated: true` on
// `makeShieldOutline` selects that path. Enemies keep the classic scaled duplicate
// (SHIELD_OUTLINE_SCALE_MULT), since they have no baked shell raster.
//
// Optional-chained so the unit tests (which mock Phaser as `{}`) can import this module; the real
// Phaser build always has BlendModes.NORMAL (=== 0). Only read at real sprite construction time.
export const SHIELD_PLAYER_BLEND = Phaser.BlendModes?.NORMAL ?? 0;

// ── Pure state/appearance logic (no Phaser — unit-tested in shieldOutline.test.js) ───────────

// Is the outline supposed to be showing right now? The ONLY rule: a live pool — base hp OR the
// #381 temporary pool. Regen brings it straight back, which is the whole point of #302 (a shielded
// enemy the player chipped but didn't burst down visibly re-shells itself).
export function shieldOutlineActive(shield) {
  return (shield?.hp || 0) + (shield?.temp || 0) > 0;
}

// ── #456: strength drives OPACITY, and ONLY opacity ──────────────────────────────────────────
// The shell used to encode a strong shield by GROWING (#381's temp-pool swell). It no longer does:
// its size is a constant of the art bake (mechArt.SHIELD_SHELL_PAD) and nothing at runtime scales
// it. A faint shell means a nearly-broken one; a solid shell means a strong one.
//
// `SHIELD_ALPHA_MIN` is the last-sliver opacity (still clearly visible — the shell must not read as
// "gone" until it actually is), `SHIELD_ALPHA_FULL` the opacity at a full BASE pool, and a
// temporary pool stacked on top of a full base (the Shield powerup) carries it the rest of the way
// to fully opaque — the strongest possible shield is the most solid-looking one, which is the whole
// #456 read. The band is deliberately much wider than the old 0.62→0.99 one, because opacity is now
// the ONLY channel carrying shield strength.
export const SHIELD_ALPHA_MIN = 0.2;
export const SHIELD_ALPHA_FULL = 0.85;

// Opacity for this frame. `pool` is the total remaining (base + temp), `cap` the BASE capacity —
// so `pool/cap` runs 0→1 as a normal shield drains and goes ABOVE 1 while a temp pool is stacked
// on top. A slow ambient hum keeps an idle glow reading as "live" rather than a flat decal; it is
// scaled to stay under 1 so a full shell never clips flat. `t` is accumulated ms.
export function shieldOutlineAlpha(pool, cap, t) {
  const denom = cap || pool || 1;
  const frac = Math.max(0, pool / denom);
  const base = SHIELD_ALPHA_MIN + (SHIELD_ALPHA_FULL - SHIELD_ALPHA_MIN) * Math.min(1, frac);
  const over = (1 - SHIELD_ALPHA_FULL) * Math.min(1, Math.max(0, frac - 1));   // temp pool → solid
  const pulse = 0.5 + 0.5 * Math.sin(t * 0.0025);
  return Math.min(1, (base + over) * (0.94 + 0.06 * pulse));
}

// #456: the capacity the alpha fraction is measured against — the BASE pool, so a temp grant reads
// as "over 100%" (see shieldOutlineAlpha) instead of silently re-normalising to full. Falls back to
// the temp grant for a chassis with no native shield at all (the Shield powerup on a zero-capacity
// mech), and finally to the live pool so the fraction is never divided by zero.
export function shieldAlphaCap(shield, pool) {
  return (shield?.max || 0) || (shield?.temp || 0) || pool || 1;
}

// ── Phaser-side construction / per-frame upkeep ──────────────────────────────────────────────

// Build the outline duplicates for one unit's view and return its visual state. `scale` is the
// display scale of the real sprites (the outline is drawn slightly larger). Callers decide
// whether a unit gets one at all: the PLAYER always does (its shield capacity can appear later,
// when the Shield powerup grants a temporary pool to a zero-capacity chassis — Mech.grantTempShield), while an ENEMY only
// gets one if its kind data configures a shield (`shieldPresent`), so the great majority of
// enemies hold no outline sprites and make no per-frame call whatsoever.
// `scaleMult`: how much bigger than the real part the rim is drawn — the ENEMY technique. Ignored
// entirely when `dilated` is set (the player), where the margin comes from the art bake instead.
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
// `dilated` (#422): the PLAYER's shell rasters are already grown outward by a constant distance at
// BAKE time (mechArt `drawDilated`/SHIELD_SHELL_PAD), so the duplicate is drawn at the mech's EXACT
// display scale — no multiplier at all. That is what finally makes the margin the same on the wide
// arm-to-arm axis and the shallow nose-to-tail axis: a dilation moves every silhouette edge by the
// same distance, while ANY scale (uniform or per-axis) moves each edge in proportion to its own
// distance from the centre. Enemies pass nothing and keep the classic `scale × scaleMult` duplicate.
export function makeShieldOutline(scene, view, {
  keys, scale, color = SHIELD_COLOR,
  scaleMult = SHIELD_OUTLINE_SCALE_MULT, blend = Phaser.BlendModes.ADD, bodyOnly = false,
  dilated = false,
}) {
  // #422/#456: ONE constant scale for every part, set once at construction and never touched again
  // — the shell's size is now a property of the art bake, not of the shield's strength.
  const baseScale = dilated ? scale : scale * scaleMult;
  const outlines = {};
  const texMap = {};
  // Resolve a real part texture to the shell raster that shadows it. Memoised, and a FUNCTION
  // rather than a fixed table because the hull swaps texture through the walk cycle: each frame
  // has its own shell raster (`..._hull_7_shield`), and the frame the outline was BUILT on is not
  // the only one it will ever see. A part with no shell raster (every enemy) resolves to itself.
  const resolveTex = (realKey) => {
    let mapped = texMap[realKey];
    if (mapped === undefined) {
      const shellKey = `${realKey}${SHIELD_SHELL_SUFFIX}`;
      mapped = bodyOnly && scene.textures?.exists?.(shellKey) ? shellKey : realKey;
      texMap[realKey] = mapped;
    }
    return mapped;
  };
  for (const key of keys) {
    const real = view[key];
    if (!real) continue;
    const shieldKey = resolveTex(real.texture.key);
    // #397 follow-up: the outline is anchored at its TEXTURE CENTRE (origin 0.5,0.5), never the
    // real part's origin — a side-torso/arm real origin is the convergence PIVOT (a joint set
    // toward the part's REAR, PART_PIVOT in mechArt.js), and anchoring there threw the shell
    // forward off the nose. The per-frame driver positions this at the real part's texture-centre
    // so the two rasters stay perfectly registered.
    const o = scene.add.sprite(real.x, real.y, shieldKey)
      .setOrigin(0.5, 0.5)
      .setScale(baseScale)
      .setTintFill(color)
      .setBlendMode(blend)
      .setVisible(false);
    outlines[key] = o;
    // Behind everything already in the container (the real parts) — order among the outlines
    // themselves doesn't matter since they're additive-blended and fully hidden by the real art.
    view.addAt(o, 0);
  }
  return { outlines, active: false, t: 0, baseScale, flash: 0, texMap, resolveTex };
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
  // #456: strength → opacity, and nothing else. No setScale call is made here at ALL any more —
  // the shell's size was fixed once at construction (and its outward margin baked into the art).
  const alpha = shieldOutlineAlpha(pool, shieldAlphaCap(shield, pool), sv.t);
  // The absorbed-hit flash is an OPACITY pop rather than the old outward size pop, for the same
  // reason: the shell never changes size. `sv.flash` is tweened 1→0 by `flashShieldOutline`, and
  // is applied here because this driver rewrites alpha every frame (a tween on the sprite's own
  // alpha would simply be overwritten).
  const lit = alpha + (1 - alpha) * Math.max(0, Math.min(1, sv.flash || 0));
  for (const key of keys) {
    const real = view[key];
    const o = sv.outlines[key];
    // #397: follow the real part's texture, but keep the body-only `_shield` variant for any part
    // that has one (the player's weapon-carrying parts). Parts with no mapping (hull frames, every
    // enemy) resolve straight back to the real key, so this is a no-op for them.
    const desired = sv.resolveTex
      ? sv.resolveTex(real.texture.key)
      : (sv.texMap?.[real.texture.key] ?? real.texture.key);
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
    o.setAlpha(lit);
  }
}

// How long the absorbed-hit opacity pop takes to settle back to the strength-driven alpha.
export const SHIELD_HIT_FLASH_MS = 220;

// A brief BRIGHTEN the instant the shield actually absorbs a hit — reinforces the 'shielded'
// floating text (combat.js) with something ON the unit itself. #456: this used to be an outward
// SIZE pop; the shell's size is now constant by design, so the pop is on opacity instead (snap to
// fully opaque, ease back). The tween drives `sv.flash` — a plain number on the visual state —
// rather than the sprites' own alpha, because `updateShieldOutline` rewrites sprite alpha every
// frame and would overwrite a sprite-level tween immediately.
export function flashShieldOutline(scene, sv) {
  if (!sv || !sv.active) return;
  sv.flash = 1;
  scene.tweens.add({ targets: sv, flash: 0, duration: SHIELD_HIT_FLASH_MS, ease: 'Quad.out' });
}
