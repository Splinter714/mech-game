import { describe, it, expect } from 'vitest';
import { CHASSIS, CHASSIS_IDS, getChassis, makeChassis } from './index.js';
import { LIGHT_CONFIG } from './light.js';
import { MEDIUM_CONFIG } from './medium.js';
import { HEAVY_CONFIG } from './heavy.js';
import { MEDIUM_PLAYER_CONFIG } from './mediumPlayer.js';

describe('CHASSIS — weight-class movement stats', () => {
  // #299 added 'mediumPlayer' — the PLAYER's own medium-class stat block, separated from the
  // enemy medium the Warden rides (see chassis/mediumPlayer.js). It's a stat variant of
  // 'medium', not a fourth weight class, and shares medium's movement verbatim.
  it('defines the three expected player weight classes', () => {
    expect(CHASSIS_IDS.filter((id) => id !== 'mediumPlayer').sort()).toEqual(['heavy', 'light', 'medium']);
  });

  // #299: the whole-chassis totals are now an exact contract, not "whatever the per-location
  // rounding produced". This is the invariant that lets the balance table be stated as totals.
  it('#299: per-location armor/HP sums EXACTLY to the config totals, for every chassis', () => {
    const CONFIGS = [LIGHT_CONFIG, MEDIUM_CONFIG, HEAVY_CONFIG, MEDIUM_PLAYER_CONFIG];
    for (const cfg of CONFIGS) {
      const locs = Object.values(makeChassis(cfg).locations);
      expect(locs.reduce((s, l) => s + l.maxArmor, 0), `${cfg.id} armor`).toBe(cfg.totalArmor);
      expect(locs.reduce((s, l) => s + l.maxHp, 0), `${cfg.id} hp`).toBe(cfg.totalHp);
    }
  });

  it('#299: handles ODD totals, which the old symmetric per-location rounding could not', () => {
    // Two torsos + two arms rounded independently can only ever sum to an EVEN number, so the
    // owner's 75 / 225 armor figures were literally unreachable before the largest-remainder pass.
    const odd = makeChassis({ ...MEDIUM_CONFIG, totalArmor: 75, totalHp: 101 });
    const locs = Object.values(odd.locations);
    expect(locs.reduce((s, l) => s + l.maxArmor, 0)).toBe(75);
    expect(locs.reduce((s, l) => s + l.maxHp, 0)).toBe(101);
  });

  it('#299: mediumPlayer is a stat variant of medium, not a new weight class', () => {
    expect(CHASSIS.mediumPlayer.weightClass).toBe('medium');
    // #403: the player's step cadence is quicker than the shared medium (its stepInterval was
    // tuned before #159 doubled maxSpeed) — the ONLY movement field allowed to diverge.
    const { stepInterval: pStep, ...pRest } = CHASSIS.mediumPlayer.movement;
    const { stepInterval: mStep, ...mRest } = CHASSIS.medium.movement;
    expect(pRest).toEqual(mRest);
    expect(pStep).toBe(250);
    expect(pStep).toBeLessThan(mStep);
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
