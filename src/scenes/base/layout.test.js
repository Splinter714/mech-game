import { describe, it, expect } from 'vitest';
import { axialKey } from '../../data/hexgrid.js';
import { isPassable } from '../../data/terrain.js';
import { BASE_TRIGGERS, CUSTOMIZATION_HEX, SCANNER_HEX, buildBaseTerrain } from './layout.js';

describe('#509 base layout — the hand-authored central-base hex map', () => {
  it('every functional trigger hex is inside the built terrain and passable', () => {
    const terrain = buildBaseTerrain();
    for (const [key] of BASE_TRIGGERS) {
      expect(terrain.has(key)).toBe(true);
      expect(isPassable(terrain.get(key))).toBe(true);
    }
  });

  it('customization and scanner are two distinct hexes with two distinct actions', () => {
    expect(axialKey(CUSTOMIZATION_HEX.q, CUSTOMIZATION_HEX.r)).not.toBe(axialKey(SCANNER_HEX.q, SCANNER_HEX.r));
    expect(BASE_TRIGGERS.get(axialKey(CUSTOMIZATION_HEX.q, CUSTOMIZATION_HEX.r))).toBe('customization');
    expect(BASE_TRIGGERS.get(axialKey(SCANNER_HEX.q, SCANNER_HEX.r))).toBe('scanner');
  });

  it('the origin (spawn point) is inside the built terrain and passable', () => {
    const terrain = buildBaseTerrain();
    const key = axialKey(0, 0);
    expect(terrain.has(key)).toBe(true);
    expect(isPassable(terrain.get(key))).toBe(true);
  });
});
