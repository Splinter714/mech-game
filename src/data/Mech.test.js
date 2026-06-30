import { describe, it, expect, vi } from 'vitest';
import { Mech } from './Mech.js';

// Unlimited-ammo (ammoMax: null) is a generic mechanic — historically exercised by the
// melee category, which has no live entry in the registry anymore. Inject a test-only
// fixture with that shape so the behavior stays covered without reviving a real weapon.
vi.mock('./weapons.js', async (importOriginal) => {
  const actual = await importOriginal();
  const WEAPONS = {
    ...actual.WEAPONS,
    testMelee: {
      id: 'testMelee', name: 'Test Melee', category: 'melee',
      damage: 22, range: { min: 0, opt: 0, max: 32 },
      ammoMax: null, ammoRegen: 0, slots: 2, cycleTime: 1300,
      delivery: { hit: 'contact', pattern: 'single', kind: 'slash' },
    },
  };
  return {
    ...actual,
    WEAPONS,
    WEAPON_IDS: Object.keys(WEAPONS),
    getWeapon: (id) => WEAPONS[id],
  };
});

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

describe('Mech build completeness (deploy gating)', () => {
  it('isComplete only once every skill slot is filled with a legal item', () => {
    const m = new Mech({ chassisId: 'light' });
    expect(m.isComplete()).toBe(false);                 // empty build
    m.mount('leftArm', 'pulseLaser');
    m.mount('rightArm', 'pulseLaser');
    m.mount('leftTorso', 'autocannon');
    m.mount('rightTorso', 'autocannon');
    expect(m.isComplete()).toBe(false);                 // centre torso still empty
    m.mount('centerTorso', 'jumpJet');
    expect(m.isComplete()).toBe(true);                  // all five filled
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

  it('losing both arms is NOT lethal', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'leftArm');
    overkill(m, 'rightArm');
    expect(m.isDestroyed()).toBe(false);
  });
});

describe('Mech damage propagation (cascade)', () => {
  const overkill = (m, loc) => m.applyDamage(loc, m.parts[loc].maxArmor + m.parts[loc].maxStructure + 50);

  it('destroying a side torso also destroys the attached arm', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'leftTorso');
    expect(m.isPartDestroyed('leftTorso')).toBe(true);
    expect(m.isPartDestroyed('leftArm')).toBe(true);
    expect(m.isPartDestroyed('rightArm')).toBe(false);
  });

  it('a weapon in an arm goes offline when its side torso is destroyed', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('rightArm', 'autocannon');
    expect(m.onlineWeapons()).toHaveLength(1);
    overkill(m, 'rightTorso');
    expect(m.onlineWeapons()).toHaveLength(0);
  });

  it('destroying the head still destroys the cockpit (via cascade)', () => {
    const m = new Mech({ chassisId: 'medium' });
    overkill(m, 'head');
    expect(m.isPartDestroyed('cockpit')).toBe(true);
  });
});

describe('Mech weapons go offline with their part', () => {
  it('a weapon in a destroyed arm is no longer online', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'pulseLaser');
    expect(m.onlineWeapons()).toHaveLength(1);
    m.applyDamage('leftArm', m.parts.leftArm.maxArmor + m.parts.leftArm.maxStructure + 10);
    expect(m.onlineWeapons()).toHaveLength(0);
    expect(m.weapons()[0].online).toBe(false);
  });
});

describe('Mech weapon ammo (self-regenerating magazines)', () => {
  it('starts a mounted weapon with a full magazine', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('rightArm', 'autocannon'); // ammoMax 12
    expect(m.weapons()[0].ammo).toBe(12);
    expect(m.weapons()[0].ready).toBe(true);
  });

  it('firing spends ammo and an empty weapon is not ready', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon'); // ammoMax 4
    for (let i = 0; i < 4; i++) m.consumeAmmo('leftArm', 0, 1);
    expect(m.weapons()[0].ammo).toBe(0);
    expect(m.weapons()[0].ready).toBe(false);
    expect(m.readyWeapons()).toHaveLength(0);
  });

  it('regenAmmo refills over time but never past the magazine size', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('leftArm', 'plasmaCannon'); // ammoMax 4, regen 0.5/s
    m.consumeAmmo('leftArm', 0, 4);
    m.regenAmmo(2); // +1.0
    expect(m.weapons()[0].ammo).toBeCloseTo(1, 5);
    m.regenAmmo(100); // would overshoot
    expect(m.weapons()[0].ammo).toBe(4);
  });

  it('melee weapons have unlimited ammo and stay ready', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('rightArm', 'testMelee'); // ammoMax null
    expect(m.weapons()[0].ammo).toBeNull();
    m.consumeAmmo('rightArm', 0, 5); // no-op
    expect(m.weapons()[0].ready).toBe(true);
  });

  it('repairAll tops every magazine back up', () => {
    const m = new Mech({ chassisId: 'medium' });
    m.mount('rightArm', 'autocannon');
    m.consumeAmmo('rightArm', 0, 12);
    expect(m.weapons()[0].ammo).toBe(0);
    m.repairAll();
    expect(m.weapons()[0].ammo).toBe(12);
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
