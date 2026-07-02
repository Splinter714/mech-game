import { describe, it, expect } from 'vitest';
import { ENEMY_KINDS, ENEMY_KIND_IDS, SWARM_SIZE, isEnemyKind } from './enemyKinds.js';
import { getWeapon } from './weapons.js';
import { HpBody } from './HpBody.js';

describe('ENEMY_KINDS — non-mech enemy data', () => {
  it('defines the four expected kinds', () => {
    expect(ENEMY_KIND_IDS.sort()).toEqual(['drone', 'helicopter', 'tank', 'turret']);
  });

  it('every kind names a REAL weapon id (so no scene ever hardcodes one)', () => {
    for (const id of ENEMY_KIND_IDS) {
      const k = ENEMY_KINDS[id];
      expect(getWeapon(k.weaponId), `${id} weapon ${k.weaponId}`).toBeTruthy();
    }
  });

  it('every kind is buildable into a valid HpBody with a part layout', () => {
    for (const id of ENEMY_KIND_IDS) {
      const k = ENEMY_KINDS[id];
      const body = new HpBody(k);
      expect(body.hp).toBe(k.hp);
      expect(body.locations().length).toBeGreaterThan(0);
      expect(body.isDestroyed()).toBe(false);
      // Damaging any part draws down the pool.
      const loc = body.locations()[0];
      body.applyDamage(loc, k.hp + 1);
      expect(body.isDestroyed()).toBe(true);
    }
  });

  it('marks turret static and the flyers as flying (ignore ground cover)', () => {
    expect(ENEMY_KINDS.turret.move.maxSpeed).toBe(0);
    expect(ENEMY_KINDS.turret.flying).toBe(false);
    expect(ENEMY_KINDS.tank.flying).toBe(false);
    expect(ENEMY_KINDS.drone.flying).toBe(true);
    expect(ENEMY_KINDS.helicopter.flying).toBe(true);
  });

  it('each kind wires an art + behavior registry key', () => {
    for (const id of ENEMY_KIND_IDS) {
      expect(typeof ENEMY_KINDS[id].art).toBe('string');
      expect(typeof ENEMY_KINDS[id].behavior).toBe('string');
    }
  });

  it('isEnemyKind distinguishes kinds from mech loadouts', () => {
    expect(isEnemyKind('tank')).toBe(true);
    expect(isEnemyKind('helicopter')).toBe(true);
    expect(isEnemyKind('raider')).toBe(false);   // a mech loadout
    expect(isEnemyKind('nope')).toBe(false);
  });

  it('SWARM_SIZE is a small positive count', () => {
    expect(SWARM_SIZE).toBeGreaterThan(1);
    expect(SWARM_SIZE).toBeLessThan(12);
  });
});
