// #337 — the pure region-fog model. These are the merge gate for this issue: every rule Jackson
// stated maps to a test here, and the CADENCE property (region membership only changes at a
// threshold) is asserted directly rather than trusted.
import { describe, it, expect } from 'vitest';
import { axialKey, hexToPixel, range } from './hexgrid.js';
import {
  OPEN_CELL_SIZE, FOG_ALPHA, KNOWN_ALPHA, FOG_SOFT_STEPS,
  buildFogWorld, regionKeyAt, openCellKey, openCellCenter, regionVisibleHexes,
  breachRevealHexes, softFogDepths, fogAlphaFor, enemyVisibleInFog,
} from './fogRegions.js';

// A compact stand-in for a worldgen base: a radius-2 disc of hexes around `center`.
function discBase(id, center, radius = 2) {
  return { id, center, footprint: range(center, radius) };
}

describe('buildFogWorld', () => {
  const world = buildFogWorld([discBase('base0', { q: 0, r: 0 })]);

  it('indexes every footprint hex to its base', () => {
    expect(world.owner.get(axialKey(0, 0))).toBe('base0');
    expect(world.owner.get(axialKey(2, 0))).toBe('base0');
    expect(world.owner.get(axialKey(3, 0))).toBeUndefined();
  });

  it('splits the footprint into an outline (where the walls sit) and an interior', () => {
    // A radius-2 disc: 19 hexes, of which the outer ring (12) touches the outside.
    expect(world.outlines.get('base0').size).toBe(12);
    expect(world.interiors.get('base0').size).toBe(7);
    expect(world.outlines.get('base0').has(axialKey(2, 0))).toBe(true);
    expect(world.interiors.get('base0').has(axialKey(0, 0))).toBe(true);
  });

  it('ignores a base with no footprint rather than half-building it', () => {
    const w = buildFogWorld([{ id: 'empty', footprint: [] }]);
    expect(w.footprints.size).toBe(0);
  });
});

describe('regionKeyAt', () => {
  const world = buildFogWorld([discBase('base0', { q: 0, r: 0 })]);

  it('reports the base region anywhere in the compound, outline included', () => {
    expect(regionKeyAt(0, 0, world)).toBe('base:base0');
    expect(regionKeyAt(2, 0, world)).toBe('base:base0');
  });

  it('reports an open cell outside any compound', () => {
    expect(regionKeyAt(30, 30, world)).toBe(openCellKey(30, 30));
  });

  // THE CADENCE PROPERTY, asserted directly: moving within a cell must not change the region key,
  // which is what makes the whole recompute event-driven instead of continuous.
  it('is constant across a whole open cell and only flips at the boundary', () => {
    const inside = [];
    for (let q = 0; q < OPEN_CELL_SIZE; q++) {
      for (let r = 0; r < OPEN_CELL_SIZE; r++) inside.push(regionKeyAt(q + 100, r + 100, world));
    }
    // (100,100) is not cell-aligned, so sample from an aligned origin instead.
    const base = OPEN_CELL_SIZE * 20;
    const keys = new Set();
    for (let q = 0; q < OPEN_CELL_SIZE; q++) {
      for (let r = 0; r < OPEN_CELL_SIZE; r++) keys.add(regionKeyAt(base + q, base + r, world));
    }
    expect(keys.size).toBe(1);
    expect(regionKeyAt(base + OPEN_CELL_SIZE, base, world)).not.toBe([...keys][0]);
    expect(inside.length).toBe(OPEN_CELL_SIZE * OPEN_CELL_SIZE);
  });

  it('handles negative coordinates without straddling two cells at the origin', () => {
    expect(openCellKey(-1, -1)).not.toBe(openCellKey(0, 0));
    const c = openCellCenter(openCellKey(-1, -1));
    expect(regionKeyAt(c.q, c.r, world)).toBe(openCellKey(-1, -1));
  });
});

describe('regionVisibleHexes', () => {
  const world = buildFogWorld([discBase('base0', { q: 0, r: 0 })]);

  it('inside a compound, lights the whole compound and nothing outside it', () => {
    const v = regionVisibleHexes('base:base0', world);
    expect(v.size).toBe(19);
    expect(v.has(axialKey(0, 0))).toBe(true);
    expect(v.has(axialKey(5, 0))).toBe(false);
  });

  it('outside, lights open ground but NOT the compound interior', () => {
    // A cell whose reveal disc comfortably covers the base at the origin.
    const cell = openCellKey(0, 0);
    const v = regionVisibleHexes(cell, world);
    expect(v.has(axialKey(0, 0))).toBe(false);   // interior stays dark
    expect(v.has(axialKey(2, 0))).toBe(true);    // outline (wall + its turrets) is visible
    expect(v.has(axialKey(8, 0))).toBe(true);    // plain open ground
  });

  it('reveals a disc centred on the cell, so the shape does not depend on exact position', () => {
    const cell = openCellKey(50, 50);
    const a = regionVisibleHexes(cell, world);
    const b = regionVisibleHexes(regionKeyAt(52, 52, buildFogWorld([])), world);
    expect(b.size).toBe(a.size);
  });
});

describe('breachRevealHexes', () => {
  const center = { q: 0, r: 0 };
  const world = buildFogWorld([discBase('base0', center)]);
  // One opening, on the east side of the compound, expressed as a short world-space segment.
  const east = hexToPixel(2, 0);
  const opening = [{ x0: east.x, y0: east.y - 20, x1: east.x, y1: east.y + 20 }];

  it('with no openings, reveals nothing', () => {
    expect(breachRevealHexes('base0', world, []).size).toBe(0);
  });

  it('is GENEROUS by design — an open compound is largely revealed through one gap', () => {
    // This is the caveat Jackson was shown and accepted: the union over ALL exterior angles means
    // anything with an unobstructed line to any part of the gap is lit.
    const revealed = breachRevealHexes('base0', world, opening);
    expect(revealed.size).toBeGreaterThan(10);
    expect(revealed.has(axialKey(0, 0))).toBe(true);
  });

  it('respects still-standing spans — a breach does not light what an intact wall hides', () => {
    const revealed = breachRevealHexes('base0', world, opening, {
      segmentBlocked: () => true,     // every line into the yard crosses an intact span
    });
    expect(revealed.size).toBe(0);
  });

  it('respects hard cover inside the yard', () => {
    const blocked = breachRevealHexes('base0', world, opening, {
      terrainAt: () => 'alertTower',   // hard cover: blocksLOS, impassable
    });
    const open = breachRevealHexes('base0', world, opening);
    expect(blocked.size).toBeLessThan(open.size);
  });

  it('honours the penetration cap when one is set (the tuning knob)', () => {
    const shallow = breachRevealHexes('base0', world, opening, { maxDepth: 1 });
    const full = breachRevealHexes('base0', world, opening);
    expect(shallow.size).toBeLessThan(full.size);
  });

  it('reveals nothing for a base it does not know', () => {
    expect(breachRevealHexes('nope', world, opening).size).toBe(0);
  });
});

describe('soft edges', () => {
  it('ramps alpha over several rings out from the lit frontier', () => {
    const visible = new Set([axialKey(0, 0)]);
    const depths = softFogDepths(visible);
    expect(depths.get(axialKey(1, 0))).toBe(1);
    expect(depths.get(axialKey(2, 0))).toBe(2);
    expect(depths.get(axialKey(FOG_SOFT_STEPS + 1, 0))).toBeUndefined();

    const near = fogAlphaFor(axialKey(1, 0), { visible, known: new Set(), depths });
    const mid = fogAlphaFor(axialKey(2, 0), { visible, known: new Set(), depths });
    const far = fogAlphaFor(axialKey(9, 0), { visible, known: new Set(), depths });
    expect(near).toBeLessThan(mid);
    expect(mid).toBeLessThan(far);
    expect(far).toBeCloseTo(FOG_ALPHA);
  });

  it('is softer than #306 ever was — the ceiling dropped well below its 0.8', () => {
    expect(FOG_ALPHA).toBeLessThan(0.8);
  });

  it('lit hexes are not dimmed at all', () => {
    const visible = new Set([axialKey(0, 0)]);
    expect(fogAlphaFor(axialKey(0, 0), { visible })).toBe(0);
  });

  it('remembered terrain sits between lit and never-seen — the run-long map memory', () => {
    const visible = new Set();
    const known = new Set([axialKey(4, 0)]);
    const a = fogAlphaFor(axialKey(4, 0), { visible, known, depths: new Map() });
    expect(a).toBe(KNOWN_ALPHA);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(FOG_ALPHA);
  });

  it('the soft ramp only ever lightens a remembered hex, never darkens it', () => {
    const visible = new Set([axialKey(0, 0)]);
    const known = new Set([axialKey(1, 0)]);
    const depths = softFogDepths(visible);
    expect(fogAlphaFor(axialKey(1, 0), { visible, known, depths })).toBeLessThanOrEqual(KNOWN_ALPHA);
  });
});

describe('enemyVisibleInFog', () => {
  const hexKeyOf = (x, y) => axialKey(x, y);   // tests address enemies by hex directly
  const lit = new Set([axialKey(0, 0)]);

  it('hides a ground enemy standing in fog', () => {
    expect(enemyVisibleInFog({ x: 9, y: 9 }, { visible: lit, hexKeyOf })).toBe(false);
  });

  it('shows a ground enemy inside the lit region', () => {
    expect(enemyVisibleInFog({ x: 0, y: 0 }, { visible: lit, hexKeyOf })).toBe(true);
  });

  it('always shows an airborne enemy — Jackson: "except for airborn enemies that have launched"', () => {
    expect(enemyVisibleInFog({ x: 9, y: 9, flying: true }, { visible: lit, hexKeyOf })).toBe(true);
  });

  it('hides a flyer that has not launched yet', () => {
    expect(enemyVisibleInFog(
      { x: 9, y: 9, flying: true, airborne: false }, { visible: lit, hexKeyOf },
    )).toBe(false);
  });

  it('always shows a wall turret — it sits ON the boundary, in both regions', () => {
    expect(enemyVisibleInFog({ x: 9, y: 9, spanKey: '1,1/2,1' }, { visible: lit, hexKeyOf })).toBe(true);
  });

  // The symmetry rule, and it is the one that guarantees the player is never shot by something he
  // cannot see: since #316 every unit needs a clear lane before it fires, so "has a lane and is
  // awake" is exactly "could be shooting me".
  it('shows an awake enemy with a firing lane even from deep fog', () => {
    expect(enemyVisibleInFog(
      { x: 9, y: 9 }, { visible: lit, hexKeyOf, losClear: true, awake: true },
    )).toBe(true);
  });

  it('does NOT show a dormant enemy that merely happens to have a clear lane', () => {
    expect(enemyVisibleInFog(
      { x: 9, y: 9 }, { visible: lit, hexKeyOf, losClear: true, awake: false },
    )).toBe(false);
  });

  it('does not gate anything before the fog has been computed', () => {
    expect(enemyVisibleInFog({ x: 9, y: 9 }, { visible: null, hexKeyOf })).toBe(true);
  });

  it('is false for a missing enemy rather than throwing', () => {
    expect(enemyVisibleInFog(null, { visible: lit, hexKeyOf })).toBe(false);
  });
});
