// The SEQUENTIAL multi-player Garage flow (#349 → #388, phase 3/4b of local co-op — parent #335).
//
// Phase 2 (#348) could only start co-op mid-sortie: press START on gamepad 2 and the joiner
// deployed a COPY of player 1's build, because there was exactly one saved build. Phase 3 (#349)
// added the "player 2 brings their own mech" garage half as a BINARY solo/2-player flow. Phase
// 4b (#388) generalises that to 1–4 players: any number of controllers can join in the garage,
// each builds its own persistent mech, control is handed player-to-player, and the last one
// deploys the whole squad.
//
// ## The state: a COUNT, not a bool
//
// The garage session is `{ count, editing }`:
//   - `count`   — how many players have JOINED (1..MAX). Solo is `count === 1`.
//   - `editing` — which joined player is building RIGHT NOW (0..count-1).
// #388 replaced phase 3's `coop` bool with `count`: "is a second player here" could not express
// "three players are here, player 2 is building." Solo is exactly `count === 1`, and every
// function below returns what single-player did before when that holds.
//
// ## The flow
//
// A player joins by pressing START on an UNCLAIMED pad (mirrors the mid-sortie drop-in, but in
// the garage) — `joinPlayer` grows the count; `editing` does not move, so joining while player 1
// is mid-build just reveals player 2's tab. The player currently building presses START on their
// OWN pad to hand control to the next joined player (`advanceEditing`); the LAST joined player's
// START deploys (`garageAction` reads 'deploy' once `editing` has reached `count - 1`). One
// player present = nobody ever joins, `editing` stays 0, and the sole START deploys.
//
//   solo ──[P2 START joins]──▸ count 2, P1 building ──[P1 START]──▸ P2 building ──[P2 START]──▸ deploy
//                                                                  (…and so on up to 4 players)
//
// The garage's single editing surface is rebound from one mech key to the next as `editing`
// advances; the handoff step IS the Deploy button relabelling itself to "▶ P1 READY" while a
// non-last player is editing. Pure: no Phaser, no scene, no localStorage. The scene wiring is
// GarageScene (the tab row, the per-builder pad, `deploy`/`_joinPlayer`) and scenes/arena/coop.js.

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

// The garage's co-op session state. `count` is how many players have joined (>=1); `editing` is
// which of them the single editing surface is currently bound to. Both are clamped to legal
// ranges here so no other function has to defend against a bad session.
export function makeGarageSession(session) {
  const { count = 1, editing = 0 } = session ?? {};
  const c = clampInt(count, 1, MAX_GARAGE_PLAYERS);
  return { count: c, editing: clampInt(editing, 0, c - 1) };
}

// How many players have joined (>=1). Reads a raw/garbage session as solo.
export function playerCount(session) {
  return clampInt(session?.count ?? 1, 1, MAX_GARAGE_PLAYERS);
}

// Solo is exactly one joined player — the single-player garage, byte-identical to before #388.
export function isSoloSession(session) {
  return playerCount(session) === 1;
}

// Is there room for another player to join? False once every slot is seated.
export function canJoin(session) {
  return playerCount(session) < MAX_GARAGE_PLAYERS;
}

// Which build the garage is editing right now — the current builder's own slot. In solo this is
// unconditionally 'mech1', so every single-player path is byte-identical to before.
export function sessionEditingKey(session) {
  return mechKeyForPlayer(session?.editing ?? 0);
}

// Which builds are deploying: exactly the joined players' slots, in order. One key in solo,
// `['mech1','mech2']` for two players, up to `['mech1'..'mech4']` for four. This is the ONE thing
// the arena needs to put the built squad on the field (scenes/arena/coop.js).
export function sessionMechKeys(session) {
  return PLAYER_MECH_KEYS.slice(0, playerCount(session));
}

// A new controller joins: grow the count by one (capped), leaving `editing` where it is so a
// join mid-build just reveals the newcomer's tab rather than yanking control away.
export function joinPlayer(session) {
  const s = makeGarageSession(session);
  return makeGarageSession({ count: s.count + 1, editing: s.editing });
}

// The current builder hands control to the next joined player. A no-op once `editing` is already
// the last player, so a stray press can never run past the end of the flow (the last player's
// press is a DEPLOY, not a handoff — see garageAction).
export function advanceEditing(session) {
  const s = makeGarageSession(session);
  return makeGarageSession({ count: s.count, editing: s.editing + 1 });
}

// What the Deploy button DOES when pressed. The handoff step lives here rather than as a separate
// button: while a non-last player is editing, the same button hands off instead of deploying, so
// co-op adds no new primary control to a garage that is already tight at narrow widths (#330/#342).
export function garageAction(session) {
  const s = makeGarageSession(session);
  return s.editing >= s.count - 1 ? 'deploy' : 'handoff';
}

export function garageActionLabel(session) {
  if (garageAction(session) === 'deploy') return '▶ DEPLOY';
  const p = clampInt(session?.editing ?? 0, 0, MAX_GARAGE_PLAYERS - 1) + 1;
  return `▶ P${p} READY`;
}

// The status line: empty in solo (a one-player garage shows no co-op chrome), else whose turn it
// is. The tab row is the primary "whose turn" indicator; this is the words beside it.
export function garageStatusText(session) {
  const s = makeGarageSession(session);
  if (s.count === 1) return '';
  return `PLAYER ${s.editing + 1} BUILDING`;
}

// The player-tab row model the garage draws: one OCCUPIED tab per joined player (the active one
// flagged), plus — while there's still room — a single trailing ADD tab (the "press START to
// join" affordance). Pure so the scene stays a thin renderer over it.
export function playerTabs(session) {
  const s = makeGarageSession(session);
  const tabs = [];
  for (let i = 0; i < s.count; i++) {
    tabs.push({ index: i, occupied: true, active: i === s.editing });
  }
  if (s.count < MAX_GARAGE_PLAYERS) {
    tabs.push({ index: s.count, occupied: false, active: false });
  }
  return tabs;
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
  if (isUsableBuild(saved)) {
    return { chassisId: saved.chassisId, mounts: saved.mounts, name: saved.name, color: saved.color };
  }
  return { chassisId: hostBuild?.chassisId, mounts: hostBuild?.mounts, name: hostBuild?.name };
}

// A build is usable if it exists and, where it can tell us, says it is complete. A plain object
// with no `isComplete` (a test double, or a raw save) is taken at face value as long as it has a
// chassis — the Mech constructor is what actually validates it.
export function isUsableBuild(build) {
  if (!build || !build.chassisId) return false;
  if (typeof build.isComplete === 'function') return build.isComplete();
  return true;
}
