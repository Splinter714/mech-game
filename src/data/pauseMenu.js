// #523: pure pause-menu logic, kept separate from the Phaser-heavy scenes/PauseMenuScene.js —
// same split as data/hudLayout.js vs scenes/HudScene.js — so it's directly unit-testable.

// The base rows, in display/cursor order. Most are persisted show/hide toggles (their own
// localStorage flag, data/pauseSettings.js); MOVEMENT is a live action button that flips the
// current player(s)' `legacyMovement` state (arena/shared.js `applyMovementToggle`) rather than
// a persisted preference — mirrors the existing D-pad-down toggle, doesn't replace it. VOLUME
// (#558) is a slider, not an ON/OFF toggle — it renders its own widget in PauseMenuScene rather
// than the shared toggle-row label. UNLOCK_ALL (#555) is a normal persisted toggle, alongside
// the other dev-diagnostic rows, that replaces the old hardcoded shop.js UNLOCK_ALL flag.
export const PAUSE_ROWS = [
  'version', 'volume', 'movement', 'perf', 'controlMethod', 'aiDebug', 'unlockAll',
];

// #529: dev-only NAVIGATION rows, appended after the base five when the pause menu is opened
// from a dev build — this is where AUDIO/ART (the two dev-only lab scenes) and STATS (the
// Garage's own run-history overlay) moved when the "Mech Lab / AUDIO / ART" scene-level tab bar
// went away (see ui/tabBar.js). Unlike the base rows, these aren't toggles: activating one
// navigates away (audio/art) or closes the menu and opens an overlay (stats).
export const DEV_NAV_ROWS = ['audio', 'art', 'stats'];

// #625: dev-only ARENA rows — the four dev actions that used to sit on the arena's D-pad
// (spawn an enemy, reset the enemies, toggle enemy AI move/fire). They only make sense when the
// pause menu was opened from the Arena (the Garage/Base have no enemies on the field), so they're
// gated on `hasArenaDebug` the same way STATS is gated on `hasStats`. SPAWN/RESET are one-shot
// action rows (static labels); AI MOVE/FIRE are live ON/OFF toggles of the arena's own
// `enemyMove`/`enemyFire` flags — not persisted preferences, so they read their state back off
// the paused scene rather than the registry.
export const DEV_ARENA_ROWS = ['spawnEnemy', 'resetEnemies', 'aiMove', 'aiFire'];

export const PAUSE_ROW_TITLES = {
  version: 'VERSION NUMBER',
  volume: 'VOLUME',
  movement: 'MOVEMENT FEEL',
  perf: 'PERF READOUT',
  controlMethod: 'CONTROL METHOD',
  aiDebug: 'AI DEBUG READOUT',
  unlockAll: 'UNLOCK ALL WEAPONS (DEV)',
  audio: 'AUDIO TAB (DEV)',
  art: 'ART TAB (DEV)',
  stats: 'RUN STATS',
  spawnEnemy: 'SPAWN ENEMY (DEV)',
  resetEnemies: 'RESET ENEMIES (DEV)',
  aiMove: 'ENEMY AI MOVE (DEV)',
  aiFire: 'ENEMY AI FIRE (DEV)',
};

// The full row id list for a pause-menu instance: the base rows, plus (in a dev build) the
// AUDIO/ART navigation rows, plus (in a dev build, AND only when the opening scene actually has a
// stats overlay to open — i.e. it's the Garage) the STATS row, plus (in a dev build, AND only when
// the opener is the Arena — #625) the four arena dev-action rows. Pure so it's testable without a
// Phaser scene; PauseMenuScene.js just calls this with what it knows about its own launch data.
export function pauseRowIds({ dev = false, hasStats = false, hasArenaDebug = false } = {}) {
  if (!dev) return [...PAUSE_ROWS];
  const nav = hasStats ? DEV_NAV_ROWS : DEV_NAV_ROWS.filter((id) => id !== 'stats');
  const arena = hasArenaDebug ? DEV_ARENA_ROWS : [];
  return [...PAUSE_ROWS, ...nav, ...arena];
}

// A plain show/hide toggle row's label.
export function toggleRowLabel(rowId, enabled) {
  return `${PAUSE_ROW_TITLES[rowId]}: ${enabled ? 'ON' : 'OFF'}`;
}

// A navigation row's (audio/art/stats) label — static, no ON/OFF state.
export function navRowLabel(rowId) {
  return PAUSE_ROW_TITLES[rowId];
}

// #625: a one-shot ACTION row's label (SPAWN ENEMY / RESET ENEMIES) — static, nothing to reflect.
export function actionRowLabel(rowId) {
  return PAUSE_ROW_TITLES[rowId];
}

// #625: the enemy-AI toggle rows read their ON/OFF off the paused Arena's live flags (undefined —
// no arena to ask — reads as ON, the arena's own `enemyMove`/`enemyFire` default).
export function aiToggleRowLabel(rowId, on) {
  return `${PAUSE_ROW_TITLES[rowId]}: ${on !== false ? 'ON' : 'OFF'}`;
}

// The movement-toggle action row's label, off the player's own legacyMovement flag (undefined —
// a fresh player — reads as fast/legacy, same `?? true` default `resolveMovement` uses).
export function movementRowLabel(legacyMovement) {
  const legacy = legacyMovement ?? true;
  return `${PAUSE_ROW_TITLES.movement}: ${legacy ? 'FAST (LEGACY)' : 'TWIST-SLEW'}`;
}

// Whether the movement row can actually be activated right now — it needs at least one live
// player to flip (Arena/Base only; the lab scenes have no mech on the field to toggle).
export function movementRowEnabled(players) {
  return Array.isArray(players) && players.length > 0;
}
