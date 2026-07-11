// Combat music ducking (#108) — a subtle sidechain-style dip: when weapon-fire/impact/
// explosion cues fire, the MUSIC bus briefly attenuates and recovers, so combat SFX stay
// readable without the "pumping" effect of a hard, fully-releasing duck per shot.
//
// Pure envelope math, decoupled from WebAudio so it's directly unit-testable: given the
// timestamps (seconds, e.g. AudioContext.currentTime) of every combat SFX trigger so far and
// a query time `t`, `duckGainAt` returns the music gain MULTIPLIER (1 = full volume, `depth`
// = fully ducked) at that instant.
//
// Shape: on a trigger, the multiplier eases down toward `depth` over `attack` seconds, then
// holds there for `hold` seconds. A trigger arriving before the hold expires EXTENDS the hold
// (found by walking back through the trigger run while consecutive gaps stay <= `hold`) rather
// than re-triggering the attack ramp from 1 — so sustained fire pins the duck at a steady depth
// instead of oscillating with every shot. Once `hold` elapses with no further trigger, the
// multiplier eases back to 1 over `release` seconds. `triggers` must be sorted ascending
// (callers append monotonically-increasing timestamps, which already satisfies this).
export const DUCK_DEFAULTS = Object.freeze({
  depth: 0.78,     // music dips to ~78% of its normal level — subtle, not a hard drop
  attack: 0.05,    // 50ms ease-down — fast enough to feel connected to the shot, no click
  hold: 0.15,      // stays ducked this long past the last trigger (merges rapid-fire shots)
  release: 0.4,    // ~400ms ease back up to full — quick recovery, no lingering "pump"
});

export function duckGainAt(triggers, t, cfg = DUCK_DEFAULTS) {
  const { depth, attack, hold, release } = cfg;
  if (!triggers || !triggers.length) return 1;

  let idx = -1;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i] <= t) idx = i;
    else break;
  }
  if (idx === -1) return 1;   // every trigger is still in the future relative to t

  const last = triggers[idx];
  // Where this continuous run of triggers began (consecutive gaps <= hold) — the attack ramps
  // from the run's START, not from each individual shot, so sustained fire doesn't re-attack.
  let start = last;
  for (let i = idx; i > 0; i--) {
    if (triggers[i] - triggers[i - 1] <= hold) start = triggers[i - 1];
    else break;
  }
  const windowEnd = last + hold;
  const attackValue = (dt) => 1 - (1 - depth) * (1 - Math.exp(-Math.max(0, dt) / Math.max(1e-6, attack)));
  if (t <= windowEnd) return attackValue(t - start);
  // Past the hold window — ease back up to 1 starting from wherever the attack curve actually
  // was at windowEnd (v0), not from an idealized `depth` — keeps the curve continuous even when
  // the attack hasn't fully settled by the time the hold expires.
  const v0 = attackValue(windowEnd - start);
  const rt = t - windowEnd;
  return 1 - (1 - v0) * Math.exp(-rt / Math.max(1e-6, release));
}
