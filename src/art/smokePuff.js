// Smoke Screen's puff texture + cloud layout (#507), lifted out of `scenes/arena/stealth.js` by
// #534 so the garage catalog card can stamp the REAL smoke rather than an approximation of it.
// Nothing about the bake or the scatter changed in the move — this is the same code stealth.js
// shipped, now living in `src/art/` where the rest of the game's baked textures live, imported
// by both the arena (which tweens each puff) and `ui/abilityPreview.js` (which animates them
// from a deterministic clock instead, so a card can loop cheaply).
//
// #507 THIRD visual pass (owner playtest, after the second pass's 11-cluster/sub-blob rework:
// "still reads as blobs, not smoke texture"). Both prior passes drew every puff with Phaser
// `Graphics.fillCircle` — no matter how many circles, how varied their size, or how much drift/
// breathing animation is layered on, a `fillCircle` has a hard geometric edge (even at low alpha
// the boundary is still a perfect circle), so it structurally cannot read as soft haze. That
// needed a different rendering technique, not another iteration on "more circles."
//
// This pass switches to the SAME technique every other texture in this game uses (art/_frames.js
// header, mechArt.js `desaturateTexture`): bake a texture once, then stamp cheap GameObject
// instances of it at runtime. The bake itself uses real Canvas 2D radial gradients
// (`createRadialGradient` — see `bakeSmokePuffTexture` below) instead of a flat fill: a gradient
// fades smoothly from an opaque-ish core to fully-transparent at the rim, which has no edge at
// all to read as a shape. `scaledGraphics`/`gen()` can't do this (Graphics has no gradient
// primitive), so this bakes straight onto a Phaser `CanvasTexture`'s own 2D context, exactly like
// `desaturateTexture` already does for Cloak's greyscale bake — same API, same guard pattern for
// hand-rolled test scenes.
//
// `this.add.particles` (Phaser's built-in emitter) was considered and rejected: this codebase has
// deliberately never used a live particle system anywhere (checked), every other FX/texture is a
// baked-texture-plus-manually-animated-GameObject (muzzle flashes, glow overlays, drone views,
// the death fireball), and introducing the first-ever particle emitter for one effect would add a
// whole second animation paradigm (its own update loop, its own tween-vs-emitter-config split)
// for no benefit over just tweening stamped Image instances the same way every other ambient FX
// already does. Staying with hand-stamped sprites keeps smoke consistent with the rest of the
// game's "bake once, animate a plain GameObject" convention.
//
// The scatter/cluster geometry (loose "clusters" of a few overlapping sub-blobs, sqrt-biased
// toward the centre) is UNCHANGED from the second pass — that part was never the problem, only
// what got drawn at each position. Each sub-blob is one stamped Image of a baked puff texture
// (randomly one of SMOKE_TEX_VARIANT_COUNT mottled variants, so instances don't look identical
// when overlapping) instead of a `Graphics` circle.
//
// #507 DENSITY pass (owner playtest 2026-08-04: "needs WAY more smoke"). The visual technique was
// finally right after the third pass, but the cloud was too THIN to read as cover — you could see
// straight through it, which is exactly wrong for an ability whose whole job is to block sight.
// Nothing about what the ability does changed (radius, duration, cooldown, depth all untouched);
// every dial that feeds PERCEIVED OPACITY got turned up hard, and every one of them is now a named
// constant in this block or `SMOKE_BREATHE` below, so the next tuning pass is one obvious edit.
//
// Four independent things make a cloud read as opaque, and this pass moved all four rather than
// leaning on raw count (which is the expensive one — see the object-count note on
// SMOKE_CLUSTER_COUNT): how MANY puffs, how BIG each one is, how OPAQUE each stamp is, and how
// opaque the baked texture itself is. It also adds a few very large HAZE puffs underneath —
// three big soft stamps fill the interior far more cheaply than the twenty extra small ones it
// would take to cover the same area.

// --- How many puffs (the cost dial) ------------------------------------------------------------
// Every entry here becomes one stamped Image plus two endlessly-repeating tweens in the arena, so
// this is the only group that costs real frame time. Peak is roughly
// (CLUSTER_COUNT * avg SUBBLOBS) + HAZE_COUNT objects per live cloud, times the number of players
// running one. Prefer raising the SIZE/ALPHA dials below before raising these again.
const SMOKE_CLUSTER_COUNT = 20;         // loose "clusters" scattered through the cloud (was 11)
const SMOKE_SUBBLOBS_MIN = 3;           // each cluster is 3-4 overlapping sub-blobs, not one circle
const SMOKE_SUBBLOBS_MAX = 4;

// --- How big each puff is (free — bigger stamps of the same texture cost nothing extra) ---------
const SMOKE_PUFF_MIN_FRAC = 0.3;        // a cluster's own radius, as a fraction of the cloud's radius
const SMOKE_PUFF_MAX_FRAC = 0.62;
const SMOKE_SUBBLOB_SIZE_MIN = 0.45;    // a sub-blob's radius, as a fraction of its cluster's radius
const SMOKE_SUBBLOB_SIZE_MAX = 1.05;    // (>1 on purpose: the biggest sub-blobs overhang their cluster)
const SMOKE_SCATTER_FRAC = 0.72;        // cluster centres land within this fraction of the cloud radius
const SMOKE_SUBBLOB_JITTER_FRAC = 0.4;  // sub-blob offset from its cluster centre, as a frac of cluster radius

// --- How opaque each stamp is ------------------------------------------------------------------
// Per-puff alpha, randomized in this band. Near 1.0 the overlaps stack into genuinely solid cover;
// dropping the floor is the fastest way to make the cloud see-through again.
const SMOKE_ALPHA_MIN = 0.78;
const SMOKE_ALPHA_MAX = 1.0;

// --- The interior fill (cheap opacity) ---------------------------------------------------------
// A few cloud-sized soft stamps under the scatter. These are what stop you seeing STRAIGHT THROUGH
// the middle: three objects that each cover the whole cloud, instead of the ~20 extra small puffs
// it would take to fill the same area. Sized near the full cloud radius so the covered area still
// matches where the LOS block actually is.
const SMOKE_HAZE_COUNT = 3;
const SMOKE_HAZE_MIN_FRAC = 0.8;        // a haze puff's radius, as a fraction of the cloud radius
const SMOKE_HAZE_MAX_FRAC = 1.0;
const SMOKE_HAZE_OFFSET_FRAC = 0.18;    // how far off-centre a haze puff may sit (frac of cloud radius)
const SMOKE_HAZE_ALPHA_MIN = 0.5;       // deliberately below the puff band — this is underlayment,
const SMOKE_HAZE_ALPHA_MAX = 0.7;       // not a flat disc you'd notice as a disc

const SMOKE_COLOR = 0xc8d2dd;
const SMOKE_COLOR_DARK = 0x9aa3ad;      // a second, slightly darker tint mixed into the gradient bake

// --- The roil envelope (shared with ui/abilityPreview.js) --------------------------------------
// Both animators breathe each puff between these bounds: the arena as two yoyo tweens, the catalog
// card as a sine off its own loop clock. `alphaFloorFrac` is a DENSITY dial in disguise — a puff
// spends most of its life somewhere between full alpha and this fraction of it, so a low floor
// thins the whole cloud on average no matter how high SMOKE_ALPHA_MIN/MAX are. It was 0.4 before
// the density pass (puffs fading to well under half), which is most of why the cloud read as thin.
export const SMOKE_BREATHE = {
  scaleMin: 0.95,       // how far a puff shrinks at the bottom of its breath (was 0.8)
  scaleMax: 1.35,       // how far it swells at the top
  alphaFloorFrac: 0.8,  // alpha at the thinnest point of the breath, as a fraction of the puff's own
};

// --- Baked puff texture ----------------------------------------------------------------------
// Bake resolution: a puff instance's on-screen radius `r` is achieved by scaling this texture,
// never by redrawing it, so one bake covers every size the scatter logic produces — including
// the very small radii a catalog card asks for.
export const SMOKE_TEX_SIZE = 256;
// A few mottled variants so overlapping instances never look like the same stamp repeated.
const SMOKE_TEX_VARIANT_COUNT = 3;

// --- How opaque the baked texture itself is ----------------------------------------------------
// This is the free density dial: it costs nothing at runtime (the bake happens once) and it lifts
// EVERY puff at once, so reach for these before adding more objects. `MID_STOP`/`MID_ALPHA_FRAC`
// control how far the near-solid core carries before the falloff starts — pushing them out makes
// each puff read as a thick body with a soft rim rather than a faint smudge.
const SMOKE_CORE_RADIUS_FRAC = 0.40;    // core gradient radius, as a fraction of the texture size
const SMOKE_CORE_ALPHA = 0.88;          // opacity at a puff's dead centre (was 0.65)
const SMOKE_CORE_MID_STOP = 0.6;        // where along the radius the falloff begins
const SMOKE_CORE_MID_ALPHA_FRAC = 0.66; // opacity there, as a fraction of the core's (was 0.5)
const SMOKE_WISP_MIN = 5;               // mottling blobs blended over the core so it isn't a disc
const SMOKE_WISP_MAX = 7;
const SMOKE_WISP_ALPHA_MIN = 0.3;
const SMOKE_WISP_ALPHA_MAX = 0.54;
export const SMOKE_TEX_KEYS = Array.from({ length: SMOKE_TEX_VARIANT_COUNT }, (_, i) => `smokePuff${i}`);

function smokeRgba(hex, a) {
  return `rgba(${(hex >> 16) & 0xff},${(hex >> 8) & 0xff},${hex & 0xff},${a})`;
}

// Bake ONE soft smoke-puff texture onto a Phaser CanvasTexture's real 2D context. A big central
// gradient (opaque-ish core → fully transparent at its own radius, no stroke, no hard edge of any
// kind) plus 4-6 smaller offset "wisp" gradients — mixed SMOKE_COLOR/SMOKE_COLOR_DARK, randomized
// position/size/alpha/squash — blended on top so the silhouette is mottled and asymmetric rather
// than a smooth disc. Idempotent (no-ops if `key` already exists), same as `gen()`.
function bakeSmokePuffTexture(scene, key) {
  if (scene.textures.exists(key)) return key;
  if (typeof scene.textures.createCanvas !== 'function') return key;
  const size = SMOKE_TEX_SIZE;
  const tex = scene.textures.createCanvas(key, size, size);
  const ctx = tex?.context;
  if (!ctx) return key;
  const cx = size / 2, cy = size / 2;
  const coreR = size * SMOKE_CORE_RADIUS_FRAC;

  const blob = (ox, oy, r, color, alpha, sx, sy) => {
    ctx.save();
    ctx.translate(cx + ox, cy + oy);
    ctx.scale(sx, sy);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, smokeRgba(color, alpha));
    g.addColorStop(SMOKE_CORE_MID_STOP, smokeRgba(color, alpha * SMOKE_CORE_MID_ALPHA_FRAC));
    g.addColorStop(1, smokeRgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // Main body: one dominant soft core, very slightly squashed so even the base shape isn't a
  // perfect circle before any wisps land on it.
  blob(0, 0, coreR, SMOKE_COLOR, SMOKE_CORE_ALPHA, 1, 0.88 + Math.random() * 0.18);
  const wisps = SMOKE_WISP_MIN + Math.floor(Math.random() * (SMOKE_WISP_MAX - SMOKE_WISP_MIN + 1));
  for (let i = 0; i < wisps; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * coreR * 0.5;
    const wr = coreR * (0.3 + Math.random() * 0.4);
    const color = Math.random() < 0.5 ? SMOKE_COLOR_DARK : SMOKE_COLOR;
    blob(Math.cos(a) * d, Math.sin(a) * d, wr, color,
      SMOKE_WISP_ALPHA_MIN + Math.random() * (SMOKE_WISP_ALPHA_MAX - SMOKE_WISP_ALPHA_MIN),
      0.75 + Math.random() * 0.5, 0.75 + Math.random() * 0.5);
  }
  tex.refresh();
  return key;
}

// Bake every puff variant once. Guarded for hand-rolled/headless scenes that stub
// `textures.exists` to always report true so real canvas work is never exercised there.
export function ensureSmokeTextures(scene) {
  if (typeof scene.textures?.exists !== 'function') return;
  for (const key of SMOKE_TEX_KEYS) bakeSmokePuffTexture(scene, key);
}

// The cloud's SHAPE, as pure data: one entry per sub-blob, `{ ox, oy, r, texKey, baseAlpha }`
// offsets relative to the cloud centre. Both the arena (which stamps an Image per entry and hangs
// two endlessly-repeating tweens off it) and the catalog card (which stamps the same Images but
// animates them from its own loop clock) build their cloud from this, so a retune of the scatter
// moves both. `scale` shrinks the whole layout without changing its proportions — the card asks
// for the real `radius` scaled down to fit its stage, so cluster count/spread/relative sizes are
// exactly the arena's.
export function smokePuffLayout(radius) {
  const puffs = [];
  // The haze underlayment first, so it stamps BENEATH the scatter (both callers add Images in
  // array order, and everything in one cloud shares a depth) — big soft bodies filling the
  // interior, with the detailed scatter riding on top of them.
  for (let hi = 0; hi < SMOKE_HAZE_COUNT; hi++) {
    const ha = Math.random() * Math.PI * 2;
    const hd = Math.random() * radius * SMOKE_HAZE_OFFSET_FRAC;
    puffs.push({
      ox: Math.cos(ha) * hd,
      oy: Math.sin(ha) * hd,
      r: radius * (SMOKE_HAZE_MIN_FRAC + Math.random() * (SMOKE_HAZE_MAX_FRAC - SMOKE_HAZE_MIN_FRAC)),
      texKey: SMOKE_TEX_KEYS[Math.floor(Math.random() * SMOKE_TEX_KEYS.length)],
      baseAlpha: SMOKE_HAZE_ALPHA_MIN + Math.random() * (SMOKE_HAZE_ALPHA_MAX - SMOKE_HAZE_ALPHA_MIN),
    });
  }
  for (let ci = 0; ci < SMOKE_CLUSTER_COUNT; ci++) {
    // sqrt(random) biases toward the centre (uniform-AREA scatter, not uniform-radius, which
    // would over-cluster near the middle) while still thinning out toward the rim.
    const ca = Math.random() * Math.PI * 2;
    const cd = Math.sqrt(Math.random()) * radius * SMOKE_SCATTER_FRAC;
    const cx = Math.cos(ca) * cd, cy = Math.sin(ca) * cd;
    const clusterR = radius * (SMOKE_PUFF_MIN_FRAC + Math.random() * (SMOKE_PUFF_MAX_FRAC - SMOKE_PUFF_MIN_FRAC));
    const subCount = SMOKE_SUBBLOBS_MIN + Math.floor(Math.random() * (SMOKE_SUBBLOBS_MAX - SMOKE_SUBBLOBS_MIN + 1));
    for (let si = 0; si < subCount; si++) {
      // Sub-blobs jitter off their cluster's own centre so they overlap raggedly instead of
      // stacking exactly — that overlap-of-offset-textures is what breaks up the silhouette.
      const sa = Math.random() * Math.PI * 2;
      const sd = Math.random() * clusterR * SMOKE_SUBBLOB_JITTER_FRAC;
      puffs.push({
        ox: cx + Math.cos(sa) * sd,
        oy: cy + Math.sin(sa) * sd,
        r: clusterR * (SMOKE_SUBBLOB_SIZE_MIN + Math.random() * (SMOKE_SUBBLOB_SIZE_MAX - SMOKE_SUBBLOB_SIZE_MIN)),
        texKey: SMOKE_TEX_KEYS[Math.floor(Math.random() * SMOKE_TEX_KEYS.length)],
        baseAlpha: SMOKE_ALPHA_MIN + Math.random() * (SMOKE_ALPHA_MAX - SMOKE_ALPHA_MIN),
      });
    }
  }
  return puffs;
}

// A puff's Image scale for an on-screen radius `r` — the texture is stamped, never redrawn, so
// every size comes out of this one conversion.
export function smokePuffScale(r) {
  return (r * 2) / SMOKE_TEX_SIZE;
}
