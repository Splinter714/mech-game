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
//
// #348 (playtest 2026-07-19: "the respawned mech was spawned outside of the corridor in the
// 'impassible terrain'"): threat distance alone is NOT enough to pick a point. #340 made the world
// a long narrow lane whose lateral half-width is much SMALLER than the camera view, so the left
// and right edge midpoints of the view are routinely outside the corridor entirely — and the
// safest-from-threats edge is very often exactly one of those, since that is where the enemies
// aren't. The player then materialised stranded in impassable terrain.
//
// The rule now takes an optional `isValid(x, y)` predicate (the caller reads it off the live
// terrain map) and prefers the SAFEST VALID candidate rather than merely the safest one. The
// preference order is unchanged where it can be honoured; validity is a filter on top of it, not
// a replacement for it. Fallback is progressive rather than failing outright:
//   1. safest edge midpoint that is valid,
//   2. the view centre (in a narrow corridor the lane runs through the middle of the view, so
//      the centre is the most likely point to still be on playable ground),
//   3. the safest edge regardless of validity — the caller still snaps the result to the nearest
//      passable hex, so this is a starting point for that search, never a final answer.
// With no predicate at all the behaviour is exactly the pre-#348 rule.
export function pickRespawnPoint(view, threats = [], opts = {}) {
  const { margin = 60, isValid = null } = typeof opts === 'number' ? { margin: opts } : opts;
  const { x, y, width, height } = view;
  const candidates = [
    { x: x + width / 2, y: y + margin },
    { x: x + width - margin, y: y + height / 2 },
    { x: x + width / 2, y: y + height - margin },
    { x: x + margin, y: y + height / 2 },
  ];
  const threatDist = (c) => {
    let score = Infinity;
    for (const t of threats) score = Math.min(score, Math.hypot(t.x - c.x, t.y - c.y));
    return score;
  };
  // Safest first, ties broken by the candidates' original (deterministic) order.
  const ranked = candidates
    .map((c, i) => ({ c, i, score: threatDist(c) }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map((e) => e.c);
  if (!isValid) return ranked[0];
  for (const c of ranked) if (isValid(c.x, c.y)) return c;
  const centre = { x: x + width / 2, y: y + height / 2 };
  if (isValid(centre.x, centre.y)) return centre;
  return ranked[0];
}
