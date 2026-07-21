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
    // #381: TEMPORARY shield pool (D&D temp-HP). An expendable buffer sitting ON TOP of `max`,
    // granted by the Shield powerup (`grantTempShield`). Damage eats this FIRST (damageShield),
    // it NEVER regenerates (tickShield leaves it alone — regen only refills base `hp` to `max`),
    // and it PERSISTS UNTIL SPENT — the powerup grants it with `tempExpiryMs = Infinity`, so it
    // does NOT time-expire; only incoming damage drains it. Zero on every enemy and on a fresh
    // player, so all the temp-aware branches below are no-ops unless a powerup is live.
    temp: 0,
    tempExpiryMs: 0,
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
//
// #381: the TEMPORARY pool (`temp`) is the OUTERMOST layer — a hit spends it before touching the
// base shield hp, so the expendable buffer always drains first and, once gone, is gone (regen
// never refills it). A shield with `max <= 0` can still have a temp pool (a chassis with no
// native shield that grabbed the powerup), so the guard admits either.
export function damageShield(shield, amount) {
  const raw = Math.max(0, amount || 0);
  if (raw <= 0 || !shield || (shield.max <= 0 && (shield.temp || 0) <= 0)) {
    return { absorbed: 0, overflow: raw };
  }
  let remaining = raw;
  let absorbed = 0;
  if (shield.temp > 0) {
    const fromTemp = Math.min(shield.temp, remaining);
    shield.temp -= fromTemp;
    remaining -= fromTemp;
    absorbed += fromTemp;
  }
  if (remaining > 0 && shield.hp > 0) {
    const fromBase = Math.min(shield.hp, remaining);
    shield.hp -= fromBase;
    remaining -= fromBase;
    absorbed += fromBase;
  }
  if (absorbed > 0) shield.pauseRemaining = shield.pauseMs;
  return { absorbed, overflow: raw - absorbed };
}

// Passive regen tick, `dt` in seconds (matches Mech.regenAmmo's convention). The hit-pause
// counts down first; only once it reaches zero does the shield actually recharge, at
// `regenPerSec` per second, capped at `max`.
//
// #381: the temporary pool PERSISTS UNTIL SPENT — the shield powerup grants it with no finite
// expiry (`tempExpiryMs = Infinity`), so this tick leaves it completely alone: it is NEVER
// regenerated, NEVER lifts the regen ceiling (base `hp` still only ever refills up to base `max`),
// and NEVER time-decays. Only `damageShield` drains it. The optional-expiry branch below only
// fires when a caller passed a positive FINITE `tempExpiryMs`; it runs BEFORE the pause's early
// return so an expiry would tick independently of the hit-pause combat state.
export function tickShield(shield, dt) {
  if (!shield) return;
  if (shield.temp > 0 && Number.isFinite(shield.tempExpiryMs) && shield.tempExpiryMs > 0) {
    shield.tempExpiryMs = Math.max(0, shield.tempExpiryMs - dt * 1000);
    if (shield.tempExpiryMs <= 0) shield.temp = 0;
  }
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

// #381: grant a TEMPORARY shield pool of `amount`. The pool PERSISTS UNTIL SPENT by incoming
// damage — it does NOT time-expire; only `damageShield` shrinks it. The magnitude does NOT
// compound (a duplicate refreshes the pool to the same granted size, never a bigger one — mirrors
// #339's duration-stacks-not-magnitude rule). The base shield is topped to full at the same time
// (the powerup's instant-fill half). Works even on a zero-`max` body so a shieldless chassis can
// still wear a temp pool.
//
// A caller MAY pass a finite positive `durationMs` to give the pool a wall-clock expiry (the old
// behaviour), but null/undefined/0/Infinity — the shield powerup's actual call — means PERMANENT
// (`tempExpiryMs = Infinity`), so `tickShield` never counts it down.
export function grantTempShield(shield, amount, durationMs) {
  if (!shield) return;
  const grant = Math.max(0, amount || 0);
  shield.temp = Math.max(shield.temp || 0, grant);
  shield.tempExpiryMs =
    durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0
      ? Infinity
      : durationMs;
  fillShield(shield);
}

// Fraction of shield remaining, 0..1 (0 for an absent shield) — for HUD/visual readouts.
export function shieldFraction(shield) {
  return shieldPresent(shield) ? shield.hp / shield.max : 0;
}

// #381: TOTAL current shield hp / capacity INCLUDING the temporary pool — the numbers the HUD bar
// and the in-world glow read so both visibly GROW when a temp pool is live (base 100 + temp 150 ⇒
// a 250-wide bar) and shrink back as the pool is spent. Zero temp ⇒ identical to base hp/max, so
// every enemy and an un-buffed player are unchanged.
export function shieldTotalHp(shield) {
  if (!shield) return 0;
  return (shield.hp || 0) + (shield.temp || 0);
}
export function shieldTotalMax(shield) {
  if (!shield) return 0;
  return (shield.max || 0) + (shield.temp || 0);
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
