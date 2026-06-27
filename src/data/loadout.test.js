import { describe, it, expect } from 'vitest';
import { getChassis } from './chassis/index.js';
import { validateLoadout, canMount, freeSlots, usedSlots } from './loadout.js';

const light = getChassis('light');

describe('loadout validation (six skill slots, one item each)', () => {
  it('accepts a build with one weapon per weapon slot', () => {
    const mounts = { leftArm: ['mediumLaser'], rightArm: ['autocannon'], leftTorso: ['srm'] };
    const v = validateLoadout(light, mounts);
    expect(v.ok).toBe(true);
    expect(v.slotUsage.leftArm).toEqual({ used: 1, cap: 1 });
    expect(usedSlots(mounts, 'rightArm')).toBe(1);
  });

  it('rejects a location holding more than one item', () => {
    const mounts = { leftArm: ['mediumLaser', 'autocannon'] };
    const v = validateLoadout(light, mounts);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('leftArm'))).toBe(true);
  });
});

describe('canMount constraints', () => {
  it('blocks mounting into an already-occupied slot', () => {
    const mounts = { rightArm: ['autocannon'] };
    expect(freeSlots(light, mounts, 'rightArm')).toBe(0);
    const res = canMount(light, mounts, 'rightArm', 'mediumLaser');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/occupied/);
  });

  it('blocks a melee weapon outside the arms, allows it in an arm', () => {
    expect(canMount(light, {}, 'leftTorso', 'hatchet').ok).toBe(false); // side torso is a weapon slot, but melee needs an arm
    expect(canMount(light, {}, 'leftArm', 'hatchet').ok).toBe(true);
  });

  it('blocks a weapon in an ability slot (head / centre torso)', () => {
    expect(canMount(light, {}, 'head', 'mediumLaser').ok).toBe(false);
    expect(canMount(light, {}, 'centerTorso', 'autocannon').ok).toBe(false);
  });

  it('blocks mounting into a non-skill location (cockpit, legs)', () => {
    expect(canMount(light, {}, 'cockpit', 'mediumLaser').ok).toBe(false);
    expect(canMount(light, {}, 'leftLeg', 'mediumLaser').ok).toBe(false);
  });

  it('allows a normal mount into an empty arm', () => {
    expect(canMount(light, {}, 'rightArm', 'autocannon').ok).toBe(true);
  });
});
