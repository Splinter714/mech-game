// The SEQUENTIAL two-player Garage flow (#349, phase 3 of local co-op — parent #335).
//
// Phase 2 (#348) could only start co-op mid-sortie: press START on gamepad 2 and the joiner
// deployed a COPY of player 1's build, because there was exactly one saved build. This module
// is the "player 2 brings their own mech" half.
//
// ## The one correction worth writing down
//
// The issue body assumed multi-slot saving was already player-facing. It is not.
// `ACTIVE_MECH_KEY` in rosters.js is the hardcoded string 'mech1' — there is ONE persistent
// mech, and the roster machinery that could hold more has never had a second entry. So there
// is no roster picker to extend and none is being built here (Jackson, explicitly: a general
// slot-picker UI "is a different feature and is not being asked for"). What phase 3 adds is
// exactly ONE more fixed slot, 'mech2', which persists between sessions so a regular co-op
// partner keeps their machine.
//
// ## The flow
//
// Sequential, chosen by Jackson over a tab-switch or a split view "because it is the least new
// UI and the Garage already works that way for one person":
//
//   solo ──[+ ADD PLAYER 2]──▸ coop/editing P1 ──[P1 READY]──▸ coop/editing P2 ──[DEPLOY]──▸ arena
//          ◂──[CANCEL CO-OP]──                  ◂──[BACK TO P1]──
//
// The garage's single editing surface is simply rebound from one mech key to the other; the
// handoff step Jackson asked for IS the Deploy button relabelling itself to "P1 READY" while
// player 1 is the one editing. One player present = the co-op toggle never gets pressed and
// every function below returns exactly what single-player did before.
//
// Pure: no Phaser, no scene, no localStorage. The scene wiring is GarageScene#_setEditing /
// #deploy and scenes/arena/coop.js.

// The fixed persistent build slots, indexed by player. Deliberately a short literal list and
// not a generated range: these are the four slots that exist, each with a matching `defaultRoster`
// build in rosters.js. #387 raised the cap to four players; slots 3 & 4 back the mid-sortie
// drop-ins (the garage still only pre-builds mech1/mech2 — #388 makes 3/4 pre-buildable).
export const PLAYER_MECH_KEYS = ['mech1', 'mech2', 'mech3', 'mech4'];

// The storage key holding player `index`'s persistent build. Out-of-range indices clamp to the
// last real slot rather than returning undefined, so a stray extra player can never index a
// nonexistent roster entry and crash the deploy path.
export function mechKeyForPlayer(index) {
  const i = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return PLAYER_MECH_KEYS[Math.min(i, PLAYER_MECH_KEYS.length - 1)];
}

// The garage's co-op session state. `coop` is whether a second player is joining from the
// garage at all; `editing` is which player's mech the single editing surface is currently bound
// to. That is the whole state — there is no per-player "ready" flag, because with a sequential
// flow "player 1 is ready" is just "we have moved on to player 2".
export function makeGarageSession({ coop = false, editing = 0 } = {}) {
  return { coop: !!coop, editing: coop ? Math.min(Math.max(0, editing | 0), PLAYER_MECH_KEYS.length - 1) : 0 };
}

// Which build the garage is editing right now. In solo this is unconditionally 'mech1', so
// every single-player path is byte-identical to what it was before phase 3.
export function sessionMechKey(session) {
  return session?.coop ? mechKeyForPlayer(session.editing) : PLAYER_MECH_KEYS[0];
}

// Which builds are deploying. One key in solo, and in co-op exactly the slots the sequential
// garage flow has actually reached — `editing` is the furthest player built, so `editing + 1`
// keys deploy (two, when player 2 is the one at the Deploy button). #387 raised PLAYER_MECH_KEYS
// to four for the mid-sortie drop-ins, so this must NOT return the whole array or a two-player
// garage deploy would suddenly put four players on the field; deriving from `editing` keeps the
// garage flow bit-identical at two (and is what #388 extends when 3/4 become pre-buildable).
export function sessionMechKeys(session) {
  if (!session?.coop) return [PLAYER_MECH_KEYS[0]];
  const reached = Math.min(Math.max(0, session.editing | 0) + 1, PLAYER_MECH_KEYS.length);
  return PLAYER_MECH_KEYS.slice(0, reached);
}

// What the Deploy button DOES when pressed. The handoff step lives here rather than as a
// separate button: while player 1 is editing in co-op, the same button hands off instead of
// deploying, so co-op adds no new primary control to a garage that is already tight at narrow
// widths (#330/#342).
export function garageAction(session) {
  return session?.coop && session.editing === 0 ? 'handoff' : 'deploy';
}

export function garageActionLabel(session) {
  return garageAction(session) === 'handoff' ? '▶ P1 READY' : '▶ DEPLOY';
}

// The co-op toggle: one button whose meaning depends on where in the flow we are. Solo → opt
// in; player 1 editing → back out entirely; player 2 editing → step back to player 1 (so a
// premature handoff is recoverable without cancelling the whole session).
export function coopToggleLabel(session) {
  if (!session?.coop) return '+ ADD PLAYER 2';
  return session.editing === 0 ? '✕ CANCEL CO-OP' : '◀ BACK TO P1';
}

// The status line beside the toggle. Empty in solo: a one-player garage shows no co-op chrome
// at all beyond the opt-in button itself.
export function garageStatusText(session) {
  if (!session?.coop) return '';
  return session.editing === 0 ? 'PLAYER 1 BUILDING' : 'PLAYER 2 BUILDING';
}

export function beginCoop(session) {
  return makeGarageSession({ coop: true, editing: 0 });
}

export function endCoop(session) {
  return makeGarageSession({ coop: false });
}

// Player 1 declares ready → the editing surface rebinds to player 2's slot. A no-op in solo and
// a no-op if player 2 is already the one editing, so a double press can never run past the end
// of the flow.
export function handOff(session) {
  if (!session?.coop) return makeGarageSession(session);
  return makeGarageSession({ coop: true, editing: Math.min(session.editing + 1, PLAYER_MECH_KEYS.length - 1) });
}

// The co-op toggle's effect, as one function so the button has no branching of its own.
export function toggleCoop(session) {
  if (!session?.coop) return beginCoop(session);
  if (session.editing > 0) return makeGarageSession({ coop: true, editing: session.editing - 1 });
  return endCoop(session);
}

// ── The mid-sortie joiner ──
//
// Jackson kept BOTH join paths: the garage flow is the normal one, and phase 2's "press START
// on gamepad 2" stays for someone dropping in late. That leaves the question of which mech a
// late joiner drives, and this is the answer: their OWN saved build if there is a usable one,
// otherwise phase 2's original behaviour (a copy of player 1's build) unchanged as the
// fallback. Since 'mech2' now ships with a complete default build, in practice a joiner gets
// their own mech from the first time anyone ever presses START — but the fallback still matters
// for a save whose player-2 slot was left half-built via the garage flow, where deploying an
// incomplete mech would put an unarmed machine on the field.
//
// Duck-typed on purpose: `saved` is a Mech (or a plain build object in tests) and only its
// build fields are read, so this stays a pure function with no Mech import.
export function joinerBuild(saved, hostBuild) {
  if (isUsableBuild(saved)) {
    return { chassisId: saved.chassisId, mounts: saved.mounts, name: saved.name };
  }
  return { chassisId: hostBuild?.chassisId, mounts: hostBuild?.mounts, name: hostBuild?.name };
}

// A build is usable if it exists and, where it can tell us, says it is complete. A plain object
// with no `isComplete` (a test double, or a raw save) is taken at face value as long as it has
// a chassis — the Mech constructor is what actually validates it.
export function isUsableBuild(build) {
  if (!build || !build.chassisId) return false;
  if (typeof build.isComplete === 'function') return build.isComplete();
  return true;
}
