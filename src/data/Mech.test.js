import { describe, it, expect } from 'vitest';
import { Mech } from './Mech.js';

describe('Mech damage: armor then structure', () => {
  it('depletes armor before structure, no destruction until structure hits 0', () => {
    const m = new Mech({ chassisId: 'light' });
    const ct = m.parts.centerTorso;
    m.applyDamage('centerTorso', ct.maxArmor + 5);
    expect(ct.armor).toBe(0);
    expect(ct.structure).toBe(ct.maxStructure - 5);
    expect(m.isPartDestroyed('centerTorso')).toBe(false);
  });

  it('destroys a part once structure reaches 0', () => {
    const m = new Mech({ chassisId: 'light' });
    const arm = m.parts.leftArm;
    const res = m.applyDamage('leftArm', arm.maxArmor + arm.maxStructure + 10);
    expect(arm.structure).toBe(0);
    expect(res.destroyed).toBe(true);
    expect(m.isPartDestroyed('leftArm')).toBe(true);
  });
});

describe('Mech kill rule', () => {
  const overkill = (m, loc) => m.applyDamage(loc, m.parts[loc].maxArmor + m.parts[loc].maxStructure + 50);

  it('center torso destruction is lethal', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'centerTorso');
    expect(m.isDestroyed()).toBe(true);
  });

  it('head destruction is lethal and takes the cockpit with it', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'head');
    expect(m.isPartDestroyed('cockpit')).toBe(true);
    expect(m.isDestroyed()).toBe(true);
  });

  it('cockpit destruction is lethal on its own', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'cockpit');
    expect(m.isDestroyed()).toBe(true);
  });

  it('one leg is survivable, both legs is lethal', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'leftLeg');
    expect(m.isDestroyed()).toBe(false);
    expect(m.legFactor()).toBe(0.5);
    overkill(m, 'rightLeg');
    expect(m.isDestroyed()).toBe(true);
    expect(m.legFactor()).toBe(0);
  });

  it('losing both arms is NOT lethal', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'leftArm');
    overkill(m, 'rightArm');
    expect(m.isDestroyed()).toBe(false);
  });
});

describe('Mech weapons go offline with their part', () => {
  it('a weapon in a destroyed arm is no longer online', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'mediumLaser');
    expect(m.onlineWeapons()).toHaveLength(1);
    m.applyDamage('leftArm', m.parts.leftArm.maxArmor + m.parts.leftArm.maxStructure + 10);
    expect(m.onlineWeapons()).toHaveLength(0);
    expect(m.weapons()[0].online).toBe(false);
  });
});

describe('Mech serialization', () => {
  it('round-trips chassis, mounts, and battle damage', () => {
    const m = new Mech({ chassisId: 'heavy', name: 'Old Faithful' });
    m.mount('rightArm', 'autocannon');
    m.applyDamage('rightTorso', 10);
    const restored = new Mech(m.toJSON());
    expect(restored.chassisId).toBe('heavy');
    expect(restored.name).toBe('Old Faithful');
    expect(restored.mounts.rightArm).toEqual(['autocannon']);
    expect(restored.parts.rightTorso.armor).toBe(m.parts.rightTorso.armor);
  });
});
