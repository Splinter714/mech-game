// Shared shield-outline visual (#302). ONE implementation of "a unit with a live shield pool
// wears a glowing rim hugging its own silhouette", driven by BOTH the player mech (the Shield
// powerup / the mech's native shield layer) and every shielded enemy: EVERY enemy mech (25/50/75 by
// weight class — data/enemies.js), the gunship's 15 and the recon drone's 5 (data/enemyKinds.js; the
// carrier was shielded too until #436 moved it to pure armor). #302's hard requirement: a future
// rework of the shield look must change player and enemies together in ONE edit, so the technique,
// the colour, the alpha curve and the hit-flash all live here and nothing outside this file knows
// how a shield is drawn.
//
// The technique (originally #205, on the player only): this repo's Phaser build can't rely on a
// WebGL-only postFX glow pipeline (a Canvas-renderer run has no glow FX at all), so the outline is
// the classic cheap 2D "duplicate" trick — for every sprite that makes up the unit's body, add a
// duplicate tinted solid shield-blue (`setTintFill`) stacked BEHIND all the real parts, drawn from a
// pre-baked SHELL raster of that sprite (its own art grown outward by a constant distance — see
// art/_frames.js `bakeShellTextures`). The real artwork fully covers each duplicate except a thin
// rim at its silhouette edge, which reads as a glowing outline hugging the unit's actual shape.
//
// #639 — WHY #302's one-edit rule needed enforcing rather than documenting: #397/#422 reworked that
// technique (scaled duplicate + ADD blend → baked constant-margin dilation + NORMAL blend) by
// changing the PLAYER's CALL SITE, because the look was configured through four `makeShieldOutline`
// options and only the player's baked the rasters it needed. Enemies kept passing the defaults and
// so kept the old look, for six issues, while this header still claimed one shared implementation.
// Every unit now bakes shell rasters, and the four options are gone — a caller can no longer choose
// a look, only describe its unit's structure, so the next rework really is one edit.
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
// vehicle view (enemies.js `_makeVehicleView`). Read fresh each frame since mech shoulder/arm
// sprites pivot (position + origin both change as they cant toward weapon convergence) and both
// hulls can swap texture through a walk cycle.
export const SHIELD_MECH_PART_KEYS = ['hull', 'shldL', 'shldR', 'armL', 'armR', 'turret'];
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

// #205 (playtest follow-up): how much bigger a duplicate is drawn than the real part it shadows.
// This is the LEGACY technique and is now only a safety net — see `makeShieldOutline`. Every unit
// in the game bakes shell rasters, so nothing should reach it; a unit that does gets a visible (if
// unevenly-thick) rim rather than no rim at all.
export const SHIELD_OUTLINE_FALLBACK_SCALE_MULT = 1.14;

// #397/#422/#639: the shell uses no scale multiplier AT ALL. A single % scale about the unit centre
// displaces each edge in proportion to its own distance from that centre, so a mech that is wider
// than it is deep necessarily wears a shell that is wider than it is deep — two passes of per-axis /
// per-part scale algebra could not fix that, because the silhouette isn't a rectangle. The shell is
// a BAKED DILATION of the unit's own art (mechArt.SHIELD_SHELL_PAD, baked by the shell pass in
// art/_frames.js) drawn at the unit's EXACT display scale — a constant outward distance on every
// side by construction.
//
// #639: that was the PLAYER's path only for a long time, because only the player theme baked shell
// rasters; enemies fell through to the scaled duplicate and an ADD blend, i.e. a visibly different
// shield. Both bakes now happen for every unit (mechArt.js for mechs of any theme,
// art/vehicles/index.js for every non-mech kind), so this is simply THE look and no caller chooses
// it — which is what #302 asked for in the first place.
//
// Optional-chained so a Phaser-less import of this module still evaluates; the real Phaser build
// always has BlendModes.NORMAL (=== 0). Only read at real sprite construction time.
// NORMAL, not ADD: an even, crisp blue rim thrown by solid plating, rather than an additive one that
// brightens wherever the unit's own emissive art sits behind it. It also can't accumulate a soft
// baked halo into a bubble the way ADD did (#397 — see the muzzle-glow note in buildMechTextures).
const SHIELD_OUTLINE_BLEND = Phaser.BlendModes?.NORMAL ?? 0;

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
// display scale of the real sprites. Callers decide whether a unit gets one at all: the PLAYER
// always does (its shield capacity can appear later, when the Shield powerup grants a temporary
// pool to a zero-capacity chassis — Mech.grantTempShield), while an ENEMY only gets one if its kind
// data configures a shield (`shieldPresent`), so the great majority of enemies hold no outline
// sprites and make no per-frame call whatsoever.
//
// #639: the only things a caller passes are STRUCTURE — which sprites make up this unit's body
// (`keys`), how big they're drawn (`scale`), where the duplicates land in the display list
// (`attach`), and `color` for the plasma-coat reuse below. HOW a shield is drawn — the blend mode,
// the baked-shell raster, the constant-distance dilation — is not a caller option at all any more.
// It used to be four of them (`scaleMult`/`blend`/`bakedShell`/`dilated`), and that is precisely how
// enemies ended up on a different-looking shield from the player's: #397/#422 changed the PLAYER's
// call site, and nothing made the enemy call site come along. Per #302 this file is supposed to be
// the one place that knows the answer, so now it simply is.
//
// `attach` (2026-07-31): where each duplicate lands in the display list. The default puts it BEHIND
// everything already in the unit's own container, which is what every arena view is. The GARAGE lab
// preview is not a container at all — it's a loose sprite stack living directly in the column layer
// (art/mechView.js `makeMechParts`) — so it hands in its own adder and orders the shells itself.
export function makeShieldOutline(scene, view, {
  keys, scale, color = SHIELD_COLOR, attach = (o) => view.addAt(o, 0),
}) {
  const outlines = {};
  const texMap = {};
  // Resolve a real part texture to the baked shell raster that shadows it. Memoised, and a FUNCTION
  // rather than a fixed table because the hull swaps texture through the walk cycle: each frame
  // has its own shell raster (`..._hull_7_shield`), and the frame the outline was BUILT on is not
  // the only one it will ever see.
  const resolveTex = (realKey) => {
    let mapped = texMap[realKey];
    if (mapped === undefined) {
      const shellKey = `${realKey}${SHIELD_SHELL_SUFFIX}`;
      mapped = scene.textures?.exists?.(shellKey) ? shellKey : realKey;
      texMap[realKey] = mapped;
    }
    return mapped;
  };
  for (const key of keys) {
    const real = view[key];
    if (!real) continue;
    const shieldKey = resolveTex(real.texture.key);
    // #422/#456: ONE constant scale per sprite, set once here and never touched again — the shell's
    // size is a property of the ART BAKE, not of the shield's strength, so nothing at runtime
    // rescales it. The shell raster is already grown outward by a constant distance at bake time, so
    // it is drawn at the unit's EXACT display scale.
    //   The fallback is the pre-#422 percentage duplicate, and only fires for a sprite whose texture
    // set somehow baked no shell. Nothing in the game should hit it (mech art bakes shells for every
    // theme, vehicle art for every kind); a sprite that does still shows a rim, just an uneven one.
    const dilated = shieldKey !== real.texture.key;
    const baseScale = dilated ? scale : scale * SHIELD_OUTLINE_FALLBACK_SCALE_MULT;
    // #397 follow-up: the outline is anchored at its TEXTURE CENTRE (origin 0.5,0.5), never the
    // real part's origin — a shoulder/arm real origin is the convergence PIVOT (a joint set
    // toward the part's REAR, PART_PIVOT in mechArt.js), and anchoring there threw the shell
    // forward off the nose. The per-frame driver positions this at the real part's texture-centre
    // so the two rasters stay perfectly registered.
    const o = scene.add.sprite(real.x, real.y, shieldKey)
      .setOrigin(0.5, 0.5)
      .setScale(baseScale)
      .setTintFill(color)
      .setBlendMode(SHIELD_OUTLINE_BLEND)
      .setVisible(false);
    outlines[key] = o;
    // Behind everything already in the container (the real parts) — order among the outlines
    // themselves doesn't matter since each is fully hidden by the real art except at its rim.
    attach(o);
  }
  return { outlines, active: false, t: 0, flash: 0, texMap, resolveTex };
}

// Per-frame upkeep for ONE unit's outline. Shows/hides on the 0↔>0 edge (pickup / regen-back-up /
// break); while active, re-poses each outline onto its real part (texture/position/rotation/origin
// all move) and sets the fraction-driven alpha. Bails out before touching any sprite when the pool
// is empty — see the perf note in the header; powerups.test.js locks this in.
// Part keys come from the outline set itself, so this never needs to know which body type it's
// driving.
// ── Shared per-frame geometry repose (2026-07-31) ────────────────────────────────────────────
// Factored out of `updateShieldOutline` so the plasma-burn "coating" outline below (same
// duplicate-sprite technique, different colour, different alpha driver — a DoT has no "HP" to
// read a fraction from) can reuse the exact same sprite-follows-its-real-part geometry rather
// than duplicating it. The only thing that differs between the two effects is what computes
// `alpha` each frame; the loop that walks every outline sprite onto its real part's live
// texture/position/rotation is identical either way.
function reposeOutlineSprites(sv, view, alpha) {
  for (const key of Object.keys(sv.outlines)) {
    const real = view[key];
    const o = sv.outlines[key];
    // Follow the real part's texture, but resolve through to its baked `_shield` shell raster —
    // the hull swaps frames through the walk cycle and each frame has its own shell. A sprite with
    // no shell raster resolves straight back to the real key (the fallback in makeShieldOutline).
    const desired = sv.resolveTex
      ? sv.resolveTex(real.texture.key)
      : (sv.texMap?.[real.texture.key] ?? real.texture.key);
    if (o.texture.key !== desired) o.setTexture(desired);
    // Register the (centre-anchored) outline onto the real part's TEXTURE CENTRE, wherever the
    // real part's own origin sits. The real shoulder/arm origin is its rear convergence joint,
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
  }
}

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
  reposeOutlineSprites(sv, view, lit);
}

// ── Showroom driver — the GARAGE lab preview (2026-07-31 live-chat ask) ──────────────────────
// Jackson: "add shield visual glow or whatever to the mech preview in garage". The garage is a
// showroom, not a combat readout: there is no live pool there to drain (the player's 100-point
// baseline is applied at DEPLOY — data/Mech.js PLAYER_SHIELD_CONFIG, and every player mech gets it
// unconditionally), so there is no fraction to read and no show/hide edge to drive. The preview
// simply wears, permanently, the shell a freshly-deployed mech wears: the outline is ALWAYS on, and
// its alpha is `shieldOutlineAlpha` at a full pool, so it sits at the same opacity and breathes with
// the same slow ambient hum as the real thing.
//
// This lives here rather than in GarageScene for #302's reason (see the file header): a rework of
// the shield look has to change every surface in ONE edit, and a garage preview that hand-rolled its
// own glow is exactly the drift that rule exists to prevent.
//
// It reposes every frame (rather than only when the preview's pose changes) purely because that's
// simpler and cannot go stale: the lab rebuilds/re-poses its preview on every mount, chassis and
// colour change, and six sprites in a menu scene cost nothing. `delta` is ms.
export function updateShowroomShieldOutline(sv, view, delta) {
  if (!sv || !view) return;
  if (!sv.active) {
    for (const key of Object.keys(sv.outlines)) sv.outlines[key].setVisible(true);
    sv.active = true;
  }
  sv.t += delta;
  reposeOutlineSprites(sv, view, shieldOutlineAlpha(1, 1, sv.t));
}

// ── Plasma-burn "coating" outline (2026-07-31 live chat ask) ────────────────────────────────
// Jackson: the plasmaBurn DoT's visual should read as a COATING on the mech itself, "more like
// the way shields are visualized, but a different color, like purple" — rather than the old
// floating pulsing circle at the unit's centre point (`_drawStatusEffects`, projectiles.js).
// Reuses `makeShieldOutline`'s sprite-construction (it takes `color` as a plain parameter, so no
// changes were needed there — and since #639 every other aspect of the look is shared with the
// shield outright) and the geometry factored out
// above; only the ALPHA driver differs, since a DoT has no "HP fraction" the way a shield pool
// does — it's simply present or not, so the outline pulses steadily for as long as the effect is
// on the target, rather than fading with remaining duration (duration ticks down in fixed-size
// steps via refresh-not-stack, so an ebbing alpha would be misleading — "10% duration left" is
// not a real per-frame quantity worth animating toward).
export const PLASMA_COAT_COLOR = 0xa04dff;   // distinct violet — clearly not shield-blue (0x2fa8ff)

// Playtest follow-up (2026-07-31): "I like the purple flashing, but maybe make the overall
// intensity of the purple stronger" — both ends of the pulse raised (0.32→0.5, 0.8→1.0, i.e. it
// now hits fully opaque at the peak instead of stopping short).
const DOT_ALPHA_MIN = 0.5;
const DOT_ALPHA_MAX = 1.0;
const DOT_PULSE_HZ = 0.0026;   // faster than the shield's ambient 0.0025 hum — reads as "actively burning"

// Opacity for this frame while a DoT coating is active — a steady pulse, no HP/duration fraction
// to read from (see header note above). `t` is accumulated ms since the coating last turned on.
export function dotOutlineAlpha(t) {
  const pulse = 0.5 + 0.5 * Math.sin(t * DOT_PULSE_HZ * Math.PI * 2);
  return DOT_ALPHA_MIN + (DOT_ALPHA_MAX - DOT_ALPHA_MIN) * pulse;
}

// Per-frame upkeep for ONE unit's plasma-coating outline — same show/hide-on-edge + early-exit-
// when-inactive shape as `updateShieldOutline`, just driven by a plain `active` boolean (is
// `plasmaBurn` currently in this unit's `statusEffects`?) instead of a shield pool.
export function updateDotOutline(sv, view, active, delta) {
  if (!sv) return;
  const keys = Object.keys(sv.outlines);
  if (active !== sv.active) {
    for (const key of keys) sv.outlines[key].setVisible(active);
    sv.active = active;
    if (!active) sv.t = 0;
  }
  if (!active) return;
  sv.t += delta;
  reposeOutlineSprites(sv, view, dotOutlineAlpha(sv.t));
}

// Playtest follow-up (2026-07-31): "a very mild flashing hue over the whole art in addition to
// the outline" — a light tint wash on the mech's own REAL part sprites (not the outline shells),
// so the whole mech reads as tinged purple while burning, not just its silhouette edge. Deliberately
// MILD: both stops are close to white (a straight RGB lerp is fine here — the range is narrow
// enough that HSL's muddy-midpoint problem, see healthReadout.js STRUCTURE_RAMP, never comes up),
// pulsing in sync with the outline's own alpha cadence so the two read as one effect breathing
// together, not two competing animations.
const DOT_TINT_LO = 0xe9d8ff;   // near-white, the faintest hint of lavender
const DOT_TINT_HI = 0xc48bff;   // still mild — nowhere near PLASMA_COAT_COLOR's full saturation

function lerpTint(lo, hi, t) {
  const lr = (lo >> 16) & 255, lg = (lo >> 8) & 255, lb = lo & 255;
  const hr = (hi >> 16) & 255, hg = (hi >> 8) & 255, hb = hi & 255;
  const r = Math.round(lr + (hr - lr) * t), g = Math.round(lg + (hg - lg) * t), b = Math.round(lb + (hb - lb) * t);
  return (r << 16) | (g << 8) | b;
}

// Uses the SAME pulse phase as `dotOutlineAlpha` (t is shared on `sv`) so the tint and the
// outline crest together.
export function dotTintColor(t) {
  const pulse = 0.5 + 0.5 * Math.sin(t * DOT_PULSE_HZ * Math.PI * 2);
  return lerpTint(DOT_TINT_LO, DOT_TINT_HI, pulse);
}

// Per-frame upkeep for the whole-art tint. Reuses `sv.outlines`' own keys (the parts that
// actually exist on this view — same set `updateDotOutline` already drives) so it never needs a
// separate part-key list threaded in. `sv.t` is shared with `updateDotOutline` — call this AFTER
// that each frame so `t` has already advanced.
export function updateDotTint(sv, view, active) {
  if (!sv) return;
  const keys = Object.keys(sv.outlines);
  if (!active) {
    for (const key of keys) view[key]?.clearTint();
    return;
  }
  const color = dotTintColor(sv.t);
  for (const key of keys) view[key]?.setTint(color);
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
