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

// ── Pure state/appearance logic (no Phaser — unit-tested in shieldOutline.test.js) ───────────

// Is the outline supposed to be showing right now? The ONLY rule: a live pool. Regen brings it
// straight back, which is the whole point of #302 (a shielded enemy the player chipped but didn't
// burst down visibly re-shells itself).
export function shieldOutlineActive(shield) {
  return (shield?.hp || 0) > 0;
}

// Opacity for this frame: fades with the remaining FRACTION of the pool rather than a flat on/off,
// so the player gets an at-a-glance "how much is left" read (same spirit as the HUD sprint bar,
// drawn in-world since this is a persistent-on-the-unit indicator). A slow ambient hum keeps an
// idle glow reading as "live" rather than a flat decal. `t` is accumulated ms.
export function shieldOutlineAlpha(pool, cap, t) {
  const frac = Math.max(0.15, Math.min(1, pool / (cap || pool || 1)));
  const pulse = 0.5 + 0.5 * Math.sin(t * 0.0025);
  return (0.35 + 0.45 * frac) * (0.85 + 0.3 * pulse);
}

// ── Phaser-side construction / per-frame upkeep ──────────────────────────────────────────────

// Build the outline duplicates for one unit's view and return its visual state. `scale` is the
// display scale of the real sprites (the outline is drawn slightly larger). Callers decide
// whether a unit gets one at all: the PLAYER always does (its shield capacity can appear later,
// when the Shield powerup boosts a zero-capacity chassis — Mech.boostShield), while an ENEMY only
// gets one if its kind data configures a shield (`shieldPresent`), so the great majority of
// enemies hold no outline sprites and make no per-frame call whatsoever.
export function makeShieldOutline(scene, view, { keys, scale, color = SHIELD_COLOR }) {
  const baseScale = scale * SHIELD_OUTLINE_SCALE_MULT;
  const outlines = {};
  for (const key of keys) {
    const real = view[key];
    if (!real) continue;
    const o = scene.add.sprite(real.x, real.y, real.texture.key)
      .setOrigin(real.originX, real.originY)
      .setScale(baseScale)
      .setTintFill(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setVisible(false);
    outlines[key] = o;
    // Behind everything already in the container (the real parts) — order among the outlines
    // themselves doesn't matter since they're additive-blended and fully hidden by the real art.
    view.addAt(o, 0);
  }
  return { outlines, active: false, t: 0, baseScale };
}

// Per-frame upkeep for ONE unit's outline. Shows/hides on the 0↔>0 edge (pickup / regen-back-up /
// break); while active, re-poses each outline onto its real part (texture/position/rotation/origin
// all move) and sets the fraction-driven alpha. Bails out before touching any sprite when the pool
// is empty — see the perf note in the header; powerups.test.js locks this in.
// Part keys come from the outline set itself, so this never needs to know which body type it's
// driving.
export function updateShieldOutline(sv, view, shield, delta) {
  if (!sv) return;
  const pool = shield?.hp || 0;
  const active = shieldOutlineActive(shield);
  const keys = Object.keys(sv.outlines);
  if (active !== sv.active) {
    for (const key of keys) sv.outlines[key].setVisible(active);
    sv.active = active;
    if (!active) sv.t = 0;
  }
  if (!active) return;
  sv.t += delta;
  const alpha = shieldOutlineAlpha(pool, shield.max, sv.t);
  for (const key of keys) {
    const real = view[key];
    const o = sv.outlines[key];
    if (o.texture.key !== real.texture.key) o.setTexture(real.texture.key);
    o.setPosition(real.x, real.y);
    o.setOrigin(real.originX, real.originY);
    o.rotation = real.rotation;
    o.setAlpha(alpha);
  }
}

// A brief outward pulse the instant the shield actually absorbs a hit — reinforces the 'shielded'
// floating text (combat.js) with something ON the unit itself. Tween-driven like the impact
// `_burst` primitive, but reusing the outline sprites' own persistent shapes.
export function flashShieldOutline(scene, sv) {
  if (!sv || !sv.active) return;
  const targets = Object.values(sv.outlines);
  for (const o of targets) o.setScale(sv.baseScale * SHIELD_HIT_FLASH_MULT);
  scene.tweens.add({
    targets, scaleX: sv.baseScale, scaleY: sv.baseScale, duration: 220, ease: 'Quad.out',
  });
}
