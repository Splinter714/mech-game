import { describe, it, expect } from 'vitest';
import { createRunStats, reduceRun, COMBAT_WINDOW_MS } from './runStats.js';
import { getWeapon } from './weapons.js';
import { burstDps, sustainedDps, pullIntervalMs } from './weaponStats.js';

describe('runStats — accumulator + reducer (#423)', () => {
  it('starts empty', () => {
    const r = createRunStats().reduce();
    expect(r.durationMs).toBe(0);
    expect(r.totalDealt).toBe(0);
    expect(r.accuracy).toBe(0);
    expect(r.weapons).toEqual({});
    expect(r.enemies).toEqual({});
  });

  it('carries meta through', () => {
    const r = createRunStats({ biome: 'ash', chassis: 'medium', loadout: ['autocannon'] }).reduce();
    expect(r.meta).toEqual({ biome: 'ash', chassis: 'medium', loadout: ['autocannon'] });
  });

  describe('time + combat clock', () => {
    it('tick advances duration', () => {
      const r = createRunStats();
      r.tick(100).tick(50);
      expect(r.reduce().durationMs).toBe(150);
    });
    it('ignores non-positive dt', () => {
      const r = createRunStats();
      r.tick(0).tick(-10);
      expect(r.reduce().durationMs).toBe(0);
    });
    it('no combat time accrues with no damage', () => {
      const r = createRunStats();
      r.tick(1000).tick(1000);
      expect(r.reduce().combatTimeMs).toBe(0);
    });
    it('combat is hot for COMBAT_WINDOW_MS after damage (either direction)', () => {
      const r = createRunStats();
      r.damageTaken({ enemyKind: 'drone', amount: 5 });   // stamps damage at clock 0
      r.tick(COMBAT_WINDOW_MS);        // within window → counts
      r.tick(1000);                    // now beyond window → does not count
      expect(r.reduce().combatTimeMs).toBe(COMBAT_WINDOW_MS);
    });
    it('dealing damage also keeps combat hot', () => {
      const r = createRunStats();
      r.damageDealt({ weaponId: 'autocannon', amount: 10 });
      r.tick(500);
      expect(r.reduce().combatTimeMs).toBe(500);
    });
    it('inCombat override forces accrual with no recent damage', () => {
      const r = createRunStats();
      r.tick(200, { inCombat: true });
      expect(r.reduce().combatTimeMs).toBe(200);
    });
  });

  describe('player weapon metrics', () => {
    it('shotFired accrues firing time = pullIntervalMs per pull', () => {
      const r = createRunStats();
      r.shotFired('autocannon').shotFired('autocannon');
      const w = r.reduce().weapons.autocannon;
      expect(w.shotsFired).toBe(2);
      expect(w.firingTimeMs).toBeCloseTo(2 * pullIntervalMs(getWeapon('autocannon')), 5);
    });
    it('accuracy = hits / shots', () => {
      const r = createRunStats();
      r.shotFired('shotgun').shotFired('shotgun').shotFired('shotgun');
      r.shotHit('shotgun', 'drone', 5);
      expect(r.reduce().weapons.shotgun.accuracy).toBeCloseTo(1 / 3, 5);
    });
    it('damageDealt books damage + overkill per weapon and globally', () => {
      const r = createRunStats();
      r.damageDealt({ weaponId: 'autocannon', targetKind: 'drone', amount: 30, overkill: 5 });
      const red = r.reduce();
      expect(red.totalDealt).toBe(30);
      expect(red.weapons.autocannon.damageDealt).toBe(30);
      expect(red.weapons.autocannon.overkill).toBe(5);
    });
    it('reloads + reload time tracked in their own bucket', () => {
      const r = createRunStats();
      r.reloadStart('autocannon');
      r.reloadEnd('autocannon', 2000);
      const w = r.reduce().weapons.autocannon;
      expect(w.reloads).toBe(1);
      expect(w.reloadTimeMs).toBe(2000);
      expect(w.firingTimeMs).toBe(0);   // reload excluded from firing time
    });
    it('theoretical numbers come from weaponStats (shared source of truth)', () => {
      const r = createRunStats();
      r.shotFired('autocannon');
      const w = r.reduce().weapons.autocannon;
      expect(w.theoreticalBurstDps).toBeCloseTo(burstDps(getWeapon('autocannon')), 5);
      expect(w.theoreticalSustainedDps).toBeCloseTo(sustainedDps(getWeapon('autocannon')), 5);
    });
    it('effective DPS variants use the right denominators', () => {
      const r = createRunStats();
      // one pull of autocannon: firing = 1100ms; reload 2000ms; combat 1000ms; 22 dmg landed
      r.tick(1000, { inCombat: true });
      r.shotFired('autocannon');
      r.shotHit('autocannon', 'drone', 22);
      r.damageDealt({ weaponId: 'autocannon', targetKind: 'drone', amount: 22 });
      r.reloadStart('autocannon');
      r.reloadEnd('autocannon', 2000);
      const w = r.reduce().weapons.autocannon;
      expect(w.effectiveBurstDps).toBeCloseTo(22 / (1100 / 1000), 5);
      expect(w.effectiveSustainedDps).toBeCloseTo(22 / ((1100 + 2000) / 1000), 5);
      expect(w.effectiveCombatDps).toBeCloseTo(22 / (1000 / 1000), 5);
    });
    it('landing ratio = effective sustained / theoretical sustained', () => {
      const r = createRunStats();
      r.shotFired('autocannon');
      r.damageDealt({ weaponId: 'autocannon', amount: 24.2 });
      r.reloadEnd('autocannon', 2000);
      const w = r.reduce().weapons.autocannon;
      expect(w.landingRatio).toBeCloseTo(w.effectiveSustainedDps / w.theoreticalSustainedDps, 5);
    });
  });

  describe('global metrics', () => {
    it('overall accuracy aggregates across weapons', () => {
      const r = createRunStats();
      r.shotFired('autocannon').shotFired('shotgun');
      r.shotHit('autocannon', 'drone', 1);
      expect(r.reduce().accuracy).toBeCloseTo(0.5, 5);
    });
    it('deaths / respawns / powerups', () => {
      const r = createRunStats();
      r.death().death().respawn();
      r.powerup('shield').powerup('shield').powerup('overdrive');
      const red = r.reduce();
      expect(red.deaths).toBe(2);
      expect(red.respawns).toBe(1);
      expect(red.powerups).toEqual({ shield: 2, overdrive: 1 });
    });
    it('totalTaken sums damage taken', () => {
      const r = createRunStats();
      r.damageTaken({ enemyKind: 'drone', amount: 3 });
      r.damageTaken({ enemyKind: 'turret', amount: 7 });
      expect(r.reduce().totalTaken).toBe(10);
    });
  });

  describe('enemy metrics (both scopes)', () => {
    it('per-unit: avg TTK, weapon accuracy, effective DPS, effective HP', () => {
      const r = createRunStats();
      r.enemySpawned('drone').enemySpawned('drone');
      r.enemyShotFired('drone').enemyShotFired('drone');
      r.enemyShotHit('drone');
      r.damageTaken({ enemyKind: 'drone', amount: 20 });
      r.enemyEngaged('drone', 4000);
      r.damageDealt({ targetKind: 'drone', amount: 100 });
      r.enemyKill('drone', 3000);
      r.enemyKill('drone', 5000);
      const e = r.reduce().enemies.drone;
      expect(e.avgTtkMs).toBe(4000);            // (3000+5000)/2
      expect(e.weaponAccuracy).toBeCloseTo(0.5, 5);   // 1 hit / 2 shots
      expect(e.effectiveDps).toBeCloseTo(20 / 4, 5);  // 20 dmg / 4s aware
      expect(e.effectiveHp).toBeCloseTo(50, 5);       // 100 dmg / 2 kills
    });
    it('aggregate: counts, damage-to-you, threat share, damage-to-kind + overkill', () => {
      const r = createRunStats();
      r.enemySpawned('drone').enemySpawned('turret');
      r.damageTaken({ enemyKind: 'drone', amount: 30 });
      r.damageTaken({ enemyKind: 'turret', amount: 10 });
      r.damageDealt({ targetKind: 'drone', amount: 80, overkill: 15 });
      r.enemyKill('drone', 2000);
      const red = r.reduce();
      expect(red.enemies.drone.spawned).toBe(1);
      expect(red.enemies.drone.killed).toBe(1);
      expect(red.enemies.drone.damageToYou).toBe(30);
      expect(red.enemies.drone.threatShare).toBeCloseTo(30 / 40, 5);
      expect(red.enemies.drone.damageToKind).toBe(80);
      expect(red.enemies.drone.overkill).toBe(15);
    });
    it('no division-by-zero: unkilled / unengaged kinds report 0', () => {
      const r = createRunStats();
      r.enemySpawned('drone');
      const e = r.reduce().enemies.drone;
      expect(e.avgTtkMs).toBe(0);
      expect(e.effectiveDps).toBe(0);
      expect(e.effectiveHp).toBe(0);
      expect(e.weaponAccuracy).toBe(0);
    });
  });

  it('reduceRun is pure — reduce() twice gives equal output, state untouched', () => {
    const r = createRunStats();
    r.shotFired('autocannon').damageDealt({ weaponId: 'autocannon', amount: 10 });
    expect(r.reduce()).toEqual(r.reduce());
    expect(reduceRun(r.state)).toEqual(r.reduce());
  });
});
