// #337 v2 — COMPOUND-INTERIOR FOG (the scene-side wiring; the model is pure in data/fogRegions.js).
//
// ── Read this before adding anything ──
// v1 fogged the whole world through coarse open-world BLOCKS with a reveal disc centred on whichever
// block you occupied. Jackson played it and it "pops badly as I drive" — inevitably, because the
// disc jumps a block-width every time you cross a boundary. All of that is DELETED: the block keys,
// the disc radius, the run-long terrain memory, the three-tier lit/known/unseen alpha stack. The
// open world is simply never drawn over.
//
// What is left is two things, and they have completely different cadences:
//
//   1. THE FOGGED SET — the interiors of compounds not yet entered. Changes ONCE per compound, the
//      moment the player drives inside, and never again for the run. There are no live interior
//      shadows, so there is nothing that can pop.
//   2. THE BREACH PEEK — the ONE hex behind each nearby open span, so the sliver of yard he can see
//      swings as he walks along the wall. Recomputed on movement, but only while he is OUTSIDE a
//      compound that still has fog and an opening; the rest of the time it is not computed at all.
//
// ── v3: the peek is a hex set again, and that is not a regression ──
// v2 cast a PEEK_RADIUS_PX (900px) visibility polygon from the player through the openings
// (data/shadowPolygon.js) and cut it out of the fog as an inverted GeometryMask. Jackson played it:
// "the auto-reveal on breach/gate is a bit too generous; maybe we just reveal the one hex inside
// the breach or opening or something small like that". A 900px raycast sweep whose intended output
// is a single hex is doing pointless work, so the sweep, the polygon and the mask are all DELETED
// rather than retuned — see `peekHexes` in data/fogRegions.js.
//
// His earlier "it shouldn't be hex by hex, it should be by raycast" was about v1's coarse
// 5-hex-block reveal disc popping as he drove; at one to three hexes of depth (#352 deepened the
// cone with proximity) there is no wedge geometry left for a raycast to express, and the reveal is
// still directional (only openings you are standing near light up). His own follow-up says as much:
// "at this scale the distinction barely matters".
//
// ── What v1 got right and is kept verbatim ──
// One dark translucent layer at DEPTH.LOS_DIM (2.9), so terrain, ground FX, small units, the cover
// canopy and large units are all fogged identically with no per-thing rule. The player (3) and
// airborne units (3.5) are above it — flyers being un-foggable is the intended rule, not a wart.
// World UI (powerups, salvage, the beacon; DEPTH.WORLD_UI 6) stays above: navigational aids, not
// threats. And the softness — 0.62 ceiling, a 3-ring gradient ramp — is the one part of the v1 look
// he did not object to.
import { DEPTH } from './shared.js';
import { fogOriginOf, fogOriginsOf } from './players.js';
import { HEX_SIZE, axialKey, hexToPixel, pixelToHex, range } from '../../data/hexgrid.js';
import { blocksSpan } from '../../data/wallEdges.js';
import {
  buildFogWorld, compoundAt, fogHexes, fogFrontier, fogAlphaFor, peekHexes, enemyVisibleInFog,
  FOG_ALPHA, FOG_FEATHER_PX,
} from '../../data/fogRegions.js';
import { DORMANT } from '../../data/awareness.js';

// Near-black with a faint blue bias: darkens without tinting, so it won't fight the biome palettes
// the way a neutral grey would.
const FOG_COLOR = 0x050a12;

// Recompute the peek / redraw the fill once the player has drifted this far. A hex is the natural
// quantum for the fill; for the peek it is a deliberate cap on how often the sweep runs.
const REDRAW_MOVE_PX = HEX_SIZE;

// A couple of rings past the camera's half-diagonal, so hexes scrolling into view are already fogged
// rather than popping a frame later.
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
    // Precomputed once per run from `this.bases` (world.js `_buildWorld` fills it before create()).
    this.fogWorld = buildFogWorld(this.bases ?? []);
    this.enteredCompounds = new Set();
    this.foggedHexes = fogHexes(this.fogWorld, this.enteredCompounds);
    this._fogFrontier = fogFrontier(this.foggedHexes);
    this._peeked = new Set();    // the hexes currently visible through an opening (v3: one per hole)
    this._fogDrawX = null;       // last position the overlay was drawn / the peek was resolved from
    this._fogDrawY = null;
  },

  // The world changed shape — a destructible hex collapsed, a wall span was breached, or a gate
  // opened/closed. All three can change what the peek reaches, and all three already call this
  // (world.js `_damageBuildingAt`/`_damageWallEdge`, bases.js's gate tick). Cheap: drops the
  // movement gate so the next tick re-sweeps.
  _invalidateVisibility() {
    this._fogDrawX = null;
  },

  _updateVisibility(view) {
    if (!this._visibilityReady) return;
    // #347: the fog is swept from ONE origin — the local player. Phase 2 makes the lit set the
    // UNION of every live player's sweep (a compound entered by either counts as entered, and
    // both peeks light), which is a real design change; phase 1 deliberately keeps the single
    // origin so the fog renders pixel-identically. Named seam so that change is one edit here.
    const o = fogOriginOf(this);
    // ── THE ONE STATE TRANSITION ── standing anywhere in a compound's footprint counts as having
    // entered it, and it stays lit for the rest of the run. Note this fires on the OUTLINE ring too,
    // which is right: the only way onto an outline hex is through the wall line itself.
    //
    // #348: this half is a UNION over every live player — either player walking into a compound
    // reveals it for the team. Entry is a persistent world-state change (it stays lit for the
    // whole run), so it must not depend on which player happens to be player 1. The SWEEP below
    // is deliberately still single-origin: the peek raycast and the redraw gate are per-frame
    // rendering, and the shared leashed camera keeps both players inside the same frame anyway.
    let entered = false;
    for (const origin of fogOriginsOf(this)) {
      const h = pixelToHex(origin.x, origin.y);
      const here = compoundAt(h.q, h.r, this.fogWorld);
      if (here != null && !this.enteredCompounds.has(here)) {
        this.enteredCompounds.add(here);
        entered = true;
      }
    }
    if (entered) {
      this.foggedHexes = fogHexes(this.fogWorld, this.enteredCompounds);
      this._fogFrontier = fogFrontier(this.foggedHexes);
      this._fogDrawX = null;
    }
    // Which compound the SWEEP origin is standing in — the peek only exists relative to the one
    // vantage point it is cast from, so this stays single-origin (see the note above).
    const oh = pixelToHex(o.x, o.y);
    const here = compoundAt(oh.q, oh.r, this.fogWorld);
    if (this._fogDrawX !== null
      && Math.abs(o.x - this._fogDrawX) < REDRAW_MOVE_PX
      && Math.abs(o.y - this._fogDrawY) < REDRAW_MOVE_PX) return;
    this._fogDrawX = o.x;
    this._fogDrawY = o.y;
    this._updatePeek(here);
    this._drawFog(view);
  },

  // ── The breach peek ──────────────────────────────────────────────────────────────────
  // Resolved from the player's CURRENT position, which is the whole point — v1 unioned over every
  // exterior angle and lit nearly the entire yard from a single hole, which is not "partial reveal";
  // v2 narrowed that to a polygon from where he stands, and v3 narrows it again to the single hex
  // behind each opening he is standing next to. Skipped entirely when there is nothing to peek
  // into: inside a compound, no fog left, or no opening anywhere. `blocksSpan` is the canonical
  // solidity predicate, so a blown span and an open gate take the same path with no branch.
  _updatePeek(here) {
    const set = this.wallEdges;
    const worth = here == null && this.foggedHexes?.size && set?.edges?.size;
    if (!worth) { this._peeked = new Set(); return; }
    const open = [...set.edges.values()].filter((e) => !blocksSpan(e));
    if (!open.length) { this._peeked = new Set(); return; }
    // #347: same single origin as `_updateVisibility`.
    this._peeked = peekHexes(this.foggedHexes, open, fogOriginOf(this));
  },

  // ── Drawing ──────────────────────────────────────────────────────────────────────────
  // One flat near-black fill over every fogged hex, then a 2-3px feather stroked around the
  // frontier hexes only. The stroke straddles the boundary, so it adds ~1.5px of half-alpha fog
  // outside the silhouette and lands on already-black fog inside it (invisible there) — a
  // crisp-but-anti-aliased outline rather than the ~144px grey ramp the ring tiering produced.
  _drawFog(view) {
    const g = this.fogFx;
    if (!g) return;
    g.clear();
    if (!this.foggedHexes?.size) return;
    const o = fogOriginOf(this);
    const center = pixelToHex(o.x, o.y);
    const drawn = [];
    for (const h of range(center, this._drawRadius(view))) {
      const k = axialKey(h.q, h.r);
      const a = fogAlphaFor(k, { fogged: this.foggedHexes, peeked: this._peeked });
      if (a <= 0) continue;
      const p = hexToPixel(h.q, h.r);
      g.fillStyle(FOG_COLOR, a);
      g.fillPoints(hexPoints(p.x, p.y), true, true);
      if (this._fogFrontier?.has(k)) drawn.push(p);
    }
    // Two thin passes: the wider one at low alpha, a narrower one nearer full — a short ramp
    // measured in pixels, not hexes.
    for (const [w, mul] of [[FOG_FEATHER_PX, 0.4], [FOG_FEATHER_PX * 0.5, 0.75]]) {
      g.lineStyle(w, FOG_COLOR, FOG_ALPHA * mul);
      for (const p of drawn) g.strokePoints(hexPoints(p.x, p.y), true, true);
    }
  },

  _drawRadius(view) {
    const halfDiag = Math.hypot(view.width / 2, view.height / 2);
    return Math.min(MAX_DRAW_RADIUS, Math.ceil(halfDiag / (HEX_SIZE * 1.5)) + DRAW_MARGIN_RINGS);
  },

  // ── Consumers ────────────────────────────────────────────────────────────────────────
  // Does the player's peek reach this world point? The SAME hex set the fill was cut from, so what
  // he can see and what he can shoot cannot disagree.
  _peekVisible(x, y) {
    if (!this._peeked?.size) return false;
    const h = pixelToHex(x, y);
    return this._peeked.has(axialKey(h.q, h.r));
  },

  // Is this world point visible? The player's targeting gate for non-enemy things (hexes, wall
  // spans). Everything outside a fogged compound interior is always visible now.
  _pointVisible(x, y) {
    if (!this.foggedHexes?.size) return true;
    const h = pixelToHex(x, y);
    if (!this.foggedHexes.has(axialKey(h.q, h.r))) return true;
    return this._peekVisible(x, y);
  },

  // Can the player SEE this enemy right now? The one gate for both drawing it and targeting it —
  // "nobody targets what they can't see", and he never gets a lock on something he isn't shown.
  _enemyVisible(e) {
    return enemyVisibleInFog(e, {
      fogged: this.foggedHexes,
      hexKeyOf: (x, y) => this._hexKeyAt(x, y),
      losClear: e?._losClear === true,
      awake: e?.awareness !== DORMANT,
      peekVisible: (x, y) => this._peekVisible(x, y),
    });
  },

  // Per-frame, per-enemy (a few dozen): hide anything the fog conceals.
  _syncEnemyFogVisibility() {
    if (!this.foggedHexes?.size || !this.enemies) return;
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
