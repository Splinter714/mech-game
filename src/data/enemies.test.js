import { describe, it, expect } from 'vitest';
import { Mech } from './Mech.js';
import * as enemiesModule from './enemies.js';
import { ENEMIES, ENEMY_ROTATION, MECH_CHASSIS_IDS } from './enemies.js';
import { CHASSIS_IDS } from './chassis/index.js';
import { ENEMY_KINDS } from './enemyKinds.js';

// #474: the four hand-written archetypes (Raider/Stalker/Warden/Mortarhead) are RETIRED. Enemy
// mechs are now exactly the three chassis weight classes, each appearing equally, and each rolls
// its own four-weapon loadout per spawn (data/enemyLoadout.js) rather than carrying a fixed one.
// The old artillery/all-indirect guarantee moved to enemyLoadout.test.js (a heavy roll CAN come up
// all-indirect), since there is no longer a hand-written Mortarhead entry to pin.

describe('ENEMIES — the three chassis (retired archetypes, #474)', () => {
  it('defines exactly the three chassis weight classes as enemy mechs', () => {
    expect(Object.keys(ENEMIES).sort()).toEqual(['heavy', 'light', 'medium']);
    expect([...MECH_CHASSIS_IDS].sort()).toEqual(['heavy', 'light', 'medium']);
  });

  it('each entry keys onto its own real chassis weight class', () => {
    expect(ENEMIES.light.chassisId).toBe('light');
    expect(ENEMIES.medium.chassisId).toBe('medium');
    expect(ENEMIES.heavy.chassisId).toBe('heavy');
    for (const [id, def] of Object.entries(ENEMIES)) {
      expect(CHASSIS_IDS, `${id}.chassisId`).toContain(def.chassisId);
    }
  });

  it('all three chassis weight classes are represented (none doubled up)', () => {
    const used = Object.values(ENEMIES).map((def) => def.chassisId).sort();
    expect(used).toEqual(['heavy', 'light', 'medium']);
  });

  it('carries NO fixed mounts — the loadout is rolled per spawn (#474)', () => {
    for (const def of Object.values(ENEMIES)) {
      expect(def.mounts).toBeUndefined();
    }
  });

  it('keeps the shield pools keyed to weight class (light 25 / medium 50 / heavy 75)', () => {
    expect(ENEMIES.light.shield.max).toBe(25);
    expect(ENEMIES.medium.shield.max).toBe(50);
    expect(ENEMIES.heavy.shield.max).toBe(75);
  });

  it('builds a valid, weaponless Mech straight from a static def (mounts come at spawn)', () => {
    for (const id of Object.keys(ENEMIES)) {
      const mech = new Mech(ENEMIES[id]);
      expect(mech.onlineWeapons()).toHaveLength(0);
      expect(mech.toughness).toBeGreaterThan(0);
    }
  });

  it('ENEMY_ROTATION references only real ENEMIES chassis ids or real ENEMY_KINDS ids', () => {
    for (const id of ENEMY_ROTATION) {
      const known = Boolean(ENEMIES[id]) || Boolean(ENEMY_KINDS[id])
        || id === 'swarm' || id === 'infantryMob';
      expect(known, id).toBe(true);
    }
  });

  it('ENEMY_ROTATION includes all three chassis, each once (equal debug-cycle weight)', () => {
    for (const id of ['light', 'medium', 'heavy']) {
      expect(ENEMY_ROTATION.filter((x) => x === id)).toHaveLength(1);
    }
  });

  // #344: `DEFAULT_SQUAD` was documented as retired in two files while still being exported AND
  // still wired as `_spawnSquad`'s default argument. Guard the deletion so a future edit can't
  // quietly reintroduce a second, unreachable opening-difficulty table.
  it('DEFAULT_SQUAD is gone (#344 — dead opening-squad table, no call sites)', () => {
    expect(enemiesModule.DEFAULT_SQUAD).toBeUndefined();
  });
});
