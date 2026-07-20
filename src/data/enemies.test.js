import { describe, it, expect } from 'vitest';
import { Mech } from './Mech.js';
import * as enemiesModule from './enemies.js';
import { ENEMIES, ENEMY_ROTATION } from './enemies.js';
import { CHASSIS_IDS } from './chassis/index.js';

// #272: artillery/Mortarhead is meant to be an entrenched siege unit whose ENTIRE loadout is
// indirect-fire (homing or arcing), so the tactical AI's `isAllIndirect` (scenes/arena/
// enemies.js) reads true and its "camp behind cover and bombard" posture actually triggers —
// see the design comment on ENEMIES.artillery above. #96 had it reusing the sniper's direct-fire
// plasmaLance/clusterRocket loadout as a stopgap (since its original indirect weapons were
// shelved), which silently broke that AI posture. #244 later un-shelved every weapon, so this
// locks in that artillery got its own distinct, fully-indirect loadout back — mirrors the exact
// condition `isIndirectWeapon` in scenes/arena/enemies.js checks (guidance 'homing' or path
// 'arcing'), without needing to import that Phaser-adjacent scene file here.
function isIndirect(weapon) {
  const d = weapon?.delivery;
  return !!d && (d.guidance === 'homing' || d.path === 'arcing');
}

describe('ENEMIES.artillery loadout', () => {
  it('is fully indirect-fire — every mounted weapon is arcing or homing', () => {
    const mech = new Mech(ENEMIES.artillery);
    const weapons = mech.weapons().map((w) => w.weapon).filter(Boolean);
    expect(weapons.length).toBeGreaterThan(0);
    expect(weapons.every(isIndirect)).toBe(true);
  });

  it('is distinct from the sniper loadout (not just a reskinned Warden)', () => {
    const artillery = new Mech(ENEMIES.artillery);
    const sniper = new Mech(ENEMIES.sniper);
    const artilleryIds = artillery.weapons().map((w) => w.weapon?.id).sort();
    const sniperIds = sniper.weapons().map((w) => w.weapon?.id).sort();
    expect(artilleryIds).not.toEqual(sniperIds);
  });
});

// #273: "each weapon loadout should actually have a different mech art type" — the 4 mech
// archetypes were keyed to only 2 of the 3 chassis weight classes (raider+skirmisher both
// 'light', sniper+artillery both 'heavy'; 'medium' unused), so any two sharing a class were
// visually near-identical apart from mounted weapon icons. Fixed as a pure data change: no
// new art-override mechanism, just reassigning chassisId so all 3 chassis weight classes
// (each with its own distinct procedural body shape + decor set — see src/data/chassis/*.js)
// are represented across the 4 archetypes.
describe('ENEMIES — mech archetype chassis assignment (#273)', () => {
  it('defines exactly the 4 expected mech archetypes', () => {
    expect(Object.keys(ENEMIES).sort()).toEqual(['artillery', 'raider', 'skirmisher', 'sniper']);
  });

  it('every archetype uses a real, known chassis weight class', () => {
    for (const [id, def] of Object.entries(ENEMIES)) {
      expect(CHASSIS_IDS, `${id}.chassisId`).toContain(def.chassisId);
    }
  });

  it('all 3 chassis weight classes are represented across the 4 archetypes (not just 2)', () => {
    const usedChassisIds = new Set(Object.values(ENEMIES).map((def) => def.chassisId));
    expect([...usedChassisIds].sort()).toEqual(['heavy', 'light', 'medium']);
  });

  it('sniper is the medium chassis (moved off heavy so it no longer doubles artillery\'s look)', () => {
    expect(ENEMIES.sniper.chassisId).toBe('medium');
  });

  it('artillery keeps the heavy chassis — fits its camp-and-bombard siege identity', () => {
    expect(ENEMIES.artillery.chassisId).toBe('heavy');
  });

  it('raider and skirmisher still share the light chassis — the one pair still allowed to overlap', () => {
    expect(ENEMIES.raider.chassisId).toBe('light');
    expect(ENEMIES.skirmisher.chassisId).toBe('light');
  });

  it('with all 3 weight classes in play, at most one pair of archetypes shares a chassis', () => {
    const counts = {};
    for (const def of Object.values(ENEMIES)) {
      counts[def.chassisId] = (counts[def.chassisId] ?? 0) + 1;
    }
    const shared = Object.values(counts).filter((n) => n > 1);
    expect(shared).toEqual([2]); // exactly one chassis id used by exactly 2 archetypes
  });

  it('ENEMY_ROTATION still only references real ENEMIES/kind ids (no typos from the edit)', () => {
    // Loose sanity check, not an exhaustive kind registry cross-check — just confirms the
    // archetype ids touched by this change (raider/skirmisher/sniper/artillery) still appear.
    for (const id of ['raider', 'skirmisher', 'sniper', 'artillery']) {
      expect(ENEMY_ROTATION).toContain(id);
    }
  });

  // #344: `DEFAULT_SQUAD` was documented as retired in two files while still being exported AND
  // still wired as `_spawnSquad`'s default argument. Traced: `_spawnSquad` had no call sites, so
  // the table was genuinely dead and both it and the method were deleted. Guard the deletion so a
  // future edit can't quietly reintroduce a second, unreachable opening-difficulty table.
  it('DEFAULT_SQUAD is gone (#344 — dead opening-squad table, no call sites)', () => {
    expect(enemiesModule.DEFAULT_SQUAD).toBeUndefined();
  });
});
