// Shared procedural-art helpers. Every sprite is drawn the same way: make an
// off-screen Graphics, draw into it, snapshot to a texture, discard. Sprites are
// super-sampled (drawn on an ART_SCALE× grid, displayed at 1/ART_SCALE) so pixel-art
// stays crisp on HiDPI/Retina while on-screen size is unchanged.

// Snapshot one draw fn into a texture under `key`. Safe to call again on an existing
// key to RE-SKIN in place (e.g. a part is destroyed): generateTexture redraws into
// the existing canvas without clearing, so we clear it first — otherwise old pixels
// ghost through. Redrawing in place keeps the Texture object valid.
export function gen(scene, key, w, h, drawFn) {
  // #639: inside a shell pass, every `gen` call bakes exactly ONE texture — the DILATED shell of
  // what it was asked to draw, under `<key><suffix>`. See `bakeShellTextures` below.
  if (SHELL_PASS) return genShell(scene, key, w, h, drawFn);
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  drawFn(g);
  if (scene.textures.exists(key)) {
    const src = scene.textures.get(key).getSourceImage();
    src.getContext?.('2d')?.clearRect(0, 0, src.width, src.height);
  }
  g.generateTexture(key, w, h);
  g.destroy();
  // #545 (art dissect tool): re-run the SAME draw fn through a recording graphics that turns
  // every fill into a tagged, serializable op instead of drawing pixels, so the dev-only dissect
  // overlay (src/dev/dissectOverlay.js) can show each part of a sprite separately. Dev-gated —
  // Vite folds this whole branch away in a production build (see main.js's identical guard on
  // the ArtPreviewScene/AudioScene registration for the same reasoning), so there is zero
  // runtime cost or risk in a shipped build.
  // #639: never captured for a SHELL raster. A shell is a mechanical dilation of art the dissect
  // tool already has, so there is nothing to see in it — and capturing one would re-run the draw
  // another DILATE_STEPS+1 times per raster, which every enemy mech now pays at spawn and on every
  // damage reskin. That is dev-only cost with no dev-only benefit.
  if (import.meta.env.DEV && !IN_SHELL_BAKE) captureLayers(key, w, h, drawFn);
}

// Dev-only art dissection: re-run `drawFn` into a recording graphics (`makeCaptureGraphics`)
// that captures every fill as a tagged op instead of drawing pixels, keyed by whatever
// `g.layer('name')` calls the draw code sprinkles through itself (a no-op against a real
// Phaser Graphics — see `scaledGraphics`'s own `.layer` below). Stored on a global keyed by
// texture key so the dissect overlay (and ArtPreviewScene, which drives it) can look any of
// them up by the same key `gen()` just baked. Best-effort — a texture whose draw fn reaches
// past `scaledGraphics` for something the recorder doesn't implement (e.g. a raw Phaser
// Graphics-only stroke primitive) must still bake its real pixels via the untouched call
// above; this second pass is purely additive and never allowed to break that.
function captureLayers(key, w, h, drawFn) {
  try {
    const cap = makeCaptureGraphics();
    drawFn(cap);
    (globalThis.__artLayers ||= {})[key] = { w, h, ops: cap.ops };
    globalThis.dispatchEvent(new CustomEvent('artLayersUpdated', { detail: { key } }));
  } catch { /* capture is best-effort; ignore */ }
}

// A graphics-shaped recorder standing in for a real Phaser Graphics. `scaledGraphics` (below)
// already turns every draw call's DESIGN-grid coordinates into final, already-transformed
// canvas coordinates (the `s()`/`px()`/`py()` math) before forwarding to whatever `g` it
// wraps — a real Graphics when baking pixels, this recorder when capturing — so all this needs
// to do is remember each already-transformed call as a serializable op, tagged with whichever
// layer name is currently active. Covers every primitive `scaledGraphics` itself forwards
// (fillStyle/lineStyle/fillRect/fillCircle/fillEllipse/fillTriangle/fillPoints) PLUS the couple
// of calls mech's art reaches past the wrapper for directly via `.raw` (mechPrims.js's `roundC`
// hits `sg.raw.fillRoundedRect` for a rounded plate, already scaled by hand the same way
// `scaledGraphics` would). `lineStyle`/`lineBetween` are no-ops: dissect renders FILLED
// silhouettes per part, and nothing in mech's art strokes a shape that isn't also filled, so
// there is nothing meaningful to capture from a bare stroke (mirrors horse game's recorder,
// which stubs `lineStyle`/`strokePath` the same way).
// #546 follow-up: `beginPath`/`moveTo`/`lineTo`/`closePath`/`fillPath` round out the primitives
// the recorder understands. projectileArt.js's missile/flame tongues (and drawChargeWedge's
// telegraph bands) build their shapes with this canvas-style path API instead of
// fillTriangle/fillPoints — without support here, `drawFn` throws on the first `beginPath()`
// call (undefined method) and captureLayers' outer try/catch silently drops the WHOLE
// texture's capture, not just the offending part. A path traced via moveTo/lineTo and closed
// with fillPath is geometrically the same "filled polygon" fillPoints already records, so it's
// captured as the same `poly` op type — no new rendering support needed in dissectOverlay.js.
// `strokePath`/`arc` stay no-ops, same reasoning as `lineStyle`/`lineBetween` above: dissect
// renders FILLED silhouettes per part, and a bare stroke (the slash crescent's arc, e.g.) has
// no fill to capture.
export function makeCaptureGraphics() {
  const ops = [];
  let cur = 'base', color = 0, alpha = 1;
  let path = [];
  const rec = (o) => ops.push({ ...o, color, alpha, layer: cur });
  return {
    __capture: true,
    ops,
    layer(name) { cur = name; },
    fillStyle(c, a = 1) { color = c; alpha = a; },
    lineStyle() {},
    lineBetween() {},
    strokePath() {},
    strokeCircle() {},   // e.g. fire.js's drum rim — a stroke ring, no fill to capture
    arc() {},
    beginPath() { path = []; },
    moveTo(x, y) { path = [{ x, y }]; },
    lineTo(x, y) { path.push({ x, y }); },
    closePath() {},   // fillPath below always treats the traced path as closed
    fillPath() { if (path.length >= 3) rec({ t: 'poly', points: path.slice() }); },
    fillRect(x, y, w, h) { rec({ t: 'rect', x, y, w, h }); },
    fillRoundedRect(x, y, w, h) { rec({ t: 'rect', x, y, w, h }); },   // rounding is cosmetic for dissect
    fillCircle(x, y, r) { rec({ t: 'circle', x, y, r }); },
    fillEllipse(x, y, w, h) { rec({ t: 'ellipse', x, y, w, h }); },
    fillTriangle(a, b, c, d, e, f) { rec({ t: 'tri', pts: [a, b, c, d, e, f] }); },
    fillPoints(points) { rec({ t: 'poly', points: points.map((p) => ({ x: p.x, y: p.y })) }); },
  };
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
// DESIGN units before the R× scale-up. Zero outside a shell pass, so every ordinary bake is
// byte-identical. It exists for the dilation below — the only way to grow a drawing by a fixed
// distance in EVERY direction is to stamp the same drawing around a small circle, which needs a
// translate hook that no per-part draw code has to know about. #639: seeded from the pass's
// current ring stamp (`SHELL_OFFSET`), since the draw code builds this wrapper itself, inside the
// `gen` callback, once per stamp.
export function scaledGraphics(g, r = ART_SCALE) {
  const s = (n) => n * r;                       // sizes: never translated
  const px = (n) => (n + wrap.ox) * r;          // positional x
  const py = (n) => (n + wrap.oy) * r;          // positional y
  const wrap = {
    raw: g,
    ox: SHELL_OFFSET?.ox ?? 0,   // #422/#639: design-unit translate applied to positional args
    oy: SHELL_OFFSET?.oy ?? 0,
    glowOnly: false,   // when true, only glow-primitive output reaches the canvas
    glowSkip: false,   // when true, glow-primitive output is suppressed (gun hardware still draws)
    _glow: false,      // set by glowDot/glowBar while emitting their layers
    _blocked() { return (this.glowOnly && !this._glow) || (this.glowSkip && this._glow); },
    // #545: tag the following draws as a named part for the dev-only dissect tool. No-op
    // against a real Phaser Graphics (which has no `.layer`); only forwards when `g` is the
    // capture recorder from `makeCaptureGraphics` above (tagged `__capture`), which is the
    // only thing that ever reads the tag. The glow/translate gates above are irrelevant here —
    // they decide WHETHER a draw call reaches `g` at all, not how it's tagged once it does, so
    // this needs no awareness of them.
    layer: (name) => { if (g.__capture) g.layer(name); },
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

// ── #422/#639: the SHELL BAKE PASS — the one and only dilation implementation ────────────────
// A "shell" raster is a unit's own art grown outward by a constant distance on every side. It is
// what the shield/plasma-coat outline draws (scenes/arena/shieldOutline.js) instead of a scaled-up
// copy of the real part: growing a drawing by a fixed distance in EVERY direction can only be done
// by stamping the same drawing around a small circle and unioning the results — a true
// morphological dilation — because ANY scale (uniform or per-axis) displaces each edge in
// proportion to its own distance from the centre, so a unit wider than it is deep gets a shell
// wider than it is deep.
//
// #639 made it a PASS rather than a per-texture call, so an art builder can be re-run VERBATIM to
// produce its shells: inside `bakeShellTextures`, every `gen()` call bakes one texture, under
// `<key><suffix>`, dilated. Callers therefore cannot misname a shell raster, forget one, or bake a
// shell for only some of a unit's sprites — which is exactly the drift that left enemies wearing a
// different-looking shield from the player's for as long as they did (#302's one-edit rule).
//
// The offset rides on module state rather than on the `sg` wrapper because the draw code creates
// its own wrapper INSIDE the `gen` callback (`(g) => drawHull(scaledGraphics(g), …)`), so there is
// no wrapper for the pass to reach; `scaledGraphics` picks the current stamp up at construction,
// which is once per stamp. Bake-time only, fully synchronous, and always restored in a `finally`.
let SHELL_PASS = null;     // { pad, suffix } while a shell pass is running
let SHELL_OFFSET = null;   // the current ring stamp, in DESIGN units — read by `scaledGraphics`
let IN_SHELL_BAKE = false; // true across the one `gen` call that bakes a shell raster

// Run `fn` (an art builder, or any run of `gen` calls) as a shell pass: `pad` DESIGN units of
// outward dilation, keys suffixed with `suffix`. A pad of 0 or less bakes nothing at all rather
// than running `fn` unchanged — `fn` is an art builder being re-run, so letting it through would
// silently re-bake the unit's REAL textures a second time under their own keys.
export function bakeShellTextures(pad, suffix, fn) {
  if (!(pad > 0)) return;
  const prev = SHELL_PASS;
  SHELL_PASS = { pad, suffix };
  try { fn(); } finally { SHELL_PASS = prev; SHELL_OFFSET = null; }
}

// One shell raster: the same draw fn run once normally and then once per ring stamp, all into the
// same canvas, so the result is the drawing's silhouette grown outward by `pad` on every side.
function genShell(scene, key, w, h, drawFn) {
  const pass = SHELL_PASS;
  SHELL_PASS = null;   // the `gen` below is an ordinary bake — of the dilated draw
  IN_SHELL_BAKE = true;
  try {
    gen(scene, `${key}${pass.suffix}`, w, h, (g) => {
      drawFn(g);
      for (let i = 0; i < DILATE_STEPS; i++) {
        const a = (i / DILATE_STEPS) * Math.PI * 2;
        SHELL_OFFSET = { ox: Math.cos(a) * pass.pad, oy: Math.sin(a) * pass.pad };
        drawFn(g);
      }
      SHELL_OFFSET = null;
    });
  } finally { SHELL_PASS = pass; SHELL_OFFSET = null; IN_SHELL_BAKE = false; }
}
