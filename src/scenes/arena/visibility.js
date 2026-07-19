// Arena line-of-sight dimming (#306; flyer rule reversed by #316; reworked to RAYCAST by #306's
// own playtest) — "could we try slightly dimming stuff that is outside of LOS for the player?"
//
// ── What the playtest changed ──
// The first pass dimmed whole HEXES that failed a hex-line LOS walk. It worked, but the owner's
// verdict was twofold: "should be MUCH MUCH more dim; also didn't realize you were building a
// hex-darkening version instead of like a raycast". So two things changed here and nothing else:
//
//   1. DIM_ALPHA 0.34 → 0.8. Close to blacked out. He chose this knowing units in shadow become
//      hard to make out — that is the accepted trade, and it is one constant to retune.
//   2. The overlay is now a true VISIBILITY POLYGON (data/shadowPolygon.js): blockers are line
//      segments, rays sweep their corners, and the dark region is filled as angularly-disjoint
//      wedges. Shadow edges are straight lines radiating from real obstacle corners at whatever
//      angle the geometry gives, instead of snapping to hex boundaries.
//
// ── TWO cadences, deliberately, because there are TWO consumers ──
// This file runs two independent computations that must not be conflated:
//
//   • RENDERING (the shadow polygon) — recomputed EVERY FRAME the player has moved at all. This is
//     not a nice-to-have: a raycast shadow's ANGLE changes continuously with the viewer's position,
//     so the hex-boundary gate the first pass used (~5 recomputes/second) would make every shadow
//     edge visibly snap and jump while driving. The owner flagged exactly this — "5x/sec seems...
//     kinda infrequent". Per-frame is the only cadence that looks right, and it measured cheap
//     enough to afford.
//   • GAMEPLAY (`_pointVisible` → what targeting/convergence may acquire) — still the ORIGINAL
//     hex-based `computeVisibleHexes`, still gated on crossing a hex boundary. That code is pure,
//     unit-tested, and #316 has just re-cut its flyer rule; re-basing a tested combat gate on new
//     geometry for a cosmetic change would be all risk and no gain. Hexes decide what you may
//     SHOOT; polygons decide what looks dark.
//
//   Both are built from the same blockers (`coverBlocksForRay` + standing wall spans), so they
//   agree to within a hex. Where they can differ is a sub-hex sliver at a shadow boundary: an
//   enemy whose hex CENTRE is lit but whose sprite is clipped by a shadow edge, or the reverse.
//   That seam is known and accepted, not silently reconciled.
//
// ── The treatment (unchanged from the original decision) ──
// ONE dark translucent layer at DEPTH.LOS_DIM (2.9) — not per-object tinting, not a grey wash.
// Because everything below 2.9 shares this single overlay, terrain (0), ground FX (1), small ground
// units (2), the cover canopy (2.5), large ground units (2.75) and — since #316 — FLYING units
// (2.8) are dimmed IDENTICALLY, by construction. There is no rule about which thing gets which
// treatment and no way for them to drift apart. The PLAYER alone sits at UNITS (3), above the
// overlay, and is the only thing in the game never dimmed.
//
// Enemies in shadow are DIMMED, NOT HIDDEN — you can still make out a shape, so you're never shot
// by something wholly invisible. At 0.8 that shape is faint; post-#316 anything with no sight line
// to you can't shoot you anyway, so the darkness reads as an honest tell that it's out of the fight.
//
// ── World UI is deliberately NOT dimmed ──
// Powerups, salvage and the objective beacon live at DEPTH.WORLD_UI (6), above the overlay, so
// leaving them bright was a real choice. They're navigational aids, not threats: dimming a threat
// is the whole mechanic, dimming a pickup marker would just make routing fiddly. The objective
// beacon in particular is what the HUD's off-screen arrow (#80/#260) promises is always findable.
//
// ── Cost ──
// The sweep is affordable because of what it is NOT asked to do: blocking hexes contribute only
// their SILHOUETTE (edges shared with another blocker are skipped), everything is culled to the
// view radius, and each ray angularly rejects a segment in two compares before any intersection
// maths. Measured in the real running game with a paired within-session A/B (same page, same world,
// same fight, toggling every second — scripts/profile-los-306.mjs), because the standard profiler
// reseeds the world per run and its noise swamps the signal. Numbers are in the issue.
import { DEPTH } from './shared.js';
import { HEX_SIZE, axialKey, hexToPixel, pixelToHex } from '../../data/hexgrid.js';
import { computeVisibleHexes } from '../../data/visibility.js';
import { collectShadowSegments, computeVisibilityPolygon, shadowWedges } from '../../data/shadowPolygon.js';
import { liveWallEdges, wallEdgeCrossing } from '../../data/wallEdges.js';

// How dark, and what colour. The owner's call after playtesting 0.34: "should be MUCH MUCH more
// dim" — he picked ~80%, knowing it makes units in shadow hard to read. A near-black with a faint
// blue bias darkens without tinting, so it won't fight the biome palettes the way a grey would.
// THIS IS THE RETUNE KNOB — one number, and nothing else needs to change with it.
const DIM_ALPHA = 0.8;
const DIM_COLOR = 0x050a12;

// Re-sweep once the player has moved this far. Effectively per-frame while driving (a mech covers
// far more than half a pixel in one frame at any speed), and exactly zero while parked — which is
// strictly better than an unconditional per-frame recompute and visually identical, because the
// geometry depends only on POSITION, not on facing or time. Deliberately sub-pixel: anything larger
// and shadow edges would step, which is the whole complaint this rework exists to fix.
const SHADOW_MOVE_EPS_PX = 0.5;

// How far past the camera's half-diagonal rays are cast. Slightly over, so geometry scrolling into
// view is already classified rather than popping a frame later.
const FAR_MARGIN = 1.15;

// Hard cap on the FOV radius so an unusually large window can't make either pass unbounded.
const MAX_FOV_RADIUS = 26;

// A couple of rings past what the camera can show, same reason as FAR_MARGIN.
const FOV_MARGIN_RINGS = 2;

export const VisibilityMixin = {
  // Called once from create(). The Graphics is world-space (not scroll-fixed) and sits between
  // DEPTH.FLYING_UNITS (2.8) and DEPTH.UNITS (3) — that single depth value is the entire
  // "everything but the player gets dimmed" implementation.
  _initVisibility() {
    this.fogFx = this.add.graphics().setDepth(DEPTH.LOS_DIM);
    this.visibleHexes = null;   // null = not computed yet; targeting treats that as "no gate"
    this._fogHexQ = null;
    this._fogHexR = null;
    this._fogRadius = 0;
    this._fogDirty = true;      // set by world.js on terrain collapse / wall breach
    this._shadowX = null;       // last position the polygon was swept from
    this._shadowY = null;
    this._shadowSegs = 0;       // last segment count — read by the perf harness
  },

  // #306: the world just changed shape (a destructible hex collapsed, or a wall span was breached),
  // so both caches are stale — blowing a hole in cover has to visibly buy vision immediately.
  // Called from world.js. Cheap: flips a flag, the work happens on the next tick.
  _invalidateVisibility() {
    this._fogDirty = true;
    this._shadowX = null;
  },

  // Per-frame tick from update(), with the camera's world-view rect (the same one tile culling and
  // the terrain labels use — no second camera-bounds computation).
  _updateVisibility(view) {
    if (!this.fogFx) return;
    const radius = this._fovRadius(view);
    this._updateTargetingFov(radius);
    this._updateShadowPolygon(view, radius);
  },

  // ── Gameplay gate: unchanged hex FOV, unchanged cadence ──────────────────────────────
  // Only runs when the player's HEX changes, the radius changes, or the world collapsed. That is
  // the right cadence for THIS consumer precisely because its output is hex-granular: targeting
  // asks "is the enemy's hex visible", and that answer cannot change until somebody changes hex.
  _updateTargetingFov(radius) {
    const h = pixelToHex(this.px, this.py);
    if (!this._fogDirty && h.q === this._fogHexQ && h.r === this._fogHexR && radius === this._fogRadius) return;
    this._fogHexQ = h.q;
    this._fogHexR = h.r;
    this._fogRadius = radius;

    // #288: base walls are hex-EDGE geometry, not terrain hexes, so they're consulted as line
    // segments (`wallEdgeCrossing`, the same exact-crossing test shots and movement use). Passed
    // as null when there are no standing spans, which re-enables the open-ground fast path.
    const walls = this.wallEdges && this.wallEdges.edges?.size > 0 ? this.wallEdges : null;
    this.visibleHexes = computeVisibleHexes(
      h, radius, (q, r) => this.terrain.get(axialKey(q, r)),
      walls
        ? {
          hexCenter: (q, r) => hexToPixel(q, r),
          // #309: `true` — you can see through an OPEN gate. A closed one blocks sight like any span.
          segmentBlocked: (x0, y0, x1, y1) => !!wallEdgeCrossing(walls, x0, y0, x1, y1, undefined, true),
        }
        : {},
    );
  },

  // ── Rendering: the raycast sweep, per frame ──────────────────────────────────────────
  // `_fogDirty` is consumed HERE rather than in the targeting pass so a wall breach re-sweeps the
  // polygon on the very next frame even if the player is standing perfectly still. (It's read by
  // the targeting pass first, which runs before this one — hence the explicit clear here.)
  _updateShadowPolygon(view, radius) {
    const dirty = this._fogDirty;
    this._fogDirty = false;
    if (!dirty && this._shadowX !== null
      && Math.abs(this.px - this._shadowX) < SHADOW_MOVE_EPS_PX
      && Math.abs(this.py - this._shadowY) < SHADOW_MOVE_EPS_PX) return;
    this._shadowX = this.px;
    this._shadowY = this.py;

    // Cull to the camera's half-diagonal plus a margin. Rays are capped at this distance and shadow
    // wedges are extended well past it, so nothing on screen is ever left unclassified.
    const far = Math.hypot(view.width / 2, view.height / 2) * FAR_MARGIN;
    const walls = this.wallEdges ? liveWallEdges(this.wallEdges) : null;
    const segs = collectShadowSegments(
      this.px, this.py, far, (q, r) => this.terrain.get(axialKey(q, r)),
      { wallEdges: walls, hexRadius: radius },
    );
    this._shadowSegs = segs.length;
    this._drawShadow(segs, far);
  },

  _drawShadow(segs, far) {
    const g = this.fogFx;
    g.clear();
    // Nothing in range blocks sight (open ground — the common case): the clear IS the whole redraw,
    // no sweep and no fills at all.
    if (!segs.length) return;
    const poly = computeVisibilityPolygon(this.px, this.py, segs, far);
    const wedges = shadowWedges(poly, this.px, this.py, far);
    if (!wedges.length) return;
    g.fillStyle(DIM_COLOR, DIM_ALPHA);
    // The wedges are angularly disjoint by construction (see shadowPolygon.js), so filling them
    // independently at one alpha gives a perfectly uniform darkness — no double-darkened overlaps,
    // which is exactly what naive per-obstacle shadow volumes WOULD have produced.
    // One reused 4-point buffer rather than fresh objects per wedge: Phaser reads the points
    // synchronously inside fillPoints, so mutating and re-passing is safe, and it turns hundreds of
    // short-lived allocations per FRAME (this now runs per frame) into zero.
    const buf = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
    for (const w of wedges) {
      for (let i = 0; i < 4; i++) { buf[i].x = w[i * 2]; buf[i].y = w[i * 2 + 1]; }
      g.fillPoints(buf, true, true);
    }
  },

  // How many rings out the hex FOV needs to cover: the half-diagonal of the camera's world-view
  // rect converted to hex steps (a hex advances 1.5 * HEX_SIZE per row, the tighter of the two
  // axes, so this over- rather than under-estimates), plus a margin, clamped.
  _fovRadius(view) {
    const halfDiag = Math.hypot(view.width / 2, view.height / 2);
    const rings = Math.ceil(halfDiag / (HEX_SIZE * 1.5)) + FOV_MARGIN_RINGS;
    return Math.min(MAX_FOV_RADIUS, rings);
  },

  // Is the world point (x, y) inside the player's current field of view? Used by TARGETING to gate
  // what convergence/lock may acquire — deliberately the HEX answer, not the polygon one (see the
  // file header). Returns true when no FOV has been computed yet, so targeting is never silently
  // disabled by ordering.
  _pointVisible(x, y) {
    if (!this.visibleHexes) return true;
    const h = pixelToHex(x, y);
    return this.visibleHexes.has(axialKey(h.q, h.r));
  },
};
