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

// #246: layered HpBody — a non-mech kind can be configured as HP-only (the pre-#246 default,
// unchanged), HP+armor, HP+shield, or all three, purely via `def.armor`/`def.shield`. Mirrors
// the combinations enemyKinds.js actually exercises (turret/drone/infantry HP-only, tank/carrier
// HP+armor, helicopter HP+shield — #436 moved the carrier off "all three" onto HP+armor) with
// minimal fixtures so this file covers the layering math independent of the real roster's tuning.
describe('HpBody layered defense (#246: HP-only / HP+armor / HP+shield / all three)', () => {
  const layout = { core: { x: 0, y: 0, w: 20, h: 20 } };

  it('HP-only (no armor, no shield config) behaves exactly as before #246', () => {
    const b = new HpBody({ hp: 50, parts: layout });
    expect(b.hasShield()).toBe(false);
    const res = b.applyDamage('core', 20);
    expect(res.shielded).toBe(false);
    expect(res.applied).toBe(20);
    expect(b.hp).toBe(30);
  });

  it('HP+armor: armor absorbs before hp, and destruction still tracks hp only', () => {
    const b = new HpBody({ hp: 50, armor: 20, parts: layout });
    expect(b.armor).toBe(20);
    const r1 = b.applyDamage('core', 15);
    expect(r1.applied).toBe(15);
    expect(b.armor).toBe(5);
    expect(b.hp).toBe(50);           // hp untouched — armor absorbed it all
    const r2 = b.applyDamage('core', 15);
    expect(b.armor).toBe(0);
    expect(b.hp).toBe(40);           // 5 armor left absorbed, 10 overflowed to hp
    expect(r2.armorBrokeNow).toBe(true);
    expect(b.isDestroyed()).toBe(false);
  });

  it('HP+shield: the shield absorbs first, in front of hp (no armor at all)', () => {
    const b = new HpBody({ hp: 50, shield: { max: 30 }, parts: layout });
    expect(b.hasShield()).toBe(true);
    const r1 = b.applyDamage('core', 20);
    expect(r1.shielded).toBe(true);
    expect(r1.shieldAbsorbed).toBe(20);
    expect(b.hp).toBe(50);
    expect(b.shield.hp).toBe(10);
    const r2 = b.applyDamage('core', 25);   // breaks the remaining 10, 15 overflows to hp
    expect(r2.shieldAbsorbed).toBe(10);
    expect(r2.applied).toBe(15);
    expect(b.hp).toBe(35);
  });

  it('all three layers: shield -> armor -> hp, in that order, on a single big hit', () => {
    const b = new HpBody({
      hp: 50, armor: 20, shield: { max: 30 }, parts: layout,
    });
    const res = b.applyDamage('core', 70);   // 30 shield + 20 armor + 20 hp
    expect(res.shieldAbsorbed).toBe(30);
    expect(b.armor).toBe(0);
    expect(b.hp).toBe(30);
    expect(res.destroyed).toBe(false);
  });

  it('tickShield regens the unit-wide shield passively, same brief-pause behavior as Mech', () => {
    const b = new HpBody({ hp: 50, shield: { max: 30 }, parts: layout });   // #382: shared 3000ms pause, 7.5/s regen (25% of 30)
    b.applyDamage('core', 10);       // shield -> 20, pause starts at the shared 3000ms
    b.tickShield(3);                 // pause clears exactly here, no regen yet
    expect(b.shield.hp).toBe(20);
    b.tickShield(1);                 // +7.5
    expect(b.shield.hp).toBe(27.5);
  });

  it('repairAll restores hp, armor, and shield all together', () => {
    const b = new HpBody({ hp: 50, armor: 20, shield: { max: 30 }, parts: layout });
    b.applyDamage('core', 90);
    b.repairAll();
    expect(b.hp).toBe(50);
    expect(b.armor).toBe(20);
    expect(b.shield.hp).toBe(30);
    expect(b.isDestroyed()).toBe(false);
  });
});
