// Chassis decor art registry — per-chassis structural ornaments (non-functional silhouette
// elements that change the LAYOUT, not just proportions: a bruiser's shoulder pauldrons, a
// scout's sensor mast, rear exhaust stacks). Each kind lives in its own file exporting
// `draw(sg, d, lay, T)`; the generic dispatcher walks the chassis' `art.decor` list and
// routes each entry by its `kind`. Unknown kinds are skipped (as the old chain did).
// **Add a decor kind = a new file + one appended line in DECOR_ART.**
import { draw as pauldron } from './pauldron.js';
import { draw as mast } from './mast.js';
import { draw as vane } from './vane.js';
import { draw as stack } from './stack.js';

export const DECOR_ART = { pauldron, mast, vane, stack };

// `opts.skip` is a list of decor kinds to NOT draw here (e.g. pauldrons, which ride on the
// pivoting side-torso textures so they cant with the side torso).
// #585 (art dissect): decor used to bake into ONE flat `decor` blob, so the tool couldn't tell a
// sensor mast from an exhaust stack. Each entry now gets its own `decor.<kind>` layer, and every
// decor draw fn takes the same trailing `tag(name)` helper the weapon mounts do so it can split
// its own pieces below that — the tag PREFIX is threaded in rather than hardcoded per fn, because
// the pauldron is also drawn from the side-torso texture under a different prefix entirely
// (drawPauldronFor, mechArt.js). `opts.prefix` is what lets that second call site reuse the same fn.
export function drawDecor(sg, mech, lay, T, opts = {}) {
  const a = mech.chassis.art;
  const skip = opts.skip || [];
  for (const d of a.decor || []) {
    if (skip.includes(d.kind)) continue;
    const fn = DECOR_ART[d.kind];
    if (fn) drawDecorPiece(sg, fn, d, lay, T, `${opts.prefix ?? 'decor'}.${d.kind}`);
  }
}

// One decor piece under `prefix`: set the whole-piece layer first (so anything the fn doesn't
// sub-tag still lands somewhere meaningful) then hand it a sub-tagger scoped to that prefix. The
// sub-tagger RETURNS the full dotted name as well as setting it, so a piece that draws a `plate()`
// can pass it straight through as `opts.tag` and get plate's own body/rim/ao furniture nested
// underneath without rebuilding the prefix by hand.
export function drawDecorPiece(sg, fn, d, lay, T, prefix) {
  sg.layer(prefix);
  fn(sg, d, lay, T, (name) => { const full = `${prefix}.${name}`; sg.layer(full); return full; });
}
