// #269 §3/§5 (issue: base population rework — dormant docks + alert towers) — the alert tower's
// wake-countdown SENSOR, as a pure state machine (no Phaser). An `alertTower` terrain hex (data/
// terrain.js) is the sensor: each frame the scene tells this module whether the tower is being
// ACTIVATED this frame (an `activate` signal — the scene ORs together any of: player within the
// tower's detection radius, a recent player gunshot near the tower, or the tower itself taking
// damage this frame — see bases.js `_updateAlertTowers`). `tickAlertTower` folds that into a
// countdown ("radioing it in") and reports when the countdown COMPLETES (`triggered: true`), at
// which point the caller (scenes/arena/bases.js `_triggerAlert`) wakes the ONE base this tower is
// linked to — its own `baseId`, threaded through from `placeGapTowers` (data/worldgen.js, #284) —
// and its dormant docked units (`_wakeBase`).
//
// #269 overhaul: the countdown is now STICKY. Once it has STARTED (any `activate` trigger fired,
// even for a single frame), it decrements monotonically to completion and NEVER resets — leaving
// the detection radius, the gunshot going stale, etc. do NOT cancel it. There is no partial-
// progress-then-reset stealth window any more: one gunshot near the tower, one hit on it, or one
// pass through its (now larger) radius COMMITS it to calling reinforcements. The ONLY thing that
// stops a running countdown is DESTROYING the tower — handled entirely scene-side: bases.js
// `_updateAlertTowers` checks `this.terrain.get(key) !== 'alertTower'` each tick and discards the
// state the instant the hex has collapsed to rubble, so a destroyed tower can never complete an
// already-running countdown. This module itself has no cancel path.

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
// Was 320px alongside the 3000ms countdown below — but with the #269 overhaul the countdown is
// now STICKY (see the header: any activation trigger commits the tower; leaving range no longer
// cancels it), so the radius no longer needs to be small enough to give the "diametric crossing
// takes ~one countdown" math a chance — merely TOUCHING the envelope for a single frame now
// commits the tower. That reframes the radius as a plain "how close before the tower notices you"
// detection envelope, and Jackson asked for a meaningfully larger one so a tower is a real
// presence to route around, not something you can hug past. Bumped to 480px (a 960px detection
// diameter — 1.5× the old 640px) so a tower's alert bubble spans a genuine chunk of corridor and
// a normal drive-by anywhere near it trips the (now one-frame-is-enough, sticky) countdown. The
// gunfire-noise and being-damaged triggers (bases.js `_updateAlertTowers`) commit it from even
// further out / regardless of distance, so this radius is only the FLOOR on "how close is close
// enough to notice you on sight alone". Owner: tunable via playtest.
export const ALERT_DETECT_RADIUS = 480;

// Countdown duration (ms) from the moment a tower is ACTIVATED to the moment it fires — "a few
// seconds" per the issue's own spec. With the #269 overhaul this is a STICKY commit timer, not a
// "stay-in-range this long" dwell timer: the instant any trigger fires (in-range / nearby gunshot
// / being hit), the tower is committed and this is simply the grace window the player has to
// DESTROY it before it radios the base — leaving range no longer buys the old "back off and it
// resets" reprieve. 3000ms keeps that window at "a few seconds": long enough that a player who
// immediately turns their guns on a just-tripped tower can plausibly drop it in time, short
// enough that ignoring it reliably wakes the base. Owner: tunable via playtest.
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

// Advance one tick. `activate` — is ANY activation trigger true this frame (the caller ORs
// together player-in-range / nearby-gunshot / tower-was-damaged; this module knows nothing of
// world positions or triggers, only the combined boolean). STICKY: once the countdown has started
// — either because `activate` fires this tick, or because `state.countingDown` was already latched
// true on a previous tick — it decrements toward completion and NEVER resets. There is no cancel
// path: `activate` going false again does nothing, the countdown keeps running (the scene stops it
// only by DROPPING the state when the tower is destroyed — see the module header). Pure: returns a
// NEW state object whenever it changes (never mutates `state`), so callers can diff old vs. new
// for a UI countdown display; returns the same `state` reference untouched when still idle
// (not-yet-activated) or already `triggered` (terminal — further ticks are a no-op).
export function tickAlertTower(state, { activate, dt }, countdownMs = ALERT_COUNTDOWN_MS) {
  if (state.triggered) return state;
  // Not started and not being activated this frame — stay idle (identity return, no new object).
  if (!state.countingDown && !activate) return state;
  const remainingMs = Math.max(0, state.remainingMs - Math.max(0, dt) * 1000);
  const fraction = countdownMs > 0 ? Math.min(1, 1 - remainingMs / countdownMs) : 1;
  if (remainingMs <= 0) return { countingDown: true, remainingMs: 0, triggered: true, fraction: 1 };
  return { countingDown: true, remainingMs, triggered: false, fraction };
}

// #385 — the pure "which tower is the siren source" rule. Once an alert tower has SIGNALED (its
// countdown completed and woke its base — scenes/arena/bases.js records it the frame
// `tickAlertTower` returns `triggered`), it keeps sirening + pulsing red until destroyed. The
// PULSE is per-tower, but only ONE siren VOICE plays at a time so a 24,000px run's many signaled
// towers don't stack into a wall of noise. That voice is driven by the NEAREST signaled-alive
// tower to the audio LISTENER (the local player — scenes/arena/players.js `listenerOf`, still the
// audio-listener seam post-#364's co-op split). This function is that selection, kept pure and
// unit-testable: given the signaled-alive towers (each `{ x, y, ... }`) and the listener's
// position, return the nearest tower (the SAME object reference passed in, so the caller reads
// its position/key straight back off it), or `null` when there are none — at which point the
// caller stops the siren. The caller passes a FRESH list every frame, so a tower dying simply
// drops out of the input and the next-nearest is returned automatically; reassignment needs no
// state kept here. Ties resolve to the first tower seen (stable, order-of-iteration).
export function pickSirenSource(towers, listenerX, listenerY) {
  let best = null;
  let bestDist = Infinity;
  for (const t of towers || []) {
    if (!t) continue;
    const dist = Math.hypot(t.x - listenerX, t.y - listenerY);
    if (dist < bestDist) { bestDist = dist; best = t; }
  }
  return best;
}
