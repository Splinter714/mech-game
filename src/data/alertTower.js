// #269 §3/§5 (issue: base population rework — dormant docks + alert towers) — the alert tower's
// wake-countdown SENSOR, as a pure state machine (no Phaser). An `alertTower` terrain hex (data/
// terrain.js) is the sensor: each frame the scene tells this module whether the player is
// currently within the tower's detection radius; `tickAlertTower` folds that into a countdown
// ("radioing it in") and reports when the countdown COMPLETES (`triggered: true`), at which point
// the caller (scenes/arena/bases.js) resolves the single nearest base and wakes its dormant
// docked units (data/bases.js `nearestBaseTo` + `_wakeBase`).
//
// Kept deliberately simple per the issue's own scoping: leaving the detection radius before the
// countdown completes resets it to idle (no partial-progress memory — a stealth/tension WINDOW,
// not a persistent suspicion meter). If the tower is destroyed at any point, the scene simply
// stops ticking (or drops) its state entirely — see bases.js `_updateAlertTowers`, which checks
// `this.terrain.get(key) !== 'alertTower'` each tick and discards the state the instant the hex
// has collapsed to rubble, so a destroyed tower can never complete an already-running countdown.

// Detection radius (px) — a real "the player is loitering close enough to be noticed" envelope.
// Picked in the same ballpark as awareness.js's NOISE_AGGRO_RANGE (260px, "a gunshot nearby
// alerts an unaware enemy") since both are "is the player doing something conspicuous nearby"
// checks — this one keys off proximity alone (no noise event needed) since a sensor tower is
// always "listening", not just reacting to gunfire. Owner: tunable via playtest.
export const ALERT_DETECT_RADIUS = 260;

// Countdown duration (ms) once the player is in range — "a few seconds" per the issue's own
// spec: long enough that simply passing through the radius briefly (a drive-by) doesn't
// automatically complete it, short enough that a player who doesn't notice/prioritize the tower
// genuinely risks the wake completing. 4s gives a stealthy player a real (but not generous)
// window to spot and destroy the tower first. Owner: tunable via playtest.
export const ALERT_COUNTDOWN_MS = 4000;

// Fresh, idle alert-tower state: not counting down, full countdown remaining, not yet triggered.
export function makeAlertState(countdownMs = ALERT_COUNTDOWN_MS) {
  return { countingDown: false, remainingMs: countdownMs, triggered: false };
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
    if (!state.countingDown && state.remainingMs === countdownMs) return state;
    return { countingDown: false, remainingMs: countdownMs, triggered: false };
  }
  const remainingMs = Math.max(0, state.remainingMs - Math.max(0, dt) * 1000);
  if (remainingMs <= 0) return { countingDown: true, remainingMs: 0, triggered: true };
  return { countingDown: true, remainingMs, triggered: false };
}
