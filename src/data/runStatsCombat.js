// #423 phase 2 — the two PURE combat-math seams the arena wiring needs, factored out of the
// scene so they can be unit-tested without Phaser (the rest of the wiring is scene-side and
// exercised in play). No imports, no side effects.

// Total remaining durability of a unit RIGHT NOW — every layer an attacker still has to chew
// through: each live location's armor + hp, plus the current shield pool (base + temp). Uniform
// over a Mech and the non-mech HpBody, since both expose `.parts` (a map of {armor,hp} records)
// and, optionally, `shieldTotalHp()`. Used to size a killing blow's OVERKILL (see overkillFor).
export function remainingDurability(mech) {
  if (!mech) return 0;
  let total = 0;
  const parts = mech.parts || {};
  for (const key of Object.keys(parts)) {
    const p = parts[key] || {};
    total += (p.armor || 0) + (p.hp || 0);
  }
  if (typeof mech.shieldTotalHp === 'function') total += Math.max(0, mech.shieldTotalHp() || 0);
  return total;
}

// Damage spilled past what was needed to down the target: only a KILLING blow overkills, and only
// by however much the raw incoming `damage` exceeded the durability that was still standing before
// it landed. A non-kill (or a hit that exactly finishes the unit) overkills 0.
export function overkillFor(damage, remainingBefore, killed) {
  if (!killed) return 0;
  return Math.max(0, (damage || 0) - (remainingBefore || 0));
}
