// #371/#384: the objective indicator spreads to everything still required. #384 marks the
// objective AND every dock AT ONCE from the start (phase 1, any order), then little markers on
// remaining enemies (phase 2). The merge gate is that this set is a PROJECTION of #356's
// `baseClearState`, never a parallel rule: it must agree with `baseClearLabel` at every step, and
// it must pick up late spawns.
import { describe, it, expect } from 'vitest';
import {
  baseClearState, baseClearLabel, baseMarkTargets, enemyMarkLift, ENEMY_MARK_LIFT,
  MARK_STRUCTURES, MARK_SMALL,
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

describe('#384 objective marker targets — objective + docks marked at once', () => {
  it('phase 1, objective alive + docks up: the objective beacon AND every dock, together', () => {
    const m = marks({ isDockStanding: allUp, enemies: [{ baseId: 'base0' }, { baseId: 'base0' }] });
    expect(m.size).toBe(MARK_STRUCTURES);
    expect(m.showObjective).toBe(true);
    expect(m.docks).toEqual(D);
    expect(m.enemies).toEqual([]);
  });

  it('phase 1, objective DOWN but docks remain: beacon drops, dock markers stay', () => {
    const m = marks({ objectiveDestroyed: true, isDockStanding: allUp, enemies: [{ baseId: 'base0' }] });
    expect(m.size).toBe(MARK_STRUCTURES);
    expect(m.showObjective).toBe(false);
    expect(m.docks).toEqual(D);
    expect(m.enemies).toEqual([]);
  });

  it('phase 1, dock DOWN but objective stands: beacon stays, only standing docks marked', () => {
    const m = marks({ objectiveDestroyed: false, isDockStanding: oneUp });
    expect(m.size).toBe(MARK_STRUCTURES);
    expect(m.showObjective).toBe(true);
    expect(m.docks).toEqual([{ q: 2, r: 0 }]);
  });

  it('a destroyed dock loses its marker', () => {
    const m = marks({ objectiveDestroyed: true, isDockStanding: oneUp });
    expect(m.docks).toEqual([{ q: 2, r: 0 }]);
  });

  it('phase 2 — structures cleared: little markers on every remaining enemy of this base', () => {
    const enemies = [{ baseId: 'base0' }, { baseId: 'base0' }, { baseId: 'other' }];
    const m = marks({ objectiveDestroyed: true, enemies });
    expect(m.size).toBe(MARK_SMALL);
    expect(m.showObjective).toBe(false);
    expect(m.docks).toEqual([]);
    expect(m.enemies).toHaveLength(2);
    expect(m.enemies.every((e) => e.baseId === 'base0')).toBe(true);
  });

  it('base clear: nothing is marked', () => {
    const m = marks({ objectiveDestroyed: true });
    expect(m.size).toBe(null);
    expect(m.docks).toEqual([]);
    expect(m.enemies).toEqual([]);
  });

  it('never marks an enemy while a structure still stands (the #356 "never show the 7" discipline)', () => {
    const enemies = Array.from({ length: 7 }, () => ({ baseId: 'base0' }));
    // A standing dock (objective already down) still holds the enemy markers back.
    const m = marks({ objectiveDestroyed: true, isDockStanding: allUp, enemies });
    expect(m.enemies).toEqual([]);
    expect(baseClearLabel(m.state)).toMatch(/DESTROY \d+ STRUCTURE/);
    expect(baseClearLabel(m.state)).not.toMatch(/7/);
    // …and so does a standing objective (docks already down).
    const n = marks({ objectiveDestroyed: false, isDockStanding: noneUp, enemies });
    expect(n.enemies).toEqual([]);
  });

  it('agrees with baseClearState counts at every step', () => {
    const enemies = [{ baseId: 'base0' }, { baseId: 'base0' }];
    const structuresStep = marks({ objectiveDestroyed: true, isDockStanding: allUp, enemies });
    expect(structuresStep.docks).toHaveLength(structuresStep.state.docksLeft);
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

  it('a base with no docks marks just the objective, then enemies', () => {
    const noDocks = { id: 'base0', docks: [] };
    // Objective standing: beacon only, no dock markers.
    const up = baseClearState(noDocks, { objectiveDestroyed: false, isDockStanding: noneUp, enemies: [] });
    const upMarks = baseMarkTargets(up, noDocks, { isDockStanding: noneUp, enemies: [] });
    expect(upMarks.size).toBe(MARK_STRUCTURES);
    expect(upMarks.showObjective).toBe(true);
    expect(upMarks.docks).toEqual([]);
    // Objective down: straight to enemy markers.
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

  // #391: leftover turrets aren't required kills, so they get no clear marker either — the marker
  // set stays a projection of the (now mobility-aware) `baseClearState` count.
  it('marks only MOBILE stragglers in phase 2 — a rooted turret gets no marker', () => {
    const mobile = { baseId: 'base0', kindDef: { move: { maxSpeed: 150 } } };
    const turret = { baseId: 'base0', kindDef: { move: { maxSpeed: 0 } } };
    const enemies = [mobile, turret, turret];
    const m = marks({ objectiveDestroyed: true, enemies });
    expect(m.size).toBe(MARK_SMALL);
    expect(m.enemies).toEqual([mobile]);
    expect(m.enemies).toHaveLength(m.state.enemiesLeft);
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
