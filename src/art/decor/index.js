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

export function drawDecor(sg, mech, lay, T) {
  const a = mech.chassis.art;
  for (const d of a.decor || []) {
    const fn = DECOR_ART[d.kind];
    if (fn) fn(sg, d, lay, T);
  }
}
