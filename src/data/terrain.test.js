import { describe, it, expect } from 'vitest';
import {
  TERRAIN, getTerrain, terrainSpeedFactor, isPassable, blocksLOS,
  isDestructible, buildingHp, damageBuilding, RUBBLE, rubbleFor,
  isSoftCover, shotBlockedAt, FLAME_COVER_MULT, flameCoverDamage,
  isWaterTerrain,
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

  // #251: helipad is a genuine first-class TERRAIN entry (same shape/rigor as grass/sand/snow/
  // pavement — a real tex + passable/blocksLOS/speedFactor), not a special-cased runtime-only
  // construct. It's placed as static base-infrastructure set dressing at world-gen time
  // (worldgen.js `HELIPAD_COUNT`), fully independent of any enemy spawn.
  it('makes the helipad ground marking normal, walkable, non-cover terrain', () => {
    expect(TERRAIN.helipad).toBeDefined();
    expect(TERRAIN.helipad.id).toBe('helipad');
    expect(typeof TERRAIN.helipad.tex).toBe('string');
    expect(TERRAIN.helipad.passable).toBe(true);
    expect(TERRAIN.helipad.blocksLOS).toBe(false);
    expect(terrainSpeedFactor('helipad')).toBe(1);
    expect(isPassable('helipad')).toBe(true);
    expect(blocksLOS('helipad')).toBe(false);
    expect(isDestructible('helipad')).toBe(false);
    expect(isSoftCover('helipad')).toBe(false);
    expect(isWaterTerrain('helipad')).toBe(false);
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

  it('isDestructible + buildingHp: buildings and soft cover have HP; open ground does not', () => {
    expect(isDestructible('building')).toBe(true);
    expect(buildingHp('building')).toBe(TERRAIN.building.hp);
    expect(isDestructible('forest')).toBe(true);   // #72 destructible soft cover
    expect(buildingHp('forest')).toBe(TERRAIN.forest.hp);
    for (const id of ['grass', 'river', 'deepWater', 'rubble', undefined]) {
      expect(isDestructible(id)).toBe(false);
      expect(buildingHp(id)).toBe(0);
    }
  });
});

describe('#72 soft cover — own-hex transparency + destructible/burnable trees', () => {
  it('isSoftCover: exactly the passable+LOS-blocking terrains', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(isSoftCover(id)).toBe(true);
    }
    // Solid cover, open ground, hazards, and off-map are NOT soft cover.
    for (const id of ['building', 'mesa', 'adobe', 'iceRuin', 'grass', 'river', 'deepWater', 'rubble', 'lava', undefined, 'nope']) {
      expect(isSoftCover(id)).toBe(false);
    }
  });

  it('every soft-cover terrain is destructible, with LESS HP than an outpost, and flattens to passable no-cover ground', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(isDestructible(id)).toBe(true);
      expect(buildingHp(id)).toBeGreaterThan(0);
      expect(buildingHp(id)).toBeLessThanOrEqual(TERRAIN.building.hp);
      const rub = rubbleFor(id);
      expect(isPassable(rub)).toBe(true);
      expect(blocksLOS(rub)).toBe(false);
      expect(getTerrain(rub).tex).not.toBe(getTerrain(id).tex);   // the hex visibly changes
    }
  });

  it('soft cover flattens to its own biome rubble (data-driven)', () => {
    // #227: each soft-cover destructible now has its OWN rubble id, distinct from its biome's
    // hard-destructible (outpost) rubble.
    expect(rubbleFor('forest')).toBe('vegRubble');
    expect(rubbleFor('scrub')).toBe('scrubRubble');
    expect(rubbleFor('drift')).toBe('driftRubble');
    expect(rubbleFor('wreck')).toBe('wreckRubble');
    expect(rubbleFor('fumarole')).toBe('fumaroleRubble');
  });

  it('shotBlockedAt: soft cover is transparent for exempted hexes only', () => {
    const exempt = new Set(['3,-1']);
    // The target's own forest hex does not protect it...
    expect(shotBlockedAt('forest', '3,-1', exempt)).toBe(false);
    // ...but another forest hex on the way still blocks ("deep woods").
    expect(shotBlockedAt('forest', '2,-1', exempt)).toBe(true);
    // No exemptions at all → forest blocks like before.
    expect(shotBlockedAt('forest', '3,-1', null)).toBe(true);
    expect(shotBlockedAt('forest', '3,-1', new Set())).toBe(true);
  });

  it('shotBlockedAt: SOLID cover blocks even when exempted; open ground never blocks', () => {
    const exempt = new Set(['3,-1']);
    for (const id of ['building', 'adobe', 'iceRuin', 'tower', 'obsidian']) {
      expect(shotBlockedAt(id, '3,-1', exempt)).toBe(true);
    }
    // #221: mesa/collapsed are boundary-only impassable terrain (like deepWater/lava) — they
    // never block LOS, matching the other biomes' boundary-only terrain (ice, deepWater, lava).
    for (const id of ['grass', 'river', 'deepWater', 'rubble', 'mesa', 'collapsed', undefined]) {
      expect(shotBlockedAt(id, '3,-1', exempt)).toBe(false);
      expect(shotBlockedAt(id, '9,9', null)).toBe(false);
    }
  });

  it('flame damage is multiplied so fire clears woods much faster than gunfire', () => {
    expect(FLAME_COVER_MULT).toBeGreaterThan(1);
    expect(flameCoverDamage(10)).toBe(10 * FLAME_COVER_MULT);
    // A napalm ground-fire patch (dps 8, ticking every 500ms) must burn a forest hex down
    // well within its 4s duration: per-tick terrain bite = flameCoverDamage(dps × 0.5).
    const perTick = flameCoverDamage(8 * 0.5);
    let hp = buildingHp('forest'), ticks = 0, destroyed = false;
    while (!destroyed && ticks < 100) { ({ hp, destroyed } = damageBuilding(hp, perTick)); ticks++; }
    expect(destroyed).toBe(true);
    expect(ticks * 0.5).toBeLessThanOrEqual(2);   // cleared in ≤2s of burning
  });

  it('gunfire clears a forest hex in a few shots — feasible but not instant', () => {
    // Autocannon-class hit: 16 damage. Forest must take more than 1 shot but not many.
    let hp = buildingHp('forest'), shots = 0, destroyed = false;
    while (!destroyed && shots < 50) { ({ hp, destroyed } = damageBuilding(hp, 16)); shots++; }
    expect(shots).toBeGreaterThan(1);
    expect(shots).toBeLessThanOrEqual(5);
  });
});

describe('isWaterTerrain (#151) — reads as actual water, not just slow terrain in general', () => {
  it('flags exactly the water-like ids across all 5 biomes', () => {
    for (const id of ['river', 'deepWater', 'slush', 'ice', 'brokenIce']) {
      expect(isWaterTerrain(id), id).toBe(true);
    }
  });

  it('does NOT flag other slow-but-not-water terrain (dry riverbeds, sand, ash, rubble, roads)', () => {
    for (const id of [
      'grass', 'grassB', 'forest', 'rubble', 'vegRubble',
      'sand', 'sandB', 'dryRiver', 'mesa', 'scrub', 'adobe', 'sandRubble', 'scrubRubble', 'quicksand',
      'snow', 'snowB', 'drift', 'iceRuin', 'snowRubble', 'driftRubble',
      'pavement', 'pavementB', 'road', 'collapsed', 'wreck', 'tower', 'cityRubble', 'wreckRubble', 'debris',
      'ash', 'ashB', 'crust', 'lava', 'fumarole', 'obsidian', 'ashRubble', 'fumaroleRubble', 'cinderField',
      undefined, 'nope',
    ]) {
      expect(isWaterTerrain(id), String(id)).toBe(false);
    }
  });

  it('includes both the passable shallow analogs and the impassable deep/boundary analogs', () => {
    // Passable — a unit CAN wade these, it just shouldn't choose to loiter there.
    expect(isPassable('river')).toBe(true);
    expect(isPassable('slush')).toBe(true);
    expect(isPassable('brokenIce')).toBe(true);
    // Impassable boundary-only water.
    expect(isPassable('deepWater')).toBe(false);
    expect(isPassable('ice')).toBe(false);
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

describe('#227 — destroyed soft cover leaves DIFFERENT rubble than a destroyed outpost, per biome', () => {
  it('every biome\'s soft-destructible rubble id differs from its hard-destructible (outpost) rubble id', () => {
    const biomes = [
      ['forest', 'building'],
      ['scrub', 'adobe'],
      ['drift', 'iceRuin'],
      ['wreck', 'tower'],
      ['fumarole', 'obsidian'],
    ];
    for (const [soft, hard] of biomes) {
      const softRub = rubbleFor(soft);
      const hardRub = rubbleFor(hard);
      expect(softRub, `${soft} rubble`).not.toBe(hardRub);
      // Both still land on ordinary passable, non-cover debris.
      expect(isPassable(softRub)).toBe(true);
      expect(blocksLOS(softRub)).toBe(false);
      expect(isPassable(hardRub)).toBe(true);
      expect(blocksLOS(hardRub)).toBe(false);
      // And the two rubbles render with visibly different textures.
      expect(getTerrain(softRub).tex).not.toBe(getTerrain(hardRub).tex);
    }
  });

  it('names the 5 new soft-destructible rubble ids', () => {
    expect(TERRAIN.vegRubble).toBeDefined();
    expect(TERRAIN.scrubRubble).toBeDefined();
    expect(TERRAIN.driftRubble).toBeDefined();
    expect(TERRAIN.wreckRubble).toBeDefined();
    expect(TERRAIN.fumaroleRubble).toBeDefined();
    for (const id of ['vegRubble', 'scrubRubble', 'driftRubble', 'wreckRubble', 'fumaroleRubble']) {
      expect(TERRAIN[id].passable).toBe(true);
      expect(TERRAIN[id].blocksLOS).toBe(false);
    }
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
