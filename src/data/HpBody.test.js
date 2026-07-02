import { describe, it, expect } from 'vitest';
import { HpBody } from './HpBody.js';

describe('HpBody — single-pool damageable body for non-mech enemies', () => {
  const def = {
    name: 'Test Tank',
    hp: 100,
    parts: {
      hull: { x: 0, y: 4, w: 24, h: 20 },
      turret: { x: 0, y: -6, w: 16, h: 14 },
    },
  };

  it('starts at full health and is not destroyed', () => {
    const b = new HpBody(def);
    expect(b.isDestroyed()).toBe(false);
    expect(b.partHealthFraction('hull')).toBe(1);
    expect(b.partHealthFraction('turret')).toBe(1);
    expect(b.name).toBe('Test Tank');
  });

  it('exposes its layout as .parts and .locations() for the arena hit-mapper', () => {
    const b = new HpBody(def);
    expect(Object.keys(b.parts).sort()).toEqual(['hull', 'turret']);
    expect(b.locations().sort()).toEqual(['hull', 'turret']);
    // Each part carries the layout geometry so art + hit mapping line up.
    expect(b.parts.hull.x).toBe(0);
    expect(b.parts.turret.y).toBe(-6);
  });

  it('any hit chips the SHARED pool — hitting different parts still draws down one total', () => {
    const b = new HpBody(def);
    b.applyDamage('hull', 30);
    expect(b.partHealthFraction('turret')).toBeCloseTo(0.7);   // one pool: turret reads the same
    b.applyDamage('turret', 30);
    expect(b.partHealthFraction('hull')).toBeCloseTo(0.4);
    expect(b.isDestroyed()).toBe(false);
  });

  it('zeroing the pool destroys the unit and reports it on the killing hit', () => {
    const b = new HpBody(def);
    const r1 = b.applyDamage('hull', 60);
    expect(r1.destroyed).toBe(false);
    const r2 = b.applyDamage('hull', 60);   // overkill past 100
    expect(r2.destroyed).toBe(true);
    expect(b.isDestroyed()).toBe(true);
    expect(b.partHealthFraction('hull')).toBe(0);
  });

  it('a hit on an already-dead body does not re-report destruction', () => {
    const b = new HpBody(def);
    b.applyDamage('hull', 999);
    const again = b.applyDamage('hull', 10);
    expect(again.destroyed).toBe(false);
    expect(again.applied).toBe(0);
  });

  it('applyDamage returns a Mech-shaped result the combat feedback code can read', () => {
    const b = new HpBody(def);
    const r = b.applyDamage('hull', 10);
    expect(r).toMatchObject({ applied: 10, destroyed: false, location: 'hull' });
    expect(r).toHaveProperty('partDestroyedNow');
  });

  it('repairAll restores a destroyed body to full', () => {
    const b = new HpBody(def);
    b.applyDamage('hull', 999);
    expect(b.isDestroyed()).toBe(true);
    b.repairAll();
    expect(b.isDestroyed()).toBe(false);
    expect(b.partHealthFraction('hull')).toBe(1);
  });

  it('non-negative / zero damage is a no-op', () => {
    const b = new HpBody(def);
    b.applyDamage('hull', 0);
    b.applyDamage('hull', -5);
    expect(b.partHealthFraction('hull')).toBe(1);
  });

  it('exposes empty weapon/ability queries so it is drop-in wherever a Mech is poked', () => {
    const b = new HpBody(def);
    expect(b.weapons()).toEqual([]);
    expect(b.readyWeapons()).toEqual([]);
    expect(b.onlineWeapons()).toEqual([]);
    expect(b.abilities()).toEqual([]);
    expect(() => b.regenAmmo(0.016)).not.toThrow();
  });

  it('defaults sensibly with no def', () => {
    const b = new HpBody();
    expect(b.maxHp).toBeGreaterThan(0);
    expect(b.isDestroyed()).toBe(false);
    expect(b.locations().length).toBeGreaterThan(0);
  });
});
