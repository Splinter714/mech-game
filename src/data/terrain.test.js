import { describe, it, expect } from 'vitest';
import {
  TERRAIN, getTerrain, terrainSpeedFactor, isPassable, blocksLOS,
  isDestructible, buildingHp, damageBuilding, RUBBLE, rubbleFor,
  isSoftCover, shotBlockedAt, FLAME_COVER_MULT, flameCoverDamage,
  isWaterTerrain, isMissionObjective,
  SLOW_MOVEMENT_FACTOR, movementTier, coverTier, isBaseCategory,
  softCoverBlocksLOS, coverBlocksForRay,
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

  // #275: the 5 biome-specific destructible outpost buildings (building/adobe/iceRuin/tower/
  // obsidian) were removed — `alertTower` is now the representative destructible-hard-cover
  // base-infra structure.
  it('makes destructible base-infra structures (e.g. alertTower) hard cover with HP', () => {
    expect(TERRAIN.alertTower.passable).toBe(false);
    expect(TERRAIN.alertTower.blocksLOS).toBe(true);
    expect(TERRAIN.alertTower.destructible).toBe(true);
    expect(TERRAIN.alertTower.hp).toBeGreaterThan(0);
  });

  it('leaves grass as normal open ground', () => {
    for (const id of ['grass', 'grassB']) {
      expect(TERRAIN[id].passable).toBe(true);
      expect(TERRAIN[id].blocksLOS).toBe(false);
      expect(terrainSpeedFactor(id)).toBe(1);
    }
  });

  // #275: `helipad` (base-infrastructure set-dressing, biome-independent) was removed entirely
  // along with the 5 destructible outpost buildings — `dock` is now the representative
  // non-destructible, open-cover, full-movement `base`-category entry.
  it('makes the dock ground marking normal, walkable, non-cover terrain', () => {
    expect(TERRAIN.dock).toBeDefined();
    expect(TERRAIN.dock.id).toBe('dock');
    expect(typeof TERRAIN.dock.tex).toBe('string');
    expect(TERRAIN.dock.passable).toBe(true);
    expect(TERRAIN.dock.blocksLOS).toBe(false);
    expect(terrainSpeedFactor('dock')).toBe(1);
    expect(isPassable('dock')).toBe(true);
    expect(blocksLOS('dock')).toBe(false);
    expect(isSoftCover('dock')).toBe(false);
    expect(isWaterTerrain('dock')).toBe(false);
  });

  // #269 playtest follow-up: dock/alertTower previously reused the (since-removed, #275)
  // helipad/tower outpost textures verbatim, making them visually indistinguishable from a real
  // helipad and from an ordinary destructible outpost building respectively — a player couldn't
  // tell an alert tower apart from a building it was fine to demolish, so it kept getting
  // destroyed incidentally and never woke a base. Each now has its own dedicated texture key
  // (art/hexArt.js).
  it('gives dock its own texture', () => {
    expect(TERRAIN.dock).toBeDefined();
    expect(typeof TERRAIN.dock.tex).toBe('string');
    expect(TERRAIN.dock.passable).toBe(true);
    expect(TERRAIN.dock.blocksLOS).toBe(false);
    expect(TERRAIN.dock.destructible).toBeFalsy();
    expect(isBaseCategory('dock')).toBe(true);
  });

  it('gives alertTower its own texture, distinct from dock, and makes it a destructible mission-objective-exempt structure', () => {
    expect(TERRAIN.alertTower).toBeDefined();
    expect(typeof TERRAIN.alertTower.tex).toBe('string');
    expect(TERRAIN.alertTower.tex).not.toBe(TERRAIN.dock.tex);
    expect(TERRAIN.alertTower.passable).toBe(false);
    expect(TERRAIN.alertTower.blocksLOS).toBe(true);
    expect(isDestructible('alertTower')).toBe(true);
    expect(TERRAIN.alertTower.hp).toBe(75);   // #313 retune, was 25
    expect(isMissionObjective('alertTower')).toBe(false);
    expect(isBaseCategory('alertTower')).toBe(true);
  });

  // #269 playtest follow-up (dock open/closed states): `dockClosed` is the sealed, destructible
  // runtime state a `dock` hex swaps into once vacated (scenes/arena/bases.js `_closeDock`) —
  // unlike the open `dock` marker (deliberately non-destructible), this is a genuine structure:
  // blocks LOS, has real HP, and collapses to the same uniform base-infra rubble every other
  // destructible base hex uses. Excluded from the mission-objective pool since it's a dynamic
  // occupancy state, not a placed assault objective. #286: unlike alertTower/objective, a sealed
  // dock stays PASSABLE (just slow) — a mech can walk over/around a closed dome, it just can't
  // resupply there until it reopens.
  it('gives dockClosed its own texture and makes it a genuine destructible structure, unlike the open dock marker', () => {
    expect(TERRAIN.dockClosed).toBeDefined();
    expect(typeof TERRAIN.dockClosed.tex).toBe('string');
    expect(TERRAIN.dockClosed.tex).not.toBe(TERRAIN.dock.tex);
    expect(TERRAIN.dockClosed.passable).toBe(true);
    expect(TERRAIN.dockClosed.blocksLOS).toBe(true);
    expect(TERRAIN.dockClosed.speedFactor).toBe(SLOW_MOVEMENT_FACTOR);
    expect(isPassable('dockClosed')).toBe(true);
    expect(blocksLOS('dockClosed')).toBe(true);
    expect(isDestructible('dockClosed')).toBe(true);
    expect(TERRAIN.dockClosed.hp).toBeGreaterThan(0);
    expect(TERRAIN.dockClosed.rubbleId).toBe('rubble');
    expect(isMissionObjective('dockClosed')).toBe(false);
    expect(isBaseCategory('dockClosed')).toBe(true);
    // Sanity: the open dock marker it swaps FROM/TO stays exactly as before — never destructible.
    expect(TERRAIN.dock.destructible).toBeFalsy();
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

  it('isPassable: grass/river/forest/rubble yes; deepWater/alertTower no; off-map no', () => {
    expect(isPassable('grass')).toBe(true);
    expect(isPassable('river')).toBe(true);
    expect(isPassable('forest')).toBe(true);
    expect(isPassable('rubble')).toBe(true);
    expect(isPassable('deepWater')).toBe(false);
    expect(isPassable('alertTower')).toBe(false);
    expect(isPassable(undefined)).toBe(false);   // off the arena disc is blocked
  });

  it('blocksLOS: forest + alertTower only; water/grass/rubble shoot over; off-map no', () => {
    expect(blocksLOS('forest')).toBe(true);
    expect(blocksLOS('alertTower')).toBe(true);
    expect(blocksLOS('river')).toBe(false);
    expect(blocksLOS('deepWater')).toBe(false);
    expect(blocksLOS('grass')).toBe(false);
    expect(blocksLOS('rubble')).toBe(false);
    expect(blocksLOS(undefined)).toBe(false);
  });

  it('isDestructible + buildingHp: destructible hard cover and soft cover have HP; open ground does not', () => {
    expect(isDestructible('alertTower')).toBe(true);
    expect(buildingHp('alertTower')).toBe(TERRAIN.alertTower.hp);
    expect(isDestructible('forest')).toBe(true);   // #72 destructible soft cover
    expect(buildingHp('forest')).toBe(TERRAIN.forest.hp);
    for (const id of ['grass', 'river', 'deepWater', 'rubble', undefined]) {
      expect(isDestructible(id)).toBe(false);
      expect(buildingHp(id)).toBe(0);
    }
  });
});

// #72 / #279 reversal: forest/scrub/drift/wreck/fumarole are `cover: 'soft'` — walk-through
// concealment that only blocks a SMALL ground unit's LOS (a mech/large unit sees clean over it),
// stay passable+slow+destructible/burnable, and the own-hex transparency rule (a unit standing
// inside cover can still see/shoot out through its own hex) applies. (#279 briefly flipped these
// to `hard`; a playtest reverted them back to `soft` — cover should only affect small units.)
describe('#72 soft cover (forest/scrub/drift/wreck/fumarole) — own-hex transparency + destructible/burnable', () => {
  it('isSoftCover: exactly the passable+LOS-blocking terrains', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(isSoftCover(id)).toBe(true);
      expect(coverTier(id)).toBe('soft');
    }
    // Solid base-infra cover, open ground, hazards, and off-map are NOT soft cover.
    for (const id of ['alertTower', 'dockClosed', 'objective', 'mesa', 'grass', 'river', 'deepWater', 'rubble', 'lava', undefined, 'nope']) {
      expect(isSoftCover(id)).toBe(false);
    }
  });

  it('blocks only a SMALL ground unit; a mech/large unit sees clean over it (size-tier soft cover)', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(coverBlocksForRay(id, false, true)).toBe(true);   // small unit — sightline blocked
      expect(coverBlocksForRay(id, false, false)).toBe(false); // large unit / mech — sees over it
    }
  });

  it('every cover terrain is destructible, with LESS HP than a full base-infra structure, and flattens to passable no-cover ground', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(isDestructible(id)).toBe(true);
      expect(buildingHp(id)).toBeGreaterThan(0);
      expect(buildingHp(id)).toBeLessThanOrEqual(TERRAIN.objective.hp);
      const rub = rubbleFor(id);
      expect(isPassable(rub)).toBe(true);
      expect(blocksLOS(rub)).toBe(false);
      expect(getTerrain(rub).tex).not.toBe(getTerrain(id).tex);   // the hex visibly changes
    }
  });

  it('cover terrain flattens to its own biome rubble (data-driven)', () => {
    // #227: each cover destructible has its OWN rubble id, distinct from its biome's hard
    // base-infra (outpost) rubble.
    expect(rubbleFor('forest')).toBe('forestRubble');
    expect(rubbleFor('scrub')).toBe('scrubRubble');
    expect(rubbleFor('drift')).toBe('driftRubble');
    expect(rubbleFor('wreck')).toBe('wreckRubble');
    expect(rubbleFor('fumarole')).toBe('fumaroleRubble');
  });

  it('shotBlockedAt: own-hex exemption — a unit standing INSIDE soft cover can see/shoot out through its own hex (small unit involved)', () => {
    // #269: soft cover only blocks a SMALL ground unit's LOS — pass smallUnitInvolved=true
    // throughout so this test exercises the #72 own-hex exemption it's actually about.
    const exempt = new Set(['3,-1']);
    // The target's own forest hex does not protect it...
    expect(shotBlockedAt('forest', '3,-1', exempt, true)).toBe(false);
    // ...but another forest hex on the way still blocks a small unit ("deep woods").
    expect(shotBlockedAt('forest', '2,-1', exempt, true)).toBe(true);
    // A large unit / mech sees clean over deep woods regardless.
    expect(shotBlockedAt('forest', '2,-1', exempt, false)).toBe(false);
    // No exemption + small unit → forest blocks like before.
    expect(shotBlockedAt('forest', '3,-1', null, true)).toBe(true);
    expect(shotBlockedAt('forest', '3,-1', new Set(), true)).toBe(true);
  });

  it('shotBlockedAt: the own-hex exemption generalizes to base-infra hard cover too (#279 keep); a different hex of the same terrain still blocks; open ground never blocks', () => {
    const exempt = new Set(['3,-1']);
    for (const id of ['alertTower', 'dockClosed', 'objective']) {
      // #279: the own-hex exemption is tier-agnostic — it applies to hard base-infra cover too.
      // For alertTower/objective (impassable) no living unit ever occupies the hex in real play;
      // #286 made dockClosed passable-but-slow, so a unit COULD stand there and it's live.
      expect(shotBlockedAt(id, '3,-1', exempt)).toBe(false);
      expect(shotBlockedAt(id, '9,9', exempt)).toBe(true);
      expect(shotBlockedAt(id, '9,9', null)).toBe(true);
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

// #278: grassland's new `mud` hazard and urban's new `canal` channel — each shaped exactly like
// the existing hazard/channel entries (passable, slow, no LOS block, terrain category, NOT
// destructible — hazards/channels never have HP, unlike soft cover).
describe('#278 mud (grassland hazard) + canal (urban channel)', () => {
  it('mud is shaped exactly like the other in-map hazards (quicksand/brokenIce/debris/cinderField)', () => {
    expect(TERRAIN.mud).toBeDefined();
    expect(TERRAIN.mud.passable).toBe(true);
    expect(TERRAIN.mud.blocksLOS).toBe(false);
    expect(TERRAIN.mud.speedFactor).toBe(SLOW_MOVEMENT_FACTOR);
    expect(TERRAIN.mud.category).toBe('terrain');
    expect(TERRAIN.mud.movement).toBe('slow');
    expect(TERRAIN.mud.cover).toBe('open');
    expect(TERRAIN.mud.destructible).toBeUndefined();
    expect(typeof TERRAIN.mud.tex).toBe('string');
  });

  it('canal is shaped exactly like the other channels (river/dryRiver/slush/crust) and reads as water', () => {
    expect(TERRAIN.canal).toBeDefined();
    expect(TERRAIN.canal.passable).toBe(true);
    expect(TERRAIN.canal.blocksLOS).toBe(false);
    expect(TERRAIN.canal.speedFactor).toBe(SLOW_MOVEMENT_FACTOR);
    expect(TERRAIN.canal.category).toBe('terrain');
    expect(TERRAIN.canal.movement).toBe('slow');
    expect(TERRAIN.canal.cover).toBe('open');
    expect(TERRAIN.canal.destructible).toBeUndefined();
    expect(isWaterTerrain('canal')).toBe(true);
    expect(typeof TERRAIN.canal.tex).toBe('string');
    // Distinct from urban's own hazard (debris) — no longer sharing a single id across two roles.
    expect(TERRAIN.canal.tex).not.toBe(TERRAIN.debris.tex);
  });
});

describe('isWaterTerrain (#151) — reads as actual water, not just slow terrain in general', () => {
  it('flags exactly the water-like ids across all 5 biomes', () => {
    // #278: urban's new `canal` channel reads as flooded standing water too.
    for (const id of ['river', 'deepWater', 'slush', 'ice', 'brokenIce', 'canal']) {
      expect(isWaterTerrain(id), id).toBe(true);
    }
  });

  it('does NOT flag other slow-but-not-water terrain (dry riverbeds, sand, ash, rubble, debris)', () => {
    for (const id of [
      'grass', 'grassB', 'forest', 'rubble', 'forestRubble', 'mud',
      'sand', 'sandB', 'dryRiver', 'mesa', 'scrub', 'scrubRubble', 'quicksand',
      'snow', 'snowB', 'drift', 'driftRubble',
      'pavement', 'pavementB', 'collapsed', 'wreck', 'wreckRubble', 'debris',
      'ash', 'ashB', 'crust', 'lava', 'fumarole', 'fumaroleRubble', 'cinderField',
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
  // #275: the 5 biome-specific destructible outposts (building/adobe/iceRuin/tower/obsidian) —
  // and their bespoke rubble ids (sandRubble/snowRubble/cityRubble/ashRubble, since orphaned once
  // their outpost was gone; grassland's `rubble` stayed as the shared/generic fallback) — were
  // removed. Every base-infra destructible now collapses to that same generic `rubble` id.
  it('every base-infra destructible collapses to the generic passable, no-cover rubble', () => {
    for (const id of ['alertTower', 'objective', 'dockClosed']) {
      const rub = rubbleFor(id);
      expect(rub).toBe(RUBBLE);
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

describe('#227 — destroyed soft cover leaves DIFFERENT rubble than the generic base-infra rubble, per biome', () => {
  it('every biome\'s soft-destructible rubble id differs from the generic base-infra rubble id', () => {
    for (const soft of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      const softRub = rubbleFor(soft);
      const hardRub = RUBBLE;   // #275: every base-infra destructible collapses to this now
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
    expect(TERRAIN.forestRubble).toBeDefined();
    expect(TERRAIN.scrubRubble).toBeDefined();
    expect(TERRAIN.driftRubble).toBeDefined();
    expect(TERRAIN.wreckRubble).toBeDefined();
    expect(TERRAIN.fumaroleRubble).toBeDefined();
    for (const id of ['forestRubble', 'scrubRubble', 'driftRubble', 'wreckRubble', 'fumaroleRubble']) {
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

  it('a destructible base-infra structure can be flattened in successive stomp bites', () => {
    let hp = buildingHp('alertTower');
    let destroyed = false;
    for (let i = 0; i < 100 && !destroyed; i++) {
      ({ hp, destroyed } = damageBuilding(hp, 15));   // ~stomp-per-frame bite
    }
    expect(destroyed).toBe(true);
    expect(hp).toBe(0);
  });
});

// #269 §1: the additive category/movement/cover vocabulary layered on top of the raw fields.
describe('#269 hex vocabulary — category/movement/cover fields', () => {
  it('every TERRAIN entry carries all three fields, with valid values', () => {
    for (const [id, t] of Object.entries(TERRAIN)) {
      expect(['terrain', 'base'], id).toContain(t.category);
      expect(['full', 'slow', 'none'], id).toContain(t.movement);
      expect(['open', 'soft', 'hard'], id).toContain(t.cover);
    }
  });

  it('an OPEN example (grass): full movement, open cover, ordinary terrain category', () => {
    expect(movementTier('grass')).toBe('full');
    expect(coverTier('grass')).toBe('open');
    expect(isBaseCategory('grass')).toBe(false);
    expect(blocksLOS('grass')).toBe(false);
    expect(isSoftCover('grass')).toBe(false);
  });

  it('a SOFT-cover example (forest): passable, slow movement, soft cover', () => {
    expect(movementTier('forest')).toBe('slow');
    expect(coverTier('forest')).toBe('soft');
    expect(isPassable('forest')).toBe(true);
    expect(isSoftCover('forest')).toBe(true);
    expect(blocksLOS('forest')).toBe(true);
  });

  it('a HARD-cover example (alertTower): impassable, no movement, hard cover', () => {
    expect(movementTier('alertTower')).toBe('none');
    expect(coverTier('alertTower')).toBe('hard');
    expect(isPassable('alertTower')).toBe(false);
    expect(isSoftCover('alertTower')).toBe(false);
    expect(blocksLOS('alertTower')).toBe(true);
  });

  // #275: `dock` is a `base`-category entry whose cover/movement fall out of its OWN raw fields
  // (open/full), not from being `base` — category never drives cover/movement.
  it('a BASE example (dock): category base, but open cover + full movement like any ground', () => {
    expect(isBaseCategory('dock')).toBe(true);
    expect(movementTier('dock')).toBe('full');
    expect(coverTier('dock')).toBe('open');
    expect(isPassable('dock')).toBe(true);
    expect(blocksLOS('dock')).toBe(false);
    expect(terrainSpeedFactor('dock')).toBe(1);
  });

  it('everything else is `terrain` category, not `base`', () => {
    for (const id of ['grass', 'forest', 'river', 'rubble', 'mesa', 'sand']) {
      expect(isBaseCategory(id), id).toBe(false);
    }
  });

  it('unknown/off-map ids resolve every new helper to a safe default', () => {
    for (const id of [undefined, 'nope']) {
      expect(movementTier(id)).toBeUndefined();
      expect(coverTier(id)).toBeUndefined();
      expect(isBaseCategory(id)).toBe(false);
      expect(isPassable(id)).toBe(false);
      expect(blocksLOS(id)).toBe(false);
      expect(isSoftCover(id)).toBe(false);
    }
  });
});

// #269 §1: consolidating ~15 hand-tuned speedFactors into ONE shared slow-movement value.
describe('#269 SLOW_MOVEMENT_FACTOR — every slow-movement entry shares one speed value', () => {
  it('is a real slowdown (strictly between 0 and 1)', () => {
    expect(SLOW_MOVEMENT_FACTOR).toBeGreaterThan(0);
    expect(SLOW_MOVEMENT_FACTOR).toBeLessThan(1);
  });

  it('every entry tagged movement:"slow" uses exactly SLOW_MOVEMENT_FACTOR as its speedFactor', () => {
    const slowIds = Object.values(TERRAIN).filter((t) => t.movement === 'slow').map((t) => t.id);
    // Sanity: this consolidation actually covers a broad swath of terrain (rivers, soft cover,
    // every rubble, desert/snow/urban/volcanic hazards) — not a trivially small/empty set.
    // #275: 4 biome-specific rubble ids (sandRubble/snowRubble/cityRubble/ashRubble) were removed
    // along with their now-gone outposts, so the threshold here dropped accordingly.
    expect(slowIds.length).toBeGreaterThan(15);
    for (const id of slowIds) {
      expect(TERRAIN[id].speedFactor, id).toBe(SLOW_MOVEMENT_FACTOR);
      expect(terrainSpeedFactor(id), id).toBe(SLOW_MOVEMENT_FACTOR);
    }
  });

  it('a representative slow example (river, previously 0.5) now reads the shared constant', () => {
    expect(terrainSpeedFactor('river')).toBe(SLOW_MOVEMENT_FACTOR);
  });

  it('movement:"full" and movement:"none" entries are unaffected by the consolidation', () => {
    for (const id of ['grass', 'sand', 'pavement', 'dock']) {
      expect(movementTier(id)).toBe('full');
      expect(terrainSpeedFactor(id)).toBe(1);
    }
    // Impassable/boundary terrain is 'none', not 'slow' — the consolidation never touches it.
    for (const id of ['deepWater', 'mesa', 'ice', 'collapsed', 'lava']) {
      expect(movementTier(id)).toBe('none');
      expect(isPassable(id)).toBe(false);
    }
  });
});

// #269 §1/§2: soft cover only blocks a SMALL ground unit's LOS — a large unit/mech sees over it.
// The size tier lives in `scenes/arena/shared.js`'s `isSmallUnit`/`unitSize` (issue #269 §2);
// these tests exercise the terrain-layer plumbing (`softCoverBlocksLOS`/`coverBlocksForRay`/
// `shotBlockedAt`) directly against a `smallUnitInvolved` boolean, since that's the boundary this
// module owns — callers compute the boolean via the real per-entity query. The walk-through cover
// terrain (forest/scrub/drift/wreck/fumarole) is the live soft-cover set (#279 briefly flipped
// them to `hard`; a playtest reverted them back to `soft`). Hard cover (base-infra: alertTower/
// dockClosed/objective) blocks unconditionally, subject only to the tier-agnostic own-hex
// exemption #279 generalized (retained on the revert).
describe('#269 §1 soft-cover size-tier plumbing', () => {
  it('softCoverBlocksLOS blocks only when a small unit is involved', () => {
    expect(softCoverBlocksLOS(true)).toBe(true);
    expect(softCoverBlocksLOS(false)).toBe(false);
    expect(softCoverBlocksLOS(undefined)).toBeFalsy();
  });

  it('coverBlocksForRay: hard cover always blocks regardless of size-tier', () => {
    expect(coverBlocksForRay('alertTower', false, false)).toBe(true);
    expect(coverBlocksForRay('alertTower', false, true)).toBe(true);
  });

  it('coverBlocksForRay: #279 generalized the own-hex exemption to hard cover too — it wins regardless of tier (retained on the soft revert)', () => {
    // Even "own hex" exempts hard base-infra cover now — kept from #279 as harmless/robust.
    expect(coverBlocksForRay('alertTower', true, false)).toBe(false);
    expect(coverBlocksForRay('alertTower', true, true)).toBe(false);
  });

  it('coverBlocksForRay: soft cover (forest et al.) blocks only a small unit; own-hex exemption still applies', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(coverBlocksForRay(id, false, false)).toBe(false);  // large unit / mech sees clean over it
      expect(coverBlocksForRay(id, false, true)).toBe(true);    // small unit's sightline is blocked
      expect(coverBlocksForRay(id, true, false)).toBe(false);   // #72 own-hex transparency still works
      expect(coverBlocksForRay(id, true, true)).toBe(false);
    }
  });

  it('coverBlocksForRay: open terrain never blocks', () => {
    expect(coverBlocksForRay('grass', false, false)).toBe(false);
    expect(coverBlocksForRay('grass', true, true)).toBe(false);
  });

  it('shotBlockedAt threads smallUnitInvolved through to the soft-cover exemption', () => {
    const exempt = new Set(['3,-1']);
    expect(shotBlockedAt('forest', '3,-1', exempt, true)).toBe(false);    // own-hex exemption wins
    expect(shotBlockedAt('forest', '2,-1', exempt, true)).toBe(true);     // deep woods still blocks a small unit
    expect(shotBlockedAt('forest', '2,-1', exempt, false)).toBe(false);   // a large unit sees over deep woods
    expect(shotBlockedAt('alertTower', '9,9', exempt, true)).toBe(true);  // hard cover (non-own hex) still blocks
    expect(shotBlockedAt('alertTower', '3,-1', exempt, true)).toBe(false); // #279: own-hex exemption generalized here too
  });
});

// #287 (owner, playtest 2026-07-19: "remove interior base turret hexes now that we have them on
// walls"): the whole `turretEmplacement`/`turretRubble` pair — and the suite that pinned it — is
// gone. #310 put rail-lance guns on the base's WALL RING, which made a second turret-bearing
// structure inside the compound redundant. Guarded below so a stale id can never sneak back in.
describe('#287: the interior turret emplacement is gone entirely', () => {
  it('has no turretEmplacement or turretRubble terrain entry', () => {
    expect(TERRAIN.turretEmplacement).toBeUndefined();
    expect(TERRAIN.turretRubble).toBeUndefined();
  });

  it('leaves no dangling reference from any surviving entry (rubbleId / tex)', () => {
    for (const t of Object.values(TERRAIN)) {
      expect(t.rubbleId ?? null).not.toBe('turretRubble');
      if (t.rubbleId) expect(TERRAIN[t.rubbleId]).toBeDefined();
      expect(t.tex).not.toBe('hex_turretEmplacement');
      expect(t.tex).not.toBe('hex_turretRubble');
    }
  });
});

describe('#313 destructible-structure HP retune (owner-confirmed values)', () => {
  // Before #313 every destructible structure was more fragile than the CHEAPEST combat unit:
  // against #299's toughness scale (tank 80, quadruped 150, light mech 200, sniper 350, player
  // 600) an objective sat at 40 — half a tank — so a four-weapon mech in the ~22-30 DPS band
  // deleted any fortification in well under a second. These are the exact values the owner
  // settled on after reviewing the real numbers; the objective in particular was offered 400 and
  // he revised it DOWN to 200. Pinned here so a future balance pass has to change them
  // deliberately rather than drift.
  it('pins the base-infrastructure HP values', () => {
    expect(buildingHp('alertTower')).toBe(75);
    expect(buildingHp('dockClosed')).toBe(200);
    expect(buildingHp('objective')).toBe(200);
  });

  it('leaves ordinary cover terrain untouched — the retune was structures only', () => {
    // The owner expressed no preference on cover, so forest/scrub/drift/wreck/fumarole keep the
    // values they were playtested at. Walk-through cover you clear incidentally SHOULD stay cheap.
    expect(buildingHp('forest')).toBe(40);
    expect(buildingHp('wreck')).toBe(40);
    expect(buildingHp('scrub')).toBe(30);
    expect(buildingHp('drift')).toBe(30);
    expect(buildingHp('fumarole')).toBe(30);
  });

  it('keeps the alert tower the most snipeable structure, and cover cheaper still', () => {
    // The ordering is the design intent, independent of the exact numbers: racing the tower's
    // wake countdown has to stay viable, so it must remain the softest STRUCTURE — while still
    // sitting above every piece of incidental cover.
    const tower = buildingHp('alertTower');
    for (const id of ['dockClosed', 'objective']) {
      expect(buildingHp(id)).toBeGreaterThan(tower);
    }
    for (const id of ['forest', 'wreck', 'scrub', 'drift', 'fumarole']) {
      expect(buildingHp(id)).toBeLessThan(tower);
    }
  });

  it('puts every structure at or above the cheapest combat unit (the whole point of #313)', () => {
    const CHEAPEST_UNIT_TOUGHNESS = 80;   // #299's tank
    for (const id of ['dockClosed', 'objective']) {
      expect(buildingHp(id)).toBeGreaterThanOrEqual(CHEAPEST_UNIT_TOUGHNESS);
    }
  });
});
