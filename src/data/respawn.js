// Co-op RESPAWN (#348, phase 2 of local co-op — parent #335).
//
// Jackson's framing, verbatim in the issue: "20 seconds, at the far edge of the current view,
// gated on the surviving player not having taken fire for 1-2 seconds."
//
// The out-of-combat gate is the point of the design, not a detail of it: without it a respawn
// lands in the middle of the firefight that just killed you and you die again immediately. With
// it, the timer running out is necessary but not sufficient — the survivor also has to have
// broken contact. That gives the survivor a reason to disengage and back off rather than tank
// the fight, which is the co-op behaviour the gate is there to produce.
//
// Pure: no scene, no Phaser. The arena wires it in scenes/arena/coop.js.

// The wait itself. Long enough that dying costs the team something real.
export const RESPAWN_DELAY_MS = 20000;

// How long every surviving player must have gone WITHOUT taking a hit before a finished timer
// is allowed to actually place the mech. Jackson gave a 1-2s range; 1500ms sits in the middle —
// long enough that it genuinely means "the shooting stopped", short enough that it is not a
// second wait bolted onto the first.
export const OUT_OF_COMBAT_MS = 1500;

// A downed player's respawn clock. `remainingMs` null = not waiting to respawn at all.
export function makeRespawnState() {
  return { remainingMs: null, waitingOnCombat: false };
}

// Called the moment a player dies. Idempotent — a second call while already counting down does
// not restart the clock, so a stray extra death event cannot extend the wait.
export function startRespawn(state) {
  if (state.remainingMs != null) return state;
  return { remainingMs: RESPAWN_DELAY_MS, waitingOnCombat: false };
}

// Advance one frame. `msSinceAnyPlayerHit` is how long ago the most recent hit on ANY live
// player landed (Infinity if nobody has been hit at all this run). Returns the next state plus
// `ready`, which is true only on the frames where BOTH conditions hold — the clock has run out
// AND the team is out of combat.
//
// The clock keeps ticking while the survivor is under fire; it is the PLACEMENT that waits, not
// the countdown. That way taking fire late in the 20s does not silently add 20 more seconds —
// it adds at most the 1.5s quiet window, once the shooting actually stops. `waitingOnCombat`
// records that we are in that held state so the HUD/report can say why nothing is happening.
export function tickRespawn(state, dtMs, msSinceAnyPlayerHit = Infinity) {
  if (state.remainingMs == null) return { state, ready: false };
  const remainingMs = Math.max(0, state.remainingMs - dtMs);
  const timerDone = remainingMs <= 0;
  const outOfCombat = msSinceAnyPlayerHit >= OUT_OF_COMBAT_MS;
  const ready = timerDone && outOfCombat;
  return {
    state: { remainingMs: ready ? null : remainingMs, waitingOnCombat: timerDone && !outOfCombat },
    ready,
  };
}

// WHERE the respawn lands: "the far edge of the current view". `view` is the camera's world-space
// rect ({x, y, width, height}); the candidates are its four edge midpoints, pulled in by `margin`
// so the mech materialises just inside the frame rather than half off it — the player has to be
// able to SEE themselves arrive.
//
// "Far" is measured against the threats: the winning edge is the one whose nearest threat is
// furthest away, which puts the returning player on the opposite side of the screen from the
// fighting. That is the same intent as the out-of-combat gate, applied in space instead of time.
// With no threats at all every edge scores identically and the first (top) wins deterministically.
export function pickRespawnPoint(view, threats = [], margin = 60) {
  const { x, y, width, height } = view;
  const candidates = [
    { x: x + width / 2, y: y + margin },
    { x: x + width - margin, y: y + height / 2 },
    { x: x + width / 2, y: y + height - margin },
    { x: x + margin, y: y + height / 2 },
  ];
  let best = candidates[0], bestScore = -Infinity;
  for (const c of candidates) {
    let score = Infinity;
    for (const t of threats) score = Math.min(score, Math.hypot(t.x - c.x, t.y - c.y));
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}
