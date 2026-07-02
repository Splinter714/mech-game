import { describe, it, expect } from 'vitest';
import { makeMission, evaluateMission, MISSION_TYPES, DEFAULT_MISSION } from './mission.js';

describe('mission model', () => {
  it('makes an active assault mission with objective text', () => {
    const m = makeMission('assault');
    expect(m.typeId).toBe('assault');
    expect(m.status).toBe('active');
    expect(m.objective).toBe(MISSION_TYPES.assault.objective);
  });

  it('defaults to the default mission type', () => {
    expect(makeMission().typeId).toBe(DEFAULT_MISSION);
  });

  it('throws on an unknown mission type', () => {
    expect(() => makeMission('nope')).toThrow(/unknown mission type/);
  });

  it('assault stays active until the objective is destroyed', () => {
    const m = makeMission('assault');
    expect(evaluateMission(m, { objectiveDestroyed: false })).toBe('active');
    expect(evaluateMission(m, { objectiveDestroyed: true })).toBe('complete');
  });

  it('fails on player death regardless of the objective', () => {
    const m = makeMission('assault');
    expect(evaluateMission(m, { objectiveDestroyed: false, playerDead: true })).toBe('failed');
    // Death takes precedence over an otherwise-complete objective.
    expect(evaluateMission(m, { objectiveDestroyed: true, playerDead: true })).toBe('failed');
  });

  it('a terminal status is sticky', () => {
    const done = { ...makeMission('assault'), status: 'complete' };
    expect(evaluateMission(done, { objectiveDestroyed: false, playerDead: true })).toBe('complete');
    const lost = { ...makeMission('assault'), status: 'failed' };
    expect(evaluateMission(lost, { objectiveDestroyed: true })).toBe('failed');
  });
});
