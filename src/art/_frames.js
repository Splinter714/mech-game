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
// #422: `ox`/`oy` translate every POSITIONAL argument (never a width/height/radius) by that many
// DESIGN units before the R× scale-up. Zero by default, so every existing bake is byte-identical.
// It exists for `drawDilated` below — the only way to grow a drawing by a fixed distance in EVERY
// direction is to stamp the same drawing around a small circle, which needs a translate hook that
// no per-part draw code has to know about.
export function scaledGraphics(g, r = ART_SCALE) {
  const s = (n) => n * r;                       // sizes: never translated
  const px = (n) => (n + wrap.ox) * r;          // positional x
  const py = (n) => (n + wrap.oy) * r;          // positional y
  const wrap = {
    raw: g,
    ox: 0,             // #422: design-unit translate applied to positional args (see drawDilated)
    oy: 0,
    glowOnly: false,   // when true, only glow-primitive output reaches the canvas
    glowSkip: false,   // when true, glow-primitive output is suppressed (gun hardware still draws)
    _glow: false,      // set by glowDot/glowBar while emitting their layers
    _blocked() { return (this.glowOnly && !this._glow) || (this.glowSkip && this._glow); },
    fillStyle: (c, a) => g.fillStyle(c, a),
    lineStyle: (w, c, a) => g.lineStyle(w * r, c, a),
    fillRect: (x, y, w, h) => { if (!wrap._blocked()) g.fillRect(px(x), py(y), s(w), s(h)); },
    fillCircle: (x, y, rad) => { if (!wrap._blocked()) g.fillCircle(px(x), py(y), s(rad)); },
    fillEllipse: (x, y, w, h) => { if (!wrap._blocked()) g.fillEllipse(px(x), py(y), s(w), s(h)); },
    fillTriangle: (a, b, c, d, e, f) => { if (!wrap._blocked()) g.fillTriangle(px(a), py(b), px(c), py(d), px(e), py(f)); },
    fillPoints: (pts, closed) => { if (!wrap._blocked()) g.fillPoints(pts.map((p) => ({ x: px(p.x), y: py(p.y) })), closed); },
  };
  return wrap;
}

// #422: how many stamps around the ring a dilation uses. The union of N stamps at radius `pad` is
// the drawing grown by `pad` in every direction, to within `1 - cos(π/N)` of the ring radius at the
// worst (between-stamp) angle — 3.4% at 12 stamps, i.e. ~0.06 design units ≈ 0.08 display px on the
// shield shell's pad. That is far below the ~1px unevenness this was filed for, and the whole cost
// is 13 passes of otherwise-unchanged draw code at texture-bake time (never per frame).
export const DILATE_STEPS = 12;

// #422: run `drawFn` once normally and then once per ring stamp, so the resulting raster is the
// drawing's silhouette GROWN OUTWARD BY A CONSTANT `pad` DESIGN UNITS on every side. This is a true
// morphological dilation, which is what "a consistent distance outside the mech" actually means —
// unlike scaling the sprite up by a percentage, which displaces each edge in proportion to its own
// distance from the centre (so a mech that is wider than it is deep gets a shell that is wider than
// it is deep). Shape-agnostic: it needs nothing from the draw code but the ability to be re-run.
export function drawDilated(sg, pad, drawFn, steps = DILATE_STEPS) {
  drawFn();
  if (!(pad > 0)) return;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    sg.ox = Math.cos(a) * pad;
    sg.oy = Math.sin(a) * pad;
    drawFn();
  }
  sg.ox = 0;
  sg.oy = 0;
}
