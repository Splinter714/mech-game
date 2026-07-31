// Weapon-mount art registry — the "what a mounted weapon looks like on the body" dispatcher.
// TWO-LEVEL lookup, both via bracket dispatch (no per-variant branching):
//   1. WEAPON_MOUNT_ART[weaponId] — a BESPOKE silhouette so each individual weapon reads
//      distinctly at a glance (Pulse Laser vs Rail Lance vs Flamethrower, …).
//   2. MOUNT_ART[category]       — the generic per-CATEGORY fallback, so a weapon WITHOUT
//      its own draw fn still gets a category-appropriate shape. Adding a new weapon never
//      requires art — it inherits its category silhouette until someone gives it a bespoke
//      one. (content-is-data ethos.)
// Each draw fn shares the signature `(sg, T, bx, frontY, s, n, cap, partW, partH, tag)` and glows
// its weapon's CATEGORY neon colour, so faction/type still reads even on a bespoke shape. `tag`
// (#585) is the shared dissect-vocabulary helper (collar/barrel/muzzle/color/detail) — see
// drawWeaponMount below.
// **Add a category mount = a new file + one appended line in MOUNT_ART. Add a bespoke weapon
// mount = one appended entry in WEAPON_MOUNT_ART (in ./weapons.js).**
import { neonFor, CENTER } from '../mechPrims.js';
import { draw as missile } from './missile.js';
import { draw as melee } from './melee.js';
import { draw as ballistic } from './ballistic.js';
import { draw as support } from './support.js';
import { draw as energy } from './energy.js';
import { WEAPON_MOUNT_ART } from './weapons.js';

export const MOUNT_ART = { missile, melee, ballistic, support, energy };
export { WEAPON_MOUNT_ART };

// Draw one mounted weapon's hardware. Prefer the weapon's bespoke silhouette; fall back to
// its category's generic shape; fall back again to energy for an unknown category. All three
// are bracket lookups so the shared dispatcher never branches on a variant literal.
// #433: the mount ALWAYS draws in the live CATEGORY neon `n` — the muzzle-off/overlay split is done
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
  const n = neonFor(catId);
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
