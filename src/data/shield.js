// Full-body shield layer (#246). Shields are FULL-MECH/full-unit (one pool covering the whole
// body), sitting in front of the per-location armor+hp stack rather than tracked per location.
// Shared by Mech (the player + mech-kind enemies) and HpBody (non-mech vehicle kinds) so the
// regen/hit-pause state machine lives in exactly ONE place instead of being duplicated per body
// type. Pure — no Phaser, no live Mech reference — so it's fully unit-tested in isolation.
//
// Config shape (chassis/kind data, or a constructor override): { max }. `max <= 0` (or no config
// at all) means "no shield at all" — some enemy kinds opt out entirely (see data/enemyKinds.js),
// which is exactly the point of formalizing this as configurable data instead of a powerup-only
// bolt-on. Per-kind `max` is the ONLY per-kind shield dial; the pause and the regen rate are
// shared across every shield (player and every enemy) — see the two constants below.
//
// #382: ONE shared pause and ONE shared regen rule for ALL shields (Jackson: "that should all be
// the same for all enemies and player, for now"). Replaces #380's per-kind `pauseMs`/`regenPerSec`
// table.
//
// Regen model (#246 decision, unified by #382): passive, continuous — but any hit that reaches the
// shield causes a BRIEF pause before regen resumes (not a long multi-second shooter-style lockout).
//   * SHIELD_PAUSE_MS — that brief window; `tickShield` counts it down before any regen accrues.
//   * SHIELD_REGEN_FRACTION — regen is a FRACTION OF MAX per second (not an absolute number and not
//     a fraction of *current*). 0.25/s ⇒ every shield refills in exactly 1/0.25 = 4s regardless of
//     pool size: a 5-pt drone regens 1.25/s, a 100-pt player 25/s, both full 4s after the pause.
//     Fraction-of-MAX is LINEAR and fully refills; fraction-of-current would be exponential and
//     asymptote (never fill) — a bug, not the intent.
export const SHIELD_PAUSE_MS = 3000;
export const SHIELD_REGEN_FRACTION = 0.25;

export function createShield(config) {
  const max = Math.max(0, config?.max ?? 0);
  return {
    max,
    hp: max,
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
  if (absorbed > 0) shield.pauseRemaining = SHIELD_PAUSE_MS;
  return { absorbed, overflow: raw - absorbed };
}

// Passive regen tick, `dt` in seconds (matches Mech.regenAmmo's convention). The hit-pause
// counts down first; only once it reaches zero does the shield actually recharge, at
// SHIELD_REGEN_FRACTION * max per second (percent-of-MAX, so linear and 4s to full), capped at max.
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
  shield.hp = Math.min(shield.max, shield.hp + SHIELD_REGEN_FRACTION * shield.max * dt);
}

// Instant fill (Shield powerup pickup, #246): top the shield to full immediately. No-op on a
// body with no shield at all.
export function fillShield(shield) {
  if (shieldPresent(shield)) shield.hp = shield.max;
}

// #381/#417: grant a TEMPORARY shield pool of `amount`. The pool PERSISTS UNTIL SPENT by incoming
// damage — it does NOT time-expire; only `damageShield` shrinks it. #417: the grant is ADDITIVE and
// UNCAPPED — each pickup ADDS its full `amount` ON TOP of whatever temp shield is already live, so
// sequential Shield powerups compound the shell without limit (it used to `Math.max`, taking the
// larger of the two, which meant a second pickup while one was live did nothing). The base shield is
// topped to full at the same time (the powerup's instant-fill half). Works even on a zero-`max` body
// so a shieldless chassis can still wear a temp pool.
//
// A caller MAY pass a finite positive `durationMs` to give the pool a wall-clock expiry (the old
// behaviour), but null/undefined/0/Infinity — the shield powerup's actual call — means PERMANENT
// (`tempExpiryMs = Infinity`), so `tickShield` never counts it down.
export function grantTempShield(shield, amount, durationMs) {
  if (!shield) return;
  const grant = Math.max(0, amount || 0);
  shield.temp = (shield.temp || 0) + grant;
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

// ── Category-vs-layer damage multipliers (#246 seam, FILLED IN by #576) ─────────────────────
// #246 architected this as a pure-data seam and left it empty on purpose, so categories only ever
// picked a hardpoint colour. #576 is the pass that gives them real mechanical identity. Jackson:
// "yes — energy vs shields, ballistic vs armor. The classic split: energy strips shields fast,
// ballistic chews armor." That is what makes a loadout choice mean something and what turns the
// existing category colour language from decoration into information.
//
// THE NUMBERS (a conservative first pass, expected to be TUNED IN PLAY):
//   energy     1.5x vs shield, 0.75x vs armor — strips the energy screen, poor against plate.
//   ballistic  0.75x vs shield, 1.5x vs armor — the exact inverse; slugs bounce off a shield.
//   missile    1.0 / 1.0, DELIBERATELY NEUTRAL. Missile identity is its DELIVERY (arcing, homing,
//              cluster, splash — axis 2 in weapons.js), not a damage type. Giving it a third
//              specialisation would blunt the only choice this feature actually creates: whether
//              to bring an answer for shields or an answer for armor. A missile rack is the
//              always-adequate option, which is a real position, not an absence of one.
//   support    1.0 / 1.0, for the same reason from the other end: a support weapon's point is not
//              damage at all (Gravity Well's damage is near-zero by design — see weaponStats.js),
//              so a damage-type modifier on it would be noise on a number nobody reads.
// Every category is written out explicitly, including the neutral pair, so this table shows the
// DECISION rather than an omission.
//
// STRUCTURE (hp) is deliberately absent and therefore neutral for everybody: once you are through
// the shield and the plate, damage is damage. Adding a third specialisation there would make the
// two that matter unreadable.
export const LAYER_MULTIPLIERS = {
  energy:    { shield: 1.5,  armor: 0.75 },
  ballistic: { shield: 0.75, armor: 1.5 },
  missile:   { shield: 1,    armor: 1 },
  support:   { shield: 1,    armor: 1 },
};

export function layerMultiplier(weaponCategory, layer) {
  return LAYER_MULTIPLIERS[weaponCategory]?.[layer] ?? 1;
}

// ── Converting a hit between "raw damage" and one layer's own currency (#576) ────────────────
// The multipliers above have to be applied PER LAYER while a single hit passes through several of
// them, so the pipeline can't just scale the incoming number once up front. The rule both bodies
// (Mech and HpBody) follow is:
//
//   raw ──scaleForLayer──▶ that layer absorbs what it can ──unscaleFromLayer──▶ raw for the next
//
// Worked example, 10 raw energy damage into a 6-point shield backed by armor:
//   10 raw × 1.5  = 15 shield-damage; the shield eats 6 and 9 is left over;
//   9 ÷ 1.5       = 6 raw still travelling; that 6 is then scaled by the ARMOR multiplier (0.75)
//                   into 4.5 armor-damage.
// So a shield that stops the hit stops it entirely, a shield that only partly stops it consumes
// exactly the share of the hit it was actually worth, and nothing double-counts a bonus.
export function scaleForLayer(raw, weaponCategory, layer) {
  return raw * layerMultiplier(weaponCategory, layer);
}
export function unscaleFromLayer(layerAmount, weaponCategory, layer) {
  const m = layerMultiplier(weaponCategory, layer);
  return m > 0 ? layerAmount / m : layerAmount;
}
