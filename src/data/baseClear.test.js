// #356: a base is not cleared — and the run is not won — until its objective, then every dock,
// then every remaining enemy is gone. The ORDER is the design: #326 made docks reinforce forever,
// so a kill count shown while a dock still stands would climb rather than fall. These tests pin
// both the rule and what the player is told at each step.
import { describe, it, expect } from 'vitest';
import {
  baseClearState, baseClearLabel,
  CLEAR_OBJECTIVE, CLEAR_DOCKS, CLEAR_ENEMIES, CLEAR_DONE,
} from './bases.js';

const base = (docks) => ({ id: 'base0', docks });
const standing = (keys) => (d) => keys.has(`${d.q},${d.r}`);
const D = [{ q: 1, r: 0 }, { q: 2, r: 0 }];
const allUp = standing(new Set(['1,0', '2,0']));
const oneUp = standing(new Set(['2,0']));
const noneUp = () => false;

function state(opts) {
  return baseClearState(base(D), { isDockStanding: noneUp, enemies: [], ...opts });
}

describe('#356 base clear state', () => {
  it('asks for the objective first, whatever else is alive', () => {
    const s = state({ objectiveDestroyed: false, isDockStanding: allUp, enemies: [{ baseId: 'base0' }] });
    expect(s.step).toBe(CLEAR_OBJECTIVE);
    expect(s.cleared).toBe(false);
  });

  it('asks for the docks once the objective is down', () => {
    const s = state({ objectiveDestroyed: true, isDockStanding: allUp, enemies: [{ baseId: 'base0' }] });
    expect(s.step).toBe(CLEAR_DOCKS);
    expect(s.docksLeft).toBe(2);
  });

  it('counts only STANDING docks — a collapsed dock hex is off the list', () => {
    expect(state({ objectiveDestroyed: true, isDockStanding: oneUp }).docksLeft).toBe(1);
  });

  it('only asks for enemies once every dock is down', () => {
    const enemies = [{ baseId: 'base0' }, { baseId: 'base0' }];
    expect(state({ objectiveDestroyed: true, isDockStanding: allUp, enemies }).step).toBe(CLEAR_DOCKS);
    const s = state({ objectiveDestroyed: true, isDockStanding: noneUp, enemies });
    expect(s.step).toBe(CLEAR_ENEMIES);
    expect(s.enemiesLeft).toBe(2);
  });

  it('ignores enemies belonging to other bases', () => {
    const s = state({ objectiveDestroyed: true, enemies: [{ baseId: 'base1' }, { baseId: null }] });
    expect(s.step).toBe(CLEAR_DONE);
    expect(s.cleared).toBe(true);
  });

  it('is cleared only when all three are satisfied', () => {
    expect(state({ objectiveDestroyed: true }).cleared).toBe(true);
    expect(state({ objectiveDestroyed: false }).cleared).toBe(false);
    expect(state({ objectiveDestroyed: true, isDockStanding: oneUp }).cleared).toBe(false);
    expect(state({ objectiveDestroyed: true, enemies: [{ baseId: 'base0' }] }).cleared).toBe(false);
  });

  it('treats a base with no docks as going straight from objective to garrison', () => {
    const s = baseClearState(base([]), { objectiveDestroyed: true, enemies: [{ baseId: 'base0' }] });
    expect(s.step).toBe(CLEAR_ENEMIES);
  });

  it('reads a missing base as cleared (index ran past the last base)', () => {
    expect(baseClearState(null).cleared).toBe(true);
  });
});

describe('#356 what the player is told', () => {
  it('never shows an enemy count while a dock still stands', () => {
    const s = state({ objectiveDestroyed: true, isDockStanding: allUp, enemies: Array(7).fill({ baseId: 'base0' }) });
    const label = baseClearLabel(s);
    expect(label).toMatch(/DOCKS/);
    expect(label).not.toMatch(/7/);
  });

  it('shows the dock count, then the garrison count, then done', () => {
    expect(baseClearLabel(state({ objectiveDestroyed: false }))).toMatch(/OBJECTIVE/);
    expect(baseClearLabel(state({ objectiveDestroyed: true, isDockStanding: oneUp }))).toMatch(/1 LEFT/);
    expect(baseClearLabel(state({ objectiveDestroyed: true, enemies: [{ baseId: 'base0' }] }))).toMatch(/GARRISON.*1 LEFT/);
    expect(baseClearLabel(state({ objectiveDestroyed: true }))).toMatch(/CLEAR/);
  });
});
