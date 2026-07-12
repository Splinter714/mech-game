import { describe, it, expect } from 'vitest';
import { CHASSIS, CHASSIS_IDS, getChassis, makeChassis } from './index.js';
import { LIGHT_CONFIG } from './light.js';
import { MEDIUM_CONFIG } from './medium.js';
import { HEAVY_CONFIG } from './heavy.js';

describe('CHASSIS — weight-class movement stats', () => {
  it('defines the three expected weight classes', () => {
    expect(CHASSIS_IDS.sort()).toEqual(['heavy', 'light', 'medium']);
  });

  it('#159: heavy maxSpeed now matches light\'s OLD (pre-#159) maxSpeed of 135', () => {
    expect(CHASSIS.heavy.movement.maxSpeed).toBe(135);
  });

  it('#159: light maxSpeed is significantly higher than 135 (its own old value)', () => {
    expect(CHASSIS.light.movement.maxSpeed).toBeGreaterThan(135);
  });

  it('#159: relative ordering is preserved — light > medium > heavy', () => {
    expect(CHASSIS.light.movement.maxSpeed).toBeGreaterThan(CHASSIS.medium.movement.maxSpeed);
    expect(CHASSIS.medium.movement.maxSpeed).toBeGreaterThan(CHASSIS.heavy.movement.maxSpeed);
  });

  it('#159: medium lands strictly between the new heavy and light maxSpeed values', () => {
    expect(CHASSIS.medium.movement.maxSpeed).toBeGreaterThan(CHASSIS.heavy.movement.maxSpeed);
    expect(CHASSIS.medium.movement.maxSpeed).toBeLessThan(CHASSIS.light.movement.maxSpeed);
  });

  it('#159: the three speeds were scaled up by roughly the same factor, preserving relative spacing', () => {
    // Old spread: light 135, medium 98, heavy 68.
    const oldLight = 135, oldMedium = 98, oldHeavy = 68;
    const scale = CHASSIS.heavy.movement.maxSpeed / oldHeavy;
    expect(CHASSIS.light.movement.maxSpeed).toBeCloseTo(oldLight * scale, 0);
    expect(CHASSIS.medium.movement.maxSpeed).toBeCloseTo(oldMedium * scale, 0);
  });

  it('makeChassis passes maxSpeed (and the rest of movement) straight through from config', () => {
    for (const cfg of [LIGHT_CONFIG, MEDIUM_CONFIG, HEAVY_CONFIG]) {
      const built = makeChassis(cfg);
      expect(built.movement.maxSpeed).toBe(cfg.movement.maxSpeed);
      expect(built.movement.accel).toBe(cfg.movement.accel);
      expect(built.movement.decel).toBe(cfg.movement.decel ?? cfg.movement.accel);
      expect(built.movement.turnRate).toBe(cfg.movement.turnRate);
    }
  });

  it('getChassis returns the matching built chassis by id, defaulting to medium', () => {
    expect(getChassis('light').movement.maxSpeed).toBe(CHASSIS.light.movement.maxSpeed);
    expect(getChassis('heavy').movement.maxSpeed).toBe(CHASSIS.heavy.movement.maxSpeed);
    expect(getChassis('nonexistent').movement.maxSpeed).toBe(CHASSIS.medium.movement.maxSpeed);
  });
});
