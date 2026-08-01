// Weapon-mount art registry — the "what a mounted weapon looks like on the body" dispatcher.
// TWO-LEVEL lookup, both via bracket dispatch (no per-variant branching):
//   1. WEAPON_MOUNT_ART[weaponId] — a BESPOKE silhouette so each individual weapon reads
//      distinctly at a glance (Pulse Laser vs Rail Lance vs Flamethrower, …).
//   2. MOUNT_ART[category]       — the generic per-CATEGORY fallback, so a weapon WITHOUT
//      its own draw fn still gets a category-appropriate shape. Adding a new weapon never
//      requires art — it inherits its category silhouette until someone gives it a bespoke
//      one. (content-is-data ethos.)
// Each draw fn shares the signature `(sg, T, bx, frontY, s, n, cap, partW, partH, tag)` and glows
// the neon `n` it is handed — its weapon's category ramp, so faction/type still reads even on a
// bespoke shape, unless the weapon overrides the colour of the round it fires (#583, `neonRamp`
// below). No draw fn picks its own colour. `tag` (#585) is the shared dissect-vocabulary helper
// (collar/barrel/muzzle/color/detail) — see drawWeaponMount below.
// **Add a category mount = a new file + one appended line in MOUNT_ART. Add a bespoke weapon
// mount = one appended entry in WEAPON_MOUNT_ART (in ./weapons.js).**
import { neonFor, CENTER } from '../mechPrims.js';
import { draw as missile } from './missile.js';
import { draw as melee } from './melee.js';
import { draw as ballistic } from './ballistic.js';
import { draw as support } from './support.js';
import { draw as energy } from './energy.js';
import { WEAPON_MOUNT_ART } from './weapons.js';
import { WEAPONS } from '../../data/weapons.js';
import { hslToInt } from '../../data/healthReadout.js';

export const MOUNT_ART = { missile, melee, ballistic, support, energy };
export { WEAPON_MOUNT_ART };

// ── #583: which neon a mount glows ───────────────────────────────────────────────────────
// A mount's glow is its weapon's CATEGORY neon (`neonFor`) — that's what makes type read off
// the silhouette. But a weapon can override the colour of the round it actually FIRES
// (`delivery.projectileColor`, data/delivery.js), and when it does, the category neon is a
// visible lie: the gun glows one colour and spits another. Plasma Coater hit this first and was
// patched with a hand-written NEON-shaped const living inside its own draw fn — which fixes that
// one weapon and guarantees the next one drifts exactly the same way, since nothing connects the
// two numbers.
//
// So the mount neon is now DERIVED from the weapon's own projectile colour whenever it declares
// one, and only falls back to the category ramp when it doesn't. Drift is structurally impossible
// after this: there is one number, in the weapon data, and both the round and the gun read it.
//
// `neonRamp` builds the halo/core/hot/edge spread around an arbitrary core. It is deliberately
// NOT applied to the four CATEGORIES ramps in mechPrims.js `NEON` — those are hand-tuned literals
// and stay byte-for-byte as they are; this only has to serve the override case. The stops mirror
// the relationship those hand-tuned ramps already hold: one hue throughout, halo dropped to ~0.70
// of the core's lightness at ~0.73 of its saturation, edge and hot progressively lightened toward
// white. Checked against Plasma Coater's hand-picked purple — the only override in the table
// today — it reproduces that ramp within ~6/255 on a single channel, so the one mount already
// using it does not visibly change.
//
// (`hslToInt` is reused from data/healthReadout.js rather than re-implemented here: same
// conversion, and a second copy is exactly the kind of drift this whole change exists to remove.)
const RAMP_CACHE = new Map();
export function neonRamp(core) {
  const cached = RAMP_CACHE.get(core);
  if (cached) return cached;
  const r = ((core >> 16) & 0xff) / 255, g = ((core >> 8) & 0xff) / 255, b = (core & 0xff) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const ramp = {
    halo: hslToInt(h, s * 0.73, l * 0.70),
    core,
    hot: hslToInt(h, s, 0.95),
    edge: hslToInt(h, s, 0.78),
  };
  RAMP_CACHE.set(core, ramp);
  return ramp;
}

// The neon one mounted weapon glows: its own projectile colour if it overrides one, else its
// category's shared ramp.
export function neonForWeapon(weaponId, catId) {
  const override = WEAPONS[weaponId]?.delivery?.projectileColor;
  return override != null ? neonRamp(override) : neonFor(catId);
}

// Draw one mounted weapon's hardware. Prefer the weapon's bespoke silhouette; fall back to
// its category's generic shape; fall back again to energy for an unknown category. All three
// are bracket lookups so the shared dispatcher never branches on a variant literal.
// #433: the mount ALWAYS draws in the live neon `n` — the muzzle-off/overlay split is done
// entirely by the scaledGraphics gates (`sg.glowSkip` on the base part omits the emissive layers →
// transparent; `sg.glowOnly` on the overlay keeps only them), not by darkening the colour here. Every
// coloured muzzle layer is flagged emissive (glowDot/glowBar, or wrapped in `emissive()`), so those
// gates capture EXACTLY the glow and base + overlay recombine to the original inline look per weapon.
// `partW`/`partH` (design units, optional): the mount's owning part's own plate dimensions —
// e.g. the arm plate's `p.w`/`p.h` — so a bespoke mount fn that wants to sit FLUSH with the
// part's own plate outline (rather than a fixed hand-tuned size/position) can size and place
// itself off the real geometry instead of a guessed constant. Trailing/optional so every
// existing draw fn (which ignores extra args) is unaffected.
export function drawWeaponMount(sg, T, weaponId, catId, bx, frontY, s, partW, partH) {
  const n = neonForWeapon(weaponId, catId);   // #583: the round's colour if it declares one
  const cap = frontY + CENTER - 2;            // keep the muzzle inside the canvas
  const drawFn = WEAPON_MOUNT_ART[weaponId] ?? MOUNT_ART[catId] ?? MOUNT_ART.energy;
  // Live-chat ask: expand the art-dissect tool's drill-down to individual mount pieces (not just
  // the whole 'weapons' blob), so screenshot feedback can reference a specific sub-piece by name.
  // Tagging by weaponId here (nested under drawWeaponsAt's 'weapons' tag) makes every mount its
  // own drillable panel; the sub-tags below split it further.
  sg.layer(`weapons.${weaponId}`);
  // #585: ONE standardized five-term sub-vocabulary, used identically by EVERY mount fn (bespoke
  // and category fallback alike) so the dissect tool can compare the same piece across weapons —
  // "the barrel of the Rail Lance vs. the barrel of the Autocannon" — instead of each mount
  // inventing its own names (only plasmaCoater had any, and it hardcoded its own weapon id into
  // the tag string). The terms, in the order a mount generally draws them:
  //   collar — the structural chunk bolted to the mech (housing, breech, base, mounting collar)
  //   barrel — the emitting body: the projecting tube(s), a launcher's launch tubes/cells, a blade
  //   muzzle — the physical BARREL-TIP HARDWARE, where a mount has one: a flared, belled or capped
  //            end piece at the business end of the barrel (a lens collar, a flared cup/nozzle, a
  //            muzzle brake, a shotgun funnel, a rim collar, a launch lip). Solid hardware only —
  //            the glow at the tip is `color`, not this. Roughly a third of the mounts have no such
  //            piece and simply don't tag one.
  //   color  — every LIT layer: glowDot/glowBar and every `emissive()`-wrapped coloured layer. That
  //            is EXACTLY the set the sg.glowSkip/glowOnly gates split into the separate muzzle-glow
  //            overlay texture (see `emissive()` in mechPrims.js, drawPartGlow in mechArt.js), so
  //            the `color` panel in the dissect tool IS that overlay's contents, per weapon. Named
  //            for what it carries — the weapon's category neon — rather than for where it sits.
  //   detail — the residual: trim that is none of the above (a tube yoke, accelerator rails).
  //            Deliberately FLAT/unsegmented — sub-names under it would be per-weapon and
  //            unstandardized, which is the thing this vocabulary exists to remove. A piece worth
  //            isolating belongs in one of the other four instead.
  // Not every mount draws all five; a fn only tags what it actually has. `tag` is threaded down as
  // a trailing arg rather than each fn rebuilding the prefix, so the weapon id lives in exactly
  // one place — here.
  const tag = (name) => sg.layer(`weapons.${weaponId}.${name}`);
  drawFn(sg, T, bx, frontY, s, n, cap, partW, partH, tag);
}
