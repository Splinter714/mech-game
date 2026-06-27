import { describe, it, expect } from 'vitest';
import { getChassis } from './chassis/index.js';
import { validateLoadout, canMount, freeTonnage } from './loadout.js';

const light = getChassis('light');

describe('loadout validation', () => {
  it('accepts a within-budget build and reports free tonnage', () => {
    const mounts = { leftArm: ['mediumLaser'], rightArm: ['srm'] }; // 2t + 3t
    const v = validateLoadout(light, mounts);
    expect(v.ok).toBe(true);
    expect(v.usedTonnage).toBe(5);
    expect(v.freeTonnage).toBe(light.maxTonnage - 5);
  });

  it('rejects an over-tonnage build', () => {
    const mounts = { centerTorso: ['autocannon', 'autocannon', 'autocannon', 'autocannon', 'autocannon', 'autocannon'] }; // 42t > 35t
    const v = validateLoadout(light, mounts);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('tonnage'))).toBe(true);
  });
});

describe('canMount constraints', () => {
  it('blocks a mount that would exceed a location\'s slots', () => {
    const mounts = { head: ['mediumLaser'] }; // light head = 1 slot, now full
    const res = canMount(light, mounts, 'head', 'mediumLaser');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/slot/);
  });

  it('blocks a mount that would exceed the tonnage budget', () => {
    // Five autocannons = 35t = the full light budget.
    const mounts = {
      leftTorso: ['autocannon'], rightTorso: ['autocannon'],
      leftArm: ['autocannon'], rightArm: ['autocannon'], centerTorso: ['autocannon'],
    };
    expect(freeTonnage(light, mounts)).toBe(0);
    const res = canMount(light, mounts, 'head', 'mediumLaser');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/tonnage/);
  });

  it('blocks mounting into a non-mount location (the cockpit)', () => {
    const res = canMount(light, {}, 'cockpit', 'mediumLaser');
    expect(res.ok).toBe(false);
  });
});
