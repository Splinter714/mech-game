import { describe, it, expect, vi } from 'vitest';
import {
  TERRAIN, getTerrain, terrainSpeedFactor, isPassable, blocksLOS,
  isDestructible, buildingHp, damageBuilding, RUBBLE, rubbleFor,
  isSoftCover, shotBlockedAt, FLAME_COVER_MULT, flameCoverDamage,
  isWaterTerrain, isMissionObjective, terrainDisplayName,
  SLOW_MOVEMENT_FACTOR, movementTier, coverTier, isBaseCategory,
  coverBlocksForRay, NATURAL_TERRAIN_DESTRUCTIBLE,
  clearedSoftCoverFor, softCoverStopsShot, softCoverHexBlockChance,
  SOFT_COVER_HEX_BLOCK_CHANCE, SOFT_COVER_OWN_HEX_BLOCK_CHANCE,
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

  it('isDestructible + buildingHp: fabricated base structures have HP; natural terrain and open ground do not (#351)', () => {
    expect(isDestructible('alertTower')).toBe(true);
    expect(buildingHp('alertTower')).toBe(TERRAIN.alertTower.hp);
    // #351: natural terrain is permanent scenery now — see the dedicated describe block below.
    expect(isDestructible('forest')).toBe(false);
    expect(buildingHp('forest')).toBe(0);
    for (const id of ['grass', 'river', 'deepWater', 'rubble', undefined]) {
      expect(isDestructible(id)).toBe(false);
      expect(buildingHp(id)).toBe(0);
    }
  });
});

// #351 (owner-confirmed experiment, 2026-07-19): "nature is permanent, their stuff isn't."
// ALL natural terrain — forests/foliage AND boulders/rock — is indestructible and untargetable;
// only fabricated `category: 'base'` structures stay destructible. Reversed by flipping the single
// `NATURAL_TERRAIN_DESTRUCTIBLE` constant in terrain.js back to `true`.
describe('#351 natural terrain is permanent scenery — indestructible + untargetable', () => {
  it('is off by default (the experiment is live)', () => {
    expect(NATURAL_TERRAIN_DESTRUCTIBLE).toBe(false);
  });

  it('no `category: terrain` entry is destructible or carries live HP, whatever its raw flags say', () => {
    for (const t of Object.values(TERRAIN)) {
      if (t.category !== 'terrain') continue;
      expect(isDestructible(t.id)).toBe(false);
      expect(buildingHp(t.id)).toBe(0);
      expect(isMissionObjective(t.id)).toBe(false);
    }
  });

  it('every soft-cover natural hex specifically — forests, foliage, rock debris — is now permanent', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(isDestructible(id)).toBe(false);
      expect(buildingHp(id)).toBe(0);
    }
  });

  it('leaves fabricated base structures fully destructible and targetable', () => {
    for (const id of ['alertTower', 'dockClosed', 'objective']) {
      expect(isDestructible(id)).toBe(true);
      expect(buildingHp(id)).toBe(TERRAIN[id].hp);
    }
    // The objective is still the one non-set-dressing assault target.
    expect(isMissionObjective('objective')).toBe(true);
    expect(isMissionObjective('alertTower')).toBe(false);
    expect(isMissionObjective('dockClosed')).toBe(false);
  });

  // #374 UPDATED this test. It used to pin "#351 did not touch cover" by asserting the size-tier
  // block (small unit concealed / mech shoots over). #374 DID change cover — deliberately — so
  // what survives here is the part #351 is actually responsible for: the soft TIER itself, and the
  // fact that indestructibility left tier/passability alone. The block rule is pinned below.
  it('does NOT touch the cover TIER — indestructibility and cover stay orthogonal', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(coverTier(id)).toBe('soft');
      expect(isSoftCover(id)).toBe(true);
      expect(blocksLOS(id)).toBe(true);
      expect(isPassable(id)).toBe(true);
    }
  });

  it('keeps the #313 HP values as dead-but-intact data, so flipping the flag restores the old tuning', () => {
    // Deliberately NOT deleted (issue #351 note): the raw declarations survive untouched.
    expect(TERRAIN.forest.destructible).toBe(true);
    expect(TERRAIN.forest.hp).toBe(40);
    expect(TERRAIN.wreck.hp).toBe(40);
    expect(TERRAIN.scrub.hp).toBe(30);
    expect(TERRAIN.drift.hp).toBe(30);
    expect(TERRAIN.fumarole.hp).toBe(30);
    // #464: the per-biome `*Rubble` tiles those entries used to name are GONE — unreachable art
    // while the flag is off. A revert falls back to the generic masonry `RUBBLE` instead.
    expect(rubbleFor('forest')).toBe(RUBBLE);
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

  // #374 UPDATED this test: it used to assert the #269 size tier (small unit blocked, mech not).
  // Soft cover now blocks NO ONE geometrically — the protection moved to `softCoverStopsShot`.
  it('#374 blocks NOBODY geometrically — no size tier, no exceptions', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(coverBlocksForRay(id, false)).toBe(false);
      expect(coverBlocksForRay(id, true)).toBe(false);
    }
  });

  // #351 flipped natural terrain to permanent scenery, so these now assert the RAW declarations
  // (`TERRAIN[id].hp`) rather than the live `buildingHp()` rule — the data that comes back if the
  // `NATURAL_TERRAIN_DESTRUCTIBLE` flag is flipped back to `true`.
  it('every cover terrain declares LESS HP than a full base-infra structure, and would flatten to passable no-cover ground', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(TERRAIN[id].destructible).toBe(true);
      expect(TERRAIN[id].hp).toBeGreaterThan(0);
      expect(TERRAIN[id].hp).toBeLessThanOrEqual(TERRAIN.objective.hp);
      const rub = rubbleFor(id);
      expect(isPassable(rub)).toBe(true);
      expect(blocksLOS(rub)).toBe(false);
    }
  });

  // #464 REPLACES the old "cover terrain flattens to its own biome rubble" test. The five bespoke
  // `*Rubble` tiles are deleted (unreachable since #351 made natural terrain indestructible), so
  // every soft-cover entry falls through `rubbleFor` to the generic masonry `RUBBLE`. What cover
  // DOES have — and the only transition it can actually make in play — is its #405 cleared ground.
  it('cover terrain no longer declares a bespoke rubble id; it declares a cleared ground id', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(TERRAIN[id].rubbleId, id).toBeUndefined();
      expect(rubbleFor(id), id).toBe(RUBBLE);
      expect(clearedSoftCoverFor(id), id).toBe(`${id}Cleared`);
    }
  });

  // #374 UPDATED this test. It used to drive the own-hex exemption with smallUnitInvolved=true,
  // because that was the only way soft cover blocked at all. With the size tier gone, soft cover
  // never blocks here for anyone — exempt hex or not, deep woods or not.
  it('shotBlockedAt: soft cover no longer blocks a shot at ANY hex, exempt or not (#374)', () => {
    const exempt = new Set(['3,-1']);
    expect(shotBlockedAt('forest', '3,-1', exempt)).toBe(false);   // the target's own hex
    expect(shotBlockedAt('forest', '2,-1', exempt)).toBe(false);   // deep woods on the way
    expect(shotBlockedAt('forest', '3,-1', null)).toBe(false);     // no exemption set at all
    expect(shotBlockedAt('forest', '3,-1', new Set())).toBe(false);
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
    // #351: reads the raw declared HP — the flame-vs-cover MATH is still exercised (it governs
    // base structures too, and is what the natural-terrain flag would restore).
    let hp = TERRAIN.forest.hp, ticks = 0, destroyed = false;
    while (!destroyed && ticks < 100) { ({ hp, destroyed } = damageBuilding(hp, perTick)); ticks++; }
    expect(destroyed).toBe(true);
    expect(ticks * 0.5).toBeLessThanOrEqual(2);   // cleared in ≤2s of burning
  });

  it('a forest hex WOULD clear in a few shots if natural terrain were destructible again (#351: raw HP)', () => {
    // Autocannon-class hit: 16 damage. Forest must take more than 1 shot but not many.
    let hp = TERRAIN.forest.hp, shots = 0, destroyed = false;
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
      // #464: the five `*Rubble` soft-cover debris ids are gone; their cleared counterparts (which
      // are what a soft-cover hex actually becomes) take their place in this negative list.
      'grass', 'grassB', 'forest', 'rubble', 'forestCleared', 'mud',
      'sand', 'sandB', 'dryRiver', 'mesa', 'scrub', 'scrubCleared', 'quicksand',
      'snow', 'snowB', 'drift', 'driftCleared',
      'pavement', 'pavementB', 'collapsed', 'wreck', 'wreckCleared', 'debris',
      'ash', 'ashB', 'crust', 'lava', 'fumarole', 'fumaroleCleared', 'cinderField',
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

// #464 REPLACES #227's suite. #227 gave each biome's soft cover its own bespoke debris tile
// (charred plant debris / dead brush / ice shards / burnt scraps / cinders) so a destroyed thicket
// wouldn't read as broken masonry. #351 then made natural terrain permanent scenery, which took
// soft cover out of `buildingHp`/`coverHp` entirely — so nothing could ever reach `rubbleFor` for
// it and those five tiles became unrenderable. They're deleted; what remains is the guarantee that
// the ids are GONE, not merely unused, so a future reader isn't misled into thinking they render.
describe('#464 — the bespoke soft-cover rubble tiles are gone entirely', () => {
  it('has no *Rubble terrain entry for any soft cover', () => {
    for (const id of ['forestRubble', 'scrubRubble', 'driftRubble', 'wreckRubble', 'fumaroleRubble']) {
      expect(TERRAIN[id], id).toBeUndefined();
    }
  });

  it('every soft-cover hex now falls through to the generic passable, no-cover rubble', () => {
    for (const soft of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(rubbleFor(soft), soft).toBe(RUBBLE);
      expect(isPassable(RUBBLE)).toBe(true);
      expect(blocksLOS(RUBBLE)).toBe(false);
    }
  });
});

// #464: the five soft-cover ids share their CLEARED twin's ground texture — the lumps have lived
// in the separate #289 canopy overlay since then, so the intact tile was a near-duplicate of the
// cleared one. Pinned because it breaks the once-safe `'hex_' + id` assumption: anything needing a
// terrain's texture must read `.tex`, and anything needing its canopy must key off the ID.
describe('#464 — intact soft cover shares its cleared twin\'s ground texture', () => {
  it('each soft-cover entry points tex at its clearedId\'s texture', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      const cleared = TERRAIN[id].clearedId;
      expect(cleared, id).toBe(`${id}Cleared`);
      expect(TERRAIN[id].tex, id).toBe(TERRAIN[cleared].tex);
      expect(TERRAIN[id].tex, id).not.toBe(`hex_${id}`);
    }
  });

  it('leaves the cover CONTRACT untouched — only the ground raster is shared', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(isSoftCover(id), id).toBe(true);
      expect(blocksLOS(id), id).toBe(true);
      expect(isSoftCover(TERRAIN[id].clearedId), id).toBe(false);
      expect(blocksLOS(TERRAIN[id].clearedId), id).toBe(false);
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
    // #464: the 5 soft-cover `*Rubble` ids went too (17 slow entries left, still comfortably over).
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

// #269 §1/§2, REWRITTEN BY #374. This block used to pin the size-tiered geometric rule: soft cover
// blocked a SMALL ground unit's ray and not a mech's, threaded through `softCoverBlocksLOS`/
// `coverBlocksForRay`/`shotBlockedAt` as a `smallUnitInvolved` boolean. Jackson removed that
// outright ("that shot blocking shouldn't happen anymore") and replaced it with a per-shot
// probability rolled at the TARGET, graded by the target's unit tier. So the tests below keep the
// same subject — how well does soft cover protect a unit — and swap what they assert about it.
// Hard cover (base-infra: alertTower/dockClosed/objective) is untouched throughout: it still blocks
// unconditionally, subject only to the tier-agnostic own-hex exemption #279 generalized.
describe('#374 REWORK — soft cover is a PER-HEX LANE roll', () => {
  const SOFT = ['forest', 'scrub', 'drift', 'wreck', 'fumarole'];
  // A scripted "rng" so every probabilistic assertion below is deterministic — the injectable
  // `rng` parameter exists precisely so this rule is testable without statistics.
  const rngOf = (...values) => { let i = 0; return () => values[i++ % values.length]; };
  // A lane of `n` plain crossed soft-cover hexes, optionally ending on the target's own hex.
  const lane = (n, own = false, id = 'forest') => [
    ...Array.from({ length: n }, () => ({ id, ownHex: false })),
    ...(own ? [{ id, ownHex: true }] : []),
  ];

  // (This block used to pin the FIRST #374 landing: one roll against the target's own hex only,
  // `SOFT_COVER_BLOCK_CHANCE = { vehicle: 0.75, mech: 0.25, air: 0 }`. That rule is gone — the
  // rework replaced it with an independent 10% roll per crossed hex plus a destination bump.)
  it('the dials are the ones Jackson named: 10% per crossed hex, own hex 25% non-mech / 10% mech / 0 air', () => {
    expect(SOFT_COVER_HEX_BLOCK_CHANCE).toBe(0.10);
    expect(SOFT_COVER_OWN_HEX_BLOCK_CHANCE).toEqual({ vehicle: 0.25, mech: 0.10, air: 0 });
    // a plain crossed hex is 10% for every ground tier — the tier only grades the own hex
    expect(softCoverHexBlockChance('vehicle')).toBe(0.10);
    expect(softCoverHexBlockChance('mech')).toBe(0.10);
    expect(softCoverHexBlockChance('air')).toBe(0);
    // the own hex: the bump REPLACES the base 10%, it is not added to it
    expect(softCoverHexBlockChance('vehicle', true)).toBe(0.25);
    expect(softCoverHexBlockChance('mech', true)).toBe(0.10);
    expect(softCoverHexBlockChance('air', true)).toBe(0);
  });

  it('an unknown tier falls back to the plain per-hex chance rather than a guessed bonus', () => {
    expect(softCoverHexBlockChance('nope')).toBe(0.10);
    expect(softCoverHexBlockChance('nope', true)).toBe(0.10);
  });

  // #374 block-visual: `softCoverStopsShot` now returns the BLOCKING lane hex (so the caller can
  // detonate a leaf puff at it) when eaten, or `null` when the shot gets through. A blocked roll
  // returns the very entry that rolled the block.
  it('rolls strictly BELOW the chance — the boundary lands on "not blocked"', () => {
    for (const id of SOFT) {
      const crossed = { id, ownHex: false };
      const own = { id, ownHex: true };
      expect(softCoverStopsShot([crossed], 'mech', () => 0.09)).toBe(crossed);
      expect(softCoverStopsShot([crossed], 'mech', () => 0.10)).toBeNull();
      expect(softCoverStopsShot([own], 'vehicle', () => 0.24)).toBe(own);
      expect(softCoverStopsShot([own], 'vehicle', () => 0.25)).toBeNull();
      // a MECH gets no own-hex bonus: a roll a vehicle would be saved by passes straight through
      expect(softCoverStopsShot([own], 'mech', () => 0.20)).toBeNull();
      expect(softCoverStopsShot([own], 'vehicle', () => 0.20)).toBe(own);
    }
  });

  // THE HEADLINE: independent per-hex rolls, so depth of woods compounds.
  it('rolls INDEPENDENTLY PER HEX — three forest hexes compound to ~27%, not 10%', () => {
    // 0.05 < 0.10 blocks on the FIRST hex; three hexes all rolling 0.5 get through.
    expect(softCoverStopsShot(lane(3), 'mech', () => 0.5)).toBeNull();
    expect(softCoverStopsShot(lane(3), 'mech', () => 0.05)).toBeTruthy();
    // only the THIRD hex rolls under: still blocked — a later hex can save nothing.
    expect(softCoverStopsShot(lane(3), 'mech', rngOf(0.5, 0.5, 0.05))).toBeTruthy();
    // one draw is taken per crossed hex until one blocks
    const rng = vi.fn(() => 0.5);
    softCoverStopsShot(lane(3), 'mech', rng);
    expect(rng).toHaveBeenCalledTimes(3);
    // and the walk short-circuits the moment a hex eats the shot
    const rng2 = vi.fn(() => 0.01);
    softCoverStopsShot(lane(3), 'mech', rng2);
    expect(rng2).toHaveBeenCalledTimes(1);
  });

  it('the compounded rate over N hexes is 1 - 0.9^N (measured against a uniform rng)', () => {
    // A deterministic uniform sweep stands in for the statistics: fraction of 1000 evenly-spaced
    // draws that end up blocked, for a lane of N plain hexes.
    const rateFor = (n) => {
      let blocked = 0;
      for (let i = 0; i < 1000; i++) {
        // each shot re-walks its lane with a fresh independent stream
        let s = i;
        const rng = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
        if (softCoverStopsShot(lane(n), 'mech', rng)) blocked++;
      }
      return blocked / 1000;
    };
    expect(rateFor(1)).toBeCloseTo(1 - 0.9 ** 1, 1);   // ~10%
    expect(rateFor(2)).toBeCloseTo(1 - 0.9 ** 2, 1);   // ~19%
    expect(rateFor(3)).toBeCloseTo(1 - 0.9 ** 3, 1);   // ~27%
  });

  // PER PROJECTILE, not per trigger pull: each round of a salvo asks separately off one shared
  // rng stream, so a volley loses SOME of its rounds — never all or none.
  it('a 6-missile salvo over three hexes loses some rounds and lands the rest', () => {
    // stream: hex rolls for six rounds x up to three hexes. Rounds 2 and 5 are eaten.
    const rng = rngOf(
      0.5, 0.5, 0.5,   // round 1 — through
      0.01,            // round 2 — eaten on its first hex
      0.5, 0.5, 0.5,   // round 3 — through
      0.5, 0.5, 0.5,   // round 4 — through
      0.5, 0.01,       // round 5 — eaten on its second hex
      0.5, 0.5, 0.5,   // round 6 — through
    );
    const salvo = Array.from({ length: 6 }, () => !!softCoverStopsShot(lane(3), 'mech', rng));
    expect(salvo).toEqual([false, true, false, false, true, false]);
    expect(salvo.filter(Boolean)).toHaveLength(2);   // partial attrition, not all-or-nothing
  });

  it('an AIR target ignores the WHOLE lane, not just its own hex — the rng is never consulted', () => {
    const rng = vi.fn(() => 0);
    expect(softCoverStopsShot(lane(5, true), 'air', rng)).toBeNull();
    expect(rng).not.toHaveBeenCalled();
    // ...and the same lane absolutely does block a ground target
    expect(softCoverStopsShot(lane(5, true), 'mech', () => 0)).toBeTruthy();
  });

  it('only SOFT cover in the lane rolls — open ground and hard cover contribute nothing', () => {
    for (const id of ['grass', 'river', 'deepWater', 'rubble', 'alertTower', 'objective', 'dockClosed', undefined, 'nope']) {
      expect(softCoverStopsShot([{ id, ownHex: false }, { id, ownHex: true }], 'vehicle', () => 0)).toBeNull();
    }
    // a mixed lane rolls only its soft hexes
    const rng = vi.fn(() => 0.5);
    softCoverStopsShot([{ id: 'grass' }, { id: 'forest' }, { id: 'alertTower' }], 'mech', rng);
    expect(rng).toHaveBeenCalledTimes(1);
  });

  // #72/#279's own-hex exemption, carried into the lane rule: it is now expressed as the
  // shooter's muzzle hex being OMITTED from the lane, so brawling in one thicket yields an
  // EMPTY lane. (The scene-side half of this is pinned in scenes/arena/softCoverBlock.test.js.)
  it('an empty lane never rolls — the brawling-in-one-thicket exemption', () => {
    const rng = vi.fn(() => 0);
    expect(softCoverStopsShot([], 'vehicle', rng)).toBeNull();
    expect(softCoverStopsShot(null, 'vehicle', rng)).toBeNull();
    expect(rng).not.toHaveBeenCalled();
  });

  it('is deterministic given a seeded rng — the same sequence yields the same outcomes', () => {
    const seq = [0.05, 0.9, 0.2, 0.99, 0.5];
    const run = () => seq.map((_, i) => !!softCoverStopsShot(lane(2), 'mech', rngOf(...seq.slice(i))));
    expect(run()).toEqual(run());
    // one plain hex @ 10%: below ⇒ eaten, above ⇒ through.
    expect(seq.map((v) => !!softCoverStopsShot(lane(1), 'mech', () => v)))
      .toEqual([true, false, false, false, false]);
  });

  it('defaults to Math.random when no rng is injected (production callers may omit it)', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(softCoverStopsShot(lane(1), 'mech')).toBeTruthy();
    spy.mockRestore();
  });

  it('coverBlocksForRay: hard cover always blocks', () => {
    expect(coverBlocksForRay('alertTower', false)).toBe(true);
  });

  it('coverBlocksForRay: #279 generalized the own-hex exemption to hard cover too — it wins regardless of tier (retained on the soft revert)', () => {
    // Even "own hex" exempts hard base-infra cover now — kept from #279 as harmless/robust.
    expect(coverBlocksForRay('alertTower', true)).toBe(false);
  });

  it('coverBlocksForRay: soft cover never blocks a ray, exempt hex or not (#374)', () => {
    for (const id of ['forest', 'scrub', 'drift', 'wreck', 'fumarole']) {
      expect(coverBlocksForRay(id, false)).toBe(false);
      expect(coverBlocksForRay(id, true)).toBe(false);          // #72 own-hex transparency still works
    }
  });

  it('coverBlocksForRay: open terrain never blocks', () => {
    expect(coverBlocksForRay('grass', false)).toBe(false);
    expect(coverBlocksForRay('grass', true)).toBe(false);
  });

  // #374 UPDATED: this used to assert `shotBlockedAt` THREADED the size-tier boolean. There is no
  // such parameter now, so what it pins is that soft cover drops out of the blocking answer while
  // hard cover (and #279's own-hex generalization of it) is left exactly as it was.
  it('shotBlockedAt: soft cover drops out entirely; hard cover and its own-hex exemption are untouched', () => {
    const exempt = new Set(['3,-1']);
    expect(shotBlockedAt('forest', '3,-1', exempt)).toBe(false);          // own-hex, as before
    expect(shotBlockedAt('forest', '2,-1', exempt)).toBe(false);          // #374: deep woods no longer blocks
    expect(shotBlockedAt('alertTower', '9,9', exempt)).toBe(true);        // hard cover (non-own hex) still blocks
    expect(shotBlockedAt('alertTower', '3,-1', exempt)).toBe(false);      // #279: own-hex exemption generalized here too
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
  // against #299's toughness scale (tank 80, carrier 150, light mech 200, sniper 350, player
  // 600) an objective sat at 40 — half a tank — so a four-weapon mech in the ~22-30 DPS band
  // deleted any fortification in well under a second. These are the exact values the owner
  // settled on after reviewing the real numbers; the objective in particular was offered 400 and
  // he revised it DOWN to 200. Pinned here so a future balance pass has to change them
  // deliberately rather than drift.
  // #363 retuned dockClosed 200 -> 100 (owner-confirmed): #326 removed dock reinforcement caps and
  // #333/#354 raised docks to 5-8 per base, so docks went from optional to mandatory and 200 each
  // was a slog. alertTower and objective keep their #313 values.
  it('pins the base-infrastructure HP values', () => {
    expect(buildingHp('alertTower')).toBe(75);
    expect(buildingHp('dockClosed')).toBe(100);
    expect(buildingHp('objective')).toBe(200);
  });

  it('leaves ordinary cover terrain untouched — the retune was structures only', () => {
    // The owner expressed no preference on cover, so forest/scrub/drift/wreck/fumarole keep the
    // values they were playtested at. Walk-through cover you clear incidentally SHOULD stay cheap.
    // #351 made these values DEAD DATA (natural terrain is indestructible now) — asserted on the
    // raw entries rather than `buildingHp()` so the retune survives intact for a revert.
    expect(TERRAIN.forest.hp).toBe(40);
    expect(TERRAIN.wreck.hp).toBe(40);
    expect(TERRAIN.scrub.hp).toBe(30);
    expect(TERRAIN.drift.hp).toBe(30);
    expect(TERRAIN.fumarole.hp).toBe(30);
  });

  it('keeps the alert tower the most snipeable structure, and cover cheaper still', () => {
    // The ordering is the design intent, independent of the exact numbers: racing the tower's
    // wake countdown has to stay viable, so it must remain the softest STRUCTURE — while still
    // sitting above every piece of incidental cover.
    const tower = buildingHp('alertTower');
    for (const id of ['dockClosed', 'objective']) {
      expect(buildingHp(id)).toBeGreaterThan(tower);
    }
    // #351: cover's raw declared HP (it has no LIVE hp any more — natural terrain is permanent).
    for (const id of ['forest', 'wreck', 'scrub', 'drift', 'fumarole']) {
      expect(TERRAIN[id].hp).toBeLessThan(tower);
    }
  });

  it('puts every structure at or above the cheapest combat unit (the whole point of #313)', () => {
    const CHEAPEST_UNIT_TOUGHNESS = 80;   // #299's tank
    for (const id of ['dockClosed', 'objective']) {
      expect(buildingHp(id)).toBeGreaterThanOrEqual(CHEAPEST_UNIT_TOUGHNESS);
    }
  });
});

describe('terrainDisplayName (#483 — the target-readout label for a locked hex)', () => {
  it('uses friendly overrides for the lockable base structures and rubble', () => {
    expect(terrainDisplayName('dockClosed')).toBe('DOCK');
    expect(terrainDisplayName('alertTower')).toBe('ALERT TOWER');
    expect(terrainDisplayName('objective')).toBe('OBJECTIVE');
    expect(terrainDisplayName('rubble')).toBe('RUBBLE');
  });

  it('humanises camelCase ids that have no override', () => {
    expect(terrainDisplayName('grassB')).toBe('GRASS B');
    expect(terrainDisplayName('deepWater')).toBe('DEEP WATER');
  });

  it('is a safe non-empty label for a missing id', () => {
    expect(terrainDisplayName(undefined)).toBe('STRUCTURE');
    expect(terrainDisplayName(null)).toBe('STRUCTURE');
  });
});
