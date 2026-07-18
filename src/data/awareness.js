// #103 — enemy awareness/aggro. An enemy starts UNAWARE (idle/loiter near its spawn point, not
// actively closing on or firing at the player) and flips to AWARE — its normal tactical AI —
// once it detects the player. Detection is deliberately simple: "in detection range AND has
// line-of-sight" OR "a noise event (the player firing) happened nearby", either trips it.
// AWARE is a ONE-WAY transition (no lose-aggro/forget system) so an alerted enemy stays alerted
// for the rest of the encounter, per the issue's "don't over-engineer a stealth system" call.
// Kept Phaser-free so the transition rule itself is unit-testable (awareness.test.js); the arena
// (scenes/arena/enemies.js) owns the per-enemy `awareness` field and calls `shouldBecomeAware`
// each frame.

export const UNAWARE = 'unaware';
export const AWARE = 'aware';
// #269 §3 (base population rework): a THIRD state, distinct from both of the above — a docked
// unit spawned at a base (data/worldgen.js `placeBases`) starts DORMANT: genuinely inert, not
// merely unaware. Unlike UNAWARE (which still runs idle-wander/loitering AI, `pickWanderGoal`),
// a DORMANT enemy skips ALL per-frame AI ticking entirely — no movement, no turret slew, no
// firing, nothing (see scenes/arena/enemies.js `_updateEnemy`'s early-return on this state). It
// transitions directly to AWARE (never through UNAWARE) the moment its base is woken by an
// alert tower's completed countdown (scenes/arena/bases.js `_wakeBase`) — a one-way transition,
// same spirit as UNAWARE→AWARE above, just with a real "asleep" state in front of it.
export const DORMANT = 'dormant';

// An enemy's detection range is its own engagement range (weapon opt-derived standoff for a
// mech, or `fireRange` for a non-mech kind — the range concept each already tracks) widened a
// bit, so it notices the player a beat before it's technically in firing range rather than
// exactly at the firing-range boundary. Owner: tunable.
export const DETECTION_RANGE_MULT = 1.2;

// A gunshot within this radius (px) of an unaware enemy instantly alerts it, regardless of LOS —
// a simple "noise" aggro trigger (the player announcing themselves by firing nearby). Owner:
// tunable.
export const NOISE_AGGRO_RANGE = 260;

// How long (ms) a fire event counts as "just happened" for noise-aggro purposes — after this the
// enemy no longer treats it as a live noise cue (it isn't a memory system, just "did a shot go
// off basically this instant"). Owner: tunable.
export const NOISE_WINDOW_MS = 200;

// This enemy's detection range, from its own base engagement range.
export function detectionRangeFor(baseRange, mult = DETECTION_RANGE_MULT) {
  return (baseRange || 300) * mult;
}

// #283 audit ("guarantee a calm, threat-free start and genuinely calm travel gaps between base
// encounters"): a DORMANT unit's `detectRange` doubles as its proximity-wake radius
// (`scenes/arena/bases.js` `_maybeProximityWake`, via `shouldBecomeAware`) — the SAME field an
// AWARE/UNAWARE non-mech kind uses for its own aggro detection. For every kind except one, that
// stays a modest few-hundred-px envelope well inside worldgen.js's `MIN_GAP_PROGRESS_PX` floor
// between encounters: tank `detectionRangeFor(420)` = 504px, helicopter `detectionRangeFor(460)`
// = 552px, quadruped `detectionRangeFor(380)` = 456px, a mech's standoff-derived detectRange
// tops out at `detectionRangeFor(520)` = 624px (STANDOFF_MAX, scenes/arena/enemies.js).
//
// The turret emplacement is the one wild outlier: its `fireRange` is DELIBERATELY "INSANE"
// (2400px, data/enemyKinds.js #94) — that's the whole point of its long-range bombardment
// once it's AWAKE and firing. But that same number, run through `detectionRangeFor`, ALSO
// becomes its DORMANT proximity-wake radius (2880px) purely as an accident of both concepts
// sharing one field — a turret never passes through UNAWARE (it starts DORMANT and only ever
// wakes via `_wakeBase`), so its `detectRange` is NEVER used for anything except proximity-wake.
// Left uncapped, that 2880px radius would swallow almost an entire inter-base gap regardless of
// how generous `MIN_GAP_PROGRESS_PX` is tuned, making a genuinely calm middle impossible near
// any base with a turret emplacement.
//
// `PROXIMITY_WAKE_RANGE_CAP` reins that outlier back in — and, per the worldgen.js
// `MIN_GAP_PROGRESS_PX` cross-check (its own comment has the full sizing math), deliberately
// unified at the SAME 320px as `alertTower.js`'s `ALERT_DETECT_RADIUS` rather than just "smaller
// than 2880." Two detection radii that could independently eat into a gap's calm middle (the
// tower's own tripwire bubble, and a dormant unit's proximity-wake bubble) are worth keeping to
// ONE shared envelope so their worst-case overlap doesn't compound into something bigger than
// either alone — with both capped at 320px, the worst-case calm stretch in a
// `MIN_GAP_PROGRESS_PX`-sized gap is simply `MIN_GAP_PROGRESS_PX - 320`, not
// `MIN_GAP_PROGRESS_PX - 320 - PROXIMITY_WAKE_RANGE_CAP`. This also tightens
// tank(504px)/helicopter(552px)/quadruped(456px)/mech(up to 624px) down to the same 320px —
// a deliberate widening of scope beyond just the turret outlier, so EVERY dormant kind's
// proximity-wake radius sits inside the audited budget, not just the worst offender.
// Applied where a DORMANT unit's `detectRange` is set (`scenes/arena/bases.js`
// `_spawnDormantUnits`), never to the turret's own combat `fireRange`/weapon range (untouched) —
// this only tightens how far away a SLEEPING unit can notice someone; once woken, combat range
// is governed entirely by the unit's own weapon/engagement stats as before.
export const PROXIMITY_WAKE_RANGE_CAP = 320;

// Should this enemy be (or become) AWARE this frame? One-way: an already-AWARE enemy always
// stays AWARE. Otherwise it flips the instant it's seen (within `detectRange` AND `hasLos`) or
// heard (`noiseDist` — the enemy's distance from the most recent player gunshot — is within
// `noiseRange`, or omitted/null if no shot is currently "live"). Pure: no Phaser/scene access.
export function shouldBecomeAware(state, { dist, detectRange, hasLos = true, noiseDist = null, noiseRange = NOISE_AGGRO_RANGE }) {
  if (state === AWARE) return true;
  const seen = hasLos && dist <= detectRange;
  const heard = noiseDist != null && noiseDist <= noiseRange;
  return seen || heard;
}
