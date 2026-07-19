// Shared procedural-art helpers. Every sprite is drawn the same way: make an
// off-screen Graphics, draw into it, snapshot to a texture, discard. Sprites are
// super-sampled (drawn on an ART_SCALE× grid, displayed at 1/ART_SCALE) so pixel-art
// stays crisp on HiDPI/Retina while on-screen size is unchanged.

// Snapshot one draw fn into a texture under `key`. Safe to call again on an existing
// key to RE-SKIN in place (e.g. a part is destroyed): generateTexture redraws into
// the existing canvas without clearing, so we clear it first — otherwise old pixels
// ghost through. Redrawing in place keeps the Texture object valid.
export function gen(scene, key, w, h, drawFn) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  drawFn(g);
  if (scene.textures.exists(key)) {
    const src = scene.textures.get(key).getSourceImage();
    src.getContext?.('2d')?.clearRect(0, 0, src.width, src.height);
  }
  g.generateTexture(key, w, h);
  g.destroy();
}

// Super-sampling factor: draw on an R× grid, display the sprite at 1/R the scale.
export const ART_SCALE = 4;

// Wrap a Phaser Graphics so draw code written in the small "design grid" renders onto
// the R× texture transparently: geometry args are multiplied by R; colours pass
// through. `.raw` exposes the underlying Graphics for native R× detail.
export function scaledGraphics(g, r = ART_SCALE) {
  const s = (n) => n * r;
  return {
    raw: g,
    // #240: the grid factor this wrapper is scaling by, exposed so a primitive that reaches
    // through to `.raw` (mechPrims.js `roundC`) can multiply by the SAME factor instead of
    // assuming the global ART_SCALE — which is wrong for a mech built on a finer grid.
    scale: r,
    fillStyle: (c, a) => g.fillStyle(c, a),
    lineStyle: (w, c, a) => g.lineStyle(w * r, c, a),
    fillRect: (x, y, w, h) => g.fillRect(s(x), s(y), s(w), s(h)),
    fillCircle: (x, y, rad) => g.fillCircle(s(x), s(y), s(rad)),
    fillEllipse: (x, y, w, h) => g.fillEllipse(s(x), s(y), s(w), s(h)),
    fillTriangle: (a, b, c, d, e, f) => g.fillTriangle(s(a), s(b), s(c), s(d), s(e), s(f)),
    fillPoints: (pts, closed) => g.fillPoints(pts.map((p) => ({ x: s(p.x), y: s(p.y) })), closed),
  };
}
