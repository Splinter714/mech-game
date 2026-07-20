// #371: the objective indicator spreads to everything still required once the objective hex is
// down — building-sized markers on remaining docks, then little ones on remaining enemies. The
// merge gate is that this set is a PROJECTION of #356's `baseClearState`, never a parallel rule:
// it must agree with `baseClearLabel` at every step, and it must pick up late spawns.
import { describe, it, expect } from 'vitest';
import {
  baseClearState, baseClearLabel, baseMarkTargets, enemyMarkLift, ENEMY_MARK_LIFT,
  MARK_OBJECTIVE, MARK_BUILDING, MARK_SMALL,
} from './bases.js';

const D = [{ q: 1, r: 0 }, { q: 2, r: 0 }];
const base = { id: 'base0', docks: D };
const standing = (keys) => (d) => keys.has(`${d.q},${d.r}`);
const allUp = standing(new Set(['1,0', '2,0']));
const oneUp = standing(new Set(['2,0']));
const noneUp = () => false;

// Always derive both the state and the marks from the SAME inputs, exactly like the scene does.
function marks({ objectiveDestroyed = false, isDockStanding = noneUp, enemies = [] } = {}) {
  const ctx = { objectiveDestroyed, isDockStanding, enemies };
  const state = baseClearState(base, ctx);
  return { state, ...baseMarkTargets(state, base, ctx) };
}

describe('#371 objective marker targets', () => {
  it('step 1 — objective alive: the single marker, nothing else', () => {
    const m = marks({ isDockStanding: allUp, enemies: [{ baseId: 'base0' }, { baseId: 'base0' }] });
    expect(m.size).toBe(MARK_OBJECTIVE);
    expect(m.showObjective).toBe(true);
    expect(m.docks).toEqual([]);
    expect(m.enemies).toEqual([]);
  });

  it('step 2 — objective down, docks remain: building markers on standing docks only', () => {
    const m = marks({ objectiveDestroyed: true, isDockStanding: allUp, enemies: [{ baseId: 'base0' }] });
    expect(m.size).toBe(MARK_BUILDING);
    expect(m.showObjective).toBe(false);
    expect(m.docks).toEqual(D);
    expect(m.enemies).toEqual([]);
  });

  it('step 2 — a destroyed dock loses its marker', () => {
    const m = marks({ objectiveDestroyed: true, isDockStanding: oneUp });
    expect(m.docks).toEqual([{ q: 2, r: 0 }]);
  });

  it('step 3 — docks cleared: little markers on every remaining enemy of this base', () => {
    const enemies = [{ baseId: 'base0' }, { baseId: 'base0' }, { baseId: 'other' }];
    const m = marks({ objectiveDestroyed: true, enemies });
    expect(m.size).toBe(MARK_SMALL);
    expect(m.docks).toEqual([]);
    expect(m.enemies).toHaveLength(2);
    expect(m.enemies.every((e) => e.baseId === 'base0')).toBe(true);
  });

  it('step 4 — base clear: nothing is marked', () => {
    const m = marks({ objectiveDestroyed: true });
    expect(m.size).toBe(null);
    expect(m.docks).toEqual([]);
    expect(m.enemies).toEqual([]);
  });

  it('never marks an enemy while a dock still stands (the #356 "never show the 7" discipline)', () => {
    const enemies = Array.from({ length: 7 }, () => ({ baseId: 'base0' }));
    const m = marks({ objectiveDestroyed: true, isDockStanding: allUp, enemies });
    expect(m.enemies).toEqual([]);
    expect(baseClearLabel(m.state)).toMatch(/DOCKS/);
    expect(baseClearLabel(m.state)).not.toMatch(/7/);
  });

  it('agrees with baseClearState counts at every step', () => {
    const enemies = [{ baseId: 'base0' }, { baseId: 'base0' }];
    const docksStep = marks({ objectiveDestroyed: true, isDockStanding: allUp, enemies });
    expect(docksStep.docks).toHaveLength(docksStep.state.docksLeft);
    const enemiesStep = marks({ objectiveDestroyed: true, enemies });
    expect(enemiesStep.enemies).toHaveLength(enemiesStep.state.enemiesLeft);
  });

  it('marks LATE SPAWNS — the set is re-derived, so a carrier drone born mid-step is marked', () => {
    const enemies = [{ baseId: 'base0', id: 'a' }];
    const before = marks({ objectiveDestroyed: true, enemies });
    expect(before.enemies).toHaveLength(1);
    // A carrier (#328) deploys two more drones after marking has already begun.
    enemies.push({ baseId: 'base0', id: 'b' }, { baseId: 'base0', id: 'c' });
    const after = marks({ objectiveDestroyed: true, enemies });
    expect(after.enemies).toHaveLength(3);
    expect(after.enemies).toHaveLength(after.state.enemiesLeft);
    // ...and it is not capped.
    for (let i = 0; i < 40; i++) enemies.push({ baseId: 'base0', id: `d${i}` });
    expect(marks({ objectiveDestroyed: true, enemies }).enemies).toHaveLength(43);
  });

  it('a base with no docks skips straight from objective to enemy markers', () => {
    const noDocks = { id: 'base0', docks: [] };
    const ctx = { objectiveDestroyed: true, isDockStanding: noneUp, enemies: [{ baseId: 'base0' }] };
    const state = baseClearState(noDocks, ctx);
    const m = baseMarkTargets(state, noDocks, ctx);
    expect(m.size).toBe(MARK_SMALL);
    expect(m.enemies).toHaveLength(1);
  });

  it('a null base marks nothing rather than throwing', () => {
    const state = baseClearState(null);
    expect(baseMarkTargets(state, null).docks).toEqual([]);
  });
});

// ── #371 playtest follow-up: where a marker sits on its unit ───────────────────────────────────
// "small objective hexes are not on the right position for the wall turrets". Hex-sitting units
// keep the float that clears their sprite; a wall gun is anchored ON its span (#310 mounts it at
// the span midpoint with TURRET_MOUNT_OFFSET_PX = 0), so a screen-up lift would slide its marker
// off the wall band onto whichever neighbouring hex happens to be upward.
describe('#371 follow-up — enemy marker lift is per-anchor, not one constant', () => {
  it('a hex-sitting unit (tank/drone/mech) keeps the 26px float clear of its sprite', () => {
    expect(enemyMarkLift({ baseId: 'base0', x: 10, y: 20 })).toBe(ENEMY_MARK_LIFT);
    expect(ENEMY_MARK_LIFT).toBeGreaterThan(0);
  });

  it('a WALL GUN gets no lift — its marker sits on the mount its view is anchored to', () => {
    expect(enemyMarkLift({ baseId: 'base0', spanKey: '0,0|1,0', x: 10, y: 20 })).toBe(0);
  });

  it('keys on spanKey, not dockKey — a dock-spawned ground unit is still a hex-sitter', () => {
    expect(enemyMarkLift({ baseId: 'base0', dockKey: '1,0' })).toBe(ENEMY_MARK_LIFT);
  });

  it('tolerates a missing/odd unit rather than throwing', () => {
    expect(enemyMarkLift(null)).toBe(ENEMY_MARK_LIFT);
    expect(enemyMarkLift(undefined)).toBe(ENEMY_MARK_LIFT);
    expect(enemyMarkLift({ spanKey: null })).toBe(ENEMY_MARK_LIFT);
  });
});
