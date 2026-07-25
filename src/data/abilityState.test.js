import { describe, it, expect } from 'vitest';
import {
  initialAbilityState, canActivate, activateAbility, updateAbilityState,
} from './abilityState.js';

// #506: the generic version of the old dash.test.js coverage — same state machine, now
// parameterized by whatever cooldown/duration an ability config supplies instead of the
// Dash-specific constants.
describe('abilityState — single-shot burst + cooldown state machine', () => {
  const CFG = { cooldown: 4, duration: 0.25 };

  it('starts inactive, no burst, ready immediately', () => {
    const s = initialAbilityState();
    expect(s).toEqual({ active: false, burstRemaining: 0, cooldown: 0 });
    expect(canActivate(s)).toBe(true);
  });

  it('activates the burst and stamps the cooldown when ready', () => {
    const s = activateAbility(initialAbilityState(), CFG);
    expect(s.active).toBe(true);
    expect(s.burstRemaining).toBe(CFG.duration);
    expect(s.cooldown).toBe(CFG.cooldown);
  });

  it('is a no-op (returns the SAME state) while mid-burst or on cooldown', () => {
    const active = { active: true, burstRemaining: 0.1, cooldown: 3 };
    expect(activateAbility(active, CFG)).toBe(active);

    const cooling = { active: false, burstRemaining: 0, cooldown: 2.5 };
    expect(activateAbility(cooling, CFG)).toBe(cooling);
  });

  it('counts the burst down then the cooldown, never going negative', () => {
    let s = activateAbility(initialAbilityState(), CFG);
    s = updateAbilityState(s, CFG.duration / 2);
    expect(s.active).toBe(true);
    expect(s.burstRemaining).toBeCloseTo(CFG.duration / 2, 5);

    s = updateAbilityState(s, 1000);
    expect(s.active).toBe(false);
    expect(s.burstRemaining).toBe(0);
    expect(s.cooldown).toBe(0);
  });

  it('cannot be re-triggered until the cooldown fully elapses, then can', () => {
    let s = activateAbility(initialAbilityState(), CFG);
    s = updateAbilityState(s, CFG.cooldown - 0.01);
    expect(canActivate(s)).toBe(false);
    expect(activateAbility(s, CFG)).toBe(s);

    s = updateAbilityState(s, 0.02);
    expect(canActivate(s)).toBe(true);
    expect(activateAbility(s, CFG).active).toBe(true);
  });
});
