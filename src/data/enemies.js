// Enemy mech definitions — data, not code (mirrors WEAPONS / CHASSIS). The arena builds a
// fresh Mech from one of these configs on spawn, so the scene layer never hardcodes an
// enemy's chassis or weapons. **Add an enemy = one entry here.**
//
// #474: the FOUR hand-written archetypes (Raider/Stalker/Warden/Mortarhead) are RETIRED. Enemy
// mechs are now just the three CHASSIS — Light / Medium / Heavy Mech — and all three appear
// equally (before #474 light was doubled up and medium was barely used). Each entry carries NO
// fixed `mounts`: a mech rolls its own four-weapon loadout PER SPAWN, constrained by its chassis
// (data/enemyLoadout.js `rollLoadout`, called from scenes/arena/enemies.js `_spawnMech` with a
// seeded RNG). Every mech fills all four MOUNT_LOCATIONS, so it reads as a proper four-weapon mech.
//
// ROLES STAY EMERGENT. Since #44 the tactical AI (scenes/arena/enemies.js) reads the mounted
// weapons' optimum range to pick behaviour, and `isAllIndirect` (every weapon arcing/homing) drives
// the camp-behind-cover posture. With per-spawn loadouts the chassis pools are RANGE-BANDED (light
// short/press, heavy long/siege, medium between), so a light roll still presses in, a heavy roll
// still kites, and a heavy roll that happens to come up all-indirect turns on camping by itself —
// the old Mortarhead's identity is now something the dice can produce, not a hand-written entry.
// There is deliberately NO role field here.
//
// #299: enemy mechs get a full-body SHIELD (they had none before that pass). The pool sizes are the
// owner's (light 25 / medium 50 / heavy 75), keyed to weight class, and are the ONLY per-kind shield
// dial. #474 leaves them untouched.
//
// #382 (playtest 2026-07-20, Jackson: "why do we have different shield pauses for different types
// of things? that should all be the same for all enemies and player, for now" + "rate should maybe
// be a percentage instead of a number?"): the per-kind `pauseMs`/`regenPerSec` table that #380/#299
// introduced is GONE. Pause and regen are now ONE shared rule for every shield — a 3000ms pause and
// a 25%-of-max-per-second regen (both in shield.js). Because regen is a fraction of MAX, each pool
// still refills in exactly 4s regardless of size, so weight class no longer changes refill time.
// NOTE the asymmetry that remains: enemy mechs rarely choose to break contact, so the long pause
// mostly costs them the mid-fight trickle they used to get, while the player (who can disengage on
// purpose) gets the real recharge tool.
export const ENEMIES = {
  // Light Mech — fast, short-range guns; presses in (skirmisher role). Loadout rolled per spawn
  // from the light pool (data/enemyLoadout.js).
  light: {
    chassisId: 'light',
    name: 'Light Mech',
    shield: { max: 25 }, // #382: shared pause/regen (see shield.js)
  },

  // Medium Mech — mid-range guns; holds a mid standoff and kites. Loadout rolled per spawn from
  // the medium pool.
  medium: {
    chassisId: 'medium',
    name: 'Medium Mech',
    shield: { max: 50 }, // #382: shared pause/regen (see shield.js)
  },

  // Heavy Mech — long, heavy shells (and every indirect weapon lives in this pool); kites at long
  // range, and a fully-indirect roll camps behind cover and bombards. Loadout rolled per spawn from
  // the heavy pool.
  heavy: {
    chassisId: 'heavy',
    name: 'Heavy Mech',
    shield: { max: 75 }, // #382: shared pause/regen (see shield.js)
  },
};

// The three enemy mech loadout ids (data/enemies.js keys) — the chassis weight classes. Exported so
// consumers (worldgen pools, run-stats, the art gallery) reference the set by name instead of
// re-listing the literals. All three are meant to appear EQUALLY (#474).
export const MECH_CHASSIS_IDS = Object.keys(ENEMIES);

// Spawn rotation for the debug "add enemy" control (#39) and the arena's mixed opener, so
// consecutive spawns cycle through the bestiary instead of stacking identical orbits. Mixes the
// three mech chassis (#474 — each rolls a fresh loadout when spawned) with the #68 non-mech KINDS
// (tank / drone 'swarm' / helicopter — the ids live in data/enemyKinds.js; 'swarm' expands into
// several drones), so pressing N cycles through the whole bestiary. The starting enemy is index 0
// (a Light Mech), keeping the first deploy stable.
// #469: the 'turretNest' entry (a cluster of free-roaming sentry turrets) is GONE along with the
// sentry `turret` kind itself — worldgen never placed it and this debug list was its only path
// into a run. Base defenses use the separate, very much alive `wallTurret` kind.
// #97: 'infantryMob' is appended to the rotation so the debug spawn-more control cycles through
// it too (expands into INFANTRY_MOB_SIZE troopers — data/enemyKinds.js — mirroring 'swarm').
// #239 (temporary): 'infantryMob' pulled back OUT of this rotation while Jackson plans a redesign
// of the kind — see enemyKinds.js's infantryMob/infantry definitions, which are left completely
// intact (art + behavior untouched too), so restoring it here is a one-line add, not an
// archaeology project.
// #234: 'carrier' (the Broodhauler) was fully built — art/behavior/toughness, plus its own
// drone-deploy mechanic — but was never added here or to DEFAULT_SQUAD, so it had no path
// into a normal run except one rare slot in run.js's then-existing LATE_POOL (reachable only in
// late-stage squad draws; that whole squad-draw system was retired by #269). That's why Jackson
// had seen it, but rarely, per his playtest note ("those enemies
// that spawn drones are so cool but I barely ever see them"). Appended once here — same tier as
// the mech chassis/swarm/infantryMob, not doubled up like tank/helicopter — so the debug
// spawn-more control (keydown-N / dpad-up) cycles through it too. This list is consumed by index
// (`ENEMY_ROTATION[this._enemySeq % ENEMY_ROTATION.length]`, scenes/arena/enemies.js), i.e. a
// straight round-robin cycle, NOT a weighted random draw — every id gets exactly 1-in-N of the
// cycle regardless of position, so "how often" is controlled purely by how many times an id is
// repeated in the array (see tank/helicopter's double entries elsewhere in this file's spirit),
// not by where it sits.
// #474: the four archetype ids (raider/skirmisher/sniper/artillery) are replaced by the three
// chassis ids (light/medium/heavy), one entry each so all three appear equally.
export const ENEMY_ROTATION = [
  'light', 'tank', 'medium', 'helicopter', 'heavy', 'swarm', 'carrier',
];

// #344 (2026-07-19): `DEFAULT_SQUAD` — the old opening-squad table (#44/#68/#75/#89) — is GONE,
// along with `scenes/arena/enemies.js`'s `_spawnSquad()` that it was the default argument of.
// The contradiction the issue flagged (worldgen.js/run.js both calling it "retired" while it was
// still exported and still wired as a default arg) resolved in favour of the comments: traced the
// whole tree and `_spawnSquad` had ZERO call sites — #269 replaced the opening squad with
// `_spawnDormantUnits` (bases.js), so nothing has spawned from this table since. What spawns at
// run start is a base's dormant docks (`BASE_EARLY_KIND_POOL`/`dockCountFor`, data/worldgen.js)
// plus the alert-tower patrols (`towerPatrolComposition`, same file) — that is where opening
// difficulty is tuned, and now the only place.
