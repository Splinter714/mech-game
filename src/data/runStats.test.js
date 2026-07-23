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
    it('a weapon fired AT cadence accrues ≈ pullIntervalMs of firing time per pull', () => {
      const r = createRunStats();
      const iv = pullIntervalMs(getWeapon('autocannon'));
      // Each voluntary pull lands exactly one cycle after the last — the weapon is busy the
      // whole time — so firing time is shots × cycle.
      r.shotFired('autocannon'); r.tick(iv);
      r.shotFired('autocannon'); r.tick(iv);   // the second (last) shot's own cycle elapses too
      const w = r.reduce().weapons.autocannon;
      expect(w.shotsFired).toBe(2);
      expect(w.firingTimeMs).toBeCloseTo(2 * iv, 5);
    });
    it('a slowly-TAPPED weapon never counts the idle gap beyond a cycle (#423 bug3)', () => {
      const r = createRunStats();
      const iv = pullIntervalMs(getWeapon('autocannon'));
      r.shotFired('autocannon');
      r.tick(iv * 5);            // five cycles of idle before the next voluntary pull
      r.shotFired('autocannon');
      r.tick(iv);               // run ends one cycle after the last shot
      const w = r.reduce().weapons.autocannon;
      // Each shot is "firing/busy" for at most its own cycle — 2×iv total. The 4 idle cycles in
      // the 5-cycle gap are NOT counted (guards against a future "add the whole gap" regression).
      expect(w.firingTimeMs).toBeCloseTo(2 * iv, 5);
    });
    it('a weapon fired FASTER than cadence counts the real gap, not a full cycle each (#423 bug3)', () => {
      // The genuine over-count the old code had: it booked a full pullInterval per shot even when
      // shots came closer together than that (e.g. under Overdrive's cycleMult), so a rapidly-tapped
      // slow weapon showed far more firing time than it was actually busy — tanking Effective Burst DPS.
      const r = createRunStats();
      const iv = pullIntervalMs(getWeapon('autocannon'));
      const gap = iv / 3;       // three shots inside one nominal cycle
      r.shotFired('autocannon'); r.tick(gap);
      r.shotFired('autocannon'); r.tick(gap);
      r.shotFired('autocannon'); r.tick(gap);
      const w = r.reduce().weapons.autocannon;
      // Two interior shots capped at their real gap (iv/3 each) + last shot's own gap-to-run-end
      // (iv/3), = iv total — NOT the old 3×iv over-count.
      expect(w.firingTimeMs).toBeCloseTo(iv, 5);
    });
    it('firing time is capped at the run end for a last shot fired near it', () => {
      const r = createRunStats();
      const iv = pullIntervalMs(getWeapon('autocannon'));
      r.tick(1000);
      r.shotFired('autocannon');
      r.tick(iv / 4);           // run ends only a quarter-cycle after the shot
      expect(r.reduce().weapons.autocannon.firingTimeMs).toBeCloseTo(iv / 4, 5);
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
      const iv = pullIntervalMs(getWeapon('autocannon'));   // one cycle of firing time
      // one pull of autocannon: firing = one full cycle; reload 2000ms; 22 dmg landed
      r.tick(1000, { inCombat: true });   // 1000ms closing in (combat hot via override)
      r.shotFired('autocannon');
      r.shotHit('autocannon', 'drone', 22);
      r.damageDealt({ weaponId: 'autocannon', targetKind: 'drone', amount: 22 });
      r.tick(iv, { inCombat: true });     // the shot's own cycle elapses → firing = iv
      r.reloadStart('autocannon');
      r.reloadEnd('autocannon', 2000);
      const w = r.reduce().weapons.autocannon;
      expect(w.firingTimeMs).toBeCloseTo(iv, 5);
      expect(w.effectiveBurstDps).toBeCloseTo(22 / (iv / 1000), 5);
      expect(w.effectiveSustainedDps).toBeCloseTo(22 / ((iv + 2000) / 1000), 5);
      expect(w.effectiveCombatDps).toBeCloseTo(22 / ((1000 + iv) / 1000), 5);
    });
    it('#440: effective DPS numerator is USEFUL damage (damageDealt - overkill)', () => {
      const r = createRunStats();
      const iv = pullIntervalMs(getWeapon('autocannon'));
      r.tick(1000, { inCombat: true });
      r.shotFired('autocannon');
      r.shotHit('autocannon', 'drone', 30);
      // 30 total damage dealt, but 10 of it was overkill (killing-blow overshoot) — only 20
      // contributed to the kill, so effective DPS should be based on 20, not 30.
      r.damageDealt({ weaponId: 'autocannon', targetKind: 'drone', amount: 30, overkill: 10 });
      r.tick(iv, { inCombat: true });
      r.reloadStart('autocannon');
      r.reloadEnd('autocannon', 2000);
      const w = r.reduce().weapons.autocannon;
      expect(w.damageDealt).toBe(30);
      expect(w.overkill).toBe(10);
      const useful = 20;
      expect(w.effectiveBurstDps).toBeCloseTo(useful / (iv / 1000), 5);
      expect(w.effectiveSustainedDps).toBeCloseTo(useful / ((iv + 2000) / 1000), 5);
      expect(w.effectiveCombatDps).toBeCloseTo(useful / ((1000 + iv) / 1000), 5);
      // Sanity: overkill-heavy weapon's Real DPS is honestly lower than raw-damage DPS would be.
      const rawDamageDps = 30 / ((iv + 2000) / 1000);
      expect(w.effectiveSustainedDps).toBeLessThan(rawDamageDps);
    });
    it('#440: a weapon with zero overkill is unaffected by the useful-damage change', () => {
      const r = createRunStats();
      const iv = pullIntervalMs(getWeapon('autocannon'));
      r.tick(1000, { inCombat: true });
      r.shotFired('autocannon');
      r.shotHit('autocannon', 'drone', 22);
      r.damageDealt({ weaponId: 'autocannon', targetKind: 'drone', amount: 22, overkill: 0 });
      r.tick(iv, { inCombat: true });
      r.reloadStart('autocannon');
      r.reloadEnd('autocannon', 2000);
      const w = r.reduce().weapons.autocannon;
      expect(w.effectiveBurstDps).toBeCloseTo(22 / (iv / 1000), 5);
      expect(w.effectiveSustainedDps).toBeCloseTo(22 / ((iv + 2000) / 1000), 5);
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
    it('#440: spawned-unit damage is cross-attributed to the spawner kind, additively', () => {
      const r = createRunStats();
      // A carrier that deals ZERO direct damage, but whose drones hit the player for 30 + 20.
      r.enemySpawned('carrier');
      r.enemySpawned('droneBrood').enemySpawned('droneBrood');
      r.damageTaken({ enemyKind: 'droneBrood', amount: 30, spawnerKind: 'carrier' });
      r.damageTaken({ enemyKind: 'droneBrood', amount: 20, spawnerKind: 'carrier' });
      const red = r.reduce();
      // The spawner gets a bucket even with 0 direct damage, and its spawnedDamage sums the drones'.
      expect(red.enemies.carrier.damageToYou).toBe(0);
      expect(red.enemies.carrier.threatShare).toBe(0);   // NOT inflated by the spawned damage
      expect(red.enemies.carrier.spawnedDamage).toBe(50);
      // The drone's OWN direct bucket is untouched — this is additive cross-attribution, not a move.
      expect(red.enemies.droneBrood.damageToYou).toBe(50);
      expect(red.enemies.droneBrood.threatShare).toBeCloseTo(1, 5);   // all 50 of totalTaken
      expect(red.enemies.droneBrood.spawnedDamage).toBe(0);
    });
    it('#440: damageTaken accumulates a per-weapon byWeapon breakdown per enemy kind', () => {
      const r = createRunStats();
      r.enemySpawned('turret');
      r.damageTaken({ enemyKind: 'turret', weaponId: 'autocannon', amount: 30 });
      r.damageTaken({ enemyKind: 'turret', weaponId: 'machineGun', amount: 10 });
      r.damageTaken({ enemyKind: 'turret', weaponId: 'autocannon', amount: 20 });
      const e = r.reduce().enemies.turret;
      expect(e.damageToYou).toBe(60);   // parent unchanged
      expect(e.byWeapon.autocannon.damageToYou).toBe(50);
      expect(e.byWeapon.machineGun.damageToYou).toBe(10);
    });
    it('#440: a damageTaken with no weaponId leaves byWeapon empty but still counts damage', () => {
      const r = createRunStats();
      r.enemySpawned('drone');
      r.damageTaken({ enemyKind: 'drone', amount: 12 });
      const e = r.reduce().enemies.drone;
      expect(e.damageToYou).toBe(12);
      expect(Object.keys(e.byWeapon)).toHaveLength(0);
    });
    it('#440: a null spawnerKind (normal unit) never books spawnedDamage', () => {
      const r = createRunStats();
      r.enemySpawned('drone');
      r.damageTaken({ enemyKind: 'drone', amount: 12 });
      const e = r.reduce().enemies.drone;
      expect(e.damageToYou).toBe(12);
      expect(e.spawnedDamage).toBe(0);
    });
    it('a kill with no measurable TTK (null) counts the kill but not the TTK average (#423 bug2)', () => {
      const r = createRunStats();
      r.enemyKill('drone', 2000);   // a fought kill — first hit → death was 2000ms
      r.enemyKill('drone', null);   // crushed / never player-damaged — excluded from the average
      const e = r.reduce().enemies.drone;
      expect(e.killed).toBe(2);          // both still count as kills
      expect(e.avgTtkMs).toBe(2000);     // averaged over the ONE measured sample, not lifetime
    });
    it('enemy accuracy is clamped to [0,1] by construction even if hits somehow exceed shots (#423 bug1)', () => {
      const r = createRunStats();
      r.enemyShotFired('helicopter');
      r.enemyShotHit('helicopter');
      r.enemyShotHit('helicopter');   // a stray double-book — must never push accuracy over 1.0
      expect(r.reduce().enemies.helicopter.weaponAccuracy).toBe(1);
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
