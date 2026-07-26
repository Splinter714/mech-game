// Shared co-op Garage primitives — the fixed persistent build slots, the join cap, and the
// mid-sortie joiner's build pick — used by both GarageScene (the multi-cursor simultaneous build,
// data/simulGarage.js) and the arena's late-drop-in join (scenes/arena/coop.js).
//
// #349 → #388 (phase 3/4b of local co-op — parent #335) built this module's original SEQUENTIAL
// flow: one editing surface handed player-to-player, "▶ P1 READY" advancing an `editing` cursor
// through up to four players. #505 replaced that flow in GarageScene with the SIMULTANEOUS
// multi-column build (data/simulGarage.js — every joined player edits at once, no handoff), per
// Jackson's playtest feedback that a separate handoff-based scene/mode was unwanted. The
// sequential-only state (`{ count, editing }`, `joinPlayer`/`advanceEditing`/`garageAction`/
// `playerTabs`/etc.) was removed along with it — nothing outside this module used those functions.
// What's left here is genuinely shared: the four build slots + cap (also used by the arena) and
// the mid-sortie joiner's own build-pick rule (`joinerBuild`), independent of which garage flow
// built the squad.

// The fixed persistent build slots, indexed by player. Deliberately a short literal list and not
// a generated range: these are the four slots that exist, each with a matching `defaultRoster`
// build in rosters.js. #387 raised the cap to four players for mid-sortie drop-ins; #388 makes
// all four pre-buildable in the garage.
export const PLAYER_MECH_KEYS = ['mech1', 'mech2', 'mech3', 'mech4'];

// The most players the garage flow will seat — one per persistent slot. The arena's own
// MAX_PLAYERS (data/players.js) is the same number; kept as a local so this module stays pure
// data with no players.js dependency, and so the two can never disagree without this line
// changing too.
export const MAX_GARAGE_PLAYERS = PLAYER_MECH_KEYS.length;

function clampInt(v, lo, hi) {
  const n = Number.isFinite(v) ? Math.trunc(v) : lo;
  return Math.min(Math.max(n, lo), hi);
}

// The storage key holding player `index`'s persistent build. Out-of-range indices clamp to the
// last real slot rather than returning undefined, so a stray extra player can never index a
// nonexistent roster entry and crash the deploy path.
export function mechKeyForPlayer(index) {
  return PLAYER_MECH_KEYS[clampInt(index, 0, PLAYER_MECH_KEYS.length - 1)];
}

// How many players have joined (>=1). Reads a raw/garbage session as solo. Duck-typed on any
// session shape with a `count` field — both the (now-removed) sequential `{count, editing}` and
// the simultaneous `{count, ready}` (data/simulGarage.js) satisfy this.
export function playerCount(session) {
  return clampInt(session?.count ?? 1, 1, MAX_GARAGE_PLAYERS);
}

// Is there room for another player to join? False once every slot is seated.
export function canJoin(session) {
  return playerCount(session) < MAX_GARAGE_PLAYERS;
}

// ── The mid-sortie joiner ──
//
// Jackson kept BOTH join paths: the garage flow is the normal one, and phase 2's "press START on
// a gamepad" stays for someone dropping in late. That leaves the question of which mech a late
// joiner drives, and this is the answer: their OWN saved build if there is a usable one, otherwise
// phase 2's original behaviour (a copy of player 1's build) unchanged as the fallback. Since every
// slot now ships with a complete default build, in practice a joiner gets their own mech from the
// first time anyone ever presses START — but the fallback still matters for a save whose slot was
// left half-built via the garage flow, where deploying an incomplete mech would put an unarmed
// machine on the field.
//
// Duck-typed on purpose: `saved` is a Mech (or a plain build object in tests) and only its build
// fields are read, so this stays a pure function with no Mech import.
export function joinerBuild(saved, hostBuild) {
  // #487: `color` rides along with the build so a drop-in driving their own saved slot keeps the
  // colour they picked in the garage. The fallback (copy of the host's build) deliberately does
  // NOT copy the host's colour — `mechColorFor` will resolve the joiner to their own per-index
  // auto-default instead, so two mechs never share the host's colour.
  // #506/#496: `abilityMounts`/`coreMounts` ride along the same way `mounts` (weapons) always
  // has — dropping them here would silently strip a joiner's Dash/Shield the instant they used
  // this path, which is exactly the kind of per-owner build state this function exists to carry.
  if (isUsableBuild(saved)) {
    return {
      chassisId: saved.chassisId, mounts: saved.mounts, name: saved.name, color: saved.color,
      abilityMounts: saved.abilityMounts, coreMounts: saved.coreMounts,
    };
  }
  return {
    chassisId: hostBuild?.chassisId, mounts: hostBuild?.mounts, name: hostBuild?.name,
    abilityMounts: hostBuild?.abilityMounts, coreMounts: hostBuild?.coreMounts,
  };
}

// A build is usable if it exists and, where it can tell us, says it is complete. A plain object
// with no `isComplete` (a test double, or a raw save) is taken at face value as long as it has a
// chassis — the Mech constructor is what actually validates it.
export function isUsableBuild(build) {
  if (!build || !build.chassisId) return false;
  if (typeof build.isComplete === 'function') return build.isComplete();
  return true;
}
