import { describe, it, expect } from 'vitest';
import {
  HEX_BLEED, HEX_TEX_W, HEX_TEX_H, BASE_INFRA_COLOR, terrainFillColor,
  buildHexTextures, COVER_CANOPY_IDS, canopyTexKey, isCoverCanopyId, BOUNDARY_ONLY_IDS,
} from './hexArt.js';
import { ART_SCALE } from './_frames.js';
import { BIOMES, BIOME_IDS } from '../data/biomes.js';
import { HEX_SIZE, hexCorners, hexToPixel } from '../data/hexgrid.js';
import { TERRAIN } from '../data/terrain.js';

const SQRT3 = Math.sqrt(3);

// #255: hairline seams between adjacent hex tiles. hexToPixel places tile centres at their
// exact (irrational) tessellating spacing, and the placement math itself has no rounding
// (see hexgrid.test.js's round-trip coverage) — the seam comes from the RENDERED tile's own
// polygon fading to fully transparent exactly at the true hex boundary, combined with
// Phaser's `roundPixels` (forced on by `pixelArt: true`, main.js) snapping each tile's
// on-screen position independently every frame as the camera scrolls. The fix is bleeding
// each tile's outer polygon `HEX_BLEED` px past the true radius so its opaque interior
// already covers the boundary — these are pure-geometry checks that the bleed actually
// creates overlap (not just a bigger number) and that the texture canvas still comfortably
// contains the bled shape.
describe('hex tile edge bleed (#255 seam fix)', () => {
  it('HEX_BLEED is a positive amount of overdraw', () => {
    expect(HEX_BLEED).toBeGreaterThan(0);
  });

  it('an un-bled hex exactly touches (zero overlap, zero gap) its same-row neighbour', () => {
    // Pointy-top apothem (centre-to-flat-side) = size * sqrt3/2, which for HEX_SIZE is also
    // exactly half of hexToPixel's same-row neighbour spacing — confirms the boundary case
    // this bleed is meant to move away from.
    const apothem = HEX_SIZE * (SQRT3 / 2);
    const { x } = hexToPixel(1, 0);
    expect(apothem).toBeCloseTo(x / 2, 10);
  });

  it('the bled hex genuinely overlaps its neighbour at the shared edge', () => {
    const bledApothem = (HEX_SIZE + HEX_BLEED) * (SQRT3 / 2);
    const { x } = hexToPixel(1, 0); // same-row neighbour centre spacing
    const halfSpacing = x / 2;
    // The bled polygon's flat side now sits PAST the midpoint between the two centres —
    // i.e. this tile's opaque paint reaches into the neighbour's half of the boundary.
    expect(bledApothem).toBeGreaterThan(halfSpacing);
  });

  it('every bled corner still fits inside the texture canvas with room for its own AA ring', () => {
    const corners = hexCorners(HEX_SIZE + HEX_BLEED);
    const halfW = HEX_TEX_W / 2, halfH = HEX_TEX_H / 2;
    const AA_MARGIN = 0.4; // px of slack left for the bled edge's own anti-alias fade
    for (const p of corners) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(halfW - AA_MARGIN);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(halfH - AA_MARGIN);
    }
  });
});

// #269 playtest follow-up: `dock` and `alertTower` used to reuse the (since-removed, #275)
// `helipad`/`tower` outpost textures verbatim, which made them indistinguishable from a real
// helipad / a regular destructible outpost building in play. Each now has its own PAL entry
// (buildHexTextures wires every non-abstract PAL key to a `hex_<key>` texture automatically) —
// these checks confirm the wiring exists and terrain.js actually points at it, without needing a
// real Phaser scene to bake the textures.
describe('dock/alertTower distinct textures (#269 playtest follow-up)', () => {
  it('terrain.js points dock and alertTower at their own distinct texture keys', () => {
    expect(TERRAIN.dock.tex).toBe('hex_dock');
    expect(TERRAIN.alertTower.tex).toBe('hex_alertTower');
    expect(TERRAIN.dock.tex).not.toBe(TERRAIN.alertTower.tex);
  });

  it('alertTower stays on the shared base-infrastructure fill colour', () => {
    expect(terrainFillColor('alertTower')).toBe(BASE_INFRA_COLOR.fill);
  });

  // #395: a `dock` hex is now a recessed BLACK BAY (the doors are separate sliding sprites), so it
  // no longer shares the base-infra concrete fill — it's a distinctly darker shaft.
  it('dock is now a dark bay fill, distinct from the base-infra concrete', () => {
    const bay = terrainFillColor('dock');
    expect(bay).not.toBe(BASE_INFRA_COLOR.fill);
    expect(terrainFillColor('dockClosed')).toBe(bay);   // both dock states share the same black bay
    expect(bay).toBeLessThan(0x222222);                 // unambiguously dark
  });
});

// #289: cover terrain (forest/scrub/drift/wreck/fumarole) now bakes a SECOND, separate texture —
// a transparent-background canopy/foliage overlay — alongside its existing ground texture, so
// world.js can place both as independent Images at different depths. A fake Phaser-shaped
// `scene.make.graphics()` stands in for the real canvas (mirrors dockResupply.test.js's approach
// elsewhere in the codebase); `generateTexture` just records which keys got baked, so these
// checks confirm the REGISTRY wiring (every cover id gets both a ground key and a canopy key)
// without needing a real GPU/canvas context.
function fakeGraphicsScene() {
  const registered = new Set();
  const noop = () => {};
  return {
    make: {
      graphics: () => ({
        fillStyle: noop, lineStyle: noop, fillRect: noop, fillCircle: noop,
        fillEllipse: noop, fillTriangle: noop, fillPoints: noop,
        generateTexture: (key) => registered.add(key),
        destroy: noop,
      }),
    },
    textures: { exists: () => false, get: () => ({ getSourceImage: () => ({ getContext: () => null }) }) },
    _registered: registered,
  };
}

describe('cover terrain ground/canopy texture split (#289)', () => {
  it('lists exactly the 5 walk-through cover terrain ids', () => {
    expect([...COVER_CANOPY_IDS].sort()).toEqual(['drift', 'forest', 'fumarole', 'scrub', 'wreck'].sort());
  });

  it('canopyTexKey accepts both a bare terrain id and a hex_-prefixed texture key', () => {
    expect(canopyTexKey('forest')).toBe('hex_forest_canopy');
    expect(canopyTexKey('hex_forest')).toBe('hex_forest_canopy');
  });

  it('isCoverCanopyId is true only for the 5 cover ids, false for ordinary terrain', () => {
    for (const id of COVER_CANOPY_IDS) {
      expect(isCoverCanopyId(id)).toBe(true);
      expect(isCoverCanopyId(`hex_${id}`)).toBe(true);
    }
    expect(isCoverCanopyId('grass')).toBe(false);
    expect(isCoverCanopyId('hex_alertTower')).toBe(false);
  });

  // #464: a cover id's GROUND texture is whatever its TERRAIN entry names — since the merge that's
  // its cleared twin's tile (`hex_forestCleared`), not `hex_<id>`. The canopy key is still derived
  // from the ID, which is exactly the split this asserts.
  it('buildHexTextures bakes both a ground texture and a canopy texture for every cover id', () => {
    const scene = fakeGraphicsScene();
    buildHexTextures(scene);
    for (const id of COVER_CANOPY_IDS) {
      expect(scene._registered.has(TERRAIN[id].tex), id).toBe(true);
      expect(scene._registered.has(canopyTexKey(id)), id).toBe(true);
      // The old per-id ground tile is genuinely gone, not just unreferenced.
      expect(scene._registered.has(`hex_${id}`), id).toBe(false);
    }
    // Non-cover terrain (e.g. plain grass) still gets exactly its one ground texture — no
    // canopy key is ever baked for it.
    expect(scene._registered.has('hex_grass')).toBe(true);
    expect(scene._registered.has('hex_grass_canopy')).toBe(false);
  });
});

// #464 (playtest, owner: "I'm still seeing the art for the deep hexes, which we talked about not
// needing"). The five world-boundary-only ids are the biomes' `deep` role. #222's 4th pass stopped
// placing ring tiles in the arena entirely (the ring is one flat camera-background fill), so their
// baked tiles had no renderer left except the art gallery — where they showed as five flat swatches.
// The tiles are gone; the PAL fill they were drawn from stays, because that IS the background fill.
describe('world-boundary "deep" terrain has no baked tile (#464)', () => {
  it('bakes no ground texture for any boundary-only id', () => {
    const scene = fakeGraphicsScene();
    buildHexTextures(scene);
    for (const id of BOUNDARY_ONLY_IDS) {
      expect(scene._registered.has(`hex_${id}`), id).toBe(false);
      expect(scene._registered.has(TERRAIN[id].tex), id).toBe(false);
    }
  });

  it('still exposes each boundary id\'s fill colour for the camera background', () => {
    for (const id of BOUNDARY_ONLY_IDS) {
      expect(typeof terrainFillColor(id), id).toBe('number');
    }
  });

  it('every biome\'s deep role is a boundary-only id, so no biome loses a rendered tile', () => {
    for (const bid of BIOME_IDS) expect(BOUNDARY_ONLY_IDS.has(BIOMES[bid].deep), bid).toBe(true);
  });
});

// #447 (owner: "hexes like mud shouldn't have a central art pattern, they should have a generally
// diffuse, vague texture"). A hex is HEX_SIZE=48 across, but mud's detail used to be a single
// 24x14 puddle ellipse plus two pockmarks and a crack, all inside ~±12px of the centre — a small
// stamped motif in the middle of a large flat tile, identical on every mud hex. These checks pin
// the property that matters and is invisible to eyeball-by-diff: the detail marks reach out to the
// tile's edges in EVERY direction, so no centre reads as "the pattern".
//
// The recording scene captures the shapes each texture's draw fn emits, keyed by the texture name
// `generateTexture` is finally called with. Coordinates come through scaled by ART_SCALE (the
// super-sampling wrapper), so they're divided back down to the design grid here.
function recordingScene() {
  const drawn = {};
  return {
    make: {
      graphics: () => {
        const marks = [];
        const rec = (x, y) => marks.push([x / ART_SCALE, y / ART_SCALE]);
        return {
          fillStyle: () => {}, lineStyle: () => {}, destroy: () => {},
          fillRect: (x, y) => rec(x, y),
          fillCircle: (x, y) => rec(x, y),
          fillEllipse: (x, y) => rec(x, y),
          fillTriangle: (x, y) => rec(x, y),
          fillPoints: () => {},                      // the base hex polygon, not "detail"
          generateTexture: (key) => { drawn[key] = marks; },
        };
      },
    },
    textures: { exists: () => false, get: () => ({ getSourceImage: () => ({ getContext: () => null }) }) },
    _drawn: drawn,
  };
}

describe('mud is a diffuse full-tile texture, not a central motif (#447)', () => {
  const scene = recordingScene();
  buildHexTextures(scene);
  const marks = scene._drawn.hex_mud;
  const cx = HEX_TEX_W / 2, cy = HEX_TEX_H / 2;
  const offsets = marks.map(([x, y]) => [x - cx, y - cy]);

  it('paints many marks, not a handful of hand-placed shapes', () => {
    expect(offsets.length).toBeGreaterThan(60);
  });

  it('reaches the outer half of the tile in every direction', () => {
    // Six 60° sectors; each must contain a mark past 60% of the hex radius.
    for (let sector = 0; sector < 6; sector++) {
      const lo = sector * 60 - 180, hi = lo + 60;
      const reach = offsets.some(([dx, dy]) => {
        const a = Math.atan2(dy, dx) * 180 / Math.PI;
        return a >= lo && a < hi && Math.hypot(dx, dy) > HEX_SIZE * 0.6;
      });
      expect(reach, `sector ${sector}`).toBe(true);
    }
  });

  it('keeps every mark inside the tile', () => {
    for (const [dx, dy] of offsets) expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(HEX_SIZE);
  });
});
