// #523: pure pause-menu row/label logic (see data/pauseMenu.js for why this is split out of
// the Phaser-heavy scenes/PauseMenuScene.js).
import { describe, it, expect } from 'vitest';
import {
  PAUSE_ROWS, PAUSE_ROW_TITLES, DEV_NAV_ROWS, pauseRowIds, toggleRowLabel, navRowLabel,
  movementRowLabel, movementRowEnabled,
} from './pauseMenu.js';

describe('PAUSE_ROWS', () => {
  it('has exactly the five confirmed rows, in display order', () => {
    expect(PAUSE_ROWS).toEqual(['version', 'movement', 'perf', 'controlMethod', 'aiDebug']);
  });

  it('every row has a title', () => {
    for (const id of PAUSE_ROWS) expect(PAUSE_ROW_TITLES[id]).toBeTruthy();
  });
});

describe('toggleRowLabel', () => {
  it('reads ON when enabled', () => {
    expect(toggleRowLabel('perf', true)).toBe('PERF READOUT: ON');
  });

  it('reads OFF when disabled', () => {
    expect(toggleRowLabel('perf', false)).toBe('PERF READOUT: OFF');
  });

  it('uses each row\'s own title', () => {
    expect(toggleRowLabel('version', true)).toBe('VERSION NUMBER: ON');
    expect(toggleRowLabel('controlMethod', false)).toBe('CONTROL METHOD: OFF');
    expect(toggleRowLabel('aiDebug', true)).toBe('AI DEBUG READOUT: ON');
  });
});

describe('movementRowLabel', () => {
  it('reads FAST (LEGACY) when legacyMovement is true', () => {
    expect(movementRowLabel(true)).toBe('MOVEMENT FEEL: FAST (LEGACY)');
  });

  it('reads TWIST-SLEW when legacyMovement is false', () => {
    expect(movementRowLabel(false)).toBe('MOVEMENT FEEL: TWIST-SLEW');
  });

  it('a fresh player (undefined legacyMovement) reads as FAST (LEGACY), matching resolveMovement\'s own default', () => {
    expect(movementRowLabel(undefined)).toBe('MOVEMENT FEEL: FAST (LEGACY)');
  });
});

// #529: AUDIO/ART/STATS moved here from the scene-level tab bar (ui/tabBar.js) — dev-only
// navigation rows appended after the five base rows.
describe('pauseRowIds (#529 — dev-only AUDIO/ART/STATS navigation rows)', () => {
  it('is just the five base rows outside a dev build', () => {
    expect(pauseRowIds({ dev: false })).toEqual(PAUSE_ROWS);
    expect(pauseRowIds()).toEqual(PAUSE_ROWS);
  });

  it('adds AUDIO/ART (but not STATS) in a dev build with no stats overlay available', () => {
    expect(pauseRowIds({ dev: true })).toEqual([...PAUSE_ROWS, 'audio', 'art']);
  });

  it('adds STATS too when the opening scene has one (the Garage)', () => {
    expect(pauseRowIds({ dev: true, hasStats: true })).toEqual([...PAUSE_ROWS, ...DEV_NAV_ROWS]);
  });

  it('every DEV_NAV_ROWS id has a title', () => {
    for (const id of DEV_NAV_ROWS) expect(PAUSE_ROW_TITLES[id]).toBeTruthy();
  });
});

describe('navRowLabel', () => {
  it('is a static title with no ON/OFF suffix', () => {
    expect(navRowLabel('audio')).toBe('AUDIO TAB (DEV)');
    expect(navRowLabel('stats')).toBe('RUN STATS');
  });
});

describe('movementRowEnabled', () => {
  it('true when there is at least one player', () => {
    expect(movementRowEnabled([{ legacyMovement: true }])).toBe(true);
  });

  it('false for an empty player list', () => {
    expect(movementRowEnabled([])).toBe(false);
  });

  it('false when no players array was supplied at all (lab scenes)', () => {
    expect(movementRowEnabled(undefined)).toBe(false);
    expect(movementRowEnabled(null)).toBe(false);
  });
});
