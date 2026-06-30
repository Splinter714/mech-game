import { describe, it, expect, vi } from 'vitest';
import { getChassis } from './chassis/index.js';

// The melee category currently has no live weapon in the registry (the Cleaver was
// removed as unsatisfying), but the "melee only mounts in an arm" rule is generic
// infrastructure that should stay covered. Inject a test-only melee item so canMount's
// item lookup resolves it without reviving a real weapon in weapons.js.
vi.mock('./items.js', async (importOriginal) => {
  const actual = await importOriginal();
  const testMeleeItem = {
    id: 'testMelee', name: 'Test Melee', category: 'melee', slots: 2,
  };
  return {
    ...actual,
    getItem: (id) => (id === 'testMelee' ? testMeleeItem : actual.getItem(id)),
    isWeapon: (id) => (id === 'testMelee' ? true : actual.isWeapon(id)),
  };
});

const { validateLoadout, canMount, freeSlots, usedSlots } = await import('./loadout.js');

const light = getChassis('light');

describe('loadout validation (six skill slots, one item each)', () => {
  it('accepts a build with one weapon per weapon slot', () => {
    const mounts = { leftArm: ['pulseLaser'], rightArm: ['autocannon'], leftTorso: ['clusterRocket'] };
    const v = validateLoadout(light, mounts);
    expect(v.ok).toBe(true);
    expect(v.slotUsage.leftArm).toEqual({ used: 1, cap: 1 });
    expect(usedSlots(mounts, 'rightArm')).toBe(1);
  });

  it('rejects a location holding more than one item', () => {
    const mounts = { leftArm: ['pulseLaser', 'autocannon'] };
    const v = validateLoadout(light, mounts);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('leftArm'))).toBe(true);
  });
});

describe('canMount constraints', () => {
  it('blocks mounting into an already-occupied slot', () => {
    const mounts = { rightArm: ['autocannon'] };
    expect(freeSlots(light, mounts, 'rightArm')).toBe(0);
    const res = canMount(light, mounts, 'rightArm', 'pulseLaser');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/occupied/);
  });

  it('blocks a melee weapon outside the arms, allows it in an arm', () => {
    expect(canMount(light, {}, 'leftTorso', 'testMelee').ok).toBe(false); // side torso is a weapon slot, but melee needs an arm
    expect(canMount(light, {}, 'leftArm', 'testMelee').ok).toBe(true);
  });

  it('blocks a weapon in an ability slot (head / centre torso)', () => {
    expect(canMount(light, {}, 'head', 'pulseLaser').ok).toBe(false);
    expect(canMount(light, {}, 'centerTorso', 'autocannon').ok).toBe(false);
  });

  it('blocks mounting into a non-skill location (the cockpit)', () => {
    expect(canMount(light, {}, 'cockpit', 'pulseLaser').ok).toBe(false);
  });

  it('allows a normal mount into an empty arm', () => {
    expect(canMount(light, {}, 'rightArm', 'autocannon').ok).toBe(true);
  });
});
