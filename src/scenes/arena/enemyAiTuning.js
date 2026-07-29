// Split out of enemies.js (#574): the #44 tactical-AI tuning knobs and the small pure helper
// functions the enemy mixin (enemies.js `EnemiesMixin`) builds its state machine and movement
// feel on. Nothing here touches `this`/scene state — see enemies.js's own header for the
// tactical-AI design this configures (PRESS/KITE/FLANK/COVER/HOLD).
import { ARENA_MECH_SCALE } from './shared.js';
import { LETHAL_GROUPS } from '../../data/anatomy.js';

// #309 playtest: an open gate is passable to EVERYONE now, so there is no longer an enemy-specific
// form of the scene's `_blocked` to route through — this is the plain query, kept as a named helper
// only because the many hand-rolled scene stubs across the test suite may omit `_blocked` entirely.
// #320: `radius` is the moving unit's own body radius, so a tank stops with its hull against the
// plate instead of parked halfway through it. Passed per-unit (`wallCollideRadius`) rather than as
// one flat constant, since a turret's footprint and an infantry trooper's differ by 4x. Defaults to
// 0 so the many hand-rolled scene stubs, and any point-shaped caller, behave exactly as before.
export const blockedForEnemy = (scene, x, y, radius = 0) => scene._blocked(x, y, radius);

export const SQRT3 = Math.sqrt(3);   // pointy-top hex horizontal spacing factor (matches hexgrid.js)

// ── #44 tactical-AI tuning (owner: review/tune) ─────────────────────────────────────────
// Grouped so the feel can be re-tuned without hunting through _updateEnemy.

// Role thresholds: an enemy whose weapons' mean optimum range is below BRAWLER_OPT is a
// close-quarters brawler (presses in); above SNIPER_OPT it's a sniper (kites); between, a
// mid-range skirmisher (flanks). Standoff distance is derived from that mean opt, clamped.
export const BRAWLER_OPT = 170;            // mean weapon opt (px) below this ⇒ brawler role
export const SNIPER_OPT = 360;             // mean weapon opt (px) above this ⇒ sniper role
export const STANDOFF_MIN = 90;            // never try to fight closer than this
export const STANDOFF_MAX = 520;           // never try to fight farther than this
export const STANDOFF_FRAC = 0.85;         // standoff = STANDOFF_FRAC × mean weapon opt (sit just inside opt)
export const DEFAULT_OPT = 220;            // fallback mean opt for a weaponless mech

// Distance bands, expressed as multiples of the enemy's standoff distance. Inside TOO_CLOSE
// it wants to back off; beyond TOO_FAR it wants to close; the sweet spot is the ring between.
export const TOO_CLOSE_FRAC = 0.55;        // dist < standoff×this ⇒ "player is in my face"
export const TOO_FAR_FRAC = 1.45;          // dist > standoff×this ⇒ "player is out of my fight"

// Decision cadence: how long a chosen state is held before the AI re-decides. A range, so N
// enemies don't re-plan in lockstep. Kept > ~0.5s so moves read as intent, not twitch.
export const DECIDE_MIN = 750;
export const DECIDE_MAX = 1500;

// FLANK: when the AI decides to reposition it picks a destination at standoff range, offset
// from the current player-bearing by a flank angle. The angle is re-picked per flank decision
// (from this spread) and its sign is the enemy's persistent orbit handedness (spaces enemies
// out — some go left, some right). Larger angle ⇒ wider, less orbit-like arcs.
export const FLANK_ANGLE_MIN = 0.55;       // rad — min off-axis flank angle (~31°)
export const FLANK_ANGLE_MAX = 1.35;       // rad — max off-axis flank angle (~77°)
export const FLANK_REACH = 0.45;           // fraction of the flank leg that counts as "arrived"

// COVER: how far to probe for a wall that breaks LOS, and how close to the cover edge to sit.
export const COVER_SEARCH_STEP = 40;       // px between sampled cover candidate points
export const COVER_SEARCH_RING = 3;        // how many rings of hexes out to search for cover
export const COVER_HEALTH_TRIGGER = 0.45;  // lethal-part health fraction below which COVER is favoured
export const COVER_DAMAGE_WINDOW = 1400;   // ms after taking a hit that the enemy prefers cover
export const PEEK_DIST = 26;               // px past a cover edge the enemy leans out to shoot

// Artillery posture (#44 follow-up): a mech whose weapons are ALL indirect-fire (every one is
// homing or arcing, so its ROUNDS never need line-of-sight to hit) camps behind cover as its
// PRIMARY state — it prefers cover over standing in the open and never willingly exposes itself
// for long. When it can't find cover it falls back to holding at standoff. These bound how far it
// ranges and how often it hunts a fresh camp spot while camped.
// #424: the mech itself still needs LOS to ACQUIRE/TRACK the player before it can fire at all
// (`_updateEnemyLock`) — camping cover no longer means "never needs to see the target," so it
// peeks out from its camp spot (`_enemyMoveIntent`'s 'cover' case) to re-open a firing lane,
// exactly like a direct-fire mech.
export const ARTY_RECAMP_MIN = 2600;       // ms — min interval an all-indirect mech holds one camp spot
export const ARTY_RECAMP_MAX = 5200;       // ms — max before it looks for a fresh cover position

// Off-screen spawn (#44 follow-up): enemies appear OUTSIDE the camera viewport and walk in.
// The spawn point is the visible-world rectangle's edge pushed out by this margin (px), placed
// on a random bearing from the player, then clamped inside the world disc so it stays on the map.
export const OFFSCREEN_MARGIN = 120;       // px beyond the visible edge to drop a spawning enemy
export const SPAWN_WORLD_INSET = 1.5;      // hexes of inset from the world edge kept clear for spawns

// Movement feel.
// #398 (owner-set): enemy MECHS drive NOTICEABLY SLOWER / more lumbering across the board —
// 0.85 -> 0.6, a ~29% cut to the fraction of chassis maxSpeed the AI drives at, applied to ALL
// enemy mechs at once (every archetype/chassis reads heavier). This is the mech-only lever: it
// gates the `_updateEnemy` mech movement path only — non-mech vehicle kinds (tank/drone/etc.)
// move via enemyBehaviors.js and never touch it, and the player has its own locomotion. Cut, not
// zeroed, so mechs still close distance eventually — just as a heavy, deliberate advance. Owner
// verifies the lumbering feel in play; this is the dial to nudge.
// #398 third pass (playtest: "still too fast AND not lurchy enough... LASER-FOCUSED"): the two
// prior cuts (0.85→0.6 speed, then a capped turret slew) still read as a fast, perfectly-aimed
// machine. This pass cuts speed further, makes the accel/decel itself heavier so velocity changes
// lag behind intent, adds an intermittent "stomp, hitch, stomp" drive cycle instead of constant
// beelining, and gives the turret real aim slop instead of a bare slew cap. All of this is scoped
// to the mech AI movement path only (`_updateEnemy`'s `kind === 'mech'` branch) — non-mech
// vehicle kinds and the player are untouched.
export const MOVE_SPEED_FRAC = 0.42;       // fraction of chassis maxSpeed the AI drives at (was 0.6)
// Heavier accel: the AI's target velocity is unchanged, but how fast e.vx/e.vy actually CATCH UP
// to it is scaled down for mechs only — the chassis's own `mv.accel` (used by real per-frame
// physics elsewhere) is never mutated, just multiplied down at the point of use below. Makes
// starting, stopping, and turning corners feel like momentum, not an instant velocity snap.
export const ENEMY_MECH_ACCEL_FRAC = 0.45;
// Lurch cycle: rather than driving continuously toward the goal, a mech alternates between a
// committed "stomp" burst (full speedFrac) and a brief hitch/settle beat (reduced speedFrac, not
// a full stop — a frozen mech reads as broken, not heavy). Reads as a lumbering gait instead of a
// smooth glide, and the pauses are exactly the moments a player can put real distance on.
export const LURCH_DRIVE_MIN_MS = 700;     // ms — how long a stomp burst is committed to
export const LURCH_DRIVE_MAX_MS = 1300;
export const LURCH_PAUSE_MIN_MS = 280;     // ms — the hitch/settle beat between stomps
export const LURCH_PAUSE_MAX_MS = 600;
export const LURCH_PAUSE_SPEED_FRAC = 0.3; // speed multiplier applied during the hitch beat
// #398 FOURTH pass (playtest 2026-07-22 — "slower, but I want MORE lumbering: heavier footstep
// weight, a telegraphed wind-up before it moves, and tank-like SEGMENTED movement between
// legs/torso/arms instead of the current fluid interpolation"). Three dials below, all scoped to
// the enemy-mech path (`_updateEnemy`'s `kind === 'mech'` branch) — vehicle kinds and the player
// are untouched.
//
// (2) WIND-UP: the lurch cycle gains a THIRD phase between the hitch and the next stomp. The mech
// plants (near-zero speed) and PIVOTS ITS HULL onto the direction it's about to walk before it
// actually goes, so the move is telegraphed — you see the legs line up, then the lunge. A heavy
// machine doesn't change direction and accelerate in the same instant.
export const LURCH_WINDUP_MIN_MS = 260;    // ms — how long the plant-and-pivot telegraph lasts
export const LURCH_WINDUP_MAX_MS = 480;
export const LURCH_WINDUP_SPEED_FRAC = 0.05; // speed multiplier during the wind-up (planted, not frozen)
export const WINDUP_TURN_FRAC = 0.8;       // fraction of chassis turnRate the hull pivots at while winding up
// (3) SEGMENTED ROTATION: a real rotation accumulator per axis (`e.angleRaw`/`e.turretRaw`) still
// slews continuously, but what's RENDERED (and what the guns fire along) is that accumulator
// snapped to fixed angular DETENTS — so the mech ratchets round in servo steps instead of gliding.
// The legs get a COARSE detent and the turret (which carries the torsos + arms via _syncTilts) a
// finer one, so the two halves visibly step at different moments rather than turning as one fluid
// piece — that mismatch is the "segmented between legs/torso/arms" read. Firing keys off the same
// snapped `e.turret` the art uses, so shots always leave along the barrel you can see (and the
// snap itself contributes a few degrees of extra aim slop, which is the direction asked for).
export const HULL_DETENT_RAD = Math.PI / 15;    // 12° — leg/hull facing steps
export const TURRET_DETENT_RAD = Math.PI / 30;  // 6°  — turret/torso/arm facing steps
// (1) FOOTSTEP WEIGHT: enemy mechs never ran a walk cycle at all — their hull sat on frame 0 and
// slid, which is most of why they read as floaty. They now run the same stompy stepped gait the
// player does (locomotion.js `_stepGait`): step frames advanced by REAL ground speed, a body bob
// that heaves up mid-stride and drops onto the plant, and the shared footfall impact FX (ground
// shock ring + dust + a squash of the body) on each planted frame. Deliberately NO camera shake —
// a squad of five stomping mechs would heave the frame constantly, and #435 already dialled the
// player's own shake way back for exactly that reason.
export const ENEMY_STEP_BOB_FRAC = 1.35;   // enemy bob amplitude vs. the chassis's own stepBob (heavier)
export const ENEMY_FOOTFALL_POWER_FRAC = 1.0; // scales the shared footfall impact FX off the chassis stepBob
// #398: enemy mechs felt "floaty" — the movement slowdown above wasn't the whole story. The tell
// Jackson named was the TURRET: it "constantly aims directly at me", snapping to the player's
// bearing every frame with the chassis's own (fast) turretSlew. A heavy machine's gun should LAG
// and swing toward its target, so lateral player movement briefly opens the aim. This caps the
// enemy mech's turret tracking to a slow fixed rad/s — well below every chassis turretSlew
// (heavy 1.9 → light 4.2) so it always bites — producing that visible aim lag. Scoped to enemy
// MECHS only (the floaty ones); turrets/tanks/other kinds keep their own per-kind slew. The
// PLAYER is untouched — it still tracks at its chassis turretSlew (full 360°, no arc clamp). Owner:
// tunable — raise toward the chassis values for snappier enemy aim, lower for heavier lag.
export const ENEMY_MECH_TURRET_SLEW = 0.55; // rad/s — capped aim-tracking rate for enemy mechs (was 0.9, #398)
// Aim slop (#398 third pass): the slew cap alone still tracks TOWARD the player's exact bearing,
// so it eventually settles dead-on and holds there. Instead, the turret chases a noisy offset
// from the true bearing that's re-rolled periodically — combined with the slow slew above, the
// gun visibly wanders near the player rather than pinning to them, so strafing genuinely breaks
// the bead instead of just delaying a perfect lock.
export const ENEMY_MECH_AIM_SLOP_RAD = 0.24;    // rad — max random aim offset from true bearing (~14°)
export const ENEMY_MECH_AIM_SLOP_MIN_MS = 450;  // ms — min hold before re-rolling the aim offset
export const ENEMY_MECH_AIM_SLOP_MAX_MS = 1000; // ms — max hold before re-rolling the aim offset
export const ARRIVE_SLOW = 70;             // px from a destination where the enemy eases to a stop
export const REPICK_ON_ARRIVE = true;      // arriving at a FLANK/COVER goal forces an early re-decide

// #103 awareness: while UNAWARE, a mech loiters near its own spawn point instead of engaging —
// a light idle wander so a "sleeping" squad still reads as alive, not frozen. Small radius/slow
// re-pick cadence so it stays a subtle patrol, not a distraction from the aware enemies nearby.
export const IDLE_WANDER_RADIUS = 90;      // px around spawnX/spawnY the idle waypoint may land
export const IDLE_REPICK_MIN = 2200;       // ms — min hold before picking a fresh idle waypoint
export const IDLE_REPICK_MAX = 4200;       // ms — max hold before picking a fresh idle waypoint

// #304: how long after the player's mech is destroyed the enemy squad keeps engaging before it
// stands down. NOT zero, on purpose (confirmed with Jackson: "a short beat, roughly half a
// second... so it doesn't cut off mid-volley in a way that reads as a glitch"). 600ms is that
// half-second-ish beat rounded up a touch: long enough that a burst weapon's own train (~300ms
// for the 5-pulse Pulse Laser, data/delivery.js) can finish rather than being chopped, and that
// rounds already in flight land — but comfortably inside RUN_OVER_DELAY, so the disengage is
// clearly visible before the garage transition takes the camera away. Owner: tunable.
export const STAND_DOWN_DELAY_MS = 600;
export const IDLE_SPEED_FRAC = 0.35;       // fraction of MOVE_SPEED_FRAC used while idle (slow patrol)

// Reactivity: bias state choice on what the player is doing.
export const PLAYER_FLEE_DOT = 0.35;       // player velocity·(away from enemy) above this ⇒ "fleeing"
export const PLAYER_VULN_HEALTH = 0.4;     // player lethal-part health below this ⇒ press the kill
export const TRACKED_DOT = 0.965;          // player aim·(toward enemy) above this ⇒ "being tracked" (~15°)
export const TRACKED_BREAK_CHANCE = 0.7;   // odds a tracked enemy juke-breaks its current plan on a decide

// #161: a non-mech KIND's textures depend only on its art builder + accent colour (def.art +
// def.themeColor), both fixed per ENEMY_KINDS entry — never varied per spawned instance (no
// per-instance texture MUTATION happens for vehicles at all, and since #472 removed the enemy
// armor visual there is only ONE shared set per kind). So every
// live unit of the same kind+theme is pixel-identical and can safely share ONE texture set,
// keyed off that visual identity instead of the old per-spawn `enemy${seq}` key. Distinct kinds
// with the same themeColor still get distinct keys (the art id is part of the key), and a kind
// reused with a different themeColor (none today, but data-driven) would also get its own set.
export function vehicleTextureKey(def) {
  return `vehicle_${def.art}_${(def.themeColor ?? 0).toString(16)}`;
}

// #68/#75: on-screen scale of a non-mech unit's sprites is now PER-KIND (data-driven): each
// ENEMY_KINDS entry carries a `scale` MULTIPLE of the arena mech scale, so adding/retuning a
// unit is a data edit. VEHICLE_SCALE_MULT is the fallback multiplier for a kind with no
// `scale` (the old global 1.15× mech); `vehicleScale(def)` resolves the display scale.
export const VEHICLE_SCALE_MULT = 1.15;
export const vehicleScale = (def) => ARENA_MECH_SCALE * (def.scale ?? VEHICLE_SCALE_MULT);

// Small helpers ---------------------------------------------------------------------------
export const rand = (a, b) => a + Math.random() * (b - a);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// #398 fourth pass: snap an angle to the nearest multiple of `step` radians. Applied to a
// SEPARATE continuous accumulator, never in place — snapping a value and then rotating that same
// snapped value would stall any slew slower than half a detent per frame.
export const detent = (rad, step) => (step > 0 ? Math.round(rad / step) * step : rad);

// Mean optimum range of a mech's mounted weapons → drives role + standoff. Approximation.
export function meanOpt(mech) {
  const ws = mech.weapons().map((w) => w.weapon).filter(Boolean);
  if (!ws.length) return DEFAULT_OPT;
  return ws.reduce((a, w) => a + (w.range?.opt ?? DEFAULT_OPT), 0) / ws.length;
}
export function roleFor(opt) {
  if (opt < BRAWLER_OPT) return 'brawler';
  if (opt > SNIPER_OPT) return 'sniper';
  return 'skirmisher';
}

// Is one weapon indirect-fire — homing or arcing, so it hits WITHOUT line-of-sight? Mirrors the
// direct/indirect split in targeting.js `_fireAngle` (guidance 'homing' or path 'arcing').
export function isIndirectWeapon(weapon) {
  const d = weapon?.delivery;
  return !!d && (d.guidance === 'homing' || d.path === 'arcing');
}

// Does a mech's ENTIRE loadout fire indirectly (every mounted weapon is homing/arcing)? Such a
// mech never needs LOS to hit, so it can camp behind cover as a primary posture and bombard over
// walls. A mech with any direct weapon must expose/peek to shoot. False if it has no weapons.
export function isAllIndirect(mech) {
  const ws = mech.weapons().map((w) => w.weapon).filter(Boolean);
  return ws.length > 0 && ws.every(isIndirectWeapon);
}

// Lowest health fraction among the enemy's lethal parts — #128: both side torsos, since
// losing both is now the kill condition (LETHAL_GROUPS) — the AI reads "am I hurt?" off
// this to decide whether to seek cover / disengage.
export function lethalHealth(mech) {
  let lo = 1;
  for (const group of LETHAL_GROUPS) {
    for (const loc of group) {
      const f = mech.partHealthFraction(loc);
      if (f < lo) lo = f;
    }
  }
  return lo;
}
