// Pure status-effect helpers (#489) — a mech can carry any number of independently-tracked
// effects (currently just Plasma's burn), each ticking its own periodic damage at a fixed
// location. No status-effect concept existed anywhere in the engine before this: `groundFire`
// (napalm) is a ground HAZARD ZONE that ticks anyone standing in it, not something attached to a
// unit. Re-applying the SAME kind (owner decision, #489 triage) REFRESHES duration only — it
// never stacks into a second independent timer, so damage-per-tick stays flat regardless of how
// many times the target is re-hit while already burning.

// Add or refresh an effect on `effects` (a plain array), returning a NEW array — never mutates
// the input. Re-applying an already-present `kind` replaces its remaining duration/tick-damage/
// location with the new application's rather than adding a second entry.
export function applyStatusEffect(effects, kind, { duration, tickDamage, tickInterval = 1, location }) {
  const next = effects.filter((e) => e.kind !== kind);
  next.push({ kind, remaining: duration, tickDamage, tickInterval, location, sinceTick: 0 });
  return next;
}

// Advance every effect by `dt` seconds. Returns `{ effects, ticks }`: `effects` is the surviving
// array (new, never the input) — an effect whose duration just ran out is dropped; `ticks` lists
// every effect that crossed its own `tickInterval` THIS call, as `{ kind, tickDamage, location }`
// for the caller to actually apply as damage (this module never touches Mech/applyDamage itself).
export function tickStatusEffects(effects, dt) {
  const ticks = [];
  const next = [];
  for (const e of effects) {
    let remaining = e.remaining - dt;
    let sinceTick = e.sinceTick + dt;
    if (sinceTick >= e.tickInterval) {
      sinceTick -= e.tickInterval;
      ticks.push({ kind: e.kind, tickDamage: e.tickDamage, location: e.location });
    }
    if (remaining > 0) next.push({ ...e, remaining, sinceTick });
  }
  return { effects: next, ticks };
}
