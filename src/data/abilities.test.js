import { describe, it, expect } from 'vitest';
import { ABILITIES, getAbility, isAbility, DASH_SPEED_MULT } from './abilities.js';

describe('abilities registry', () => {
  it('every entry has the fields abilityState.js needs plus a name and effect kind', () => {
    for (const [id, def] of Object.entries(ABILITIES)) {
      expect(def.name, id).toBeTruthy();
      expect(def.effect, id).toBeTruthy();
      expect(typeof def.cooldown, id).toBe('number');
      expect(typeof def.duration, id).toBe('number');
    }
  });

  it('getAbility/isAbility resolve known and reject unknown ids', () => {
    expect(isAbility('dash')).toBe(true);
    expect(getAbility('dash').effect).toBe('dash');
    expect(isAbility('not-a-real-ability')).toBe(false);
    expect(getAbility('not-a-real-ability')).toBeUndefined();
  });

  it('dash is meaningfully stronger than Sprint\'s old 1.5x multiplier', () => {
    expect(DASH_SPEED_MULT).toBeGreaterThan(2);
  });
});
