// The SIMULTANEOUS multi-player Garage flow — a PROTOTYPE Jackson asked to evaluate live
// alongside the shipped SEQUENTIAL one (data/coopGarage.js). Where the sequential flow hands one
// editing surface player-to-player ("P1 READY" → rebind → "P2 READY" → deploy), this one gives
// every joined player their own column, editing at the same time — so there is no `editing`
// cursor to move at all. The whole session is just "how many players are here" and "who has
// declared themselves ready."
//
// Kept as its own tiny module rather than folded into coopGarage.js so the prototype can be
// deleted wholesale (this file + SimulGarageScene.js + the one entry point in GarageScene.js) if
// Jackson doesn't like it, without touching the shipped flow at all. It deliberately reuses
// coopGarage's own MAX_GARAGE_PLAYERS/PLAYER_MECH_KEYS/canJoin rather than duplicating them — both
// flows seat the exact same four persistent build slots, they just differ in whether one editing
// surface is handed around or four exist at once.
//
// Session shape: `{ count, ready }` — `count` is how many players have joined (1..MAX, same
// meaning as the sequential session's `count`); `ready` is a per-player bool array, one entry per
// joined player. Deploying is a per-player CHOICE (toggleReady) rather than a single last-player
// action — the scene deploys the instant `allReady` goes true (see SimulGarageScene).
import { MAX_GARAGE_PLAYERS } from './coopGarage.js';

function clampInt(v, lo, hi) {
  const n = Number.isFinite(v) ? Math.trunc(v) : lo;
  return Math.min(Math.max(n, lo), hi);
}

// Normalises a raw/partial session into a legal one: `count` clamped to [1, MAX_GARAGE_PLAYERS],
// `ready` trimmed/padded to exactly `count` entries (missing entries read as not-ready).
export function makeSimulSession(session) {
  const { count = 1, ready = [] } = session ?? {};
  const c = clampInt(count, 1, MAX_GARAGE_PLAYERS);
  const r = [];
  for (let i = 0; i < c; i++) r.push(!!ready[i]);
  return { count: c, ready: r };
}

// How many players have joined. Mirrors coopGarage's playerCount so callers that just want the
// count don't have to know this module's exact shape.
export function simulPlayerCount(session) {
  return makeSimulSession(session).count;
}

// A new controller joins: grow the count by one (capped at MAX_GARAGE_PLAYERS — a no-op past the
// cap, so a stray extra join attempt can't overflow the fixed four columns), starting NOT ready.
export function joinSimulPlayer(session) {
  const s = makeSimulSession(session);
  if (s.count >= MAX_GARAGE_PLAYERS) return s;
  return makeSimulSession({ count: s.count + 1, ready: s.ready });
}

// Flip player `index`'s ready flag. Out-of-range indices are a no-op (defends against a stray
// call for a not-yet-joined slot).
export function toggleReady(session, index) {
  const s = makeSimulSession(session);
  if (index < 0 || index >= s.count) return s;
  const ready = s.ready.slice();
  ready[index] = !ready[index];
  return { count: s.count, ready };
}

// Every joined player has marked themselves ready — the deploy trigger. False for an empty
// session (there is always at least one player once the garage exists, but this stays defensive).
export function allReady(session) {
  const s = makeSimulSession(session);
  return s.ready.length > 0 && s.ready.every(Boolean);
}

// The joined player indices, in order — [0] in solo, up to [0,1,2,3] at full capacity. What the
// scene iterates to build/update one column per active player.
export function activeIndices(session) {
  return Array.from({ length: makeSimulSession(session).count }, (_, i) => i);
}
