// Base scene world mixin — renders the hand-authored layout (base/layout.js) with the same
// tile-image/hex-primitive approach the arena uses, pared down to what a flat, no-combat space
// actually needs: no destructible buildings, no visibility culling (the whole base is a few
// dozen hexes — the arena's tile-culling exists because its corridor is ~20k hexes, which
// doesn't apply here). `_terrainAt`/`_hexKeyAt`/`_blocked`/`_blockedAlongSegment` mirror their
// arena/world.js namesakes' TERRAIN-only half; the arena versions also consult `this.wallEdges`
// for COLLISION, which the base doesn't have (its boundary is already impassable — there's no
// terrain past the disc). The wall RING drawn below is purely decorative: the same wall ART
// (art/wallArt.js `drawWallSpans`) baked once around the compound's edge, with no HP/gates/
// destructibility data behind it — there's nothing here to attack it.
import { ART_SCALE } from '../../art/index.js';
import { hexToPixel, pixelToHex, axialKey, hexesAlongSegment, hexCorners, neighbors, HEX_SIZE } from '../../data/hexgrid.js';
import { getTerrain, isPassable, terrainSpeedFactor } from '../../data/terrain.js';
import { WALL_THICKNESS_PX } from '../../data/wallEdges.js';
import { drawWallSpans } from '../../art/wallArt.js';
import { DEPTH } from '../arena/shared.js';
import { buildBaseTerrain, CUSTOMIZATION_HEX, SCANNER_HEX } from './layout.js';

// The two functional hexes get a visible ring + floating label — otherwise there is nothing
// distinguishing them from ordinary ground, and a player has no way to tell where to walk.
const TRIGGER_MARKERS = [
  { hex: CUSTOMIZATION_HEX, label: 'GARAGE', color: 0x5ec8e0 },
  { hex: SCANNER_HEX, label: 'MISSIONS', color: 0xefc14a },
];

// Maps a `neighbors(q,r)` direction index to the `hexCorners()` edge index that geometrically
// faces that same neighbour — same derivation arena/world.js uses for its own (unexported)
// NEIGHBOR_EDGE, restated here rather than reaching into arena internals for one constant.
const NEIGHBOR_EDGE = [1, 0, 5, 4, 3, 2];

export const BaseWorldMixin = {
  _buildBaseWorld() {
    this.terrain = buildBaseTerrain();
    this.tileImages = new Map();
    for (const [k, id] of this.terrain) {
      const [q, r] = k.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      const img = this.add.image(x, y, getTerrain(id).tex).setScale(1 / ART_SCALE).setDepth(DEPTH.TERRAIN);
      this.tileImages.set(k, img);
    }
    for (const { hex, label, color } of TRIGGER_MARKERS) {
      const { x, y } = hexToPixel(hex.q, hex.r);
      this.add.circle(x, y, HEX_SIZE * 0.8).setStrokeStyle(3, color, 0.9).setDepth(DEPTH.WORLD_UI);
      this.add.text(x, y - HEX_SIZE * 1.6, label, {
        fontFamily: 'monospace', fontSize: '16px', fontStyle: 'bold',
        color: `#${color.toString(16).padStart(6, '0')}`,
      }).setOrigin(0.5).setDepth(DEPTH.WORLD_UI);
    }
    this._buildWallRing();
  },

  // A decorative wall ring around the compound's outer edge — every boundary edge (a hex inside
  // the disc whose neighbour in that direction is outside it) gets a wall span baked with the
  // arena's own wall art, once, into a static Graphics object. Purely visual: passability is
  // already fully decided by `this.terrain` above, same as every other hex in the disc.
  _buildWallRing() {
    const corners = hexCorners();
    const edges = [];
    for (const k of this.terrain.keys()) {
      const [q, r] = k.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      const nbrs = neighbors(q, r);
      for (let i = 0; i < nbrs.length; i++) {
        if (this.terrain.has(axialKey(nbrs[i].q, nbrs[i].r))) continue;   // interior edge
        const edgeIdx = NEIGHBOR_EDGE[i];
        const c0 = corners[edgeIdx], c1 = corners[(edgeIdx + 1) % 6];
        edges.push({ x0: x + c0.x, y0: y + c0.y, x1: x + c1.x, y1: y + c1.y });
      }
    }
    const wallGfx = this.add.graphics().setDepth(DEPTH.WALLS);
    drawWallSpans(wallGfx, edges, WALL_THICKNESS_PX);
  },

  _terrainAt(x, y) {
    const h = pixelToHex(x, y);
    return this.terrain.get(axialKey(h.q, h.r));
  },

  _hexKeyAt(x, y) {
    const h = pixelToHex(x, y);
    return axialKey(h.q, h.r);
  },

  _blocked(x, y) {
    return !isPassable(this._terrainAt(x, y));
  },

  _speedFactorAt(x, y) {
    return terrainSpeedFactor(this._terrainAt(x, y));
  },

  // Swept across every hex the segment crosses (not just its endpoint) so a fast mech grazing
  // the base's edge at a shallow angle can't tunnel past it in one frame — same reasoning as
  // arena/world.js's own `_blockedAlongSegment`, minus the wall-edge check (no walls here).
  _blockedAlongSegment(x0, y0, x1, y1) {
    for (const h of hexesAlongSegment(x0, y0, x1, y1)) {
      if (!isPassable(this.terrain.get(axialKey(h.q, h.r)))) return true;
    }
    return false;
  },
};
