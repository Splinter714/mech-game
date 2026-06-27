// Procedural hex-tile art. Pointy-top hexes sized from hexgrid's HEX_SIZE, drawn as a
// filled polygon with a subtle inset so adjacent tiles read as a grid. A dark
// battlefield palette keeps the bright mech + weapon barrels popping. The arena places
// one of these at each hex centre (hexgrid.hexToPixel).

import { gen, scaledGraphics, ART_SCALE } from './_frames.js';
import { HEX_SIZE, hexCorners } from '../data/hexgrid.js';

const SQRT3 = Math.sqrt(3);
// Texture footprint (true on-screen px); displayed at 1/ART_SCALE after super-sampling.
export const HEX_TEX_W = Math.ceil(SQRT3 * HEX_SIZE) + 2;
export const HEX_TEX_H = Math.ceil(2 * HEX_SIZE) + 2;

const PAL = {
  ground:  { fill: 0x1b2129, edge: 0x2a333f },
  groundB: { fill: 0x1f2630, edge: 0x2a333f },
  wall:    { fill: 0x3a4250, edge: 0x4a5564 },
};

function drawHex(sg, fill, edge, inset = 0.9) {
  const cx = HEX_TEX_W / 2, cy = HEX_TEX_H / 2;
  const outer = hexCorners(HEX_SIZE).map((p) => ({ x: cx + p.x, y: cy + p.y }));
  const inner = hexCorners(HEX_SIZE * inset).map((p) => ({ x: cx + p.x, y: cy + p.y }));
  sg.fillStyle(edge, 1);
  sg.fillPoints(outer, true);
  sg.fillStyle(fill, 1);
  sg.fillPoints(inner, true);
}

export function buildHexTextures(scene) {
  const tiles = {
    hex_ground: PAL.ground,
    hex_groundB: PAL.groundB,
    hex_wall: PAL.wall,
  };
  for (const [key, pal] of Object.entries(tiles)) {
    gen(scene, key, HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE,
      (g) => drawHex(scaledGraphics(g), pal.fill, pal.edge));
  }
  // The wall tile gets a raised top plate so cover reads as solid.
  gen(scene, 'hex_wall', HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE, (g) => {
    const sg = scaledGraphics(g);
    drawHex(sg, PAL.wall.fill, PAL.wall.edge, 0.92);
    drawHex(sg, 0x4a5564, 0x39414d, 0.6);
  });
}
