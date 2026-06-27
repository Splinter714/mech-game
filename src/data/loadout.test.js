import { describe, it, expect } from 'vitest';
import { getChassis } from './chassis/index.js';
import { validateLoadout, canMount, freeSlots, usedSlots } from './loadout.js';

const light = getChassis('light');

describe('loadout validation', () => {
  it('accepts a within-capacity build and reports per-location slot usage', () => {
    const mounts = { leftArm: ['mediumLaser'], rightArm: ['srm'] }; // 1 + 1 slots
    const v = validateLoadout(light, mounts);
    expect(v.ok).toBe(true);
    expect(v.slotUsage.leftArm).toEqual({ used: 1, cap: 2 });
    expect(usedSlots(mounts, 'leftArm')).toBe(1);
  });

  it('rejects a build that overfills a location\'s slots', () => {
    // Light arm = 2 slots; three autocannons (2 slots each) = 6 > 2.
    const mounts = { leftArm: ['autocannon', 'autocannon', 'autocannon'] };
    const v = validateLoadout(light, mounts);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('leftArm'))).toBe(true);
  });
});

describe('canMount constraints', () => {
  it('blocks a mount that would exceed a location\'s slots', () => {
    const mounts = { head: ['mediumLaser'] }; // light head = 1 slot, now full
    const res = canMount(light, mounts, 'head', 'mediumLaser');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/slot/);
  });

  it('reports remaining free slots and blocks an over-capacity mount', () => {
    const mounts = { rightArm: ['autocannon'] }; // 2-slot item fills the 2-slot arm
    expect(freeSlots(light, mounts, 'rightArm')).toBe(0);
    const res = canMount(light, mounts, 'rightArm', 'machineGun');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/slot/);
  });

  it('blocks mounting into a non-mount location (the cockpit)', () => {
    const res = canMount(light, {}, 'cockpit', 'mediumLaser');
    expect(res.ok).toBe(false);
  });
});
