// The SIMULTANEOUS multi-player Garage flow (#505) — GarageScene's one and only build session
// model. Every joined player gets their own column, editing at the same time — so there is no
// `editing` cursor to move at all, unlike the sequential handoff flow this replaced ("P1 READY" →
// rebind → "P2 READY" → deploy, formerly data/coopGarage.js's `{count, editing}` state, removed
// with #505 since GarageScene no longer uses it — see coopGarage.js's header). The whole session
// is just "how many players are here" and "who has declared themselves ready."
//
// Kept as its own module (rather than folded into coopGarage.js) because it's genuinely a
// different shape of state, not because it's provisional any more — #505 made this the shipped
// flow, replacing the separate SimulGarageScene it used to back. It still reuses coopGarage's own
// MAX_GARAGE_PLAYERS/PLAYER_MECH_KEYS/canJoin rather than duplicating them — both seat the same
// four persistent build slots.
//
// Session shape: `{ count, ready }` — `count` is how many players have joined (1..MAX); `ready` is
// a per-player bool array, one entry per joined player. Deploying is a per-player CHOICE
// (toggleReady) rather than a single last-player action — the scene deploys the instant
// `allReady` goes true (see GarageScene#_deploy).
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
