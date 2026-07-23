// INKED texture bounds — the box around a baked texture's non-transparent pixels, rather than
// its canvas.
//
// Every texture in this game is drawn onto a FIXED-SIZE square (a mech part is a 256px canvas; a
// vehicle hull is the same square whatever the unit's real footprint), because that is what makes
// the part sprites composite with perfect registration. The cost is that anything which wants to
// show a unit ISOLATED — fitted to a cell, a card, a HUD bay — cannot fit the canvas: an infantry
// trooper renders as a speck and a mech at half size, all of them adrift from the box's centre.
// Fitting the INK instead means the art fills whatever it is put in.
//
// Extracted from ArtPreviewScene (#461), which is where this was first solved, so #452's HUD
// target readout uses the identical rule rather than a second, subtly-different copy. The scan is
// O(pixels) and cached per key, so a texture is only ever read back once.

// Scan one texture's non-transparent extent. Returns `{ x, y, w, h, cx, cy, texW, texH }` in
// TEXTURE px (`cx`/`cy` = the ink's centre, so layers can be re-centred on it), `null` for a
// fully transparent texture — which is exactly what a DESTROYED mech part bakes to, and must not
// contribute to a union, since the full-canvas fallback would silently blow the fit right up.
function scanInk(textures, key) {
  const src = textures.exists(key) ? textures.get(key).getSourceImage() : null;
  if (!src) return null;
  const W = src.width, H = src.height;
  let box = { x: 0, y: 0, w: W, h: H, cx: W / 2, cy: H / 2 };
  try {
    const data = src.getContext?.('2d')?.getImageData(0, 0, W, H)?.data;
    if (data) {
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (data[(y * W + x) * 4 + 3] > 8) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < x0) return null;   // scanned fine and found nothing: a blank texture
      box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 };
    }
  } catch {
    // A canvas the browser won't let us read back — the full-canvas fallback above is fine.
  }
  box.texW = W; box.texH = H;
  return box;
}

export class InkCache {
  // `textures` is a Phaser TextureManager (game-wide, so a texture baked by one scene is
  // readable from another — which is what lets the HUD show art the arena baked).
  constructor(textures) {
    this.textures = textures;
    this._cache = new Map();
  }

  // The inked bounds of one texture, or null if it doesn't exist / is blank.
  bounds(key) {
    if (this._cache.has(key)) return this._cache.get(key);
    const box = scanInk(this.textures, key);
    if (box || this.textures.exists(key)) this._cache.set(key, box);
    return box;
  }

  // Union of several layers' inked bounds, each optionally shifted (in texture px). All layers of
  // one unit share a canvas size, so compositing in texture space is exact — which is what makes
  // the union the real silhouette box of an assembled hull+turret or six-sprite mech.
  union(keys, offsets = []) {
    let u = null;
    keys.forEach((k, i) => {
      const b = this.bounds(k);
      if (!b) return;
      const o = offsets[i] ?? { x: 0, y: 0 };
      const x0 = b.x + o.x, y0 = b.y + o.y, x1 = x0 + b.w, y1 = y0 + b.h;
      u = u
        ? { x0: Math.min(u.x0, x0), y0: Math.min(u.y0, y0), x1: Math.max(u.x1, x1), y1: Math.max(u.y1, y1), texW: b.texW, texH: b.texH }
        : { x0, y0, x1, y1, texW: b.texW, texH: b.texH };
    });
    if (!u) return null;
    return {
      w: u.x1 - u.x0, h: u.y1 - u.y0, cx: (u.x0 + u.x1) / 2, cy: (u.y0 + u.y1) / 2,
      texW: u.texW, texH: u.texH,
    };
  }

  // Forget cached bounds for keys starting with `prefix` (or everything, with no prefix). Needed
  // whenever a texture is RE-DRAWN in place under the same key — a mech reskin (a part destroyed)
  // changes the silhouette without changing the key, so a stale entry would keep fitting the art
  // to bounds it no longer has.
  drop(prefix = '') {
    if (!prefix) return this._cache.clear();
    for (const k of [...this._cache.keys()]) if (k.startsWith(prefix)) this._cache.delete(k);
  }
}

// The canvas size of a texture (not its ink), or null.
export function texSize(textures, key) {
  const src = textures.exists(key) ? textures.get(key).getSourceImage() : null;
  return src ? { w: src.width, h: src.height } : null;
}

// Scale that fits a w×h box inside a square of side `box`. Upscaling is allowed on purpose —
// every texture here is super-sampled (ART_SCALE), so blowing one up is how you see its real
// edge quality, and Phaser's pixelArt mode keeps it crisp rather than smeared.
export function fitScale(w, h, box) {
  return Math.min(box / w, box / h);
}
