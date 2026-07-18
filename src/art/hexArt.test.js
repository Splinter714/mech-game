import { describe, it, expect } from 'vitest';
import { HEX_BLEED, HEX_TEX_W, HEX_TEX_H, BASE_INFRA_COLOR, terrainFillColor } from './hexArt.js';
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

// #269 playtest follow-up: `dock` and `alertTower` used to reuse `hex_helipad`/`hex_tower`
// verbatim (see the terrain.js entries at the time), which made them indistinguishable from a
// real helipad / a regular destructible outpost building in play. Each now has its own PAL
// entry (buildHexTextures wires every non-abstract PAL key to a `hex_<key>` texture
// automatically) — these checks confirm the wiring exists and terrain.js actually points at it,
// without needing a real Phaser scene to bake the textures.
describe('dock/alertTower distinct textures (#269 playtest follow-up)', () => {
  it('terrain.js points dock and alertTower at their own texture keys, not helipad/tower', () => {
    expect(TERRAIN.dock.tex).toBe('hex_dock');
    expect(TERRAIN.alertTower.tex).toBe('hex_alertTower');
    expect(TERRAIN.dock.tex).not.toBe(TERRAIN.helipad.tex);
    expect(TERRAIN.alertTower.tex).not.toBe(TERRAIN.tower.tex);
  });

  it('both stay on the shared base-infrastructure fill colour, like helipad', () => {
    expect(terrainFillColor('dock')).toBe(BASE_INFRA_COLOR.fill);
    expect(terrainFillColor('alertTower')).toBe(BASE_INFRA_COLOR.fill);
    expect(terrainFillColor('helipad')).toBe(BASE_INFRA_COLOR.fill);
  });

  it('alertTower does NOT reuse the regular urban-ruins tower fill either', () => {
    // hex_tower (the ordinary destructible outpost building) keeps its own grey PAL entry,
    // distinct from the base-infrastructure family alertTower now shares with helipad/dock.
    expect(terrainFillColor('alertTower')).not.toBe(terrainFillColor('tower'));
  });
});
