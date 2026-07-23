import { describe, it, expect } from 'vitest';
import {
  HEX_BLEED, HEX_TEX_W, HEX_TEX_H, BASE_INFRA_COLOR, terrainFillColor,
  buildHexTextures, COVER_CANOPY_IDS, canopyTexKey, isCoverCanopyId,
} from './hexArt.js';
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
