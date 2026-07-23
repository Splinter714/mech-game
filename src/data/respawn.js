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

// #394: the pure display state behind the IN-WORLD respawn countdown drawn at a downed player's
// wreck (coop.js `_updateRespawnMarkers`). Returns null when there is nothing to show (the player
// is not waiting to respawn), otherwise:
//   fraction — how full the draining ring is, 1 at the moment of death → 0 at zero (like the
//              powerup cooldown-pies), so the same 12-o'clock-clockwise arc reads as time left;
//   seconds  — the remaining wait, for the readout in the ring;
//   holding  — the out-of-combat gate is holding the placement (the clock hit zero but the
//              survivor is still under fire). The renderer shows this as a HELD/pulsing ring
//              rather than a frozen "0s", so a paused clock never reads as a bug.
export function respawnReadout(state) {
  if (!state || state.remainingMs == null) return null;
  const remainingMs = Math.max(0, state.remainingMs);
  return {
    fraction: Math.max(0, Math.min(1, remainingMs / RESPAWN_DELAY_MS)),
    seconds: remainingMs / 1000,
    holding: !!state.waitingOnCombat,
  };
}

// ── #394 (playtest follow-up): the HUD countdown ─────────────────────────────────────────────
//
// Jackson, 2026-07-22: "HUD timer + a better in-world cue" — the countdown goes on the HUD in the
// SAME visual language as the powerup timers, and the in-world marker is redesigned (the ground
// circle "looks kinda weird"), not replaced by the HUD line.
//
// The powerup timers are a stack of draining rings with a label and a seconds count beside them
// (HudScene `_updateBuffHud`). A respawn is exactly that shape of thing — a clock running down on
// a state you did not choose — so it becomes another ROW in that same stack rather than a second
// widget with its own idiom. This is the pure part: which rows exist, what each says, and how full
// its ring is. `snapshots` is the per-player HUD channel (data/hudLayout.js `hudPlayerSnapshot`),
// so this works identically for a solo death and for either co-op player.
//
// A HELD row (the clock is done but the out-of-combat gate is still holding placement) reports
// `holding` and a FULL ring: the renderer shows it breathing rather than parked at 0.0s, the same
// call the in-world marker makes, so the two readouts never disagree about why nothing is
// happening.
export function respawnHudRows(snapshots = []) {
  const rows = [];
  snapshots.forEach((s, i) => {
    if (!s?.dead) return;
    const r = respawnReadout(s.respawn);
    if (!r) return;
    rows.push({
      // Solo has nobody to be told apart from, so the row is just RESPAWN; co-op names the pilot
      // it belongs to — the same rule every other per-player label on the HUD follows.
      label: snapshots.length > 1 ? `P${i + 1} RESPAWN` : 'RESPAWN',
      color: s.color ?? null,
      // Held reads as a full ring (see above); otherwise the drain is the time left.
      fraction: r.holding ? 1 : r.fraction,
      seconds: r.seconds,
      holding: r.holding,
    });
  });
  return rows;
}

// ── #394 (playtest follow-up): the IN-WORLD marker, redesigned ───────────────────────────────
//
// The first cut drew a filled ring flat on the ground at the wreck; Jackson: "I'm seeing a respawn
// circle on the ground, which looks kinda weird". The problem is that a ring lying in the terrain
// reads as a DECAL — one more painted circle among the craters and scorch marks — rather than as
// something arriving.
//
// The replacement is a DROP ZONE: four corner brackets that CLOSE IN as the clock runs down (wide
// and loose at the moment of death, tight around the landing spot at zero), with a beacon column
// standing up out of the ground and a chevron sliding down it. Nothing is drawn as a closed
// circle, everything is off the ground plane, and the shape itself carries the countdown — so it
// reads at a glance from across the arena without anyone having to look at the number.
//
// Pure geometry, in LOCAL coordinates around the wreck (the scene adds the player's x/y), so it is
// testable and the renderer stays a painter.
export const RESPAWN_MARKER = {
  farHalf: 52,      // bracket square half-extent at the start of the wait...
  nearHalf: 20,     // ...and at zero, where it frames the returning mech
  armFrac: 0.36,    // how much of each side a corner bracket occupies
  beamH: 46,        // height of the beacon column above the wreck
  chevronDrop: 12,  // how far the sliding chevron travels along the column per cycle
  textLift: 14,     // the seconds readout, above the bracket square
};

// `readout` is `respawnReadout`'s result; `phase` is a 0..1 animation phase the scene drives off
// its own clock (the chevron's slide and the held pulse), kept as an argument so this stays pure.
export function respawnMarkerLayout(readout, phase = 0) {
  if (!readout) return null;
  const M = RESPAWN_MARKER;
  const p = Math.max(0, Math.min(1, phase));
  // `fraction` is time REMAINING, so the square closes as it falls: 1 ⇒ far, 0 ⇒ near.
  const half = readout.holding
    ? M.nearHalf
    : M.nearHalf + (M.farHalf - M.nearHalf) * readout.fraction;
  const arm = half * 2 * M.armFrac;
  // Four corners, each drawn as two arms running back along the square's sides toward its middle.
  const corners = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = sx * half, y = sy * half;
      corners.push({
        x, y,
        arms: [
          { x1: x, y1: y, x2: x - sx * arm, y2: y },
          { x1: x, y1: y, x2: x, y2: y - sy * arm },
        ],
      });
    }
  }
  return {
    half,
    corners,
    // The beacon column, standing UP out of the wreck (screen-up: negative y).
    beam: { x: 0, y1: 0, y2: -M.beamH },
    // ...and the chevron sliding down it, looping on the phase.
    chevronY: -M.beamH + M.chevronDrop * p,
    textY: -half - M.textLift,
    holding: !!readout.holding,
    // The held state breathes instead of sliding, so the scene has one number for both.
    pulse: p,
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
