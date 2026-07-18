// #269 §3/§5 (issue: base population rework — dormant docks + alert towers) — the alert tower's
// wake-countdown SENSOR, as a pure state machine (no Phaser). An `alertTower` terrain hex (data/
// terrain.js) is the sensor: each frame the scene tells this module whether the player is
// currently within the tower's detection radius; `tickAlertTower` folds that into a countdown
// ("radioing it in") and reports when the countdown COMPLETES (`triggered: true`), at which point
// the caller (scenes/arena/bases.js `_triggerAlert`) wakes the ONE base this tower is linked to —
// its own `baseId`, threaded through from `placeGapTowers` (data/worldgen.js, #284) — and its
// dormant docked units (`_wakeBase`).
//
// Kept deliberately simple per the issue's own scoping: leaving the detection radius before the
// countdown completes resets it to idle (no partial-progress memory — a stealth/tension WINDOW,
// not a persistent suspicion meter). If the tower is destroyed at any point, the scene simply
// stops ticking (or drops) its state entirely — see bases.js `_updateAlertTowers`, which checks
// `this.terrain.get(key) !== 'alertTower'` each tick and discards the state the instant the hex
// has collapsed to rubble, so a destroyed tower can never complete an already-running countdown.

// Detection radius (px) — a real "the player is loitering close enough to be noticed" envelope.
// Originally 260px (the same ballpark as awareness.js's NOISE_AGGRO_RANGE, "a gunshot nearby
// alerts an unaware enemy") paired with a 4000ms countdown — but #269 playtest follow-up found
// that combination was too tight to ever trigger from a normal drive-by. The longest possible
// chord through a 260px-radius circle is its 520px diameter; crossing that dead-centre, in a
// straight line, at each chassis's own top speed (chassis/*.js maxSpeed) took:
//   light (268px/s) 1.94s, medium (195px/s) 2.67s, heavy (135px/s, the SLOWEST/most generous
//   case) 3.85s — i.e. even the slowest chassis driving flat-out straight through the tower's
//   exact centre fell short of a 4000ms countdown. Any real, non-dead-centre pass (a shorter
//   chord) failed by a wider margin, so in practice only a player who stopped or circled near
//   the tower could ever complete it — not "driving past at normal speed" as intended.
// Bumped to 320px alongside the 3000ms countdown below (see its comment for the matching math)
// so a medium/heavy chassis crossing anywhere near the tower's centre — not just a dead-on
// diametric line — has a real chance to complete it, while light's higher top speed still lets
// it evade more reliably (an intentional emergent trade: light is the nimble, hard-to-snare
// chassis; heavy is slow but easy to detect). Owner: tunable via playtest.
export const ALERT_DETECT_RADIUS = 320;

// Countdown duration (ms) once the player is in range — "a few seconds" per the issue's own
// spec: long enough that simply passing through the radius briefly (a drive-by) doesn't
// automatically complete it, short enough that a player who doesn't notice/prioritize the tower
// genuinely risks the wake completing. #269 playtest follow-up: paired with the 320px radius
// above, a straight-line pass through the tower takes (at each chassis's top speed):
//   full 640px diameter — light 2.39s, medium 3.28s, heavy 4.74s;
//   average 503px chord (mean chord length of a circle, ~1.571×radius) — light 1.88s,
//   medium 2.58s, heavy 3.72s.
// 3000ms sits so medium/heavy complete the countdown on a typical (average-chord) pass, and
// comfortably on a more central one, while light needs to slow down or loiter near the centre
// to trigger it — still "a few seconds", still skippable by a fast/careful player, but no longer
// requiring the player to stop dead near the tower the way 4000ms@260px effectively did.
// Owner: tunable via playtest.
export const ALERT_COUNTDOWN_MS = 3000;

// Fresh, idle alert-tower state: not counting down, full countdown remaining, not yet triggered.
// `fraction` is how close the countdown is to completion — 0 (just started/idle) -> 1 (about to
// trigger) — kept as a derived-but-stored field (rather than making every caller recompute
// `1 - remainingMs/countdownMs`) so the scene-side visual/audio escalation (bases.js
// `_updateAlertTowers`) has a single ready-made "how urgent is this right now" number, and so
// it's directly assertable in tests without reaching into remainingMs/countdownMs math.
export function makeAlertState(countdownMs = ALERT_COUNTDOWN_MS) {
  return { countingDown: false, remainingMs: countdownMs, triggered: false, fraction: 0 };
}

// Advance one tick. `inRange` — is the player currently within the tower's detection radius this
// frame (the caller computes the actual distance check; this module knows nothing of world
// positions). Pure: always returns a NEW state object (never mutates `state`), so callers can
// diff old vs. new for a UI countdown display. Once `triggered`, the state is terminal — further
// ticks are a no-op (mirrors data/mission.js's sticky-terminal-status style).
export function tickAlertTower(state, { inRange, dt }, countdownMs = ALERT_COUNTDOWN_MS) {
  if (state.triggered) return state;
  if (!inRange) {
    // Leaving range before completion resets the countdown — no partial credit carried over
    // (kept simple per the issue: a stealth/tension window, not a persistent suspicion meter).
    // This is also the cancel signal the scene-side visual/audio escalation watches for
    // (`countingDown` false again) — resetting `fraction` to 0 alongside it tears the FX down.
    if (!state.countingDown && state.remainingMs === countdownMs) return state;
    return { countingDown: false, remainingMs: countdownMs, triggered: false, fraction: 0 };
  }
  const remainingMs = Math.max(0, state.remainingMs - Math.max(0, dt) * 1000);
  const fraction = countdownMs > 0 ? Math.min(1, 1 - remainingMs / countdownMs) : 1;
  if (remainingMs <= 0) return { countingDown: true, remainingMs: 0, triggered: true, fraction: 1 };
  return { countingDown: true, remainingMs, triggered: false, fraction };
}
