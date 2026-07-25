// Base scene world mixin — renders the hand-authored layout (base/layout.js) with the same
// tile-image/hex-primitive approach the arena uses, pared down to what a flat, wall-free space
// actually needs: no wall edges, no destructible buildings, no visibility culling (the whole
// base is a few dozen hexes — the arena's tile-culling exists because its corridor is ~20k
// hexes, which doesn't apply here). `_terrainAt`/`_hexKeyAt`/`_blocked`/`_blockedAlongSegment`
// mirror their arena/world.js namesakes' TERRAIN-only half; the arena versions also consult
// `this.wallEdges`, which the base doesn't have.
import { ART_SCALE } from '../../art/index.js';
import { hexToPixel, pixelToHex, axialKey, hexesAlongSegment } from '../../data/hexgrid.js';
import { getTerrain, isPassable } from '../../data/terrain.js';
import { DEPTH } from '../arena/shared.js';
import { buildBaseTerrain } from './layout.js';

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
