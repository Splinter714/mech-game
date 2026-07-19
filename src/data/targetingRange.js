// Weapon-derived targeting range (#322).
//
// Convergence/lock used to carry TWO hand-set ranges: `ASSIST_RANGE` (2200) for enemies and
// `CONVERGE_DIST` (450) for destructible terrain. Both were arbitrary, they disagreed with each
// other, and 2200 was 450px PAST the longest weapon in the game — the player could lock something
// nothing in any loadout could reach.
//
// This is the single derivation instead, in the same spirit as `rosterBounds.js` (#106/#301):
// the game answers "how far can targeting reach" from the live `WEAPONS` table, so retuning a
// weapon's range — or adding a longer-ranged one — moves targeting with it and no constant
// anywhere needs re-solving by hand.
//
// The value is the LONGEST `range.max` across all weapons (swarmRack, 1750, today). Deliberately
// the max and not an average: targeting has to serve whatever the player actually mounted, and a
// build carrying the longest gun should be able to designate at that gun's full reach. Builds with
// shorter guns simply can't hit what they lock, which is honest — the weapon's own range check
// still applies at fire time.
//
// NOT to be confused with `CONVERGE_DIST` (arena/shared.js), which survives #322 in its OTHER
// role: the convergence GEOMETRY distance used when there is no target at all.

import { WEAPONS } from './weapons.js';

// Longest `range.max` in a weapon table. Entries without a numeric `range.max` (should not exist,
// but a malformed/partial entry must not poison the result) are skipped; an empty/garbage table
// falls back to 0 so callers get a defined number rather than -Infinity.
export function longestWeaponRange(weapons = WEAPONS) {
  let max = 0;
  for (const w of Object.values(weapons || {})) {
    const r = w?.range?.max;
    if (typeof r === 'number' && Number.isFinite(r) && r > max) max = r;
  }
  return max;
}

// The one targeting range: how far convergence/lock will consider ANY candidate — enemy, hex, or
// wall span alike (#322 scores all three by one rule).
export const TARGETING_RANGE = longestWeaponRange();
