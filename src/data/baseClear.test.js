// #356/#384: a base is not cleared — and the run is not won — until its objective AND every dock
// (phase 1, ANY order) and then every remaining enemy (phase 2) are gone. #326 made docks
// reinforce forever, so a kill count shown while a structure still stands would climb rather than
// fall — hence no garrison count until phase 1 is complete. #384 collapsed #356's ordered
// objective-then-docks into one any-order structures phase. These tests pin both the rule and what
// the player is told at each step.
import { describe, it, expect } from 'vitest';
import {
  baseClearState, baseClearLabel,
  CLEAR_STRUCTURES, CLEAR_ENEMIES, CLEAR_DONE,
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

describe('#384 base clear state — objective + docks are ONE any-order phase', () => {
  it('asks for the structures while the objective still stands, whatever else is alive', () => {
    const s = state({ objectiveDestroyed: false, isDockStanding: allUp, enemies: [{ baseId: 'base0' }] });
    expect(s.step).toBe(CLEAR_STRUCTURES);
    expect(s.objectiveStanding).toBe(true);
    expect(s.docksLeft).toBe(2);
    expect(s.structuresLeft).toBe(3);   // objective + 2 docks
    expect(s.cleared).toBe(false);
  });

  it('stays in the structures phase when the objective is down but docks remain (any order)', () => {
    const s = state({ objectiveDestroyed: true, isDockStanding: allUp, enemies: [{ baseId: 'base0' }] });
    expect(s.step).toBe(CLEAR_STRUCTURES);
    expect(s.objectiveStanding).toBe(false);
    expect(s.docksLeft).toBe(2);
    expect(s.structuresLeft).toBe(2);
  });

  it('stays in the structures phase when a dock is down but the objective stands (any order)', () => {
    const s = state({ objectiveDestroyed: false, isDockStanding: oneUp, enemies: [{ baseId: 'base0' }] });
    expect(s.step).toBe(CLEAR_STRUCTURES);
    expect(s.objectiveStanding).toBe(true);
    expect(s.docksLeft).toBe(1);
    expect(s.structuresLeft).toBe(2);   // objective + 1 dock
  });

  it('counts only STANDING docks — a collapsed dock hex is off the list', () => {
    expect(state({ objectiveDestroyed: true, isDockStanding: oneUp }).docksLeft).toBe(1);
  });

  it('only asks for enemies once EVERY structure is down (objective and all docks)', () => {
    const enemies = [{ baseId: 'base0' }, { baseId: 'base0' }];
    // Objective down but docks up: still structures, no enemy ask.
    expect(state({ objectiveDestroyed: true, isDockStanding: allUp, enemies }).step).toBe(CLEAR_STRUCTURES);
    // Docks down but objective up: still structures, no enemy ask.
    expect(state({ objectiveDestroyed: false, isDockStanding: noneUp, enemies }).step).toBe(CLEAR_STRUCTURES);
    // Both down: NOW the garrison.
    const s = state({ objectiveDestroyed: true, isDockStanding: noneUp, enemies });
    expect(s.step).toBe(CLEAR_ENEMIES);
    expect(s.enemiesLeft).toBe(2);
  });

  it('ignores enemies belonging to other bases', () => {
    const s = state({ objectiveDestroyed: true, enemies: [{ baseId: 'base1' }, { baseId: null }] });
    expect(s.step).toBe(CLEAR_DONE);
    expect(s.cleared).toBe(true);
  });

  it('is cleared only when the objective, every dock AND the garrison are all satisfied', () => {
    expect(state({ objectiveDestroyed: true }).cleared).toBe(true);
    expect(state({ objectiveDestroyed: false }).cleared).toBe(false);
    expect(state({ objectiveDestroyed: true, isDockStanding: oneUp }).cleared).toBe(false);
    expect(state({ objectiveDestroyed: false, isDockStanding: noneUp }).cleared).toBe(false);   // objective still up
    expect(state({ objectiveDestroyed: true, enemies: [{ baseId: 'base0' }] }).cleared).toBe(false);
  });

  it('treats a base with no docks as needing only the objective, then the garrison', () => {
    const s = baseClearState(base([]), { objectiveDestroyed: true, enemies: [{ baseId: 'base0' }] });
    expect(s.step).toBe(CLEAR_ENEMIES);
    // …and while its objective stands it is still in the structures phase.
    expect(baseClearState(base([]), { objectiveDestroyed: false }).step).toBe(CLEAR_STRUCTURES);
  });

  it('reads a missing base as cleared (index ran past the last base)', () => {
    expect(baseClearState(null).cleared).toBe(true);
  });
});

describe('#384 what the player is told', () => {
  it('never shows an enemy count while a structure still stands', () => {
    const s = state({ objectiveDestroyed: true, isDockStanding: allUp, enemies: Array(7).fill({ baseId: 'base0' }) });
    const label = baseClearLabel(s);
    expect(label).toMatch(/DESTROY THE BASE/);
    expect(label).not.toMatch(/7/);
    expect(label).not.toMatch(/GARRISON/);
  });

  it('names exactly what still stands in phase 1, then the garrison count, then done', () => {
    // Objective + both docks up.
    expect(baseClearLabel(state({ objectiveDestroyed: false, isDockStanding: allUp })))
      .toBe('DESTROY THE BASE  (OBJECTIVE + 2 DOCKS)');
    // Objective down, one dock left — objective drops out of the line, dock singularised.
    expect(baseClearLabel(state({ objectiveDestroyed: true, isDockStanding: oneUp })))
      .toBe('DESTROY THE BASE  (1 DOCK)');
    // Docks down, objective still up.
    expect(baseClearLabel(state({ objectiveDestroyed: false, isDockStanding: noneUp })))
      .toBe('DESTROY THE BASE  (OBJECTIVE)');
    // Structures gone: garrison count.
    expect(baseClearLabel(state({ objectiveDestroyed: true, enemies: [{ baseId: 'base0' }] }))).toMatch(/GARRISON.*1 LEFT/);
    // All done.
    expect(baseClearLabel(state({ objectiveDestroyed: true }))).toMatch(/CLEAR/);
  });
});
