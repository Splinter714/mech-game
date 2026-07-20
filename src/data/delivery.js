// Delivery simulation — the SINGLE source of "how a weapon fires", shared by the live
// arena and the Weapon Lab preview so the two can never drift. Pure + headless (no
// Phaser): it owns only the parts that are identical between the two —
//
//   1. planEmissions(weapon)  — how one trigger pull turns into shots: a single shot, a
//      fanned spread cone, a tight parallel cluster, a multi-pulse/multi-missile burst,
//      or some combination (e.g. Streak Pod is a burst of staggered single shots).
//      Each emission is a descriptor (delay + angle offset + lateral offset); the scene
//      applies it to its own muzzle/aim at fire time.
//   2. makeProjectile(...)    — the kinematic round object (velocity, kind, colour…).
//   3. stepProjectile(...)    — advancing a round one frame, incl. homing steering.
//
// Everything that genuinely differs stays in the scenes: the arena resolves live
// targets, walls, collision and damage; the Lab just flies rounds to the stage edge.
// Both, however, get spread/cluster/burst/homing/wobble behaviour from exactly one place.

import { CATEGORIES } from './categories.js';

const TURN_RATE = 4.0;            // fallback guided steering rate (rad/s) for a round with no speed

// ── Homing steering (#77) ────────────────────────────────────────────────────────────────
// A guided round's turn rate is DERIVED from its speed so it can always corner within a fixed
// radius: turn = speed / turn radius. The old fixed 4 rad/s cap meant a fast missile
// (streak pod at 440 px/s) had a ~110px turn radius and would orbit / corkscrew a target it got
// close to — it literally could not turn tight enough. Pinning the radius instead (clamped) lets
// every missile bank onto its target the same way regardless of speed. Feel/tuning levers.
// #243: the radius is a per-weapon lever now — `delivery.homingTurnRadius` (px) overrides the
// default (a lazier wide-banking missile vs. a snappy tight-cornering one); the min/max rad/s
// clamps stay engine-level safety rails shared by every guided round.
const HOMING_TURN_RADIUS = 64;   // px — default turn radius a guided round corners within
const HOMING_TURN_MIN = 3.2;     // rad/s floor (very slow rounds still steer deliberately)
const HOMING_TURN_MAX = 9.0;     // rad/s ceiling (very fast rounds don't snap-track instantly)

// The steering rate a guided round of the given speed should fly with (see above). `radius`
// defaults to the shared engine value; a weapon passes its own `delivery.homingTurnRadius`.
export function homingTurnRate(speed, radius = HOMING_TURN_RADIUS) {
  return Math.max(HOMING_TURN_MIN, Math.min(HOMING_TURN_MAX, speed / radius));
}

// Proportional-navigation-style lead: the bearing a round at (px,py) flying at `speed` should aim
// to INTERCEPT a target at (tx,ty) moving (tvx,tvy) — i.e. where the target will be when the round
// arrives, not where it is now. Pure pursuit (aim at the current position) makes a missile trail a
// crossing target and curve in lazily from behind; leading the intercept makes it commit to a clean
// converging line. Solves |target + vel·t − shooter| = speed·t for the earliest positive t; if there
// is no solution (target faster than the round, or stationary) it falls back to the direct bearing.
export function leadAngle(px, py, speed, tx, ty, tvx = 0, tvy = 0) {
  const rx = tx - px, ry = ty - py;
  const a = tvx * tvx + tvy * tvy - speed * speed;
  const b = 2 * (rx * tvx + ry * tvy);
  const c = rx * rx + ry * ry;
  let t = -1;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) > 1e-6) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const cand of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (cand > 0 && (t < 0 || cand < t)) t = cand;
      }
    }
  }
  if (!(t > 0) || !Number.isFinite(t)) return Math.atan2(ry, rx);
  return Math.atan2(ry + tvy * t, rx + tvx * t);
}

// Shortest distance from point (px,py) to the segment (ax,ay)→(bx,by). Used for SWEPT hit
// detection (#77): a fast round can move farther than the hit radius in one frame and tunnel
// clean through a target if you only test its end position — testing the whole step segment
// against the target catches the pass-through.
export function segmentPointDistance(ax, ay, bx, by, px, py) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
// #243: each of these is the DEFAULT for a per-weapon `delivery` field of the same spirit —
// clusterSpacing / streamSpacing / spreadAngle / spreadJitterDelay — so any weapon can retune
// its own clump tightness, lane gap, fan width, or emission-stagger chaos without touching the
// shared value every other weapon inherits.
const CLUSTER_SPACING = 6;        // lateral px between rounds in a dumbfire cluster
const STREAM_SPACING = 5;         // default lateral px between parallel lanes of a multi-stream weapon (Repeater)
const DEFAULT_SPREAD_DEG = 16;    // fan width for a spread weapon that omits spreadAngle
const SPREAD_JITTER_DELAY = 35;   // ms, max random emission stagger for a jittered spread (#46)
const SPEED_JITTER_FRAC = 0.18;   // ±fraction of velocity a jittered particle's speed varies (#46's 0.82–1.18 band)

// ── Per-weapon flight "personality" ─────────────────────────────────────────────────────
// Opt-in lateral wobble layered on top of homing steering (or, for a cluster clump, on top
// of straight dumbfire flight), purely cosmetic — it nudges the round's drawn position,
// never its steering target.
//   jostle — Swarm Rack (#49): chaotic random-phase jiggle, constant amplitude (no settling).
//   weave  — Streak Pod (#50): smooth deliberate sine weave, constant amplitude.
//   sway   — Cluster Salvo (#51): a modest sine undulation, but each rocket rolls its OWN
//            random phase — the clump stays loosely together while every rocket wiggles
//            independently within it (no lockstep, no fanning apart). Same math as 'weave';
//            it's a distinct kind only so the amplitude can be tuned separately.
const JOSTLE_AMPLITUDE = 5;       // px, lateral jiggle (Swarm Rack) — owner: tune
const JOSTLE_FREQUENCY = 11;      // rad/s, jiggle rate
const WEAVE_AMPLITUDE = 4;        // px, lateral weave (Streak Pod) — moderate, not chaotic
const WEAVE_FREQUENCY = 6;        // rad/s, weave rate — slow enough to read as deliberate
const STREAK_STAGGER_DEG = 0.3;   // ° default angular stagger between consecutive weave-burst sub-shots (#243: per-weapon via delivery.burstStaggerDeg)
const SWAY_AMPLITUDE = 5;         // px, per-rocket undulation within a cluster clump (#51) — small so the clump stays tight
const SWAY_FREQUENCY = 7;         // rad/s

// Which wobble personality (if any) a weapon's rounds fly with. Cluster weapons always get
// 'sway' (#51 — a small per-rocket-independent undulation); among homing weapons, it's an
// explicit opt-in data flag (`delivery.wobble: 'jostle' | 'weave'`); a non-cluster,
// non-homing weapon can also opt directly into 'sway' (#101 — Scatter Gun: fixed, even
// launch fan, but each pellet still independently sways in flight, exactly like a Cluster
// Salvo rocket) — never a hardcoded weapon id, so this stays shared/variant-agnostic
// plumbing.
function wobbleKind(weapon) {
  const d = weapon.delivery || {};
  if (d.cluster || d.wobble === 'sway') return 'sway';
  if (d.guidance !== 'homing') return null;
  return d.wobble === 'jostle' || d.wobble === 'weave' ? d.wobble : null;
}

// Default lateral amplitude (px) / angular frequency (rad/s) for each wobble personality —
// a weapon can override either via `delivery.wobbleAmplitude` / `delivery.wobbleFrequency`
// (#101 — Scatter Gun's pellets scale these down/up for their much shorter flight).
function defaultWobbleAmplitude(kind) {
  if (kind === 'jostle') return JOSTLE_AMPLITUDE;
  if (kind === 'weave') return WEAVE_AMPLITUDE;
  if (kind === 'sway') return SWAY_AMPLITUDE;
  return 0;
}
function defaultWobbleFrequency(kind) {
  if (kind === 'jostle') return JOSTLE_FREQUENCY;
  if (kind === 'weave') return WEAVE_FREQUENCY;
  if (kind === 'sway') return SWAY_FREQUENCY;
  return 0;
}

// ── Arcing lob travel budget (#77 follow-up) ────────────────────────────────────────────
// An arcing round's flight distance ("how far before it's `landed`" — projectiles.js) is
// normally the straight-line distance to its seek target, so a wide-fan salvo (Swarm Rack,
// spreadAngle 44°) still gives every round the SAME correct budget even though each round's
// own launch heading is offset from the true target bearing. `aimAngle` must be the weapon's
// un-offset CENTRE bearing (shared by every shot in the fan), not the individual shot's own
// launch angle — projecting onto a wide fan-offset angle instead made the target's
// perpendicular "miss" balloon with range (e.g. ~112px at 300px range, 22° offset) past
// ARC_PERP_GATE, so those rounds fell back to a short `range.opt` budget: they landed well
// short of the target (read as "range is too low") AND had the homing-blend window (see
// arcHomingBlend below, which ramps over a fraction of this same maxDist) squeezed into a much
// shorter remaining distance for the round with the LARGEST initial heading error to correct —
// together, that read as "the flight path is too crazy".
const ARC_PERP_GATE = 80;   // px — perpendicular miss beyond which we don't trust "target ahead"

// The travel budget (px) an arcing round should fly this shot: the straight-line distance to
// `tgt` when it's roughly ahead of the launch point (along the weapon's CENTRE bearing
// `aimAngle`, not this shot's own possibly fan-offset launch angle) and within `maxRange`;
// otherwise a fallback lob distance (`opt`, the weapon's optimal range) for a shot with no
// usable target ahead of it (no lock, or a target behind/far to the side).
export function arcMaxDist(x, y, aimAngle, tgt, maxRange, opt) {
  const ex = tgt.x - x, ey = tgt.y - y;
  const fwd = ex * Math.cos(aimAngle) + ey * Math.sin(aimAngle);
  const perp = Math.abs(ex * Math.sin(aimAngle) - ey * Math.cos(aimAngle));
  return (fwd > 0 && fwd < maxRange && perp < ARC_PERP_GATE) ? fwd : opt;
}

// ── Arcing homing blend (#57) ────────────────────────────────────────────────────────────
// The seeker on an arcing homing round doesn't engage until the round is past apex and
// descending — like a real missile leaving the tube mostly ballistic, then curving in on its
// target during the back half of the arc. `ASCENT_END` is the fractional-flight-distance
// (dist / maxDist) where the seeker starts blending in (0 = launch, 1 = impact); the blend then
// ramps from 0→1 over `HOMING_BLEND_SPAN` so the turn-in reads as a smooth curve, not a snap.
// This is the DEFAULT engagement point (the missile family — Swarm Rack/Streak Pod — has been
// played and tuned against it, so it stays put); #252 playtest follow-up: `delivery.
// homingBlendStart` lets an individual weapon override just the start point (see
// `makeProjectile`'s `blendStart`, stamped per-round) without touching this shared default or
// the ramp span, so a lobbed-shell weapon can engage its seeker earlier without changing how
// Swarm Rack/Streak Pod already feel.
export const ASCENT_END = 0.4;           // fraction of flight spent mostly ballistic before homing engages
export const HOMING_BLEND_SPAN = 0.35;   // fraction of flight over which homing ramps from 0% to 100%

// How strongly an arcing homing round should steer toward its target at flight-fraction `t`
// (dist / maxDist): 0 before `ascentEnd`, ramping smoothly up to 1 over `HOMING_BLEND_SPAN`
// after that. `ascentEnd` defaults to the shared `ASCENT_END` (missile-family timing) but a
// round stamped with its own `blendStart` (from `delivery.homingBlendStart`, #252 follow-up)
// passes that instead, so a lobbed-shell weapon can start curving in earlier in its flight.
// Getting `maxDist` right (arcMaxDist above) matters here too — a maxDist that's artificially
// short compresses this whole ramp into much less real distance, so a round with a large
// heading error has to correct it far more abruptly.
export function arcHomingBlend(t, ascentEnd = ASCENT_END) {
  if (t <= ascentEnd) return 0;
  return Math.min(1, (t - ascentEnd) / HOMING_BLEND_SPAN);
}

// ── Arc loft profiles (#377) ──────────────────────────────────────────────────────────────
// An arcing round has NO vertical axis: its "height" is faked entirely by a sprite-scale
// pulse in the arena's `_drawProjectile`, keyed to the flight FRACTION (dist / maxDist). So
// the SHAPE of the arc is nothing but an easing curve on that fraction, and this is it —
// pure, testable, and per-weapon selectable via `delivery.arcProfile` (stamped onto the round
// as `arcProfile` by makeProjectile).
//
//   * 'lob' (the default, and what every arcing weapon used before #377) — a symmetric
//     parabola, 4t(1-t). Rises and falls at the same lazy rate: a thrown ball. Napalm,
//     Plasma Cannon and Streak Pod keep exactly this, unchanged.
//   * 'mortar' (#377, Swarm Rack only) — Jackson: "rise quickly, then travel, then come
//     falling down on the enemy abruptly towards the end." Three phases: a hard ramp to full
//     height over the first `MORTAR_RISE_END` of flight, a near-flat cruise (drifting down
//     only slightly, so the round doesn't read as frozen), then a steep cosine drop to zero
//     over the last stretch after `MORTAR_FALL_START`.
//
// Both are continuous at the phase joins and both return 0 at t=0 and t=1 (launch and impact
// are on the deck). Returns a 0..1 height fraction; the caller scales it into sprite gain.
export const MORTAR_RISE_END = 0.15;    // fraction of flight spent climbing to apex
export const MORTAR_FALL_START = 0.80;  // fraction of flight where the terminal dive begins
const MORTAR_CRUISE_SAG = 0.08;         // how much height bleeds off across the flat cruise

export function arcLoft(t, profile = 'lob') {
  const u = Math.min(1, Math.max(0, t));
  if (profile !== 'mortar') return 4 * u * (1 - u);
  if (u <= MORTAR_RISE_END) {
    // Quarter-sine: fastest at the muzzle, easing to a flat top at apex — it pops.
    return Math.sin((u / MORTAR_RISE_END) * (Math.PI / 2));
  }
  const cruiseEnd = 1 - MORTAR_CRUISE_SAG;
  if (u < MORTAR_FALL_START) {
    const k = (u - MORTAR_RISE_END) / (MORTAR_FALL_START - MORTAR_RISE_END);
    return 1 - MORTAR_CRUISE_SAG * k;                       // near-flat travel
  }
  const k = (u - MORTAR_FALL_START) / (1 - MORTAR_FALL_START);
  return cruiseEnd * (0.5 + 0.5 * Math.cos(Math.PI * k));   // abrupt terminal plunge
}

// ── Salvo separation: converge at the last moment (#377 follow-up) ───────────────────────
// Jackson, after the speed/arc pass landed: "can we keep slight separation of the individual
// missiles warbling until last minute they converge on the target?"
//
// The cause of the collapse is the seeker, not the launch fan. Swarm Rack sets
// `homingBlendStart: 0`, so all six rounds have full steering authority by t=0.35 and every
// one of them resolves onto the SAME aim point almost immediately — the 14° fan and the
// 'jostle' wobble get erased before they can read, and the salvo flies as a single line.
//
// The fix keeps the strong tracking he says feels good (every round IS steering the whole
// way) and just gives each round its own slightly-offset aim point, which then decays to the
// true target late. Two pure pieces:
//
//   * `salvoAimOffset` — the round's own lateral offset in px, taken from its position in the
//     launch fan (`angleOffset` / half-cone, a centred −1…+1) times the weapon's
//     `delivery.salvoSpread`. Deterministic per round, NOT re-rolled per frame — a re-roll
//     would read as jitter, and warble is the 'jostle' wobble's job. The outermost missile in
//     the fan aims furthest off, so the salvo holds the shape it launched in.
//   * `salvoConvergeFalloff` — how much of that offset still applies at flight fraction `t`:
//     full through the cruise, then a cosine decay to exactly zero over the converge window.
//     It finishes at `SALVO_CONVERGE_END`, deliberately short of impact, so every round has
//     real flight left to settle onto the true target and all six still HIT.
//
// The window opens with the mortar arc's terminal dive (MORTAR_FALL_START), so the salvo
// tightening and the rounds falling out of the sky are the same beat.
export const SALVO_CONVERGE_START = MORTAR_FALL_START;   // 0.80 — offsets hold full until here
export const SALVO_CONVERGE_END = 0.93;                  // fully converged, with flight left to settle

export function salvoConvergeFalloff(t) {
  if (t <= SALVO_CONVERGE_START) return 1;
  if (t >= SALVO_CONVERGE_END) return 0;
  const k = (t - SALVO_CONVERGE_START) / (SALVO_CONVERGE_END - SALVO_CONVERGE_START);
  return 0.5 + 0.5 * Math.cos(Math.PI * k);
}

export function salvoAimOffset(d, angleOffset) {
  const spread = d.salvoSpread || 0;                     // opt-in per weapon; 0 = off (the default)
  if (!spread || !angleOffset) return 0;
  const halfCone = (((d.spreadAngle || DEFAULT_SPREAD_DEG) * Math.PI) / 180) / 2;
  if (!halfCone) return 0;
  const fanPos = Math.max(-1, Math.min(1, angleOffset / halfCone));   // −1 … +1 across the fan
  return spread * fanPos;
}

const ARRIVAL_SPEED_LIMIT = 0.35;  // max fractional speed nudge either way (Swarm Rack convergence)

// Swarm Rack (#49): all 6 missiles launch at once from the same point but fan out at
// different angles, so the outer missiles' initial line-of-sight to the target is
// slightly longer than the centre missile's (the fan is wide, 44°). Nudge each round's
// speed so every missile's estimated flight time matches the centre shot's — outer/
// longer-path missiles fly a little faster, converging on one simultaneous impact
// instead of trickling in. `angleOffset` is the shot's fan angle (radians off the aim
// line, as planEmissions produced it); `straightDist` is the centre-line range to the
// target at fire time.
export function arrivalSpeedMultiplier(weapon, angleOffset, straightDist) {
  if (wobbleKind(weapon) !== 'jostle' || !straightDist || straightDist <= 0) return 1;
  // Path length for a shot fired `angleOffset` off the direct line, modelled as the chord
  // it must close back onto the target: longer for wider angles. A flat approximation
  // (1/cos) captures "wider fan → longer path" without needing real target geometry.
  const pathFactor = 1 / Math.max(0.4, Math.cos(angleOffset));
  const mult = pathFactor; // faster for the longer (wider-angle) paths
  return 1 + Math.max(-ARRIVAL_SPEED_LIMIT, Math.min(ARRIVAL_SPEED_LIMIT, mult - 1));
}

// The visual KIND of a fired round (shared by the arena, the Lab, and the garage icons).
export function projectileKind(weapon) {
  const d = weapon.delivery || {};
  if (d.kind) return d.kind;                       // explicit override (flame, fire, bullet, rail…)
  if (weapon.category === 'energy') return 'plasma';
  if (weapon.category === 'missile') return 'missile';
  // Ballistic: rapid streams/pellets are little tracer bullets; a single shot is a heavy
  // autocannon shell.
  if (d.pattern === 'stream' || d.pattern === 'spread') return 'bullet';
  return 'slug';
}

// What one trigger pull emits. Returns { mode, shots } where mode is 'hitscan' |
// 'contact' | 'projectile' and each shot is { delay, angleOffset, lateral }:
//   delay        ms to wait before this sub-shot (multi-pulse/multi-missile burst); 0 = now
//   angleOffset  radians off the aim line (spread fan, a cluster's tiny jitter, or stagger)
//   lateral      px perpendicular to the shot (a cluster's parallel offset)
// The caller turns each into a real shot from its current muzzle/aim.
//
// #137: `opts.countMult` scales the weapon's `delivery.count` (see `emissionCount` below) —
// the Barrage powerup passes 2 so EVERY pattern emits twice as many things per trigger pull
// through its own existing expansion (a wider fan, more parallel lanes, a longer burst).
export function planEmissions(weapon, { countMult = 1 } = {}) {
  const d = weapon.delivery || {};
  if (d.hit === 'contact') return { mode: 'contact', shots: [shot()] };
  const mode = d.hit === 'hitscan' ? 'hitscan' : 'projectile';

  // The ONE canonical "how many things per trigger pull" number, already multiplied by any
  // active buff. Every pattern below expands the SAME n in its own way.
  const n = emissionCount(d, countMult);

  if (mode === 'hitscan') {
    // Hitscan burst (Pulse Laser): n light pulses `burst.interval` ms apart.
    if (d.burst) {
      const shots = [];
      for (let i = 0; i < n; i++) shots.push(shot({ delay: i * d.burst.interval }));
      return { mode, shots };
    }
    // #137: a non-burst hitscan (Beam Laser, Rail Lance) has no pattern of its own to widen,
    // so a count above 1 becomes PARALLEL BEAMS — n lanes straddling the aim line. This is
    // what makes Barrage read as "2 beams instead of 1" on a beam weapon.
    return { mode, shots: laneShots(n, d) };
  }

  // Projectile: a single round, a fanned cone of n, or — for `cluster` weapons — a tight
  // parallel clump (lateral offsets, ~parallel headings, no fan).
  // `spreadJitter` (degrees) randomizes each fan shot's angle and emission timing instead
  // of a perfectly even, repeating fan — used by weapons that should feel chaotic shot to
  // shot rather than reading as a clean mechanical pulse (Flamethrower, #46).
  const fan = d.pattern === 'spread' ? n : 1;
  const jitterRad = ((d.spreadJitter || 0) * Math.PI) / 180;

  // Continuous-stream weapons. Two shapes, chosen by whether the weapon jitters:
  //  • JITTERED (Flamethrower, Plasma Lance): each cadence tick pops n independently
  //    angle-jittered particles at once, for a chaotic gout / sputtering bolt line rather
  //    than a lane pattern. (#137 folded Flamethrower's old random `sprayCount {min,max}`
  //    range into this fixed count — the chaos now comes purely from `spreadJitter`.)
  //  • LANED (Repeater): n rounds side by side in fixed lanes — a lateral offset centred on
  //    the aim line (like a cluster's parallel clump), all with angleOffset 0 so the lanes
  //    stay parallel and read as n distinct tracer streams, NOT a fanned cone.
  //    `streamSpacing` (px) tunes the lane gap.
  // Either way the ammo cost is unchanged: ammo is spent once per fireWeapon() call, not per
  // shot, so hold-to-fire sustain doesn't care how many particles pop out.
  if (d.pattern === 'stream' && (jitterRad || n > 1)) {
    if (!jitterRad) return { mode, shots: laneShots(n, d) };
    const streamShots = [];
    for (let i = 0; i < n; i++) {
      streamShots.push(shot({ angleOffset: (Math.random() - 0.5) * 2 * jitterRad }));
    }
    return { mode, shots: streamShots };
  }

  // #137: likewise for a plain single-round projectile (Autocannon, Plasma Cannon, Napalm) —
  // no fan, no lanes, no burst to lengthen, so a count above 1 fires n rounds side by side in
  // parallel lanes rather than n invisibly-overlapping shots on the exact same line.
  if (n > 1 && !d.burst && d.pattern !== 'spread') return { mode, shots: laneShots(n, d) };

  const shots = [];
  const cone = ((d.spreadAngle || DEFAULT_SPREAD_DEG) * Math.PI) / 180;
  const clusterSpacing = d.clusterSpacing || CLUSTER_SPACING;   // per-weapon clump tightness (#51)
  // #243: the max random emission stagger of a jittered spread is per-weapon tunable
  // (`delivery.spreadJitterDelay`, ms) — how raggedly a chaotic fan's shots leave the muzzle.
  const jitterDelay = d.spreadJitterDelay ?? SPREAD_JITTER_DELAY;
  for (let i = 0; i < fan; i++) {
    const c = fan > 1 ? (i - (fan - 1) / 2) : 0;   // centred index: −…0…+
    if (d.cluster) {
      shots.push(shot({ lateral: c * clusterSpacing }));
    } else if (fan > 1) {
      const jitter = jitterRad ? (Math.random() - 0.5) * 2 * jitterRad : 0;
      const fireDelay = jitterRad ? Math.random() * jitterDelay : 0;
      shots.push(shot({ angleOffset: (c / (fan - 1)) * cone + jitter, delay: fireDelay }));
    } else if (jitterRad) {
      // A single continuously-streamed shot (Flamethrower, #46) still gets the same
      // per-shot angle jitter a multi-pellet spread would use — each rapid-fire particle
      // lands at its own random angle, so the held stream reads as a chaotic gout rather
      // than a laser-straight repeating line.
      shots.push(shot({ angleOffset: (Math.random() - 0.5) * 2 * jitterRad }));
    } else shots.push(shot());
  }

  // Projectile burst (Streak Pod, #50): one trigger pull unloads n rounds in rapid
  // succession instead of requiring the button held — replaces the single shot above
  // with n delayed copies. Consecutive sub-shots alternate a tiny angular stagger (for
  // a 'weave' wobble weapon) so the stream reads as a packed, slightly offset column rather
  // than perfectly overlapping shots.
  if (d.burst && fan === 1) {
    // #243: the alternating stagger is per-weapon tunable (`delivery.burstStaggerDeg`, °).
    const staggerRad = ((d.burstStaggerDeg ?? STREAK_STAGGER_DEG) * Math.PI) / 180;
    const staggered = wobbleKind(weapon) === 'weave';
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(shot({ angleOffset: staggered ? staggerRad * (i % 2 === 0 ? 1 : -1) : 0, delay: i * d.burst.interval }));
    }
    return { mode, shots: out };
  }

  return { mode, shots };
}

function shot({ delay = 0, angleOffset = 0, lateral = 0 } = {}) {
  return { delay, angleOffset, lateral };
}

// n rounds/beams fired at once in parallel lanes, centred on the aim line (no fan — every
// shot keeps angleOffset 0). Shared by the multi-lane stream weapons (Repeater) and, since
// #137, by any weapon whose count has been pushed above 1 without a pattern of its own to
// expand. n === 1 is just the plain single shot.
function laneShots(n, d) {
  if (n <= 1) return [shot()];
  const spacing = d.streamSpacing || STREAM_SPACING;
  const out = [];
  for (let i = 0; i < n; i++) out.push(shot({ lateral: (i - (n - 1) / 2) * spacing }));
  return out;
}

// #137: the ONE canonical "how many things does one trigger pull emit" number, replacing the
// three pattern-specific fields this used to be split across (`spreadCount` for a fan,
// `streams` for parallel lanes, `burst.count` for sequential pulses — plus Flamethrower's
// random `sprayCount {min,max}` range, now a fixed count too). `delivery.count` defaults to 1;
// each pattern in planEmissions expands the same number in its own geometric way, which is why
// a single multiplier (Barrage's `countMult: 2`) doubles every weapon type with no per-weapon
// special-casing. Rounded + floored at 1 so a fractional multiplier can never emit nothing.
export function emissionCount(delivery, countMult = 1) {
  const base = Math.max(1, delivery?.count ?? 1);
  return Math.max(1, Math.round(base * (countMult || 1)));
}

// Build a round's kinematic state. The caller supplies `maxDist` (its own travel budget:
// the arena's target/lob distance, the Lab's stage width) and may tack on scene-specific
// fields (owner, trail) afterward.
// `angleOffset` (#377 follow-up, optional): this shot's own offset off the salvo's centre
// bearing — what planEmissions handed the caller for this round of a fanned spread. Only used
// to derive the round's late-converging aim offset (salvoAimOffset above); a caller that omits
// it, or a weapon with no `salvoSpread`, gets 0 and the old behaviour exactly.
export function makeProjectile(weapon, x, y, angle, { maxDist, angleOffset = 0 }) {
  const d = weapon.delivery || {};
  // A jittered-spread weapon (Flamethrower, #46) also gets a per-particle speed variance so
  // the flame front looks ragged/chaotic rather than a uniform wall advancing in lockstep.
  // `jitterSpeed` (default true) gates this independently of the angle jitter above — Plasma
  // Lance (#220, #223) wants the angle wobble WITHOUT the paired speed variance, so it sets
  // `jitterSpeed: false` to keep every bolt launching at its exact tuned velocity (#219) while
  // still varying its launch angle.
  const jitterSpeed = d.jitterSpeed ?? true;
  // #243: the jitter band's half-width is per-weapon tunable (`delivery.speedJitterFrac`,
  // ±fraction of velocity) — the default reproduces #46's 0.82–1.18 band exactly.
  const jitterFrac = d.speedJitterFrac ?? SPEED_JITTER_FRAC;
  const speedJitter = d.spreadJitter && jitterSpeed ? 1 - jitterFrac + Math.random() * 2 * jitterFrac : 1;
  const speed = (d.velocity || 480) * speedJitter;
  const wobble = wobbleKind(weapon);
  // Every wobble kind — including a cluster's 'sway' (#51) — rolls its OWN random phase, so
  // no two rounds in a salvo/clump ever undulate in lockstep. For a cluster this means each
  // rocket wiggles independently within the (still tight) clump instead of snaking together.
  // Same for Scatter Gun's pellets (#101): each pellet's launch angle is fixed (the even fan),
  // but its own random phase makes it sway independently in flight.
  const wobblePhase = wobble ? Math.random() * Math.PI * 2 : 0;
  const wobbleAmplitude = d.wobbleAmplitude ?? defaultWobbleAmplitude(wobble);
  const wobbleFrequency = d.wobbleFrequency ?? defaultWobbleFrequency(wobble);
  return {
    x, y, angle, speed,
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    kind: projectileKind(weapon), color: CATEGORIES[weapon.category]?.color ?? 0xffffff,
    weaponId: weapon.id,
    damage: weapon.damage, splash: d.splash || 0, range: weapon.range, scale: d.scale || 1,
    dist: 0, maxDist, arc: d.path === 'arcing', ground: d.groundFire || null,
    // #377: which loft easing the fake "height" follows (see arcLoft above). Defaults to the
    // symmetric 'lob' parabola every arcing weapon used before, so only a weapon that opts in
    // via `delivery.arcProfile` changes shape.
    arcProfile: d.arcProfile || 'lob',
    // #377 follow-up: this round's own lateral aim offset (px), fixed for its whole flight and
    // faded out late by salvoConvergeFalloff — see salvoAimOffset above. 0 for every weapon
    // that doesn't opt in via `delivery.salvoSpread`.
    aimOffset: salvoAimOffset(d, angleOffset),
    // Turn rate is derived from speed (#77) so the round can always corner within a fixed radius
    // instead of orbiting a target it's too fast to turn onto. Arcing lobs override `speed` after
    // this (firing.js) and re-derive `turn` from the new speed (passing the same per-weapon
    // radius). #243: `delivery.homingTurnRadius` (px) tunes that radius per weapon.
    homing: d.guidance === 'homing', turn: homingTurnRate(speed, d.homingTurnRadius ?? HOMING_TURN_RADIUS),
    // #252 playtest follow-up: "the seeker only correcting last-minute reads as flying dumb the
    // whole way up." Per-weapon override of where arcHomingBlend starts engaging (fraction of
    // flight, dist/maxDist) — defaults to the shared ASCENT_END (missile-family timing,
    // untouched); a lobbed-shell weapon (plasmaCannon/napalm) sets `delivery.homingBlendStart`
    // earlier so its seeker visibly curves in well before apex instead of only in the back
    // stretch of descent.
    blendStart: d.homingBlendStart ?? ASCENT_END,
    // #213: opt-in WEAK per-projectile seek (Plasma Lance) — see stepWeakSeek below. Distinct
    // flag from `homing` so it never touches the real lock-on steering/turn-rate/gating.
    // #243: the seek's turn rate + notice radius ride on the round so a weapon can tune its own
    // bias strength (`delivery.weakSeekTurnRate` rad/s / `delivery.weakSeekRadius` px);
    // stepWeakSeek/withinWeakSeekRadius fall back to the shared constants when absent.
    weakSeek: !!d.weakSeek,
    weakSeekTurnRate: d.weakSeekTurnRate ?? WEAK_SEEK_TURN_RATE,
    weakSeekRadius: d.weakSeekRadius ?? WEAK_SEEK_RADIUS,
    // Flight-personality wobble — see wobbleKind(). `wobbleOffset` is the last-applied
    // lateral nudge (kept so the trail/art can read where the round visually is).
    // `wobbleAmplitude`/`wobbleFrequency` are per-round so a weapon can scale its wobble
    // (e.g. Scatter Gun's shorter-range pellets, #101) without touching the shared defaults.
    wobble, wobblePhase, wobbleOffset: 0, wobbleTime: 0, wobbleAmplitude, wobbleFrequency,
  };
}

// Resolve a homing round's live steering aimpoint for THIS frame from its `seekTarget` handle
// (regression guard for the "missiles hit where the target WAS" bug — #77 follow-up). Two shapes:
//   • a LIVE target handle — `{ x, y, vx, vy, mech }`, the same mutable object the arena keeps
//     updating in place every frame (an enemy record, or the enemy's `playerTarget`). Calling this
//     fresh each frame re-reads its CURRENT x/y/vx/vy, so a round steers at where the target IS
//     right now, not where it was when the round spawned.
//   • a FIXED point — a plain `{ x, y }` with no `.mech` (a blind-fire dead-reckoned last-known +
//     predicted position). No velocity to lead with; it's just steered toward directly.
// Returns `{ x, y, vx, vy, alive }` — `alive: false` means the live target died mid-flight, and the
// caller should stop homing (a dead target doesn't retarget to the nearest enemy).
export function resolveSeekPoint(seekTarget) {
  if (!seekTarget) return null;
  if (!seekTarget.mech) return { x: seekTarget.x, y: seekTarget.y, vx: 0, vy: 0, alive: true };
  if (seekTarget.mech.isDestroyed()) return { x: seekTarget.x, y: seekTarget.y, vx: 0, vy: 0, alive: false };
  return { x: seekTarget.x, y: seekTarget.y, vx: seekTarget.vx || 0, vy: seekTarget.vy || 0, alive: true };
}

// Advance a round one frame. `desiredAngle` (radians) is where a guided round should steer
// — the arena passes the bearing to its live target, the Lab passes straight-ahead;
// `null` (or a non-homing round) flies ballistically.
export function stepProjectile(p, dt, desiredAngle = null) {
  if (p.homing && desiredAngle != null) {
    p.angle = rotateToward(p.angle, desiredAngle, p.turn * dt);
    p.vx = Math.cos(p.angle) * p.speed;
    p.vy = Math.sin(p.angle) * p.speed;
  }
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.dist += p.speed * dt;
  // Cosmetic lateral wobble (#49/#50) — layered on top of the homing steering above, never
  // fighting it: each frame we undo last frame's perpendicular nudge and apply a fresh one,
  // so the round's true (unwobbled) path still advances cleanly toward its target and the
  // wobble never accumulates into drift.
  if (p.wobble) {
    p.wobbleTime += dt;
    // All three personalities (jostle/weave/sway) are the same sine — a constant-amplitude
    // undulation, never settling — differing only in amplitude/frequency (defaultWobbleAmplitude/
    // defaultWobbleFrequency above) and each round's own random `wobblePhase`, so no two rounds
    // in a salvo/clump/spread ever move in lockstep (jostle: chaotic jiggle; weave: deliberate
    // sway; sway: each cluster rocket — or, #101, each Scatter Gun pellet — wiggles
    // independently within its clump/fan instead of snaking together).
    const offset = Math.sin(p.wobbleTime * p.wobbleFrequency + p.wobblePhase) * p.wobbleAmplitude;
    const perp = p.angle + Math.PI / 2;
    const dx = Math.cos(perp) * (offset - p.wobbleOffset);
    const dy = Math.sin(perp) * (offset - p.wobbleOffset);
    p.x += dx; p.y += dy;
    p.wobbleOffset = offset;
  }
}

// Rotate angle `a` toward `target` by at most `maxStep`, taking the shortest way around.
export function rotateToward(a, target, maxStep) {
  const diff = wrapAngle(target - a);
  if (Math.abs(diff) <= maxStep) return wrapAngle(target);
  return wrapAngle(a + Math.sign(diff) * maxStep);
}

function wrapAngle(x) { return Math.atan2(Math.sin(x), Math.cos(x)); }

// ── Weak seek (Plasma Lance, #213) ───────────────────────────────────────────────────────
// A Halo-Needler-style "these bolts have a mind of their own, a little" bias — deliberately
// its OWN tiny model, not a reuse of the real homing/lock-on system above:
//   • no lock at all — never gates firing (targetlock.js's canFireWeapon only special-cases
//     `guidance === 'homing'`; a weakSeek round is `guidance: null` and fires like any
//     dumbfire round)
//   • no fixed target — every frame (or period) the caller re-resolves whichever LIVING
//     enemy is nearest to the ROUND'S OWN current (x,y), not the player's locked target and
//     not whatever was nearest at spawn, so it naturally retargets as the round travels and
//     as enemies move/die
//   • no lead/intercept (leadAngle) — just a raw bearing to the target's current position
//   • a turn rate far below HOMING_TURN_MIN (3.2 rad/s) so a target that's dodging or far off
//     the bolt's own axis is barely corrected toward, never run down like a real missile
// #219: playtest tuning pass — bumped 0.5 -> 0.8 rad/s so the seek reads a bit more, while
// staying comfortably under HOMING_TURN_MIN (3.2 rad/s) so it's still a light bias/wobble,
// never a hard lock-on.
// #243: both are now per-weapon tunable (`delivery.weakSeekTurnRate` / `delivery.weakSeekRadius`)
// — makeProjectile stamps them onto the round, defaulting to these shared values, so a future
// weak-seek weapon can be a stronger/wider (or fainter/narrower) drifter than Plasma Lance
// without touching its tuning.
const WEAK_SEEK_TURN_RATE = 0.8; // rad/s — deliberately small; ~1/4 of the weakest real homing turn
const WEAK_SEEK_RADIUS = 260;    // px — a bolt only "notices" a target within this range of itself

export { WEAK_SEEK_TURN_RATE, WEAK_SEEK_RADIUS };

// Nudge a weak-seek round's heading a small, bounded amount toward (tx,ty), then re-derive its
// velocity at its existing speed. Pure + testable: given the round's own position/heading/speed
// and a candidate target position, this is the entire steering-math contract — the caller
// (arena) owns finding the nearest living enemy and the every-frame re-evaluation. Reads the
// round's own stamped `weakSeekTurnRate` (#243), falling back to the shared default.
export function stepWeakSeek(p, dt, tx, ty) {
  const desired = Math.atan2(ty - p.y, tx - p.x);
  p.angle = rotateToward(p.angle, desired, (p.weakSeekTurnRate ?? WEAK_SEEK_TURN_RATE) * dt);
  p.vx = Math.cos(p.angle) * p.speed;
  p.vy = Math.sin(p.angle) * p.speed;
}

// Is a candidate target within weak-seek "notice" range of the round's own current position?
// Kept as a pure predicate so the caller can cheaply gate the (already-computed) nearest-enemy
// lookup without duplicating the radius default (per-round `weakSeekRadius` since #243).
export function withinWeakSeekRadius(p, tx, ty) {
  return Math.hypot(tx - p.x, ty - p.y) <= (p.weakSeekRadius ?? WEAK_SEEK_RADIUS);
}
