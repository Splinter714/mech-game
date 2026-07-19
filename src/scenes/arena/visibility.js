// #337 — REGION FOG OF WAR (the scene-side wiring; the model is pure in data/fogRegions.js).
//
// THIS REPLACED #306's per-hex/per-frame raycast dimming. That version swept a visibility POLYGON
// every frame the player moved and gated targeting on a per-hex LOS set; Jackson had the overlay
// toggled off, undecided, and then re-specced the whole thing: "rework the greying out thing, I
// have in 'inside/outside' concept that's less frequently updating that I think would be good",
// plus "I would like to soften the edges of the shadow itself. So it's not quite so stark."
//
// ⚠ THE CADENCE IS THE FEATURE. Everything expensive here is keyed to an EVENT, not to a frame:
//
//   • The region set recomputes when the player CROSSES A REGION THRESHOLD (leaves a base compound,
//     or leaves one coarse open cell for another). Driving across the middle of a cell recomputes
//     nothing at all.
//   • Breach/open-gate reveals recompute when a span falls or a gate changes state
//     (`_invalidateVisibility`, already called from world.js and bases.js for exactly those events).
//   • Symmetric visibility ("if it can shoot me I can see it") is evaluated PER ENGAGING ENEMY, a
//     few dozen at most, never per hex.
//
// The only per-frame work is the overlay REDRAW, and even that is gated on the camera having moved
// a hex. If you are about to add a per-frame full-map visibility pass, stop — that pass is the
// thing this issue deleted.
//
// ── What the layer looks like ──
// ONE dark translucent layer at DEPTH.LOS_DIM (2.9), the same single-overlay treatment #306 chose
// and for the same reason: terrain (0), ground FX (1), small ground units (2), the cover canopy
// (2.5) and large ground units (2.75) are all fogged IDENTICALLY by construction, with no rule
// about which thing gets which treatment. The player (3) is above it and is never fogged.
//
// Unlike #306 the fog is drawn PER HEX with a per-hex alpha, which is what buys the softness:
// `softFogDepths` ramps alpha over FOG_SOFT_STEPS rings out from the lit frontier, so an edge is a
// two-or-three-hex gradient instead of a stencil, and the ceiling dropped 0.8 → 0.62.
//
// THREE tiers, and they encode the persistence rule Jackson set:
//   • lit    (alpha 0)          — inside the current region, or revealed through a breach/open gate
//   • known  (alpha KNOWN_ALPHA)— TERRAIN PERSISTS for the run once seen. A fresh run starts dark.
//   • unseen (alpha FOG_ALPHA)  — never visited
// ENEMIES DO NOT PERSIST ("Yes, but enemies still hide") — they are hidden per-frame by
// `_enemyVisible`, independently of the terrain memory, so a compound you have already looted still
// reads as mapped-but-unwatched.
//
// #327's z-order (flyers at 3.5, ABOVE this layer) was previously flagged as a wart to revisit. It
// is now the INTENDED rule — "Hides enemies too except for airborn enemies that have launched into
// the air" — so flyers being un-foggable is correct and nothing about the depth stack needs redoing.
//
// World UI (powerups, salvage, the objective beacon, DEPTH.WORLD_UI 6) stays above the fog for
// #306's original reason: they are navigational aids, not threats.
import { DEPTH } from './shared.js';
import { HEX_SIZE, axialKey, hexToPixel, pixelToHex, range } from '../../data/hexgrid.js';
import { blocksSpan, wallEdgeCrossing } from '../../data/wallEdges.js';
import {
  buildFogWorld, regionKeyAt, regionVisibleHexes, breachRevealHexes,
  softFogDepths, fogAlphaFor, enemyVisibleInFog,
} from '../../data/fogRegions.js';
import { DORMANT } from '../../data/awareness.js';

// Near-black with a faint blue bias: darkens without tinting, so it won't fight the biome palettes
// the way a neutral grey would. Kept from #306; only the ALPHAS changed (see fogRegions.js).
const FOG_COLOR = 0x050a12;

// Redraw the overlay once the camera has drifted this far. A hex is the natural quantum — the fog
// is drawn per hex, so nothing on screen can change identity until roughly this much has moved.
const REDRAW_MOVE_PX = HEX_SIZE;

// A couple of rings past the camera's half-diagonal, so hexes scrolling into view are already
// fogged rather than popping a frame later.
const DRAW_MARGIN_RINGS = 2;

// Hard cap on the drawn radius so an unusually large window can't make the redraw unbounded.
const MAX_DRAW_RADIUS = 26;

// Fills are drawn a hair oversized so adjacent hexes overlap instead of leaving hairline seams
// between two differently-alpha'd neighbours.
const HEX_OVERDRAW = 1.06;

export const VisibilityMixin = {
  _initVisibility() {
    this.fogFx = this.add.graphics().setDepth(DEPTH.LOS_DIM);
    this._visibilityReady = true;
    // The precomputed region map: base footprints, their interiors and their outlines. Built once
    // per run from `this.bases` (world.js `_buildWorld` populates it before create() gets here).
    this.fogWorld = buildFogWorld(this.bases ?? []);
    this.fogRegion = null;        // current region key — the threshold everything hangs off
    this.visibleHexes = null;     // LIVE lit set; also the targeting gate (see `_pointVisible`)
    this.knownHexes = new Set();  // terrain memory, persists for the whole run
    this._fogDepths = new Map();  // per-hex soft-edge depth, rebuilt with the region
    this._fogDirty = true;        // a wall fell / a gate moved ⇒ recompute the reveals
    this._fogDrawX = null;        // last position the overlay was drawn from
    this._fogDrawY = null;
  },

  // The world just changed shape — a destructible hex collapsed, a wall span was breached, or a
  // gate opened/closed. All three are exactly the events a breach reveal depends on, and all three
  // already call this (world.js `_damageBuildingAt`/`_damageWallEdge`, bases.js's gate tick). Cheap:
  // flips a flag; the recompute happens on the next tick.
  _invalidateVisibility() {
    this._fogDirty = true;
    this._fogDrawX = null;
  },

  _updateVisibility(view) {
    if (!this._visibilityReady) return;
    const h = pixelToHex(this.px, this.py);
    const region = regionKeyAt(h.q, h.r, this.fogWorld);
    // ── THE THRESHOLD ── everything below this line runs only when the answer to "which region am
    // I in" changed, or when the wall geometry did. Not per frame, not per hex, not per movement.
    if (region !== this.fogRegion || this._fogDirty) {
      this._fogDirty = false;
      this.fogRegion = region;
      this._rebuildRegionVisibility(region);
    }
    this._drawFog(view);
  },

  // Lit set = the region's own hexes ∪ everything any breach/open gate reveals. Then fold the
  // result into the run-long terrain memory and recompute the soft-edge ramp.
  _rebuildRegionVisibility(region) {
    const visible = regionVisibleHexes(region, this.fogWorld);
    for (const k of this._breachReveals()) visible.add(k);
    this.visibleHexes = visible;
    for (const k of visible) this.knownHexes.add(k);
    this._fogDepths = softFogDepths(visible);
  },

  // Every base with at least one non-solid span gets the all-angles reveal. `blocksSpan` is the
  // canonical "is this span solid" predicate, so a breached wall and an open gate are handled by
  // the SAME code path with no branch — which is precisely what Jackson asked for ("open gate should
  // reveal a portion of the base per what we talked about, right?").
  //
  // This is the generous case he was shown and accepted: the union over all exterior viewpoints of
  // what is visible through the gap. For an open compound that can be most of the interior. If it
  // plays too loose the knob is `BREACH_MAX_DEPTH` in fogRegions.js — one constant.
  _breachReveals() {
    const out = new Set();
    const set = this.wallEdges;
    if (!set || !set.edges?.size) return out;
    const openings = new Map();   // baseId -> [segment]
    for (const e of set.edges.values()) {
      if (blocksSpan(e) || e.baseId == null) continue;
      if (!openings.has(e.baseId)) openings.set(e.baseId, []);
      openings.get(e.baseId).push({ x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 });
    }
    for (const [baseId, segs] of openings) {
      const revealed = breachRevealHexes(baseId, this.fogWorld, segs, {
        // Standing spans still block — a breach on the north wall does not light the yard behind
        // an intact south wall. Same exact-crossing test shots and movement use.
        segmentBlocked: (x0, y0, x1, y1) => !!wallEdgeCrossing(set, x0, y0, x1, y1),
        terrainAt: (q, r) => this.terrain.get(axialKey(q, r)),
      });
      for (const k of revealed) out.add(k);
    }
    return out;
  },

  // ── Drawing ──────────────────────────────────────────────────────────────────────────
  // Redrawn only when the camera has drifted a hex, or a rebuild just happened. Everything it needs
  // (the lit set, the memory set, the depth ramp) is already computed; this is pure fill.
  _drawFog(view) {
    const g = this.fogFx;
    if (!g) return;
    if (this._fogDrawX !== null
      && Math.abs(this.px - this._fogDrawX) < REDRAW_MOVE_PX
      && Math.abs(this.py - this._fogDrawY) < REDRAW_MOVE_PX) return;
    this._fogDrawX = this.px;
    this._fogDrawY = this.py;
    g.clear();
    const center = pixelToHex(this.px, this.py);
    for (const h of range(center, this._drawRadius(view))) {
      const k = axialKey(h.q, h.r);
      const a = fogAlphaFor(k, {
        visible: this.visibleHexes, known: this.knownHexes, depths: this._fogDepths,
      });
      if (a <= 0) continue;
      const p = hexToPixel(h.q, h.r);
      g.fillStyle(FOG_COLOR, a);
      g.fillPoints(hexPoints(p.x, p.y), true, true);
    }
  },

  _drawRadius(view) {
    const halfDiag = Math.hypot(view.width / 2, view.height / 2);
    return Math.min(MAX_DRAW_RADIUS, Math.ceil(halfDiag / (HEX_SIZE * 1.5)) + DRAW_MARGIN_RINGS);
  },

  // ── Consumers ────────────────────────────────────────────────────────────────────────
  // Is this world point currently lit? The player's targeting gate for non-enemy things (hexes,
  // wall spans). Returns true before any fog exists so targeting is never silently disabled.
  _pointVisible(x, y) {
    if (!this.visibleHexes) return true;
    const h = pixelToHex(x, y);
    return this.visibleHexes.has(axialKey(h.q, h.r));
  },

  // Can the player SEE this enemy right now? The one gate for both drawing it and targeting it —
  // "nobody targets what they can't see", and the player never gets a lock on something he isn't
  // being shown. Airborne units and wall turrets are always visible; anything with a live firing
  // lane to the player is visible by SYMMETRY, so he is never shot by something wholly invisible.
  _enemyVisible(e) {
    return enemyVisibleInFog(e, {
      visible: this.visibleHexes,
      hexKeyOf: (x, y) => this._hexKeyAt(x, y),
      losClear: e?._losClear === true,
      awake: e?.awareness !== DORMANT,
    });
  },

  // Per-frame, per-enemy (a few dozen): hide the view of anything the fog conceals. Terrain memory
  // deliberately does NOT apply here — enemies never persist.
  _syncEnemyFogVisibility() {
    if (!this.visibleHexes || !this.enemies) return;
    for (const e of this.enemies) {
      if (e.view) e.view.setVisible(this._enemyVisible(e));
    }
  },
};

// A pointy-top hex outline in world pixels, slightly oversized (see HEX_OVERDRAW). One reused
// buffer: Phaser reads the points synchronously inside fillPoints, so mutating and re-passing is
// safe, and it turns hundreds of short-lived allocations per redraw into zero.
const HEX_BUF = [0, 1, 2, 3, 4, 5].map(() => ({ x: 0, y: 0 }));
function hexPoints(cx, cy) {
  const rad = HEX_SIZE * HEX_OVERDRAW;
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    HEX_BUF[i].x = cx + rad * Math.cos(a);
    HEX_BUF[i].y = cy + rad * Math.sin(a);
  }
  return HEX_BUF;
}
