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
};

// The full row id list for a pause-menu instance: the five base rows, plus (in a dev build) the
// AUDIO/ART navigation rows, plus (in a dev build, AND only when the opening scene actually has a
// stats overlay to open — i.e. it's the Garage) the STATS row. Pure so it's testable without a
// Phaser scene; PauseMenuScene.js just calls this with what it knows about its own launch data.
export function pauseRowIds({ dev = false, hasStats = false } = {}) {
  if (!dev) return [...PAUSE_ROWS];
  const nav = hasStats ? DEV_NAV_ROWS : DEV_NAV_ROWS.filter((id) => id !== 'stats');
  return [...PAUSE_ROWS, ...nav];
}

// A plain show/hide toggle row's label.
export function toggleRowLabel(rowId, enabled) {
  return `${PAUSE_ROW_TITLES[rowId]}: ${enabled ? 'ON' : 'OFF'}`;
}

// A navigation row's (audio/art/stats) label — static, no ON/OFF state.
export function navRowLabel(rowId) {
  return PAUSE_ROW_TITLES[rowId];
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
