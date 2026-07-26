// #523: pure pause-menu logic, kept separate from the Phaser-heavy scenes/PauseMenuScene.js —
// same split as data/hudLayout.js vs scenes/HudScene.js — so it's directly unit-testable.

// The five rows, in display/cursor order. Four are persisted show/hide toggles (their own
// localStorage flag, data/pauseSettings.js); MOVEMENT is a live action button that flips the
// current player(s)' `legacyMovement` state (arena/shared.js `applyMovementToggle`) rather than
// a persisted preference — mirrors the existing D-pad-down toggle, doesn't replace it.
export const PAUSE_ROWS = ['version', 'movement', 'perf', 'controlMethod', 'aiDebug'];

export const PAUSE_ROW_TITLES = {
  version: 'VERSION NUMBER',
  movement: 'MOVEMENT FEEL',
  perf: 'PERF READOUT',
  controlMethod: 'CONTROL METHOD',
  aiDebug: 'AI DEBUG READOUT',
};

// A plain show/hide toggle row's label.
export function toggleRowLabel(rowId, enabled) {
  return `${PAUSE_ROW_TITLES[rowId]}: ${enabled ? 'ON' : 'OFF'}`;
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
