import { describe, it, expect } from 'vitest';
import { ENEMIES, ENEMY_ROTATION, DEFAULT_SQUAD } from './enemies.js';
import { CHASSIS_IDS } from './chassis/index.js';

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

  it('ENEMY_ROTATION and DEFAULT_SQUAD still only reference real ENEMIES/kind ids (no typos from the edit)', () => {
    // Loose sanity check, not an exhaustive kind registry cross-check — just confirms the
    // archetype ids touched by this change (raider/skirmisher/sniper/artillery) still appear.
    for (const id of ['raider', 'skirmisher', 'sniper', 'artillery']) {
      expect(ENEMY_ROTATION).toContain(id);
    }
    expect(DEFAULT_SQUAD).toContain('raider');
    expect(DEFAULT_SQUAD).toContain('sniper');
  });
});
