// Full-body shield layer (#246). Shields are FULL-MECH/full-unit (one pool covering the whole
// body), sitting in front of the per-location armor+hp stack rather than tracked per location.
// Shared by Mech (the player + mech-kind enemies) and HpBody (non-mech vehicle kinds) so the
// regen/hit-pause state machine lives in exactly ONE place instead of being duplicated per body
// type. Pure — no Phaser, no live Mech reference — so it's fully unit-tested in isolation.
//
// Config shape (chassis/kind data, or a constructor override): { max, regenPerSec, pauseMs }.
// `max <= 0` (or no config at all) means "no shield at all" — some enemy kinds opt out entirely
// (see data/enemyKinds.js), which is exactly the point of formalizing this as configurable data
// instead of a powerup-only bolt-on.
//
// Regen model (#246 decision): passive + slow, continuous — but any hit that reaches the shield
// causes a BRIEF pause before regen resumes (not a long multi-second shooter-style lockout).
// `pauseMs` is that brief window; `tickShield` counts it down before any regen accrues.

export function createShield(config) {
  const max = Math.max(0, config?.max ?? 0);
  return {
    max,
    hp: max,
    regenPerSec: Math.max(0, config?.regenPerSec ?? 0),
    pauseMs: Math.max(0, config?.pauseMs ?? 0),
    pauseRemaining: 0,
  };
}

// Is a shield actually present (vs. a zero-capacity/absent config)? Callers (HUD, damage
// pipeline) use this to decide whether to show/consult the layer at all.
export function shieldPresent(shield) {
  return !!shield && shield.max > 0;
}

// Apply incoming damage to the shield first. Returns { absorbed, overflow } — `overflow` is
// what's left to pass through to the next layer (armor, then hp) on this SAME hit. Any hit that
// actually reaches the shield (absorbed > 0) resets the regen pause, even on the hit that breaks
// it (overflow > 0 too) — the pause is about "was just hit," not "is still up."
export function damageShield(shield, amount) {
  const raw = Math.max(0, amount || 0);
  if (!shieldPresent(shield) || raw <= 0) return { absorbed: 0, overflow: raw };
  const absorbed = Math.min(shield.hp, raw);
  shield.hp -= absorbed;
  if (absorbed > 0) shield.pauseRemaining = shield.pauseMs;
  return { absorbed, overflow: raw - absorbed };
}

// Passive regen tick, `dt` in seconds (matches Mech.regenAmmo's convention). The hit-pause
// counts down first; only once it reaches zero does the shield actually recharge, at
// `regenPerSec` per second, capped at `max`.
export function tickShield(shield, dt) {
  if (!shieldPresent(shield)) return;
  if (shield.pauseRemaining > 0) {
    shield.pauseRemaining = Math.max(0, shield.pauseRemaining - dt * 1000);
    return;
  }
  shield.hp = Math.min(shield.max, shield.hp + shield.regenPerSec * dt);
}

// Instant fill (Shield powerup pickup, #246): top the shield to full immediately. No-op on a
// body with no shield at all.
export function fillShield(shield) {
  if (shieldPresent(shield)) shield.hp = shield.max;
}

// Fraction of shield remaining, 0..1 (0 for an absent shield) — for HUD/visual readouts.
export function shieldFraction(shield) {
  return shieldPresent(shield) ? shield.hp / shield.max : 0;
}

// ── Damage-pipeline category-vs-layer seam (#246) ───────────────────────────────────────────
// Forward-compatibility scoping per the design decision: architect the pipeline so a FUTURE
// weapon-category-vs-layer bonus (e.g. energy strong vs shields, ballistic strong vs armor)
// can be added as a pure DATA change here, without touching Mech.applyDamage/HpBody.applyDamage
// or any call site's control flow. NOT implemented this pass — every entry defaults to 1.0, so
// every weapon damages every layer identically today. A future pass would populate
// LAYER_MULTIPLIERS (e.g. `{ energy: { shield: 1.5 }, ballistic: { armor: 1.3 } }`) and thread
// the attacking weapon's category id into `layerMultiplier` at the call sites — nothing else
// changes.
export const LAYER_MULTIPLIERS = {};

export function layerMultiplier(weaponCategory, layer) {
  return LAYER_MULTIPLIERS[weaponCategory]?.[layer] ?? 1;
}
