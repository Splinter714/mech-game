// The perceptual-luminance greyscale conversion behind Cloak's "remove ALL colour from the mech"
// visual (#500 playtest follow-up: "camoflage/cloaking ability needs to remove color from the
// mech except for the multiplayer color ring"). Pulled out as its own pure module because it's
// the one piece of the fix that's actually testable without a live Phaser scene/canvas — the
// per-pixel bake itself (mechArt.js `desaturateTexture`) needs a real `<canvas>` and stays
// unit-test-free like the rest of the art layer (verified live instead, per CLAUDE.md).
//
// Rec. 601 luma weights (the standard "grey out a colour photo" formula), not a flat (r+g+b)/3
// average — human vision is far more sensitive to green than to red or blue, so an equal-average
// would make a saturated green panel read brighter than an equally-bright red one stays too dark.
//
// Why this has to be a PER-PIXEL formula at all, rather than a Phaser sprite tint: `setTint`
// multiplies each channel by a constant (`out = texture * tint`), which preserves every pixel's
// hue/saturation ratio exactly — it can only dim or colour-cast a sprite, never desaturate one.
// A saturated red panel (255,0,0) tinted by ANY grey (say 0x808080 → ×0.5) becomes (128,0,0):
// still fully-saturated red, just darker. That's why the original tint-based Cloak (a pale
// steel-blue-grey wash) still read as "has colour" once a player's saturated accent/rim-highlight
// hue was under it — the earlier playtest fix that added CLOAK_TINT/CLOAK_ALPHA in abilities.js
// only ever added a wash on TOP of the existing colours, never removed them. Collapsing R, G and B
// to the SAME value per pixel is the only way to actually zero out saturation.
export function luminanceGrey(r, g, b) {
  const grey = 0.299 * r + 0.587 * g + 0.114 * b;
  return Math.max(0, Math.min(255, Math.round(grey)));
}

// #500 (third playtest pass — "can we make it a bit more wire-frame-y? like more outline-y"): the
// flat-grey fill read as "solid grey mech" rather than the translucent ghost Jackson wanted, so
// `desaturateTexture` (art/mechArt.js) now also bakes a bright rim line around each part's
// silhouette and pushes the INTERIOR fill more transparent, on top of the existing greyscale. The
// edge math itself is pure per-pixel-alpha array logic (no canvas needed), so it's factored out
// here and unit-tested directly; only the canvas read/write around it stays in mechArt.js.
//
// A pixel counts as "inside the silhouette" once its alpha clears this floor — filters out the
// near-transparent antialiasing fringe Phaser's Graphics leaves along a shape's boundary, so that
// fringe doesn't itself get misread as a solid edge one pixel further out than the real one.
const EDGE_ALPHA_THRESHOLD = 40;

function isOpaque(alpha) {
  return alpha > EDGE_ALPHA_THRESHOLD;
}

// A flat `width*height` boolean(-ish, 0/1) mask: true for every opaque pixel that has at least one
// of its 4-neighbours (up/down/left/right, canvas edges counting as transparent) NOT opaque — i.e.
// the one-pixel-thin boundary line of the silhouette.
export function silhouetteBoundary(alphas, width, height) {
  const out = new Uint8Array(width * height);
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height) ? 0 : alphas[y * width + x];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!isOpaque(alphas[i])) continue;
      if (!isOpaque(at(x - 1, y)) || !isOpaque(at(x + 1, y)) || !isOpaque(at(x, y - 1)) || !isOpaque(at(x, y + 1))) {
        out[i] = 1;
      }
    }
  }
  return out;
}

// Grow a 0/1 mask outward by `radius` pixels in every direction (a separable box-max dilation —
// horizontal pass then vertical pass, so it's O(width*height*radius) rather than the O(radius^2)
// a naive per-pixel square scan would cost). This is what turns a literal 1-pixel boundary line
// into a band `radius` pixels thick: the mech's art is baked at ART_SCALE (4x) supersampling and
// then displayed at ARENA_MECH_SCALE (0.34x — see scenes/arena/shared.js), so a single raster
// pixel resolves to well under one on-screen pixel and would be invisible without this.
export function dilateMask(mask, width, height, radius) {
  if (radius <= 0) return mask;
  const horiz = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let hit = 0;
      for (let dx = -radius; dx <= radius && !hit; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < width && mask[row + xx]) hit = 1;
      }
      horiz[row + x] = hit;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let hit = 0;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < height && horiz[yy * width + x]) hit = 1;
      }
      out[y * width + x] = hit;
    }
  }
  return out;
}

// The full outline mask for the Cloak rim pass in one call: detect the silhouette's 1-pixel
// boundary, then thicken it to `thicknessPx`. Pixels where this is truthy get painted as the bright
// rim line; every other still-opaque pixel is ordinary (now more-transparent) desaturated fill.
export function cloakEdgeMask(alphas, width, height, thicknessPx) {
  return dilateMask(silhouetteBoundary(alphas, width, height), width, height, thicknessPx);
}
