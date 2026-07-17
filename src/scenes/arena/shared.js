// Constants + tiny helpers shared across more than one arena mixin. Each mixin keeps its
// OWN single-use constants local to its file; only the genuinely cross-cutting ones live
// here so they can't drift between concerns.
import { LOCATIONS } from '../../data/anatomy.js';
import { isWeapon } from '../../data/items.js';
import { getWeapon } from '../../data/weapons.js';
import { CENTER } from '../../art/mechPrims.js';
import { weaponMuzzleTip } from '../../art/mounts/barrelSpec.js';

// On-screen scale of an arena mech (hull/turret sprites). Used by locomotion (view + muzzle)
// and combat (mapping a hit point back to the nearest body part).
export const ARENA_MECH_SCALE = 0.34;

// #149 (follow-up to #138: "the map still feels huge" — but the owner's playtest clarified the
// complaint isn't walking distance, it's PERCEIVED scale: "even standing still at spawn, the
// amount of open terrain/corridor visible or implied reads as vast"). Before this, ArenaScene's
// camera only neutralized device-pixel-ratio scaling (`setZoom(dpr)` — 1 world unit === 1 CSS
// px), with no separate gameplay-framing zoom on top; the world rendered at native scale, so a
// typical viewport showed a LOT of open ground per glance. GAMEPLAY_ZOOM is an extra multiplier
// applied ONLY in the arena (`setZoom(dpr * GAMEPLAY_ZOOM)`, ArenaScene.create() + main.js's
// resize handler) — purely a rendering/framing change: every world-space distance (weapon
// range, movement speed, hex size, `_offscreenSpawnPoint`'s viewport math) is untouched, only
// how much of that world-space a screen shows changes.
//
// Chosen by comparing real Playwright screenshots at the same seed/spawn across candidate
// factors (1.0/1.15/1.3/1.5/1.75): 1.15 read as barely different from native scale; 1.5+ started
// meaningfully shrinking how far an incoming threat is visible before it's already close (no
// enemy-radar/arrow exists in this game — only the mission-objective wayfinding arrow — so
// anything not on-screen is genuinely unseen, not just off the beaten path). 1.3 was the
// smallest factor that visibly changed the "vast empty field" read: the player mech and nearby
// terrain fill noticeably more of the frame, tree clusters/water read as closer landmarks
// instead of distant scenery, while still leaving a comfortable viewport radius for spotting
// enemies (most direct-fire weapons' optimal range, 338-500px, still fits well inside the
// shrunk view at any common viewport size).
// #157 (direct instruction, 2026-07-11: "turn off the new 1.3x game zoom"): set back to 1.0
// (a no-op multiplier — setZoom(dpr * GAMEPLAY_ZOOM) is equivalent to the pre-#149
// setZoom(dpr)). The mechanism above stays intact so a different value is a one-line change.
// #160 (direct instruction, 2026-07-11: "turn zoom back to 1.2 or 1.3, that was actually kinda
// cool") — reverts #157. Owner played without the zoom after confirming #155's tile-culling fix
// was the real FPS win (unrelated to zoom), and wants the 1.3 framing back.
export const GAMEPLAY_ZOOM = 1.3;

// #136: the single shared "wayfinding/aim highlight" colour — one source of truth for every
// UI element that means "pay attention to this direction/spot": the objective marker's amber
// ring (mission.js), the edge-direction arrow (HudScene.js), and the turret aim-line (targeting.js
// `_drawAimLine`). Previously each of the first two hardcoded the same 0xffb84a hex independently;
// naming it here means a future re-tint only ever needs one edit.
export const UI_HIGHLIGHT_COLOR = 0xffb84a;

// #99: explicit world-space depth tiers for everything drawn in the arena. Before this, most
// layers relied on Phaser's default same-depth tiebreak (scene display-list ADD ORDER) instead
// of a real `setDepth()` — which happened to read right only by accident of when each thing got
// created relative to the player. That broke down as more layers piled on: enemy views are
// spawned (`_spawnSquad`) AFTER `this.playerView` is created (ArenaScene.create()), so a tank
// unconditionally rendered over the player on overlap; napalm's burning-ground decal was drawn
// into the SAME graphics object as in-flight projectiles (`projFx`), which is itself created
// after both the player view and every enemy view, so the fire patch painted over both too.
// Neither bug was about ground fire or tanks specifically — it was every layer implicitly
// depending on creation order. One flat, named scale fixes both and holds as new layers arrive:
// #81 follow-up (playtest 2026-07-10 point 1): terrain tiles used to rely on that same default-
// depth-0 behavior, which happens to sort correctly ONLY because Phaser re-runs its depth sort
// whenever a game object is added to the display list — true for the very first world build, but
// a stage-advance's growth pass adds its NEW tile Images well after `this.playerView` (depth
// DEPTH.UNITS) already exists, and (depending on Phaser's internal batching) an unset depth can
// still end up compared by list index against objects it was never sorted against, landing the
// fresh ground tiles above the player instead of below. Giving terrain tiles the same explicit
// `DEPTH.TERRAIN` every time (initial build AND every growth pass) removes that ambiguity for good
// — see world.js `_buildWorld`.
//
// #113 (playtest 2026-07-10: "all ground units should be z-ordered below the player mech, such
// as infantry"): reverses part of #99's original "no player-above/below-enemies rule, just one
// flat UNITS tier" call — that flat tier is still correct for FLYING units (helicopter/drone:
// they're narratively elevated, and #92 already excludes them from ground collision for the same
// reason, so there's no "who's actually closer to the ground" ambiguity to resolve for them) but
// wrong for ground units, which can now stand directly under/beside the player and visually hide
// it. `GROUND_UNITS` slots into the previously-unused gap between GROUND_FX (1) and UNITS (3) —
// every non-flying enemy view (mech, tank, turret, infantry) renders here; the player and flying
// units keep DEPTH.UNITS.
export const DEPTH = {
  TERRAIN: 0,         // terrain tiles (world.js) — the floor, always lowest, explicit every time.
  GROUND_FX: 1,       // ground-hugging decals: napalm's burning-ground patch (projectiles.js)
  GROUND_UNITS: 2,    // #113: non-flying enemy views (mech, tank, turret, infantry) — always
                      // below the player so a ground unit standing under/near the player can
                      // never obscure it.
  UNITS: 3,           // the player, and flying enemy views (helicopter, drone) — elevated units
                      // that don't have the same "who's actually closer to the ground" ambiguity
                      // ground units do, so they keep the original flat #99 tier alongside the
                      // player.
  PROJECTILES: 4,     // in-flight rounds, persistent beams, muzzle flash / melee slash — flying
                      // over the units they're headed toward or past.
  IMPACT_FX: 5,       // impact bursts, death explosions, outpost-collapse debris, floating text
                      // — momentary feedback that should read clearly over whatever it's on.
  WORLD_UI: 6,        // world-space markers: the mission objective beacon, powerup/salvage
                      // beacons — always legible above units and FX.
};

// #113: which DEPTH tier a unit's view belongs at. The player and any FLYING enemy (helicopter,
// drone) stay at DEPTH.UNITS; every other (ground) unit — enemy mech, tank, turret, infantry —
// renders one tier lower at DEPTH.GROUND_UNITS so it can never stand over/obscure the player.
// PURE so the actual tier-SELECTION logic is unit-testable without touching Phaser; the two real
// call sites (locomotion.js `_makeMechView`, enemies.js `_makeVehicleView`) just feed this and
// call `setDepth()` with the result, and are covered by the arena smoke test instead.
export function unitDepth(isPlayer, flying) {
  return (isPlayer || flying) ? DEPTH.UNITS : DEPTH.GROUND_UNITS;
}

// The starting enemy's hex (world build clears it; create() spawns the first enemy there).
export const DUMMY_HEX = { q: 3, r: -1 };

// #100 (playtest 2026-07-10, correcting #87): a dying enemy's death explosion should scale
// with how TOUGH the enemy actually was, not its ON-SCREEN SPRITE scale. #87 used the sprite
// scale (enemyKinds.js `scale` / a mech's weightClass table) as the size signal, but sprite
// scale is a visual-composition knob, not a toughness one — e.g. the Battle Tank (hp 160, the
// toughest non-mech enemy) is deliberately drawn SMALL (scale 0.48, "tanks smaller" — #91) so
// it produced a SMALLER death explosion than a drone (hp 14, scale 0.52), exactly backwards
// from what a player expects. Both `Mech` and the non-mech `HpBody` expose a uniform `.maxHp`
// (#90) that already drives the powerup drop-chance scaling on this same "how big a deal was
// this kill" signal (data/powerups.js `dropChanceForMaxHp` — same floor/ceiling bounds, same
// roster spread: weakest real enemy is a drone at hp 14, toughest is a base heavy-chassis mech
// at maxHp 616) — reuse it here too instead of inventing a second, kind-branching one.
const DEATH_HP_FLOOR = 14;    // maxHp at/below which a kill gets the smallest boom (a drone)
const DEATH_HP_CEIL = 616;    // maxHp at/above which a kill gets the biggest boom (base heavy mech)
const DEATH_SCALE_MIN = 0.5;
// #225: exported (was module-private) so combat.js's player-death path can reuse the exact
// same ceiling `deathScaleFor` ever produces for an enemy, instead of a second hardcoded
// magic number drifting out of sync with it.
export const DEATH_SCALE_MAX = 1.3;
export function deathScaleFor(e) {
  const hp = Math.max(0, e.mech?.maxHp || 0);
  const span = DEATH_HP_CEIL - DEATH_HP_FLOOR;
  const t = span > 0 ? Math.min(1, Math.max(0, (hp - DEATH_HP_FLOOR) / span)) : 1;
  return DEATH_SCALE_MIN + t * (DEATH_SCALE_MAX - DEATH_SCALE_MIN);
}

// #107: which discrete destruction-EXPLOSION SOUND category a dying enemy's boom uses (Weapon
// Lab tunable — see audio/sfxParams.js's deathExplosionSmall/Medium/Large/Massive entries +
// Audio.deathExplosion). Buckets off the SAME `.maxHp` toughness signal `deathScaleFor` above
// already uses (drone 14 hp … base heavy mech 616 hp) — a few tunable buckets instead of
// continuously scaling one param set. Calibrated against the actual roster: drone 14 hp ⇒
// small; turret 90 / tank 160 / helicopter 70 / light mech ≈266 hp ⇒ medium; medium mech ≈416
// hp ⇒ large; heavy mech ≈616 hp ⇒ massive.
export function explosionCategoryFor(e) {
  const hp = Math.max(0, e.mech?.maxHp || 0);
  if (hp < 50) return 'small';
  if (hp < 300) return 'medium';
  if (hp < 550) return 'large';
  return 'massive';
}

// Move `cur` toward `target` by at most `maxStep`. Used by player + enemy locomotion.
export function approach(cur, target, maxStep) {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return cur;
}

// #86 — one shared turret/heading rotation step, used by the player's turret slew, every
// enemy mech's turret + facing, and the vehicle-behavior turret tracking (locomotion.js,
// enemies.js, enemyBehaviors.js all had their own copy of this exact expression, each calling
// Phaser.Math.Angle.RotateTo directly). PURE reimplementation of that same algorithm (no
// Phaser import — importing the `phaser` package itself crashes under vitest's node test
// environment: it touches `navigator` at import time for device detection) so this is
// directly unit-testable: rotate `cur` toward `target` at `radPerSec`, scaled by `dt` —
// properly dt-scaled so it behaves the same at 30fps (dt≈0.033) as 60fps (dt≈0.017), taking
// the short way around the ±π seam, and snapping to the target instead of overshooting past
// it once the step would cover the remaining distance (a big dt, or being already close).
const PI2 = Math.PI * 2;
export function rotateToward(cur, target, radPerSec, dt) {
  const lerp = radPerSec * dt;
  if (cur === target) return cur;
  let t = target;
  const diff = Math.abs(t - cur);
  if (diff <= lerp || diff >= PI2 - lerp) return t;
  if (diff > Math.PI) t += t < cur ? PI2 : -PI2;
  if (t > cur) return cur + lerp;
  if (t < cur) return cur - lerp;
  return cur;
}

// Re-exported for the combat mixin (damage maps to a body location). #128: LOCATIONS is
// already the damage-tracked set (head/cockpit/centerTorso are cosmetic only and can't be
// hit), so no filtering is needed here any more.
export const DAMAGEABLE = LOCATIONS;

// #231: nearest of `locs` (each a key into `lay`, a {x,y} design-space layout) to local hit
// point (lx, ly), in world px via `dispUnit`. PURE — factored out of combat.js `_damageEnemyAt`
// so both the initial pick and the already-destroyed redirect below can share it, and so the
// geometry is unit-testable without a Phaser scene.
export function nearestLocation(lay, locs, lx, ly, dispUnit) {
  let best = null, bestD = Infinity;
  for (const loc of locs) {
    const a = lay[loc];
    const d = Math.hypot(lx - a.x * dispUnit, ly - a.y * dispUnit);
    if (d < bestD) { bestD = d; best = loc; }
  }
  return best;
}

// #231 (real bug: "easy to destroy one side torso, then waaaaaay harder to destroy the
// second" — reported 2026-07-15): a hit maps to the part nearest the world hit point, but
// that part may already be destroyed (armor+structure both zeroed — directly, or cascaded,
// e.g. a side torso takes its arm with it per DESTROY_CASCADE). Applying damage to an
// already-dead part just wastes the hit into nothing, and since a kill needs BOTH side
// torsos destroyed (LETHAL_GROUPS), every hit that geometrically lands on the now-empty side
// silently did nothing instead of redirecting — making the second side (the actual kill)
// feel far tankier than the first. Redirects to the nearest still-LIVE location instead,
// falling back to the originally-nearest (dead) one only if every candidate is dead (should
// be unreachable while the unit is alive, since a full-kill combination is caught by the
// caller's `isDestroyed()` check first — kept as a safe no-op fallback regardless).
export function resolveHitLocation(lay, locs, lx, ly, dispUnit, isPartDestroyed) {
  const best = nearestLocation(lay, locs, lx, ly, dispUnit);
  if (!isPartDestroyed(best)) return best;
  const live = locs.filter((loc) => !isPartDestroyed(loc));
  return live.length ? nearestLocation(lay, live, lx, ly, dispUnit) : best;
}

// #231: same redirect idea as `resolveHitLocation` above, for the player's weighted-random
// hit-location roll (combat.js `_damagePlayerAt`) instead of nearest-part geometry. Rerolls
// only among the LIVE entries of the same weighted pool (so relative weights among survivors
// are preserved, e.g. losing one torso still leaves the other torso doubly-weighted against
// the arms) rather than a plain uniform pick or a reroll loop. `rng` is injectable for tests.
export function pickLiveWeighted(pool, isPartDestroyed, rng = Math.random) {
  const loc = pool[Math.floor(rng() * pool.length)];
  if (!isPartDestroyed(loc)) return loc;
  const live = pool.filter((p) => !isPartDestroyed(p));
  return live.length ? live[Math.floor(rng() * live.length)] : loc;
}

// #109: world position of a muzzle at a body part's front edge — the shared geometry behind
// EVERY "where does this shot actually leave from" computation in the arena. `part` is a
// {x, y, w, h} box in mech-local design coords (origin = unit centre, −y = forward): x is
// lateral offset from centre, y is the box's own centre, w/h its size. `disp` converts design
// units → world px (chassis/vehicle on-screen scale × ART_SCALE). Placed at world (x, y),
// rotated by `angle` (the unit's current turret/aim facing). PURE (no Phaser/scene) so it's
// unit-testable. Originally just the player's locomotion `_muzzle(loc)` (a left-arm shot visibly
// leaves the left arm); factored out here so enemy MECH fire (enemies.js, keyed off w.location
// via mechLayout) and non-mech KIND fire (enemies.js `_fireVehicleWeapon`, keyed off the kind's
// gun/barrel/etc. part in enemyKinds.js) compute the same real muzzle instead of each using its
// own fixed near-centre offset (#109).
// `tipOffset` (#233, design units, same scale as `part`): how much further forward the
// weapon's actual drawn muzzle art reaches PAST the part's own front edge — e.g. a Rail
// Lance's barrel juts well beyond its arm/torso box, so spawning at the bare front edge (the
// old default of 0) visibly started every shot inside the mech instead of at the barrel tip.
// Callers with real weapon art (mech mounts via `weaponMuzzleTip`, mounts/barrelSpec.js) pass
// that length in; callers with no such art (or that predate #233) get the old front-edge
// behaviour unchanged.
//
// `tilt`/`pivotFrac` (#233 follow-up, playtest: "not matching up with the arm/torso tilt that
// happens with convergence tuning"): a pivoting part (arm/side-torso) doesn't rotate around the
// MECH CENTRE — it rotates around its own joint (see mechArt.js `partSpriteTransform`/
// `PART_PIVOT`), `pivotFrac` of the way toward the part's rear. At tilt 0 the whole box still
// behaves as if rigidly attached to the centre (rotating everything by the same `angle`
// recovers the old single-rotation formula exactly, regardless of `pivotFrac` — the split below
// is linear, so it only matters once tilt != 0). But once convergence tilts the part by `tilt`
// on top of `angle`, only the JOINT stays fixed relative to the mech centre; everything from the
// joint forward (including the muzzle tip) swings by the full `angle + tilt`. Computing the tip
// as one rotation of the whole centre-to-tip vector by `angle` (the old formula, unconditionally)
// silently assumed the part was still at its neutral/rest orientation, so the computed muzzle
// drifted from the real rendered barrel tip any time the arm/torso was actually tilted for
// convergence. Non-pivoting callers (centerTorso/head, or anything that predates convergence
// tilt) simply never pass a non-zero `tilt`, so they're unaffected.
export function partMuzzle(part, x, y, angle, disp, tipOffset = 0, tilt = 0, pivotFrac = 0) {
  // Joint: `pivotFrac` of the part's height toward its rear (+y), same fraction the sprite
  // itself pivots around — fixed relative to the mech centre, so it only ever rotates by the
  // base `angle` (never the tilt).
  const jointF = -(part.y + part.h * pivotFrac) * disp;
  const jointR = part.x * disp;
  const jointX = x + jointF * Math.cos(angle) - jointR * Math.sin(angle);
  const jointY = y + jointF * Math.sin(angle) + jointR * Math.cos(angle);
  // Tip: straight ahead of the joint (no lateral component — a barrel extends along the part's
  // own forward axis), rotated by the part's LIVE orientation (`angle + tilt`).
  const tipF = (part.h * (0.5 + pivotFrac) + tipOffset) * disp;
  return {
    x: jointX + tipF * Math.cos(angle + tilt),
    y: jointY + tipF * Math.sin(angle + tilt),
  };
}

// #233: the tipOffset partMuzzle needs for a MECH's mounted weapon at `loc` — shared by the
// player's locomotion `_muzzle(loc)` and an enemy mech's fire loop (enemies.js), so both spawn
// shots at the same real muzzle-art tip instead of the front edge. `part` is `mechLayout(mech)
// [loc]` (already computed by both callers); returns 0 for an empty/unweaponed location so a
// bare mount (or the tilt-preview call on a location with no gun) still resolves to the front
// edge, same as before this fix.
export function mechMuzzleTipOffset(mech, loc, part) {
  const ids = mech.mounts[loc]?.filter(isWeapon) ?? [];
  if (!ids.length) return 0;
  const wpn = getWeapon(ids[0]);
  if (!wpn) return 0;
  return weaponMuzzleTip(wpn.id, wpn.category, part, mech.chassis.art.bodyLen, CENTER);
}

// ── Direct-fire convergence (#40, #31, #74) ──────────────────────────────────────────
// Direct-fire weapons (lasers, autocannons) toe their off-centre muzzles inward to a point
// on the turret line at the live most-aimed enemy's range, so shots land where the turret
// points. Two named distances, both playtest-tunable:
export const CONVERGE_DIST = 450;     // px: convergence range when nothing is being aimed at.
// #74: floor on the convergence distance so a point-blank enemy (dist → ~0) can't drag the
// point onto the mech and rotate the arm/torso muzzles until they nearly cross — an absurd,
// silly toe-in the playtester flagged. Below this floor the muzzles stay only gently toed.
// Sanity-checked against the actual world-space muzzle geometry (part.x × ARENA_MECH_SCALE ×
// ART_SCALE — see locomotion `_muzzle`): the widest muzzles are the arms, whose LATERAL
// offset r ≈ 17px (light) … 33px (heavy) sit forward f ≈ 12–19px of the mech centre, so the
// worst-case toe-in is atan(r / (dist − f)). The tested worst case (heavy arm, r ≈ 32.7px,
// f ≈ 12.1px — see convergence.test.js) needs dist ≳ 166px to stay under the test's 12° cap,
// so 170 is the lowest round floor with headroom: it peaks at ~11.7° (heavy arm) down to
// ~6° (light) — a modest inward cant, versus ~2–4° at the natural 450 range and the ~45–90°
// near-crossing it replaces at true point-blank. Follow-up (2026-07-12): lowered from 200 to
// 170 per playtest feedback that the floor was a bit too conservative. Raising it toes in
// less (more parallel), lowering it toes in more; 170 keeps convergence active through the
// common mid-range engagement while killing the point-blank cross-eye.
export const MIN_CONVERGE_DIST = 170;

// Fire angle for one direct-fire muzzle at world (mx, my): aim it at a convergence point on
// the turret line `dist` ahead of the mech at (px, py), with `dist` clamped to `minDist` so
// the toe-in can't blow up at point-blank. PURE (no Phaser / no scene) so it's unit-testable;
// both the firing path (targeting `_fireAngle`) and the visual part-tilt (locomotion
// `_partTilt`, which calls `_fireAngle`) go through this, so the clamp applies to both.
export function convergedFireAngle(px, py, turretAngle, dist, mx, my, minDist = MIN_CONVERGE_DIST) {
  const d = Math.max(dist, minDist);
  const cx = px + Math.cos(turretAngle) * d;
  const cy = py + Math.sin(turretAngle) * d;
  return Math.atan2(cy - my, cx - mx);
}

// #250: signed angular offset of world point (x, y) from (px, py), relative to `turretAngle`,
// wrapped to (−π, π]. PURE reimplementation of `Phaser.Math.Angle.Wrap(atan2(...) - turretAngle)`
// (no Phaser import — see `rotateToward` above for why that crashes under vitest) so the
// convergence-candidate scoring below is unit-testable.
export function aimAngleOffset(px, py, turretAngle, x, y) {
  const raw = Math.atan2(y - py, x - px) - turretAngle;
  return Math.atan2(Math.sin(raw), Math.cos(raw));
}

// #250: of `candidates` (each a {x, y, ...}) within `maxDist` px of (px, py), the one most
// centred on the aim line (smallest |aimAngleOffset|) — no cone gate, "whatever I'm pointing
// closest to." PURE; mirrors the enemy convergence pick in targeting.js `_updateLock` exactly,
// so destructible-terrain candidates are scored by the identical rule.
export function nearestToAimLine(px, py, turretAngle, candidates, maxDist = Infinity) {
  let best = null, bestOff = Infinity;
  for (const c of candidates) {
    if (Math.hypot(c.x - px, c.y - py) > maxDist) continue;
    const off = Math.abs(aimAngleOffset(px, py, turretAngle, c.x, c.y));
    if (off < bestOff) { bestOff = off; best = c; }
  }
  return best;
}

// #250 (issue: "destroyable hexes should be potential convergence targets, but lower priority
// than enemies"): what direct-fire convergence should aim at this frame. `aimEnemy` is whatever
// targeting.js `_updateLock` already picked as the live most-aimed enemy (or null); `hexCandidates`
// is a list of standing destructible-terrain points (world.js `_destructibleHexesNear`) to fall
// back on. The ordering is enforced structurally, not by comparing scores: an enemy is returned
// immediately whenever one exists, so a destructible hex is NEVER even considered — let alone
// preferred — while any enemy is available, regardless of which is closer or better-aimed. Only
// when there is no enemy at all does a hex get scored via `nearestToAimLine`. Returns null (the
// pre-#250 "nothing to converge on" case) when neither exists, matching prior behavior exactly.
export function pickConvergeTarget(px, py, turretAngle, aimEnemy, hexCandidates, maxDist = Infinity) {
  if (aimEnemy) return aimEnemy;
  return nearestToAimLine(px, py, turretAngle, hexCandidates, maxDist);
}

// #92: the tank's HULL turns to face its direction of TRAVEL (like a real tank driving),
// completely independent of its turret (which separately tracks the player — see aimAndFire
// in enemyBehaviors.js, which drives e.turret). PURE + testable: only turns while actually
// moving faster than `moveThreshold` (a stopped tank keeps facing wherever it last drove,
// rather than snapping to some arbitrary heading), reusing the same dt-scaled `rotateToward`
// step every other facing/aim rotation in the arena uses.
export function hullTravelAngle(curAngle, vx, vy, turnRate, dt, moveThreshold = 5) {
  if (Math.hypot(vx, vy) <= moveThreshold) return curAngle;
  return rotateToward(curAngle, Math.atan2(vy, vx), turnRate, dt);
}

// #92: is point (px, py) inside a circle of `radius` centred at (ex, ey)? PURE — the shared
// primitive behind the player-vs-ground-enemy collision check (world.js `_blockedByGroundEnemy`),
// factored out so the geometry itself is unit-testable without a scene.
export function circleContains(px, py, ex, ey, radius) {
  return Math.hypot(px - ex, py - ey) < radius;
}

// #92: the on-screen collision footprint (px) of a GROUND enemy unit, used both to block the
// player's movement (world.js `_blockedByGroundEnemy`) and to decide how close counts as
// "pressed into it" for the tank-crush check. A mech enemy uses one flat radius (they're all
// drawn at the same ARENA_MECH_SCALE); a non-mech vehicle kind scales a base radius by its
// own data-driven `scale` (enemyKinds.js) so a small turret and a bulkier tank each collide at
// roughly their drawn size. Both radii are owner-tunable — picked to roughly match the sprite
// footprints, not derived from exact art bounds.
export const ENEMY_COLLIDE_RADIUS_MECH = 28;      // px — enemy mech chassis footprint
export const ENEMY_COLLIDE_RADIUS_VEHICLE = 24;   // px — base non-mech ground-unit footprint
export function groundEnemyRadius(e) {
  if (e.kind === 'mech' || e.kind === undefined) return ENEMY_COLLIDE_RADIUS_MECH;
  return ENEMY_COLLIDE_RADIUS_VEHICLE * (e.kindDef?.scale ?? 1);
}

// #112 (playtest 2026-07-10: "the stomp hitbox... needs to be bigger"): the crush-trigger check
// (world.js `_crushTargetAt`, called from locomotion.js `_drive`) used to test the player's
// point position against `groundEnemyRadius(e)` alone — i.e. the PLAYER contributed zero radius
// of its own, so triggering a stomp required the player's exact centre to land inside the
// enemy's (often tiny) footprint. That's especially punishing for the two crushable kinds:
// CRUSHABLE_BEHAVIORS are tank (scale 0.48 ⇒ ENEMY_COLLIDE_RADIUS_VEHICLE*0.48 ≈ 11.5px) and
// infantry (scale 0.38 ⇒ ≈ 9.1px) — both well under half the player mech's own on-screen
// footprint (drawn at the same ARENA_MECH_SCALE as an enemy mech, whose flat collision radius is
// ENEMY_COLLIDE_RADIUS_MECH = 28px), so "lining up" meant threading a target roughly a third the
// size of the mech doing the stomping. This constant is the player's own contribution to the
// crush trigger ONLY — added on top of the enemy's existing radius via `crushTriggerRadius`
// below — so the general "can't walk through a mech/turret" blocking check
// (`_blockedByGroundEnemy`, still just `groundEnemyRadius(e)`) is deliberately left untouched:
// bumping the shared radius would also make merely blocking past an uncrushable mech/turret feel
// too generous, which nobody asked for. 26px (≈ the base vehicle footprint, and roughly half the
// player's own drawn radius) roughly triples the tank's and infantry's effective trigger circle
// (≈37.5px / ≈35.1px) — big enough that brushing past a trooper cluster reliably stomps them,
// without ballooning to something that reaches out and crushes units the player only grazed.
export const PLAYER_CRUSH_RADIUS_BONUS = 26; // px — player's own contribution, crush-trigger only

// #112: crush-trigger radius for a specific enemy — the enemy's own footprint plus the player's
// contribution above. Deliberately separate from `groundEnemyRadius` (general blocking) so the
// two can diverge; see the comment on `PLAYER_CRUSH_RADIUS_BONUS`.
export function crushTriggerRadius(e) {
  return groundEnemyRadius(e) + PLAYER_CRUSH_RADIUS_BONUS;
}

// #92/#104: which `behavior` keys get the instant-crush-on-contact treatment (world.js
// `_crushGroundEnemyAt`, called from locomotion.js `_drive`) instead of just blocking the player
// like a normal ground enemy. Originally tank-only (#92 correction); #104 extends it to infantry
// — the weakest unit in the game (hp 6) — since a single stomp destroying one trooper as the
// player drives through a cluster is the natural read of "infantry should be stompable."
export const CRUSHABLE_BEHAVIORS = new Set(['tank', 'infantry']);

// #41: crush/stomp damage for ONE frame of the player leaning into a destructible outpost — DPS
// scaled by how hard the player is driving in (speedFrac, clamped 0..1), with a floor (0.35) so
// even a gentle press still chips away instead of doing nothing. PURE — used by world.js
// `_stompBuildingAt`. #92 (corrected 2026-07-10): tanks used to share this gradual formula via
// `_crushTankAt`, but playtest feedback ("it should be instant smash") moved tank-crushing (and,
// per #104, infantry too — see `_crushGroundEnemyAt`) to a one-hit kill instead — buildings are
// the only thing still using this gradual formula.
export function crushDamage(dps, dt, speedFrac) {
  const frac = speedFrac < 0 ? 0 : speedFrac > 1 ? 1 : speedFrac;
  return dps * dt * (0.35 + 0.65 * frac);
}

// #45: mechs don't run backwards at full tilt. Scale a max-speed figure down when the
// movement-intent vector (mx, my; needn't be normalized) has a net negative component
// along the turret facing — i.e. the mech is backing away from where it's aimed. Pure
// sideways/forward movement is untouched; only the backward component is penalized, via
// a continuous lerp so strafing diagonally-back doesn't hard-clip to one multiplier.
export const BACKWARD_SPEED_MULT = 0.55; // owner: tune — 50-60% of maxSpeed while backing up
export function backwardSpeedScale(mx, my, turretAngle) {
  const mag = Math.hypot(mx, my);
  if (mag < 1e-4) return 1;
  const facing = Math.cos(turretAngle) * (mx / mag) + Math.sin(turretAngle) * (my / mag);
  if (facing >= 0) return 1;
  // facing in [-1, 0]; lerp from 1 (purely sideways) to BACKWARD_SPEED_MULT (straight back).
  return 1 + facing * (1 - BACKWARD_SPEED_MULT);
}
