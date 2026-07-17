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
export const ASCENT_END = 0.4;           // fraction of flight spent mostly ballistic before homing engages
export const HOMING_BLEND_SPAN = 0.35;   // fraction of flight over which homing ramps from 0% to 100%

// How strongly an arcing homing round should steer toward its target at flight-fraction `t`
// (dist / maxDist): 0 during ascent, ramping smoothly up to 1 by the time it's well into its
// descent. Getting `maxDist` right (arcMaxDist above) matters here too — a maxDist that's
// artificially short compresses this whole ramp into much less real distance, so a round with
// a large heading error has to correct it far more abruptly.
export function arcHomingBlend(t) {
  if (t <= ASCENT_END) return 0;
  return Math.min(1, (t - ASCENT_END) / HOMING_BLEND_SPAN);
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
export function planEmissions(weapon) {
  const d = weapon.delivery || {};
  if (d.hit === 'contact') return { mode: 'contact', shots: [shot()] };
  const mode = d.hit === 'hitscan' ? 'hitscan' : 'projectile';

  if (mode === 'hitscan') {
    if (d.burst) {
      const shots = [];
      for (let i = 0; i < d.burst.count; i++) shots.push(shot({ delay: i * d.burst.interval }));
      return { mode, shots };
    }
    return { mode, shots: [shot()] };
  }

  // Projectile: a single round, a fanned cone of `spreadCount`, or — for `cluster`
  // weapons — a tight parallel clump (lateral offsets, ~parallel headings, no fan).
  // `spreadJitter` (degrees) randomizes each fan shot's angle and emission timing instead
  // of a perfectly even, repeating fan — used by weapons that should feel chaotic shot to
  // shot rather than reading as a clean mechanical pulse (Flamethrower, #46).
  const n = d.pattern === 'spread' ? Math.max(1, d.spreadCount) : 1;
  const jitterRad = ((d.spreadJitter || 0) * Math.PI) / 180;

  // A continuous stream that also sprays a random handful of particles per cadence tick
  // (Flamethrower): each tick launches `sprayCount.min`-`sprayCount.max` independently
  // jittered rounds at once instead of exactly one, for a denser/wider gout — without
  // changing the ammo cost per tick (ammo is spent once per fireWeapon() call, not per
  // shot), so hold-to-fire sustain is unaffected by how many particles pop out.
  if (d.sprayCount) {
    const { min, max } = d.sprayCount;
    const count = min + Math.floor(Math.random() * (max - min + 1));
    const sprayShots = [];
    for (let i = 0; i < count; i++) {
      sprayShots.push(shot({ angleOffset: jitterRad ? (Math.random() - 0.5) * 2 * jitterRad : 0 }));
    }
    return { mode, shots: sprayShots };
  }

  // Parallel-stream weapon (Repeater, `streams: N`): each cadence tick emits N rounds side by
  // side in fixed lanes — a lateral offset centred on the aim line (like a cluster's parallel
  // clump), all with angleOffset 0 so the lanes stay parallel and read as N distinct tracer
  // streams, NOT a fanned cone. `streamSpacing` (px) tunes the lane gap. Single-stream
  // weapons (no `streams`, or streams ≤ 1) skip this and fall through to the n = 1 case below.
  if (d.pattern === 'stream' && d.streams > 1) {
    const s = d.streams;
    const spacing = d.streamSpacing || STREAM_SPACING;
    const streamShots = [];
    for (let i = 0; i < s; i++) {
      const c = i - (s - 1) / 2;                    // centred lane index: −…0…+
      streamShots.push(shot({ lateral: c * spacing }));
    }
    return { mode, shots: streamShots };
  }

  const shots = [];
  const cone = ((d.spreadAngle || DEFAULT_SPREAD_DEG) * Math.PI) / 180;
  const clusterSpacing = d.clusterSpacing || CLUSTER_SPACING;   // per-weapon clump tightness (#51)
  // #243: the max random emission stagger of a jittered spread is per-weapon tunable
  // (`delivery.spreadJitterDelay`, ms) — how raggedly a chaotic fan's shots leave the muzzle.
  const jitterDelay = d.spreadJitterDelay ?? SPREAD_JITTER_DELAY;
  for (let i = 0; i < n; i++) {
    const c = n > 1 ? (i - (n - 1) / 2) : 0;       // centred index: −…0…+
    if (d.cluster) {
      shots.push(shot({ lateral: c * clusterSpacing }));
    } else if (n > 1) {
      const jitter = jitterRad ? (Math.random() - 0.5) * 2 * jitterRad : 0;
      const fireDelay = jitterRad ? Math.random() * jitterDelay : 0;
      shots.push(shot({ angleOffset: (c / (n - 1)) * cone + jitter, delay: fireDelay }));
    } else if (jitterRad) {
      // A single continuously-streamed shot (Flamethrower, #46) still gets the same
      // per-shot angle jitter a multi-pellet spread would use — each rapid-fire particle
      // lands at its own random angle, so the held stream reads as a chaotic gout rather
      // than a laser-straight repeating line.
      shots.push(shot({ angleOffset: (Math.random() - 0.5) * 2 * jitterRad }));
    } else shots.push(shot());
  }

  // Projectile burst (Streak Pod, #50): one trigger pull unloads `burst.count` rounds in
  // rapid succession instead of requiring the button held — replaces the single shot above
  // with `count` delayed copies. Consecutive sub-shots alternate a tiny angular stagger (for
  // a 'weave' wobble weapon) so the stream reads as a packed, slightly offset column rather
  // than perfectly overlapping shots.
  if (d.burst && n === 1) {
    // #243: the alternating stagger is per-weapon tunable (`delivery.burstStaggerDeg`, °).
    const staggerRad = ((d.burstStaggerDeg ?? STREAK_STAGGER_DEG) * Math.PI) / 180;
    const staggered = wobbleKind(weapon) === 'weave';
    const out = [];
    for (let i = 0; i < d.burst.count; i++) {
      out.push(shot({ angleOffset: staggered ? staggerRad * (i % 2 === 0 ? 1 : -1) : 0, delay: i * d.burst.interval }));
    }
    return { mode, shots: out };
  }

  return { mode, shots };
}

function shot({ delay = 0, angleOffset = 0, lateral = 0 } = {}) {
  return { delay, angleOffset, lateral };
}

// Build a round's kinematic state. The caller supplies `maxDist` (its own travel budget:
// the arena's target/lob distance, the Lab's stage width) and may tack on scene-specific
// fields (owner, trail) afterward.
export function makeProjectile(weapon, x, y, angle, { maxDist }) {
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
    // Turn rate is derived from speed (#77) so the round can always corner within a fixed radius
    // instead of orbiting a target it's too fast to turn onto. Arcing lobs override `speed` after
    // this (firing.js) and re-derive `turn` from the new speed (passing the same per-weapon
    // radius). #243: `delivery.homingTurnRadius` (px) tunes that radius per weapon.
    homing: d.guidance === 'homing', turn: homingTurnRate(speed, d.homingTurnRadius ?? HOMING_TURN_RADIUS),
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
