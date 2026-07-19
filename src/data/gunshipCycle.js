// #305: the GUNSHIP ATTACK CYCLE — the pure state machine behind `helicopterBehavior`.
//
// Playtest feedback (Jackson, 2026-07-18): "helicopters should do strafe firing, not flyby
// firing." The old behaviour, despite a variable called `strafe`, was a strike-aircraft flyby:
// pick a waypoint 220px along a perpendicular, fly there, flip sides, repeat — facing its own
// VELOCITY the entire time and hosing one weapon regardless of where it was pointed.
//
// The confirmed design is a THREE-PHASE cycle whose whole point is that WEAPON SELECTION IS
// DRIVEN BY FACING:
//
//   APPROACH   — nose-on. Turns to face the player and closes on him, firing the DUMBFIRE
//                Cluster Salvo forward along the airframe axis. Dumbfire was chosen over the
//                homing seeker deliberately, so a nose-on run is something the player can
//                sidestep. Ends when it reaches its standoff radius (or times out).
//   STRAFE     — broadside. Turns side-on and slides laterally across the player's front while
//                the door gun (single-lane-derived Repeater) chatters at him. This is the
//                "strafe firing" that was asked for. Ends on a timer.
//   REPOSITION — break off. Stops shooting, flies out to a NEW angle of attack (nose into
//                travel, an ordinary non-strafing cruise), then re-enters APPROACH.
//                Jackson's words: "after strafing by and shooting, it could fly off in a
//                non-strafing style, reposition, and then strafe-shoot again."
//
// NOTE this REVERSES an earlier answer in the same conversation — he first said the strafe phase
// should face the player, then on reflection chose broadside. Broadside is the live design.
//
// Why this file is pure. Motion can't be unit-tested, but the *machine* can: which phase follows
// which, on what trigger, what facing each phase wants, and which weapon slot each phase pulls.
// Keeping that here (no Phaser, no scene) makes all of it directly testable, and leaves
// `helicopterBehavior` as a thin adapter that turns a phase + facing mode into velocity.

export const APPROACH = 'approach';
export const STRAFE = 'strafe';
export const REPOSITION = 'reposition';

// Facing modes a phase can ask for. The behaviour maps these onto e.angle.
//   'player'    nose on the player (bearing)
//   'broadside' flank on the player (bearing ± 90°, per the unit's handedness)
//   'travel'    nose into its own velocity — the ordinary non-strafing cruise
export const FACE_PLAYER = 'player';
export const FACE_BROADSIDE = 'broadside';
export const FACE_TRAVEL = 'travel';

// Weapon SLOT keys (see data/kindWeapons.js). Role names, not weapon names — the actual weapon
// ids for these slots live only in enemyKinds.js, so this file stays free of weapon literals.
export const SLOT_NOSE = 'nose';
export const SLOT_FLANK = 'flank';

// Randomised standoff band (#305): `strafeRange` used to be a flat 320px for every gunship, so a
// pair of them sat on the same radius and read as one formation. Each unit now rolls its own
// standoff in this band. It is re-rolled PER ATTACK CYCLE (on entering REPOSITION, which is
// exactly when the unit is choosing its next angle of attack anyway) rather than once at spawn:
// rolling per cycle gives the same across-the-field spread that a spawn roll does, AND stops any
// individual gunship from settling into one memorised orbit radius the player can pre-aim.
// The spawn-time roll is just cycle zero of the same rule.
export const STANDOFF_MIN = 240;
export const STANDOFF_MAX = 400;

// Phase timings (ms). APPROACH and REPOSITION are primarily distance-triggered — these are
// safety timeouts so a gunship that can never reach its target point (blocked, chasing a player
// who is outrunning it) still cycles instead of locking up. STRAFE is purely timed: it's the
// firing pass, and its length is what makes the pass read as a deliberate raking run.
export const APPROACH_TIMEOUT_MS = 4200;
export const STRAFE_MIN_MS = 2200;
export const STRAFE_MAX_MS = 3200;
// Generous enough that the unit normally ARRIVES at its new attack point rather than timing out
// mid-swing: the break-off is an arc of up to ~2.3 rad out to ~1.9x standoff, which at the
// gunship's 210px/s can be most of 800px of travel. Cutting it short leaves the unit halfway
// round, which reads as an aimless wobble instead of a break-off and re-attack.
export const REPOSITION_TIMEOUT_MS = 4600;

// Distance triggers.
// APPROACH ends once the unit is inside its standoff radius — it has closed to gun range and now
// turns broadside. The 1.08 slack means it doesn't have to hit the radius exactly.
export const APPROACH_ARRIVE_FRAC = 1.08;
// REPOSITION ends once the unit is near the fresh attack point it picked.
export const REPOSITION_ARRIVE_PX = 110;
// How far out the reposition point sits, as a multiple of the (new) standoff — it breaks off
// well beyond gun range so the next approach is a real run in, not a twitch.
export const REPOSITION_OUT_FRAC = 1.9;
// How far around the player the new angle of attack is, in radians — a genuinely different
// bearing, not a token nudge. Signed by the unit's handedness so it swings around consistently.
export const REPOSITION_ARC_MIN = 1.1;
export const REPOSITION_ARC_MAX = 2.3;

// What each phase wants, as data. `slot: null` = hold fire.
export const PHASE_PLAN = {
  [APPROACH]: { facing: FACE_PLAYER, slot: SLOT_NOSE },
  [STRAFE]: { facing: FACE_BROADSIDE, slot: SLOT_FLANK },
  [REPOSITION]: { facing: FACE_TRAVEL, slot: null },
};

export function phasePlan(phase) {
  return PHASE_PLAN[phase] ?? PHASE_PLAN[APPROACH];
}

// Fresh cycle state for a newly-spawned gunship. `rng` is injectable so tests are deterministic.
export function initGunshipCycle(rng = Math.random) {
  return {
    phase: APPROACH,
    timer: APPROACH_TIMEOUT_MS,
    standoff: roll(STANDOFF_MIN, STANDOFF_MAX, rng),
    // The point the unit is repositioning toward; null outside REPOSITION.
    repoX: null, repoY: null,
  };
}

// Advance the machine one frame. Mutates and returns `st`.
//   st       cycle state from initGunshipCycle
//   delta    ms since last frame
//   dist     current distance to the player
//   ctx      { px, py, ex, ey, handed, repoDist } — player + unit position, the unit's
//            handedness (±1, which side it swings around), and its distance to the reposition
//            point (Infinity when it has none yet)
// Returns st. Transitions are: APPROACH -(inside standoff | timeout)-> STRAFE
//                              STRAFE   -(timer)-> REPOSITION   (re-rolls standoff + a new
//                                                                angle of attack)
//                              REPOSITION -(arrived | timeout)-> APPROACH
export function stepGunshipCycle(st, delta, dist, ctx, rng = Math.random) {
  st.timer -= delta;
  if (st.phase === APPROACH) {
    if (dist <= st.standoff * APPROACH_ARRIVE_FRAC || st.timer <= 0) {
      st.phase = STRAFE;
      st.timer = roll(STRAFE_MIN_MS, STRAFE_MAX_MS, rng);
    }
  } else if (st.phase === STRAFE) {
    if (st.timer <= 0) {
      st.phase = REPOSITION;
      st.timer = REPOSITION_TIMEOUT_MS;
      // New cycle: fresh standoff (see STANDOFF_MIN/MAX above) and a fresh angle of attack.
      st.standoff = roll(STANDOFF_MIN, STANDOFF_MAX, rng);
      const cur = Math.atan2(ctx.ey - ctx.py, ctx.ex - ctx.px);
      const arc = roll(REPOSITION_ARC_MIN, REPOSITION_ARC_MAX, rng) * (ctx.handed || 1);
      const out = st.standoff * REPOSITION_OUT_FRAC;
      st.repoX = ctx.px + Math.cos(cur + arc) * out;
      st.repoY = ctx.py + Math.sin(cur + arc) * out;
    }
  } else {
    if ((ctx.repoDist ?? Infinity) <= REPOSITION_ARRIVE_PX || st.timer <= 0) {
      st.phase = APPROACH;
      st.timer = APPROACH_TIMEOUT_MS;
      st.repoX = null; st.repoY = null;
    }
  }
  return st;
}

function roll(a, b, rng) { return a + rng() * (b - a); }
