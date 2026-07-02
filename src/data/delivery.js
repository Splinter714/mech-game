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

const TURN_RATE = 4.0;            // guided-missile steering rate (rad/s)
const CLUSTER_SPACING = 6;        // lateral px between rounds in a dumbfire cluster
const STREAM_SPACING = 5;         // default lateral px between parallel lanes of a multi-stream weapon (Repeater)
const DEFAULT_SPREAD_DEG = 16;    // fan width for a spread weapon that omits spreadAngle
const SPREAD_JITTER_DELAY = 35;   // ms, max random emission stagger for a jittered spread (#46)

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
const STREAK_STAGGER_DEG = 0.3;   // ° angular stagger between consecutive Streak Pod sub-shots — tight column
const SWAY_AMPLITUDE = 5;         // px, per-rocket undulation within a cluster clump (#51) — small so the clump stays tight
const SWAY_FREQUENCY = 7;         // rad/s

// Which wobble personality (if any) a weapon's rounds fly with. Cluster weapons always get
// 'sway' (#51 — a small per-rocket-independent undulation); among homing weapons, it's an
// explicit opt-in data flag (`delivery.wobble: 'jostle' | 'weave'`), never a hardcoded
// weapon id, so this stays shared/variant-agnostic plumbing.
function wobbleKind(weapon) {
  const d = weapon.delivery || {};
  if (d.cluster) return 'sway';
  if (d.guidance !== 'homing') return null;
  return d.wobble === 'jostle' || d.wobble === 'weave' ? d.wobble : null;
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
  for (let i = 0; i < n; i++) {
    const c = n > 1 ? (i - (n - 1) / 2) : 0;       // centred index: −…0…+
    if (d.cluster) {
      shots.push(shot({ lateral: c * CLUSTER_SPACING }));
    } else if (n > 1) {
      const jitter = jitterRad ? (Math.random() - 0.5) * 2 * jitterRad : 0;
      const fireDelay = jitterRad ? Math.random() * SPREAD_JITTER_DELAY : 0;
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
    const staggerRad = (STREAK_STAGGER_DEG * Math.PI) / 180;
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

// #60 Double Shot powerup: turn a plan's emission list into a doubled one — every original
// emission gets a twin fired a hair later (DOUBLE_SHOT_STAGGER ms) so the pair reads as a
// genuine double rather than one fat shot. To keep the doubled output reading as a DOUBLE and
// not merely a wider fan/clump, each shot's spread offsets (angle + lateral) are scaled by
// `tighten` (< 1 pulls the fan in). Pure — operates on the { delay, angleOffset, lateral }
// descriptors planEmissions produces, so it's shared/unit-tested and Phaser-free.
const DOUBLE_SHOT_STAGGER = 40;   // ms between a shot and its twin
export function doubleShotEmissions(shots, tighten = 1) {
  const out = [];
  for (const s of shots) {
    const tightened = { delay: s.delay, angleOffset: s.angleOffset * tighten, lateral: s.lateral * tighten };
    out.push(tightened);
    out.push({ ...tightened, delay: s.delay + DOUBLE_SHOT_STAGGER });
  }
  return out;
}

// Build a round's kinematic state. The caller supplies `maxDist` (its own travel budget:
// the arena's target/lob distance, the Lab's stage width) and may tack on scene-specific
// fields (owner, trail) afterward.
export function makeProjectile(weapon, x, y, angle, { maxDist }) {
  const d = weapon.delivery || {};
  // A jittered-spread weapon (Flamethrower, #46) also gets a per-particle speed variance so
  // the flame front looks ragged/chaotic rather than a uniform wall advancing in lockstep.
  const speedJitter = d.spreadJitter ? 0.82 + Math.random() * 0.36 : 1;
  const speed = (d.velocity || 480) * speedJitter;
  const wobble = wobbleKind(weapon);
  // Every wobble kind — including a cluster's 'sway' (#51) — rolls its OWN random phase, so
  // no two rounds in a salvo/clump ever undulate in lockstep. For a cluster this means each
  // rocket wiggles independently within the (still tight) clump instead of snaking together.
  const wobblePhase = wobble ? Math.random() * Math.PI * 2 : 0;
  return {
    x, y, angle, speed,
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    kind: projectileKind(weapon), color: CATEGORIES[weapon.category]?.color ?? 0xffffff,
    weaponId: weapon.id,
    damage: weapon.damage, splash: d.splash || 0, range: weapon.range, scale: d.scale || 1,
    dist: 0, maxDist, arc: d.path === 'arcing', ground: d.groundFire || null,
    homing: d.guidance === 'homing', turn: TURN_RATE,
    // Flight-personality wobble — see wobbleKind(). `wobbleOffset` is the last-applied
    // lateral nudge (kept so the trail/art can read where the round visually is).
    wobble, wobblePhase, wobbleOffset: 0, wobbleTime: 0,
  };
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
    let offset = 0;
    if (p.wobble === 'jostle') {
      // Chaotic random-phase jiggle, constant amplitude all the way to impact (no settling).
      offset = Math.sin(p.wobbleTime * JOSTLE_FREQUENCY + p.wobblePhase) * JOSTLE_AMPLITUDE;
    } else if (p.wobble === 'weave') {
      // Smooth, deliberate sine weave at constant amplitude — no decay, no randomness.
      offset = Math.sin(p.wobbleTime * WEAVE_FREQUENCY + p.wobblePhase) * WEAVE_AMPLITUDE;
    } else if (p.wobble === 'sway') {
      // Each rocket has its OWN random phase (#51), so within one clump every rocket
      // undulates independently — a loose-but-together group that wiggles internally,
      // never a rigid formation snaking in lockstep. Small amplitude keeps the clump tight.
      offset = Math.sin(p.wobbleTime * SWAY_FREQUENCY + p.wobblePhase) * SWAY_AMPLITUDE;
    }
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
