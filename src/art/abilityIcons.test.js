// #506 THIRD rework — every mountable ability gets its own bespoke tile icon instead of the flat
// colored-swatch placeholder. What's pinned here: (1) a completeness guard so a future ability
// added to data/abilities.js without art here is caught rather than silently degrading to the
// generic fallback, and (2) every registered glyph (plus the fallback) actually draws without
// throwing against a minimal Graphics stub — this is procedural vector art with no Phaser scene
// required to exercise it.

import { describe, it, expect } from 'vitest';
import { drawAbilityIcon, ABILITY_ICON_IDS } from './abilityIcons.js';
import { ABILITIES } from '../data/abilities.js';

// A no-op recorder covering every Graphics method the icon drawers call. None of the draw code
// chains return values off these calls, so plain no-ops (rather than chainable stubs) suffice.
function fakeGraphics() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, args]); };
  return {
    calls,
    fillStyle: rec('fillStyle'), fillCircle: rec('fillCircle'), fillTriangle: rec('fillTriangle'),
    fillRect: rec('fillRect'), fillRoundedRect: rec('fillRoundedRect'), fillPoints: rec('fillPoints'),
    lineStyle: rec('lineStyle'), lineBetween: rec('lineBetween'), strokeCircle: rec('strokeCircle'),
    strokeRoundedRect: rec('strokeRoundedRect'),
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    closePath: rec('closePath'), strokePath: rec('strokePath'),
  };
}

describe('ability tile art registry (#506 third rework)', () => {
  it('has a bespoke icon for every ability in the ABILITIES catalog — no ability silently falls back', () => {
    expect(ABILITY_ICON_IDS.sort()).toEqual(Object.keys(ABILITIES).sort());
  });

  it('draws every registered ability icon without throwing, and actually draws something', () => {
    for (const id of ABILITY_ICON_IDS) {
      const g = fakeGraphics();
      expect(() => drawAbilityIcon(g, id, 4, 60, 0x5ec8e0)).not.toThrow();
      expect(g.calls.length).toBeGreaterThan(0);
    }
  });

  it('falls back to a plain swatch (rather than throwing or drawing nothing) for an unknown id', () => {
    const g = fakeGraphics();
    expect(() => drawAbilityIcon(g, 'notARealAbility', 4, 60, 0x5ec8e0)).not.toThrow();
    expect(g.calls.some(([name]) => name === 'fillRoundedRect')).toBe(true);
  });
});
