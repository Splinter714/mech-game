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
//
// #433 (glow-overlay bake): set `sg.glowOnly = true` and every draw op is SUPPRESSED except
// those emitted from inside a glow primitive (glowDot/glowBar toggle `sg._glow` around their
// body). That lets the EXACT same weapon-mount draw code (barrel + muzzle glowDot/glowBar, etc.)
// bake a muzzle-glow-ONLY texture — transparent everywhere the gun hardware would be — with zero
// per-mount changes. The reload blink toggles that overlay sprite's visibility instead of swapping
// the part texture (arena/ammoIndicators.js), so the part texture stays CONSTANT (shield-shape fix).
// The INVERSE gate `sg.glowSkip = true` suppresses ONLY glow-primitive output while the gun hardware
// still draws — so the base part bakes with the muzzle glow OMITTED ENTIRELY (transparent where the
// glow would be, not a dark blob). The glow-only overlay stays the sole source of the muzzle colour,
// so the reload blink's off phase reads as the colour vanishing to nothing, not blinking to dark.
export function scaledGraphics(g, r = ART_SCALE) {
  const s = (n) => n * r;
  const wrap = {
    raw: g,
    glowOnly: false,   // when true, only glow-primitive output reaches the canvas
    glowSkip: false,   // when true, glow-primitive output is suppressed (gun hardware still draws)
    _glow: false,      // set by glowDot/glowBar while emitting their layers
    _blocked() { return (this.glowOnly && !this._glow) || (this.glowSkip && this._glow); },
    fillStyle: (c, a) => g.fillStyle(c, a),
    lineStyle: (w, c, a) => g.lineStyle(w * r, c, a),
    fillRect: (x, y, w, h) => { if (!wrap._blocked()) g.fillRect(s(x), s(y), s(w), s(h)); },
    fillCircle: (x, y, rad) => { if (!wrap._blocked()) g.fillCircle(s(x), s(y), s(rad)); },
    fillEllipse: (x, y, w, h) => { if (!wrap._blocked()) g.fillEllipse(s(x), s(y), s(w), s(h)); },
    fillTriangle: (a, b, c, d, e, f) => { if (!wrap._blocked()) g.fillTriangle(s(a), s(b), s(c), s(d), s(e), s(f)); },
    fillPoints: (pts, closed) => { if (!wrap._blocked()) g.fillPoints(pts.map((p) => ({ x: s(p.x), y: s(p.y) })), closed); },
  };
  return wrap;
}
