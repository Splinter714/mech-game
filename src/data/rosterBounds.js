// Roster-derived toughness bounds (#106 → #301).
//
// Several systems want to know "how tough was this kill, RELATIVE to the weakest and toughest
// things that exist in the game": the powerup drop curve (data/powerups.js) and the death-
// explosion size/sound tiers (scenes/arena/shared.js). Both used to carry HAND-SET floor/ceiling
// constants, and both drifted out of sync with the roster every time enemy stats moved — #128
// silently invalidated BOTH (the drop bounds were re-solved by hand in #106; the explosion
// ceiling stayed at a stale 616 until #301, well above the real toughest unit, so the biggest
// boom was literally unreachable).
//
// This module is the single derivation, so there is one place that answers "what is the range of
// toughness in the live game" and no near-copies to drift apart again. Retuning enemy health, or
// adding/removing a unit, needs NO edit in any consumer — the endpoints move on their own (which
// is what made #299's HP retune a no-op here).
//
// TOUGHNESS, not `maxHp`: `body.toughness` (structure + armor + shield) is exposed identically by
// `Mech` and the non-mech `HpBody`, so there's no per-kind branching at any call site. `maxHp`
// deliberately still means something narrower (HUD bars, crush damage) and is NOT interchangeable.

import { ENEMIES } from './enemies.js';
import { ENEMY_KINDS } from './enemyKinds.js';
import { Mech } from './Mech.js';
import { HpBody } from './HpBody.js';

// The toughness of every roster entry, whatever kind it is: mech enemies (data/enemies.js) build
// as `Mech`, vehicle kinds (data/enemyKinds.js) as `HpBody`. Both expose `.toughness`, so this is
// a straight read. Malformed/unbuildable entries are skipped rather than throwing.
function rosterToughnesses(enemies = ENEMIES, kinds = ENEMY_KINDS) {
  const out = [];
  for (const def of Object.values(enemies || {})) {
    try { out.push(new Mech(def).toughness); } catch { /* skip a malformed entry */ }
  }
  for (const def of Object.values(kinds || {})) {
    try { out.push(new HpBody(def).toughness); } catch { /* skip a malformed entry */ }
  }
  return out.filter((v) => Number.isFinite(v) && v > 0);
}

// Min/max toughness across a roster. Parameterized + pure (no memo-state) so tests can prove the
// endpoints actually TRACK the roster by passing a stubbed one. Degenerate empty roster returns a
// safe non-zero span so consumers never divide by zero.
export function rosterToughnessBounds(enemies = ENEMIES, kinds = ENEMY_KINDS) {
  const all = rosterToughnesses(enemies, kinds);
  if (!all.length) return { floor: 0, ceil: 1 };
  return { floor: Math.min(...all), ceil: Math.max(...all) };
}

// The LIVE roster's bounds, computed lazily ONCE on first use (the registries are static data, and
// building a few Mechs at module-eval time would be needless import-order coupling). Post-#299 this
// derives to floor 3 (infantry/drone, tied) and ceiling 500 (the heavy mech on the heavy
// chassis). #299 retuned every unit in the roster and needed ZERO edits here or in either
// consumer, which is exactly what this module was built for. Note the PLAYER's mech (600) sits
// deliberately OUTSIDE the span: only ENEMIES + ENEMY_KINDS are read, so "ceiling" means the
// toughest thing you FIGHT.
let _liveBounds = null;
export function liveToughnessBounds() {
  if (!_liveBounds) _liveBounds = rosterToughnessBounds();
  return _liveBounds;
}
