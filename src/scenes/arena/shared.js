// Constants + tiny helpers shared across more than one arena mixin. Each mixin keeps its
// OWN single-use constants local to its file; only the genuinely cross-cutting ones live
// here so they can't drift between concerns.
import { LOCATIONS } from '../../data/anatomy.js';
import { isWeapon } from '../../data/items.js';
import { getWeapon } from '../../data/weapons.js';
import { CENTER } from '../../art/mechPrims.js';
import { weaponMuzzleTip } from '../../art/mounts/barrelSpec.js';
import { hexCorners } from '../../data/hexgrid.js';
import { liveToughnessBounds } from '../../data/rosterBounds.js';

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
// spawned AFTER `this.playerView` is created (ArenaScene.create()), so a tank
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
  // #326 playtest bug (Jackson: "z-ordering on docks reinforcing animation is bad... it's too high
  // compared to the units that are coming out"). The dock hatch FX — the shaft, the sliding door
  // leaves, the rising platform and its glow (`_resupplyDock`), plus the dome plate/rim that seals
  // a vacated dock (`_closeDockFx`), all in bases.js — used to be built on IMPACT_FX (5), far
  // above every unit tier, so a tank driving out of its own bay rendered UNDERNEATH its own hatch
  // doors. Exactly backwards: a hatch is a HOLE IN THE GROUND, and the things standing on the
  // ground belong on top of it.
  //
  // Slotted between GROUND_FX (1) and GROUND_UNITS (2) — the ground-decal band, alongside napalm's
  // burning patch — using the same fractional-tier pattern (#289) that COVER_CANOPY/
  // LARGE_GROUND_UNITS use, so nothing has to be renumbered. The four sub-offsets below preserve
  // the FX's existing internal order (shaft under doors under platform under glow).
  //
  // Deliberately ENTIRELY below the units rather than the alternative of leaving the door leaves
  // above GROUND_UNITS to occlude a rising unit: by the time `_resupplyDock` spawns anything, its
  // doors-open tween has already completed and the leaves have slid clear to either side, so they
  // are not over the unit to occlude it in the first place. Splitting the tiers would buy no
  // occlusion and would reintroduce the reported bug for large units. The reported problem is that
  // units are hidden; this makes them unambiguously visible.
  DOCK_FX: 1.5,
  GROUND_UNITS: 2,    // #113: SMALL non-flying enemy views (tank, infantry — #289 size-split) —
                      // always below the player, and (per #289) below the cover canopy so a small
                      // unit standing in cover peeks out from UNDER the foliage.
  // #289: cover terrain's foliage/canopy overlay (world.js's per-cover-hex second Image, art
  // from hexArt.js's CANOPY_DETAIL) — sits strictly between GROUND_UNITS and LARGE_GROUND_UNITS
  // so a SMALL ground unit standing in cover renders BELOW the canopy (visible from the waist
  // down under the tree/foliage silhouette, not fully obscured) while LARGE ground units and the
  // player render ABOVE it. A non-integer value (2.5) is used deliberately instead of renumbering
  // every existing tier below/above it: Phaser's depth sort only needs correct RELATIVE
  // ordering, so slotting a fractional value between 2 and 3 is exactly as valid as an integer
  // and avoids a shotgun rename of GROUND_UNITS/UNITS/PROJECTILES/etc. across every call site
  // that already hardcodes/imports those names.
  COVER_CANOPY: 2.5,
  // #289 follow-up (playtest: "light mechs should not sort below the tops of trees/cover"): LARGE
  // ground enemy views (enemy mech, carrier, turret) are tall enough to tower OVER the tree/
  // foliage canopy, so they render ABOVE COVER_CANOPY (2.5) — but still strictly BELOW the player
  // (UNITS = 3), preserving #113's invariant that no ground unit ever obscures the player. Only
  // SMALL ground units (tank/infantry) stay at GROUND_UNITS (2), below the canopy, per #289's
  // peek-out-from-under intent. Another fractional slot (2.75) between COVER_CANOPY and UNITS, for
  // the same "no renumbering" reason COVER_CANOPY uses 2.5.
  LARGE_GROUND_UNITS: 2.75,
  // #306: the line-of-sight dimming overlay (arena/visibility.js) — ONE dark translucent layer
  // over the hexes the player currently has no sight of. Its position in this stack IS the
  // feature: everything below it (terrain 0, ground FX 1, small ground units 2, cover canopy 2.5,
  // large ground units 2.75) is dimmed uniformly because they all share this single overlay,
  // while the player and FLYING enemy views (UNITS = 3) sit ABOVE it and are untouched — which is
  // exactly the requested "a flying enemy over a blocked area still flies above the dimming",
  // with no per-entity logic. Ground enemies under it read as DIMMED, not hidden (confirmed
  // intent: the player must never be shot by something wholly invisible). World-space markers
  // (WORLD_UI = 6) stay bright as navigational aids — a deliberate call, see visibility.js.
  // Another fractional slot, for the same "don't renumber every existing tier" reason 2.5/2.75
  // use (#289).
  LOS_DIM: 2.9,
  // #337 v3: base perimeter WALLS and the wall turrets emplaced on them, just ABOVE LOS_DIM. The
  // fog now covers a compound's whole footprint including the ring of hexes the walls line (fixing
  // "the first ring of hexes inside the wall isn't blacked out at all") and fills it FULLY OPAQUE,
  // so a wall drawn under the overlay would simply vanish. Lifting the perimeter over the fill is
  // what keeps "Wall turrets should be visible from inside or outside, right?" true without
  // punching a hole in the fog. Still below UNITS (3), so the player is never obscured.
  WALLS: 2.95,
  UNITS: 3,           // the player — never dimmed, and never obscured by any GROUND unit.
                      // (Flyers deliberately DO pass over the player — see FLYING_UNITS.)
  // #327: FLYING enemy views (helicopter, drone) render ABOVE the player. History: #306 gave them
  // the player's UNITS (3) tier so the LOS overlay passed under them; #316 dropped them to 2.8,
  // strictly BELOW LOS_DIM (2.9), so the fog dimmed them like any ground unit. In play that read
  // wrong — an airborne unit drew UNDERNEATH the mech it was flying over. LOS dimming is currently
  // switched off, and Jackson's call on #327 was "don't care [about the fog], just fix the
  // z-order", so flyers now sit at 3.5: above the player (3), below projectiles (4) so rounds,
  // impact FX and world UI still draw over them.
  // OPEN THREAD: this puts flyers ABOVE LOS_DIM again, which means if LOS dimming is ever
  // re-enabled a flyer over un-sighted ground will stay bright — the exact thing #316 fixed. That
  // trade was accepted knowingly. Whoever turns the dimming back on has to re-decide it (options:
  // raise LOS_DIM above 3.5, or dim flyers per-entity instead of via the single overlay).
  FLYING_UNITS: 3.5,
  PROJECTILES: 4,     // in-flight rounds, persistent beams, muzzle flash / melee slash — flying
                      // over the units they're headed toward or past.
  IMPACT_FX: 5,       // impact bursts, death explosions, outpost-collapse debris, floating text
                      // — momentary feedback that should read clearly over whatever it's on.
  WORLD_UI: 6,        // world-space markers: the mission objective beacon, powerup/salvage
                      // beacons — always legible above units and FX.
};

// #113/#289/#327: which DEPTH tier a unit's view belongs at. The PLAYER stays at DEPTH.UNITS
// (3), above the LOS dimming layer and above every ground unit. A FLYING enemy (helicopter, drone)
// renders at DEPTH.FLYING_UNITS (3.5) — above the player and every ground unit, so an aircraft
// visibly passes OVER the mechs it flies across (#327), but below PROJECTILES (4) so rounds,
// impact FX and world UI still draw over it. Every non-flying
// (ground) ENEMY unit renders below that, and #289 splits ground units by SIZE tier so they sort
// correctly against the cover canopy (COVER_CANOPY = 2.5): SMALL ground units (tank/infantry —
// `small === true`) stay at DEPTH.GROUND_UNITS (2, below the canopy, so they peek out from UNDER
// foliage), while LARGE ground units (enemy mech/carrier/turret) render at
// DEPTH.LARGE_GROUND_UNITS (2.75, above the canopy so they tower over tree tops). `small` is the
// caller's size-tier signal (isSmallUnit / `def.size === 'small'`); it's ignored for the player and
// flyers, which the isPlayer/flying branches handle first. PURE so the tier-SELECTION logic is
// unit-testable without touching Phaser; the two real call sites (locomotion.js `_makeMechView`,
// enemies.js `_makeVehicleView`) feed this and call `setDepth()` with the result.
// #337 v3: `wallMounted` (a gun emplaced on a wall span — `spanKey != null`, bases.js) overrides the
// size tiers and returns DEPTH.WALLS, above the fog overlay, for the reason given on that constant.
// Checked after the player/flyer branches, which are about who the unit IS rather than where it sits.
export function unitDepth(isPlayer, flying, small = false, wallMounted = false) {
  if (isPlayer) return DEPTH.UNITS;
  if (flying) return DEPTH.FLYING_UNITS;
  if (wallMounted) return DEPTH.WALLS;
  return small ? DEPTH.GROUND_UNITS : DEPTH.LARGE_GROUND_UNITS;
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
// (#90), the same family of "how big a deal was this kill" signal the powerup drop chance uses
// — reuse it here too instead of inventing a second, kind-branching one.
// #301 (fixing the drift this comment used to just describe): both the explosion SIZE and the
// explosion SOUND tier now read `.toughness` (structure + armor + shield — uniform across
// Mech/HpBody) against bounds DERIVED from the live roster, exactly as the drop curve does
// (data/rosterBounds.js, shared by both). The old hand-set pair — floor 14, ceiling 616 on
// `.maxHp` — was stale: #128 dropped head/cockpit/centerTorso out of the tracked damage
// locations, making the real toughest unit 430, so NOTHING could reach the ceiling and the whole
// scale sat compressed in its lower range. Deriving the endpoints means the toughest thing alive
// always gets the biggest boom, and #299's coming HP retune moves it automatically.
// Today's derived range: floor 6 (infantry) … ceiling 430 (the artillery mech on heavy chassis).
const DEATH_SCALE_MIN = 0.5;
// #225: exported (was module-private) so combat.js's player-death path can reuse the exact
// same ceiling `deathScaleFor` ever produces for an enemy, instead of a second hardcoded
// magic number drifting out of sync with it.
export const DEATH_SCALE_MAX = 1.3;

// How far up the roster's toughness range this body sits: 0 = the weakest thing in the game,
// 1 = the toughest. `bounds` is injectable for tests.
function toughnessProgress(e, bounds = liveToughnessBounds()) {
  const t = Math.max(0, e?.mech?.toughness || 0);
  const span = bounds.ceil - bounds.floor;
  if (!(span > 0)) return 1;
  return Math.min(1, Math.max(0, (t - bounds.floor) / span));
}

export function deathScaleFor(e, bounds = liveToughnessBounds()) {
  return DEATH_SCALE_MIN + toughnessProgress(e, bounds) * (DEATH_SCALE_MAX - DEATH_SCALE_MIN);
}

// #107: which discrete destruction-EXPLOSION SOUND category a dying enemy's boom uses (Weapon
// Lab tunable — see audio/sfxParams.js's deathExplosionSmall/Medium/Large/Massive entries +
// Audio.deathExplosion). Still the same four discrete buckets off the same toughness signal
// `deathScaleFor` uses — #301 only changed WHAT the thresholds are measured against, not the
// bucketing design (whether tiers should track toughness linearly at all is an open playtest
// question on #301, deliberately not touched here). The cut points are expressed as FRACTIONS
// of the derived range, preserving #107's original relative calibration (its 50/300/550 cuts
// sat at ~0.06/0.48/0.89 of the then-assumed 14..616 span) while letting the endpoints move with
// the roster. Against the post-#299 derived 3..500: infantry / drone 3 ⇒ small; turret 50 /
// helicopter 50 / tank 80 / carrier 150 / light mech 200 ⇒ medium; medium mech 350 ⇒ large;
// heavy mech 500 ⇒ massive — the top tier is still reachable, by exactly the toughest unit.
// #299 retuned the entire roster and this file needed no edit: the cuts are fractions of a
// derived span, so the tiers re-sorted themselves.
const CATEGORY_CUTS = [
  [0.06, 'small'],
  [0.48, 'medium'],
  [0.89, 'large'],
];
export function explosionCategoryFor(e, bounds = liveToughnessBounds()) {
  const t = toughnessProgress(e, bounds);
  for (const [cut, name] of CATEGORY_CUTS) if (t < cut) return name;
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

// ── #322: cone gate, then NEAREST wins ───────────────────────────────────────────────────
// The whole targeting priority rule, replacing #250's blended angle+distance score for enemies,
// #250's pure-angle score for terrain, and #262's focus toggle (all removed). Designed live with
// the owner, who summed up the old behaviour as "enemy always wins has been feeling really bad."
//
// A candidate qualifies if it lies within TARGET_CONE of the aim direction; among qualifiers the
// CLOSEST wins. Two reasons for this shape over a blended score:
//  • Angle is the wrong unit at a distance. At 1750px, 5° off-aim is ~153px lateral; at 200px the
//    same 5° is ~17px. Any angle-weighted score therefore flatters far targets, which is exactly
//    the drift this issue reported. Used only as a GATE, angle stops distorting the ranking.
//  • One legible dial. There is no normalization and no weight to re-solve when a range changes —
//    behaviour is identical at every distance, so the cone is the only number to tune in play.
//
// ENEMIES AND TERRAIN GO THROUGH THE SAME RULE. A destructible hex or a base wall span is scored
// exactly like a mech, so a wall directly in front of you can now beat a drone way out to the
// side — the thing that used to be structurally impossible.
export const TARGET_CONE = 20 * Math.PI / 180;   // half-angle of the qualifying cone

// The enemy's edge: an enemy is ranked as if it were this fraction of its true distance away, so
// an enemy well BEYOND terrain still beats it, while terrain much closer than the enemy wins.
//
// #322 playtest follow-up: was 0.8, which lost the case the owner cares most about — "shoot flying
// targets flying within/over their bases behind their walls." Solved from the real geometry rather
// than picked: a base ring is ~479px ACROSS (`leash.js`), so a flyer anywhere inside a compound is
// at most ~480px deeper than the wall span facing you. Standing a realistic 250-400px off that
// wall, the worst-case ratio is (250 + 480) / 250 ≈ 2.9 — the deep-corner flyer is ~3x the wall's
// distance. So the edge has to be under ~1/2.9 for the flyer to win at all, which is exactly why
// 0.5 (floated in conversation) does NOT fix this: at 0.5 a flyer 700px out competes at 350px and
// a 300px wall still takes the pick. 0.3 covers the whole compound depth from any realistic
// standoff — a flyer out to 1000px beats a wall at 300px. Closer than ~150px to the wall the ratio
// passes 3x again and the wall retakes the pick, which is the correct end of the dial: at that
// range the wall IS the thing you are pointing at.
//
// Deliberately NOT absolute (the owner had enemy-always-wins removed: "enemy always wins has been
// feeling really bad"). Terrain still wins whenever it is nearer than a third of the enemy's range,
// which is the "this is clearly what I'm pointing at" case: point-blank demolition at 120px beats
// a mech 400px away, and terrain inside ~525px beats an enemy at the 1750px targeting limit.
//
// PLAYTEST DIAL: lower = enemies win from farther out, 1.0 = pure nearest-wins with no preference.
export const ENEMY_RANGE_EDGE = 0.3;

// The pick: the best candidate among `enemies` and `terrain` (each entry a {x, y, ...}), or null.
// PURE (no Phaser / no scene), so the priority rule is unit-testable on its own.
// `maxDist` is the single derived targeting range (data/targetingRange.js) at the call site.
// Enemies are considered first so an exact effective-distance tie resolves to the enemy.
export function pickConvergeTarget(px, py, turretAngle, enemies, terrain, maxDist = Infinity) {
  let best = null, bestScore = Infinity;
  const consider = (c, edge) => {
    const dist = Math.hypot(c.x - px, c.y - py);
    if (dist > maxDist) return;
    if (Math.abs(aimAngleOffset(px, py, turretAngle, c.x, c.y)) > TARGET_CONE) return;
    const score = dist * edge;
    if (score < bestScore) { bestScore = score; best = c; }
  };
  for (const e of enemies || []) consider(e, ENEMY_RANGE_EDGE);
  for (const t of terrain || []) consider(t, 1);
  return best;
}

// #317: the hex key a converge/lock target designates, or null if it designates anything else (a
// live enemy, a wall span, or nothing). PURE — the whole "is this hex my target" question in one
// place, so the firing code never has to re-derive target identity from a bare {x,y} point.
//
// This is the fix for #317's core bug, and it deliberately does NOT go through the terrain
// transparency mechanism. `coverBlocksForRay` answers "does this terrain stop a ray that happens to
// pass through it" — and for SOFT cover the honest answer, for a mech, is no: a mech shoots clean
// over foliage, which is the entire point of the soft tier (#279). The own-hex `transparent`
// exemption only ever makes a hex MORE see-through, so for soft cover it was a no-op and a targeted
// forest hex could never be impacted at all. "Is this my target" is a different question from "does
// this terrain block", and it has to be able to STOP a shot that the terrain rule would let sail
// past — so it is asked separately, and only ever about the one hex the player actually aimed at.
export function targetHexKeyOf(target) {
  if (!target || target.mech) return null;
  return target.hexKey ?? null;
}

// #318 note on the OTHER target shape: a wall span is edge-keyed (`edgeKey`/`edge`), so
// `targetHexKeyOf` correctly returns null for one. A span needs no impact rule of its own — spans
// are solid to sight and fire unconditionally, so every non-arcing round already detonates on one
// (projectiles.js `_wallEdgeHit`) and every beam already stops on one (world.js `_wallDistance`).
// #318 was therefore purely a POOL gap: spans were hittable all along, just never offered as a
// convergence/lock target because the pool only scanned the hex-keyed HP maps.

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

// #320: how big a unit is TO A WALL. Deliberately a separate number from `groundEnemyRadius`
// above, in the same spirit as `crushTriggerRadius` below — one physical body, three questions
// ("can I be crushed", "do I block that unit", "do I fit through there"), each entitled to its own
// tuned answer rather than one radius forced to serve all of them.
//
// Why it is capped rather than just being the unit radius. A wall span is one hex edge, 48px, and
// a breach in it is the ONLY way into a base (#288/#313). Colliding at the full 28px mech radius
// makes that hole a needle. Measured in the real game, driving the real integrator at a real
// breach across 7 approach angles x 5 lateral offsets (scripts/audit-wall-hitbox-320.mjs):
//
//     wall radius   0    8    12   16   18   20   22   24   28
//     got through  35/35 35   33   31   31   31   31   29   19      (of 35 approaches)
//
// The cliff at 28 is the corner chamfer saturating: once a span is shorter than 2R it collapses to
// its midpoint and the barrier becomes a chain of 35px discs, which is wider than the gap between
// them. 20 sits on the flat of that curve — it costs only a few extreme grazing approaches versus
// the old point model, while stopping a mech's centre 27px off the centreline, which is past the
// drawn torso (half-width ~23px at ARENA_MECH_SCALE) so nothing chunky visibly overlaps the plate.
// Every vehicle kind is already smaller than this and so is unaffected by the cap — a tank's ~14px
// footprint clears the plate with room to spare, which is the "tanks poke through" report itself.
// Owner: tunable. Raising it tightens breaches (see the table); lowering it lets big units lean
// further into a wall before stopping.
export const WALL_COLLIDE_RADIUS_MAX = 20;
export function wallCollideRadius(e) {
  return Math.min(groundEnemyRadius(e), WALL_COLLIDE_RADIUS_MAX);
}
// The player is drawn at the same scale as an enemy mech, so he takes the same treatment.
export const PLAYER_WALL_COLLIDE_RADIUS = Math.min(ENEMY_COLLIDE_RADIUS_MECH, WALL_COLLIDE_RADIUS_MAX);


// #112 (playtest 2026-07-10: "the stomp hitbox... needs to be bigger"): the crush-trigger check
// (world.js `_crushTargetAt`, called from locomotion.js `_drive`) used to test the player's
// point position against `groundEnemyRadius(e)` alone — i.e. the PLAYER contributed zero radius
// of its own, so triggering a stomp required the player's exact centre to land inside the
// enemy's (often tiny) footprint. That's especially punishing for the two crushable ('small',
// per #269's `isSmallUnit` below) kinds: tank (scale 0.48 ⇒ ENEMY_COLLIDE_RADIUS_VEHICLE*0.48 ≈
// 11.5px) and infantry (scale 0.38 ⇒ ≈ 9.1px) — both well under half the player mech's own on-screen
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

// #269 (ground-unit size-tier design doc, section 2): canonical query for a ground unit's SIZE
// TIER — 'small' or 'large'. Every ENEMY_KINDS vehicle entry (data/enemyKinds.js) now carries an
// explicit `size` field; a MECH enemy (data/enemies.js — raider/skirmisher/sniper/artillery) has
// no kind-registry entry at all (`e.kind` is `'mech'` or, for the oldest call sites, simply
// undefined) and is architecturally uniform in size across the whole roster, so it's always
// 'large' regardless of chassis weight class. This is the single place either signal should be
// read from — both the crush-eligibility check below (`_crushTargetAt`/`_crushGroundEnemyAt`,
// world.js) and the hex-vocabulary cover/LOS work (#269's other half) call `isSmallUnit`/
// `unitSize` instead of re-deriving "how big is this thing" from `behavior`/`kind` themselves.
export function unitSize(e) {
  if (e.kind === 'mech' || e.kind === undefined) return 'large';
  return e.kindDef?.size ?? 'large';
}
// #269: convenience boolean wrapper around `unitSize` for the common "is this crushable/small"
// call site — reads better than `unitSize(e) === 'small'` at each use.
export function isSmallUnit(e) {
  return unitSize(e) === 'small';
}

// #374 (owner, playtest 2026-07-20): which SOFT-COVER BLOCK tier a unit belongs to — the key into
// terrain.js's `SOFT_COVER_BLOCK_CHANCE` ('vehicle' 75% / 'mech' 25% / 'air' 0%). Jackson: "let's
// give non-mech ground units a 75% block chance and mech ground units 25% block chance and air
// units NO block chance."
//
// Deliberately derived from the classifications that ALREADY exist rather than a new hand-kept
// list of kinds — a new enemy kind gets its tier for free:
//   • AIR is `targetCoverExempt`'s exact airborne test (`flying && airborne !== false`, visibility.js).
//     A flying kind that is currently GROUNDED (landed/downed) is NOT air — it's sitting in the
//     foliage like anything else, so it takes the ground treatment. Same reading #338 already
//     applies to the cover exemption, so the two can't drift apart.
//   • MECH is `unitSize`'s own mech test: `kind === 'mech'` or no kind at all. The PLAYER falls
//     here for free — a player ref carries no `kind`, and the player is always a mech.
//   • everything else is a non-mech ground vehicle: tank, infantry, carrier, turret.
// Note there is no wall-turret special case and none is needed: an emplaced gun sits on a wall
// span, never in a soft-cover hex, so `softCoverStopsShot` bails on the terrain test long before
// this tier matters.
//
// This is a property of the TARGET being shot at ("how well does this thing hide in trees"), never
// of the shooter — see `softCoverStopsShot`'s own comment.
export function softCoverUnitTier(target) {
  if (!target) return 'mech';
  if (target.flying && target.airborne !== false) return 'air';
  if (target.kind === 'mech' || target.kind === undefined) return 'mech';
  return 'vehicle';
}

// #92/#104: which ground units get the instant-crush-on-contact treatment (world.js
// `_crushGroundEnemyAt`, called from locomotion.js `_drive`) instead of just blocking the player
// like a normal ground enemy. Originally tank-only (#92 correction); #104 extends it to infantry
// — the weakest unit in the game (hp 6) — since a single stomp destroying one trooper as the
// player drives through a cluster is the natural read of "infantry should be stompable."
// #269: the scope check itself moved from a hardcoded `behavior`-keyed Set (the old
// CRUSHABLE_BEHAVIORS, now removed) to the formal size tier above — `isSmallUnit(e)` is true for
// exactly tank and infantry (both now `size: 'small'` in enemyKinds.js), so the crush-eligible
// set is unchanged; this is a pure refactor of HOW the scope is expressed, not what's in it.

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

// #285 ("units should fully commit to attacking the player, not stay tethered near their dock"):
// #269 Part 1 originally gave a woken hold-ground unit a leash (`leashIntent`/
// `HOLD_GROUND_LEASH_PX`, keeping it clamped to a radius around its home point) so it wouldn't
// chase the player unbounded. Jackson's follow-up playtest clarified the actually-intended feel:
// once alerted, these units should commit fully with no distance clamp at all — the leash has
// been removed outright (not re-tuned) from every hold-ground movement path
// (enemyBehaviors.js's tank/carrier/infantry, and the mech tactical AI in enemies.js). A woken
// hold-ground unit now just runs the exact same advance/standoff/strafe movement a non-hold-
// ground unit already runs; `e.holdGround` no longer constrains movement at all — see
// bases.js's `_wakeBase` for what it still means. `leashIntent`/`HOLD_GROUND_LEASH_PX` and the
// `e.homeX`/`e.homeY` anchor they read (stashed at spawn by bases.js `_spawnDormantUnits`) had
// no other callers, so all of it is removed here rather than left as dead code.

// #280 playtest follow-up ("hexagon rings render offset toward the top-left of the intended hex
// position"): both the static objective marker (mission.js) and the live-resizing alert-tower
// ring (bases.js) used to draw their hex outline as a `Phaser.GameObjects.Polygon` built from
// `hexCorners()` — a point set that's already centered on (0,0) (symmetric, -size..+size on both
// axes). Polygon/Shape's renderer draws every point as `point - displayOrigin`, where
// `displayOrigin` is derived from the polygon's bounding box under the ASSUMPTION the points
// span 0..width/0..height (a top-left-origin box), same convention as a rectangle's corner
// points. Feeding it an already-centered point set double-subtracts that centering: the whole
// shape renders shifted by exactly `-size` on both axes — up and to the left of the intended
// centre, matching the reported bug precisely (`setTo()` recomputes width/height/origin correctly
// on every resize, so this wasn't a stale-cache bug — the offset was there from frame one, at
// every radius). hexArt.js's terrain-hex drawing never hit this because it never uses `Polygon`
// at all — it draws every hex via `Graphics.fillPoints`/`strokePoints` with points it offsets to
// an absolute centre itself (`cx + p.x`), which has no origin-guessing step to get wrong. This
// helper follows that same established, already-correct pattern: `graphics` must already be
// positioned (via `add.graphics()` + `setPosition`, or as a child of a container already placed)
// at the ring's intended centre, and `hexCorners(radius)` — centered on (0,0) — is stroked as
// literal LOCAL points with no origin math involved, so the rendered ring is centered on
// `graphics`'s own position by construction, at any radius, every time it's redrawn.
export function strokeHexRing(graphics, radius, lineWidth, color, alpha) {
  graphics.clear();
  graphics.lineStyle(lineWidth, color, alpha);
  graphics.strokePoints(hexCorners(radius), true);
  return graphics;
}
