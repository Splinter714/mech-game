import { describe, it, expect } from 'vitest';
import { BIOMES, BIOME_IDS, DEFAULT_BIOME, getBiome } from './biomes.js';
import { TERRAIN, isPassable, blocksLOS, isDestructible, rubbleFor } from './terrain.js';

const ROLE_FIELDS = ['groundA', 'groundB', 'channel', 'deep', 'cover', 'outpost'];

describe('biome registry (#67)', () => {
  it('has the four new biomes plus grassland', () => {
    for (const id of ['grassland', 'desert', 'arctic', 'urban', 'volcanic']) {
      expect(BIOMES[id]).toBeDefined();
      expect(BIOMES[id].id).toBe(id);
      expect(typeof BIOMES[id].name).toBe('string');
    }
    expect(BIOME_IDS).toEqual(Object.keys(BIOMES));
  });

  it('every biome maps all roles to real terrain ids', () => {
    for (const b of Object.values(BIOMES)) {
      for (const f of ROLE_FIELDS) {
        expect(TERRAIN[b[f]], `${b.id}.${f} = ${b[f]}`).toBeDefined();
      }
    }
  });

  it('roles keep the same passability/LOS contract in every biome', () => {
    for (const b of Object.values(BIOMES)) {
      // Ground is open + fast-passable + no cover.
      for (const g of [b.groundA, b.groundB]) {
        expect(isPassable(g)).toBe(true);
        expect(blocksLOS(g)).toBe(false);
      }
      // Channel: passable, shoot-over (no LOS block).
      expect(isPassable(b.channel)).toBe(true);
      expect(blocksLOS(b.channel)).toBe(false);
      // Deep: impassable (the lake analog) — #110: boundary-ring-only, never in-map.
      expect(isPassable(b.deep)).toBe(false);
      // Cover: walk-through cover — passable AND blocks LOS.
      expect(isPassable(b.cover)).toBe(true);
      expect(blocksLOS(b.cover)).toBe(true);
      // Outpost: destructible hard cover — impassable, blocks LOS, has HP, collapses to rubble.
      expect(isPassable(b.outpost)).toBe(false);
      expect(blocksLOS(b.outpost)).toBe(true);
      expect(isDestructible(b.outpost)).toBe(true);
      const rub = rubbleFor(b.outpost);
      expect(TERRAIN[rub]).toBeDefined();
      expect(isPassable(rub)).toBe(true);     // you can drive over the debris
      expect(blocksLOS(rub)).toBe(false);
    }
  });

  // #110: every biome's LESSER in-map hazard (replacing the now boundary-only `deep`) must be
  // passable — it's a danger to slow you down, not a wall — and, when declared, a real
  // terrain id distinct from `deep` itself.
  it('every biome hazard (if declared) is passable and distinct from the boundary-only deep id', () => {
    for (const b of Object.values(BIOMES)) {
      if (!b.hazard) { expect(b.hasHazard).toBe(false); continue; }
      expect(TERRAIN[b.hazard]).toBeDefined();
      expect(isPassable(b.hazard)).toBe(true);
      expect(b.hazard).not.toBe(b.deep);
      expect(b.hasHazard).toBe(true);
    }
  });

  it('grassland has no separate in-map hazard blob — its channel already covers the role', () => {
    expect(BIOMES.grassland.hazard).toBeNull();
    expect(BIOMES.grassland.hasHazard).toBe(false);
  });

  it('every biome declares generation knobs', () => {
    for (const b of Object.values(BIOMES)) {
      expect(typeof b.coverClusters).toBe('number');
      expect(Number.isInteger(b.outposts)).toBe(true);
      expect(typeof b.hasChannel).toBe('boolean');
      expect(typeof b.hasHazard).toBe('boolean');
    }
  });

  it('getBiome falls back to the default for an unknown id', () => {
    expect(getBiome('desert')).toBe(BIOMES.desert);
    expect(getBiome('nope')).toBe(BIOMES[DEFAULT_BIOME]);
    expect(getBiome(undefined)).toBe(BIOMES[DEFAULT_BIOME]);
    expect(DEFAULT_BIOME).toBe('grassland');
  });
});
