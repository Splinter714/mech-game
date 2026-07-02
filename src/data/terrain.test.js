import { describe, it, expect } from 'vitest';
import {
  TERRAIN, getTerrain, terrainSpeedFactor, isPassable, blocksLOS,
  isDestructible, buildingHp, damageBuilding, RUBBLE, rubbleFor,
} from './terrain.js';

describe('terrain table (#41 full model)', () => {
  it('splits water into a passable-but-slow river and impassable deep water', () => {
    // River: shallow — drive through it, it slows you, and you can shoot over it.
    expect(TERRAIN.river.passable).toBe(true);
    expect(TERRAIN.river.blocksLOS).toBe(false);
    expect(TERRAIN.river.speedFactor).toBeLessThan(1);
    // Deep water: impassable, still no LOS block.
    expect(TERRAIN.deepWater.passable).toBe(false);
    expect(TERRAIN.deepWater.blocksLOS).toBe(false);
    // The old single `water` type is gone.
    expect(TERRAIN.water).toBeUndefined();
  });

  it('makes forest walk-through cover: passable + slowing + still blocks LOS', () => {
    expect(TERRAIN.forest.passable).toBe(true);
    expect(TERRAIN.forest.blocksLOS).toBe(true);
    expect(TERRAIN.forest.speedFactor).toBeLessThan(1);
  });

  it('makes buildings destructible hard cover with HP', () => {
    expect(TERRAIN.building.passable).toBe(false);
    expect(TERRAIN.building.blocksLOS).toBe(true);
    expect(TERRAIN.building.destructible).toBe(true);
    expect(TERRAIN.building.hp).toBeGreaterThan(0);
  });

  it('leaves grass as normal open ground', () => {
    for (const id of ['grass', 'grassB']) {
      expect(TERRAIN[id].passable).toBe(true);
      expect(TERRAIN[id].blocksLOS).toBe(false);
      expect(terrainSpeedFactor(id)).toBe(1);
    }
  });

  it('leaves rubble passable, no cover, mildly slowing', () => {
    expect(TERRAIN.rubble.passable).toBe(true);
    expect(TERRAIN.rubble.blocksLOS).toBe(false);
    expect(TERRAIN.rubble.speedFactor).toBeLessThan(1);
    expect(RUBBLE).toBe('rubble');
  });

  it('getTerrain falls back to grass for an unknown id', () => {
    expect(getTerrain('nope')).toBe(TERRAIN.grass);
    expect(getTerrain(undefined)).toBe(TERRAIN.grass);
  });
});

describe('terrain property resolvers', () => {
  it('terrainSpeedFactor: slow terrain <1, normal =1, unknown/off-map =1', () => {
    expect(terrainSpeedFactor('grass')).toBe(1);
    expect(terrainSpeedFactor('river')).toBe(TERRAIN.river.speedFactor);
    expect(terrainSpeedFactor('forest')).toBe(TERRAIN.forest.speedFactor);
    expect(terrainSpeedFactor(undefined)).toBe(1);   // off the arena disc
    expect(terrainSpeedFactor('nope')).toBe(1);
  });

  it('isPassable: grass/river/forest/rubble yes; deepWater/building no; off-map no', () => {
    expect(isPassable('grass')).toBe(true);
    expect(isPassable('river')).toBe(true);
    expect(isPassable('forest')).toBe(true);
    expect(isPassable('rubble')).toBe(true);
    expect(isPassable('deepWater')).toBe(false);
    expect(isPassable('building')).toBe(false);
    expect(isPassable(undefined)).toBe(false);   // off the arena disc is blocked
  });

  it('blocksLOS: forest + building only; water/grass/rubble shoot over; off-map no', () => {
    expect(blocksLOS('forest')).toBe(true);
    expect(blocksLOS('building')).toBe(true);
    expect(blocksLOS('river')).toBe(false);
    expect(blocksLOS('deepWater')).toBe(false);
    expect(blocksLOS('grass')).toBe(false);
    expect(blocksLOS('rubble')).toBe(false);
    expect(blocksLOS(undefined)).toBe(false);
  });

  it('isDestructible + buildingHp: only buildings have HP', () => {
    expect(isDestructible('building')).toBe(true);
    expect(buildingHp('building')).toBe(TERRAIN.building.hp);
    for (const id of ['grass', 'river', 'forest', 'deepWater', 'rubble', undefined]) {
      expect(isDestructible(id)).toBe(false);
      expect(buildingHp(id)).toBe(0);
    }
  });
});

describe('rubbleFor — a destructible collapses into its biome rubble (#67)', () => {
  it('maps each biome outpost to its own passable, no-cover debris', () => {
    const pairs = [
      ['building', 'rubble'], ['adobe', 'sandRubble'], ['iceRuin', 'snowRubble'],
      ['tower', 'cityRubble'], ['obsidian', 'ashRubble'],
    ];
    for (const [outpost, rub] of pairs) {
      expect(rubbleFor(outpost)).toBe(rub);
      expect(isPassable(rub)).toBe(true);
      expect(blocksLOS(rub)).toBe(false);
    }
  });

  it('falls back to the default RUBBLE for non-destructible / unknown terrain', () => {
    expect(rubbleFor('grass')).toBe(RUBBLE);
    expect(rubbleFor(undefined)).toBe(RUBBLE);
    expect(rubbleFor('nope')).toBe(RUBBLE);
  });
});

describe('damageBuilding — HP → rubble transition (pure)', () => {
  it('chips HP without destroying while HP remains', () => {
    const r = damageBuilding(60, 20);
    expect(r.hp).toBe(40);
    expect(r.destroyed).toBe(false);
  });

  it('destroys exactly at zero', () => {
    const r = damageBuilding(20, 20);
    expect(r.hp).toBe(0);
    expect(r.destroyed).toBe(true);
  });

  it('overkill clamps HP to 0 and reports destroyed', () => {
    const r = damageBuilding(10, 999);
    expect(r.hp).toBe(0);
    expect(r.destroyed).toBe(true);
  });

  it('ignores negative damage (no healing, no destruction)', () => {
    const r = damageBuilding(30, -50);
    expect(r.hp).toBe(30);
    expect(r.destroyed).toBe(false);
  });

  it('a building can be flattened in successive stomp bites', () => {
    let hp = buildingHp('building');
    let destroyed = false;
    for (let i = 0; i < 100 && !destroyed; i++) {
      ({ hp, destroyed } = damageBuilding(hp, 15));   // ~stomp-per-frame bite
    }
    expect(destroyed).toBe(true);
    expect(hp).toBe(0);
  });
});
