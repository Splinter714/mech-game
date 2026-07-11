import { describe, it, expect } from 'vitest';
import { explosionCategoryFor, deathScaleFor } from './shared.js';

// #107: which discrete destruction-explosion-SOUND category a dying enemy falls into, bucketed
// off `.maxHp` (uniform across Mech/HpBody per #90) — calibrated against the real roster: drone
// 14 hp, turret 90 hp, tank 160 hp, helicopter 70 hp, light mech ≈266 hp, medium mech ≈416 hp,
// heavy mech ≈616 hp (see enemyKinds.js + chassis maxHp comment in data/Mech.js).
function enemyWithHp(hp) {
  return { mech: { maxHp: hp } };
}

describe('explosionCategoryFor (#107 — Weapon Lab destruction-explosion size categories)', () => {
  it('buckets a drone (14 hp) as small', () => {
    expect(explosionCategoryFor(enemyWithHp(14))).toBe('small');
  });

  it('buckets turret (90 hp), tank (160 hp), helicopter (70 hp), and light mech (~266 hp) as medium', () => {
    expect(explosionCategoryFor(enemyWithHp(90))).toBe('medium');
    expect(explosionCategoryFor(enemyWithHp(160))).toBe('medium');
    expect(explosionCategoryFor(enemyWithHp(70))).toBe('medium');
    expect(explosionCategoryFor(enemyWithHp(266))).toBe('medium');
  });

  it('buckets a medium mech (~416 hp) as large', () => {
    expect(explosionCategoryFor(enemyWithHp(416))).toBe('large');
  });

  it('buckets a heavy mech (~616 hp) as massive', () => {
    expect(explosionCategoryFor(enemyWithHp(616))).toBe('massive');
  });

  it('is monotonic across the small/medium/large/massive boundaries', () => {
    const order = ['small', 'medium', 'large', 'massive'];
    const hps = [10, 49, 50, 299, 300, 549, 550, 1000];
    let lastIdx = -1;
    for (const hp of hps) {
      const idx = order.indexOf(explosionCategoryFor(enemyWithHp(hp)));
      expect(idx).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = idx;
    }
  });
});

describe('deathScaleFor (unchanged by #107 — still drives the visual burst size)', () => {
  it('scales with maxHp toughness, drone (14 hp) at the floor and heavy mech (616 hp) at the ceiling', () => {
    expect(deathScaleFor(enemyWithHp(14))).toBeCloseTo(0.5, 5);
    expect(deathScaleFor(enemyWithHp(616))).toBeCloseTo(1.3, 5);
  });

  it('is monotonically increasing with maxHp', () => {
    expect(deathScaleFor(enemyWithHp(90))).toBeGreaterThan(deathScaleFor(enemyWithHp(14)));
    expect(deathScaleFor(enemyWithHp(416))).toBeGreaterThan(deathScaleFor(enemyWithHp(160)));
  });
});
