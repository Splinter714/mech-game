// Base scene firing (#597) — the ARENA's real firing path, composed onto BaseScene rather than
// re-implemented. Owner's answer when asked what firing in the base is for: "Full arena rules,
// just no enemies." So the mixins that actually resolve a trigger pull are reused byte-for-byte
// (`FiringMixin`, `ProjectilesMixin`, `AmmoIndicatorsMixin` — see BaseScene.js's Object.assign),
// which is what guarantees ammo drain, magazine reloads, cycle cooldowns, charge-and-release,
// spread/arc/homing delivery, muzzle flashes and impact FX all behave identically here. Nothing
// in this file re-decides any of that.
//
// What DOES need supplying is the handful of seams those mixins ask the WORLD about, because the
// arena answers them from geometry the base doesn't have (`arena/world.js`'s wall-span list,
// destructible building/cover HP maps, the enemy roster). The base's only geometry is the
// decorative wall ring around the compound — which is really just "where the paved disc ends"
// (base/world.js `_buildWallRing`) — so every one of those questions collapses to a terrain
// lookup, and every damage sink collapses to nothing. Those are the seams below.
//
// DELIBERATELY NOT COMPOSED (see the report on #597): the arena's damage half. Nothing in the
// base can be hurt — no enemies exist, single-player means no friendly fire, and the base has no
// respawn clock, so letting a player cook themselves with their own napalm would strand them in
// a scene with no way back up. `_damagePlayerAt`/`_damageEnemyAt` are therefore no-ops here and
// the base stays a safe zone; the shots themselves are otherwise fully real.
import { DEPTH } from '../arena/shared.js';

// How coarsely a hitscan ray is sampled looking for the wall it stops on — the same 8px step
// arena/world.js `_wallDistance` marches, kept identical so a beam's stopping point reads the
// same in both scenes.
const RAY_STEP_PX = 8;

export const BaseFiringSeams = {
  // ── World seams the arena answers from wall spans / destructible HP ──
  //
  // In the base there is exactly ONE thing a shot can stop on: the edge of the paved disc, i.e.
  // the wall ring. `_blocked` (base/world.js) already answers "is this point off the walkable
  // floor" for MOVEMENT, so shots and footsteps agree on where the compound ends by construction
  // — which is the property worth having, more than matching the arena's span geometry exactly.
  //
  // The arena's `transparent`/`originHexes`/`ignoreSpanKey` arguments are accepted and ignored on
  // purpose: they exist to make a unit's OWN hex see-through (soft cover) or to open a lane to a
  // wall-mounted turret. The base has neither — every hex inside the disc is plain `baseYard`
  // (passable, never a blocker), so no hex the exemptions could name is ever a wall to begin with.

  // Distance along `angle` to the first blocked point, or Infinity if the ray stays on the floor.
  _wallDistance(x0, y0, angle, maxT) {
    const cx = Math.cos(angle), cy = Math.sin(angle);
    for (let t = RAY_STEP_PX; t < maxT; t += RAY_STEP_PX) {
      if (this._blocked(x0 + cx * t, y0 + cy * t)) return t;
    }
    return Infinity;
  },

  // Per-step check for a travelling round (projectiles.js) — same predicate as the ray march.
  _isWallForRound(x, y) {
    return this._blocked(x, y);
  },

  // #320's rule, base flavour: a muzzle that has poked past the ring while the mech itself is
  // still inside eats its own shot, rather than spawning the round outside the compound. The
  // arena resolves this against the span the barrel crossed; here "outside" is the whole test.
  _muzzleWallBlocked(cx, cy, mx, my) {
    return !this._blocked(cx, cy) && this._blocked(mx, my);
  },

  // ── Damage sinks ── the base compound is indestructible and nothing in it can be hurt (see the
  // header note). These exist because the arena mixins call them unconditionally on the paths a
  // base shot really does take: a round detonating on the ring runs `_damageBuildingAt`, and a
  // napalm patch burning under your own feet runs `_damagePlayerAt`.
  _damageBuildingAt() {},
  _damageEnemyAt() {},
  _damagePlayerAt() {},
};

// The scene-level state the arena sets up in ArenaScene.create() and the firing mixins then read
// every frame. Same layers, same depths, same names — the point is that the composed code can't
// tell which scene it's running in.
export function createBaseFiringState(scene) {
  scene.groundFx = scene.add.graphics().setDepth(DEPTH.GROUND_FX);   // burning ground + planted hazards
  scene.fx = scene.add.graphics().setDepth(DEPTH.WEAPON_FX);       // melee slash (timed clear)
  scene.beamFx = scene.add.graphics().setDepth(DEPTH.WEAPON_FX);   // persistent beams + dying sparks
  scene.projFx = scene.add.graphics().setDepth(DEPTH.WEAPON_FX);   // travelling projectiles
  scene.chargeFx = scene.add.graphics().setDepth(DEPTH.WEAPON_FX); // charge-up telegraph
  scene.projectiles = [];
  scene.beams = [];
  scene.dyingBeams = [];
  scene.firePatches = [];
  scene.buildingBurns = [];
  scene.hazards = [];
  // The enemy roster the firing/projectile paths iterate. Permanently empty — that IS the "just
  // no enemies" half of the rule, and it's what makes every enemy branch in those mixins a no-op
  // without a single `if (isBase)` anywhere in them.
  scene.enemies = [];
  // Destructible-terrain HP. Empty maps rather than absent, because `_igniteBuildingHex` keys its
  // "is this hex ignitable" check off membership in them — no entries means a Plasma bolt landing
  // on the apron simply never plants a burn.
  scene.buildingHp = new Map();
  scene.coverHp = new Map();
}

// One frame of firing, in ArenaScene.update()'s own order: reload before firing (so a topped-off
// magazine reads `ready` the same frame), then the trigger, then everything the trigger spawned.
// `_drawAmmoIndicators` (#595) runs last, after the gait has posed the parts, so the per-slot
// muzzle-glow readout reflects the cooldowns this frame's firing just set.
export function updateBaseFiring(scene, intent, delta, dt) {
  scene._handleReload(intent, scene.player);
  scene._handleFiring(intent, delta, scene.player);
  scene._updateProjectiles(dt);
  scene._updateFirePatches();
  scene._updateHazards(dt);
  scene._updateBeams(delta);
  scene._updateChargeVisuals();
  scene._drawAmmoIndicators();
}
