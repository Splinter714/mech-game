// Arena line-of-sight dimming (#306, flyer rule reversed by #316) — "could we try slightly
// dimming stuff that is outside of LOS for the player?"
//
// #306 originally also granted flyers an exemption ("if there's a flying enemy that is in LOS
// because of that, then they fly ABOVE the LOS dimming"). #316 reversed that along with every
// other flying cover exemption — "let's let the flying enemies get greyed out the same as ground
// enemies when behind cover" — so flyers are now dimmed like anything else. See below.
//
// ── The treatment (final decision, #306) ──
// ONE dark translucent layer over the un-sighted hexes, at DEPTH.LOS_DIM (2.9) — deliberately NOT
// per-object tinting, and deliberately NOT a grey/desaturating wash. Because everything below 2.9
// shares this single overlay, terrain (0), ground FX (1), small ground units (2), the cover canopy
// (2.5), large ground units (2.75) and — since #316 — FLYING units (2.8) are all dimmed
// IDENTICALLY, by construction: there is no rule about which thing gets which treatment and no way
// for terrain and units to drift to different looks. The PLAYER alone sits at UNITS (3), above the
// overlay, and is the only thing never dimmed. #316 is therefore a one-number change — moving
// flyers from 3 to their own FLYING_UNITS tier at 2.8, still above the canopy and every ground
// unit so they visually fly over trees, but below 2.9 so the overlay covers them. Same
// fractional-depth-tier trick #289 established for COVER_CANOPY/LARGE_GROUND_UNITS.
//
// It also means enemies in un-sighted areas — ground or flying — are DIMMED, NOT HIDDEN,
// confirmed as the intent: you can still make out a shape through the dimming, so the player is
// never shot by something completely invisible. (Post-#316 a flyer with no sight line to the
// player can't shoot at all anyway — cover blocks it — so the dimming reads as an honest tell
// that the thing is currently out of the fight.)
//
// ── World UI is deliberately NOT dimmed ──
// Powerups, salvage/scrap and the objective beacon live on DEPTH.WORLD_UI (6), above the overlay,
// so leaving them bright was a real choice rather than a forced one. They stay fully visible:
// they're navigational aids, not threats. Dimming a threat is the whole mechanic (concealment
// protects a unit); dimming a pickup marker would only make routing around the map fiddly without
// adding any tactical decision, and the objective beacon in particular is the thing the HUD's
// off-screen arrow (#80/#260) already promises is always findable.
//
// ── Cost ──
// See data/visibility.js for the algorithm choice. The recompute is gated hard: it only runs when
// the player CROSSES A HEX BOUNDARY, or when a destructible tile collapses (which is what makes
// "blow a hole in the wall and the dimming behind it clears" work). Standing still or driving
// within one hex costs a single integer comparison per frame. The Graphics is likewise only
// redrawn when the set actually changes, never per frame.
import { DEPTH } from './shared.js';
import { HEX_SIZE, axialKey, hexCorners, hexToPixel, pixelToHex, range } from '../../data/hexgrid.js';
import { computeVisibleHexes } from '../../data/visibility.js';
import { wallEdgeCrossing } from '../../data/wallEdges.js';

// How dark, and what colour. Emphasis from the request is on *slightly*: this should read as
// "you can't see round there", not fog-of-war blackout. A near-black with a faint blue bias
// darkens without tinting — it won't fight the biome palettes the way a grey wash would.
const DIM_COLOR = 0x050a12;
const DIM_ALPHA = 0.34;

// Hexes are filled a hair oversized so two adjacent dim hexes don't leave a hairline seam of
// full-brightness terrain between them at fractional zoom levels.
const DIM_HEX_SIZE = HEX_SIZE + 0.75;

// Hard cap on the FOV radius, so an unusually large window can't make the pass unbounded. A
// viewport is comfortably inside this at the arena's GAMEPLAY_ZOOM.
const MAX_FOV_RADIUS = 26;

// A couple of rings past what the camera can actually show, so a hex that scrolls into view is
// already classified rather than popping from bright to dim a frame later.
const FOV_MARGIN_RINGS = 2;

export const VisibilityMixin = {
  // Called once from create(). The Graphics is world-space (not scroll-fixed) and sits between
  // DEPTH.FLYING_UNITS (2.8) and DEPTH.UNITS (3) — see the file header for why that single depth
  // value is the entire "everything but the player gets dimmed" implementation.
  _initVisibility() {
    this.fogFx = this.add.graphics().setDepth(DEPTH.LOS_DIM);
    this.visibleHexes = null;   // null = not computed yet; targeting treats that as "no gate"
    this._fogHexQ = null;
    this._fogHexR = null;
    this._fogRadius = 0;
    this._fogDirty = true;      // set by world.js on terrain collapse — see `_invalidateVisibility`
  },

  // #306: terrain just changed shape (a destructible hex collapsed to rubble), so the cached
  // visible set is stale — blowing a hole in cover has to visibly buy vision. Called from
  // world.js `_damageBuildingAt`'s destroyed branch. Cheap: just flips a flag, the actual
  // recompute happens on the next `_updateVisibility` tick.
  _invalidateVisibility() {
    this._fogDirty = true;
  },

  // Per-frame tick, called from update() with the camera's world-view rect (the same one tile
  // culling and the terrain labels already use — no second camera-bounds computation).
  //
  // The recompute gate is the whole performance story: the field-of-view pass and the Graphics
  // redraw run ONLY when the player's hex changes, the needed radius changes, or terrain
  // collapsed. Every other frame this function is three comparisons and a return.
  _updateVisibility(view) {
    if (!this.fogFx) return;
    const h = pixelToHex(this.px, this.py);
    const radius = this._fovRadius(view);
    if (!this._fogDirty && h.q === this._fogHexQ && h.r === this._fogHexR && radius === this._fogRadius) return;
    this._fogDirty = false;
    this._fogHexQ = h.q;
    this._fogHexR = h.r;
    this._fogRadius = radius;

    // The pure FOV pass (data/visibility.js). `this.terrain` is the live hex→terrain-id Map, so a
    // collapsed building is already rubble here by the time the invalidation flag is read.
    // #288: base walls are hex-EDGE geometry, not terrain hexes, so they're consulted as line
    // segments (`wallEdgeCrossing`, the same exact-crossing test shots and movement use) rather
    // than via the terrain lookup — otherwise the player would see straight through a base wall.
    // Passed as null when there are no standing spans, which re-enables the open-ground fast path.
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
    this._drawVisibilityOverlay(h, radius);
  },

  // How many rings out the overlay needs to cover: the half-diagonal of the camera's world-view
  // rect, converted to hex steps (a hex advances 1.5 * HEX_SIZE per row, the tighter of the two
  // axes, so this over- rather than under-estimates), plus a margin, clamped.
  _fovRadius(view) {
    const halfDiag = Math.hypot(view.width / 2, view.height / 2);
    const rings = Math.ceil(halfDiag / (HEX_SIZE * 1.5)) + FOV_MARGIN_RINGS;
    return Math.min(MAX_FOV_RADIUS, rings);
  },

  // Redraw the single dark layer: one fill per hex in the disc that ISN'T in the visible set.
  // Only the un-sighted hexes are drawn (normally the minority), and only when the set changed —
  // so this is a few hundred polygon fills a few times a second, not per frame.
  _drawVisibilityOverlay(center, radius) {
    const g = this.fogFx;
    g.clear();
    // Nothing is un-sighted (the whole disc is visible — open ground, the common case): the clear
    // above is the entire redraw, no polygon fills at all.
    if (this.visibleHexes.size >= 3 * radius * (radius + 1) + 1) return;
    g.fillStyle(DIM_COLOR, DIM_ALPHA);
    // One reused 6-point buffer rather than a fresh `corners.map(...)` array of fresh objects per
    // hex — Phaser reads the points synchronously inside fillPoints, so mutating and re-passing
    // the same array is safe, and it turns a few hundred short-lived allocations per redraw into
    // zero. Same reason the hex-corner offsets are computed once outside the loop.
    const corners = hexCorners(DIM_HEX_SIZE);
    const buf = corners.map(() => ({ x: 0, y: 0 }));
    for (const hx of range(center, radius)) {
      if (this.visibleHexes.has(axialKey(hx.q, hx.r))) continue;
      const p = hexToPixel(hx.q, hx.r);
      for (let i = 0; i < 6; i++) { buf[i].x = p.x + corners[i].x; buf[i].y = p.y + corners[i].y; }
      g.fillPoints(buf, true, true);
    }
  },

  // Is the world point (x, y) inside the player's current field of view? Used by targeting to
  // gate what convergence/lock may acquire. Returns true when no FOV has been computed yet, so
  // targeting is never silently disabled by ordering.
  _pointVisible(x, y) {
    if (!this.visibleHexes) return true;
    const h = pixelToHex(x, y);
    return this.visibleHexes.has(axialKey(h.q, h.r));
  },
};
