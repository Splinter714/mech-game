// #270: a SECOND, quieter labelling layer alongside bases.js's `_spawnHexLabels` — that one
// stays exactly as-is (a handful of bold-red "DOCK"/"ALERT TOWER"/"TURRET" tags, one persistent
// Text per hex, created once at world-build time — fine at that scale). This file labels EVERY
// other hex with its real terrain id ("grass"/"forest"/"building"/...), which a full corridor
// map can carry thousands of — creating one persistent Text per hex for the whole map the way
// bases.js does would mean thousands of live GameObjects sitting around from world-build, most
// never on screen (worldgen.js CORRIDOR_LENGTH_PX=5700 after #308 lengthened the run ×
// CORRIDOR_HALF_WIDTH_PX=250, i.e. a ~2.9M px² playable area against a 48px hex — comfortably
// four figures of hexes, and #308 made it ~1.7x more so, on top of the
// #155 tile-culling comment's own ~20k-tile figure for the boundary-inclusive terrain map).
//
// So instead of pre-building, this is a camera-culled POOL: only hexes within the current view
// (+ a small margin) have a live Text object at all, keyed by hex key in `this._terrainLabelPool`
// so a hex re-entering range reuses nothing special (a fresh Text — see the perf note below) and
// a hex leaving range gets its Text destroyed and dropped from the pool.
//
// Update cadence — LABEL_UPDATE_MS: mirrors world.js's LOS_REFRESH_MS staggered-recompute idea.
// A hex is HEX_SIZE (48px) across; even the fastest chassis (light, 268px/s — data/chassis/
// light.js) only covers ~54px in a 200ms window, well under one hex width, so the "nearby set"
// genuinely doesn't need per-frame precision — recomputing every frame would just be redundant
// work. 200ms keeps the recompute rate low (~5/s, alongside world.js's own ~8/s LOS cadence)
// while staying comfortably faster than a hex crossing.
//
// Radius margin — LABEL_RADIUS_MARGIN_PX: padded past the view's own half-diagonal (same "view
// rect + margin ⇒ circle ⇒ hexesWithinPixelRadius" shape `_updateTileCulling`, world.js, already
// uses — reusing the exact `view` rect ArenaScene computes once per frame rather than a second
// camera-bounds computation) so a label a player is about to scroll onto is already alive rather
// than popping in right at the screen edge. 220px comfortably outruns the ~54px/200ms worst-case
// per-tick travel above with real headroom (~4x), while staying far smaller than world.js's own
// CULL_MARGIN_PX (1200px) — that margin exists to make TILE recomputes rare (an expensive full
// map diff), not to hide label pop-in, and a much larger label margin would just mean far more
// simultaneous Text objects alive for no visual benefit (these are always inside the tile-culled
// view already).
//
// Pooling vs. plain create/destroy: with dozens of labels churning every ~200ms as the player
// drives down a long corridor, a naive create-fresh/destroy-old approach would still be a lot of
// GameObject churn (each `this.add.text` allocates a new Phaser Text + its own tinted glyph
// texture/geometry) purely because a hex leaves range on one tick and a DIFFERENT hex enters —
// most ticks only touch the edge of the active set, not all of it. This pool only ever creates a
// Text the first time a given hex key becomes visible and only destroys it once that hex key
// actually falls out of range, so steady-state driving (the common case — long stretches with a
// stable "nearby" set) does zero allocation. True object-reuse pooling (re-texturing an existing
// Text for a NEW hex instead of destroy+create) was considered but skipped: it adds real
// complexity (matching pool size to churn rate, `setText`+reposition bookkeeping) for a case
// (dozens of live Texts, ~5 recomputes/sec) that's nowhere near what `_updateTileCulling`'s own
// #148 audit flagged (thousands of Image objects/frame) — this is a couple of orders of
// magnitude cheaper. Revisit with real profiling if playtest shows otherwise.
import { hexToPixel, axialKey } from '../../data/hexgrid.js';
import { hexesForLabelsInRange } from '../../data/hexLabels.js';
import { getTerrain } from '../../data/terrain.js';
import { isBoundaryTerrainId } from '../../art/hexArt.js';
import { DEPTH } from './shared.js';
import { HEX_LABEL_COLOR, HEX_LABEL_FONT_SIZE, HEX_LABEL_FONT_STYLE } from './hexLabelStyle.js';

export const LABEL_UPDATE_MS = 200;
export const LABEL_RADIUS_MARGIN_PX = 220;

// #270 playtest follow-up: unified with bases.js's dock/alertTower/turretEmplacement labels —
// same color/size/weight (hexLabelStyle.js), full alpha. Previously this layer used a distinct
// muted-gray/low-alpha look to read as "quiet ambient flavour text" vs. bases.js's "pay
// attention" red; Jackson asked for one consistent look across all hex labels instead, so that
// distinction is gone. Dev-only now too (see ArenaScene.js's `import.meta.env.DEV` gate around
// `_initTerrainLabels()`/`_updateTerrainLabels()`).

export const TerrainLabelsMixin = {
  // Called once from ArenaScene.create(), after `_buildWorld`/`_spawnHexLabels` have populated
  // `this.terrain`/`this.bases`/`this.alertTowerHexes` — mirrors bases.js `_spawnHexLabels`'s own
  // iteration over bases/towers, but only to build a Set of hex KEYS to skip (never creates a
  // Text here) so a dock/alertTower/turretEmplacement hex is never double-labelled. Read-only
  // over `this.bases`/`this.alertTowerHexes`; doesn't touch bases.js's own `_hexLabels` array.
  _initTerrainLabels() {
    this._terrainLabelPool = new Map();   // hexKey -> live Phaser.Text
    this._terrainLabelCd = 0;             // ms until next recompute (simulation time)
    this._specialLabelHexes = new Set();
    for (const base of this.bases ?? []) {
      for (const dock of base.docks) this._specialLabelHexes.add(axialKey(dock.q, dock.r));
      for (const turret of base.turrets ?? []) this._specialLabelHexes.add(axialKey(turret.q, turret.r));
    }
    for (const t of this.alertTowerHexes ?? []) this._specialLabelHexes.add(axialKey(t.q, t.r));
  },

  // Called from ArenaScene.update() alongside `_updateTileCulling(view)` — reuses the SAME `view`
  // rect (the camera's world-space view, already computed once per frame) rather than a second
  // camera-bounds computation. `dt` is the same per-frame delta (seconds) every other mixin's
  // per-frame method already receives.
  _updateTerrainLabels(view, dt) {
    if (!this.terrain) return;
    this._terrainLabelCd -= Math.max(0, dt) * 1000;
    if (this._terrainLabelCd > 0) return;
    this._terrainLabelCd += LABEL_UPDATE_MS;
    if (this._terrainLabelCd <= 0) this._terrainLabelCd = LABEL_UPDATE_MS;   // guard: huge delta spike

    const cx = view.x + view.width / 2;
    const cy = view.y + view.height / 2;
    const radius = Math.hypot(view.width / 2 + LABEL_RADIUS_MARGIN_PX, view.height / 2 + LABEL_RADIUS_MARGIN_PX);
    const nearby = hexesForLabelsInRange(this.terrain, cx, cy, radius, this._specialLabelHexes);

    const nextKeys = new Set();
    for (const { key, q, r, id } of nearby) {
      // No tile is drawn for a boundary-only hex (world.js `_buildWorld`'s tile-image loop skips
      // it the same way) — skip its label too, so a label never appears floating over the flat
      // camera-colour boundary fill with nothing else there.
      const tex = getTerrain(id)?.tex;
      if (tex && isBoundaryTerrainId(tex)) continue;
      nextKeys.add(key);
      if (this._terrainLabelPool.has(key)) continue;
      const { x, y } = hexToPixel(q, r);
      const label = this.add.text(x, y, id, {
        fontFamily: 'monospace', fontSize: HEX_LABEL_FONT_SIZE, color: HEX_LABEL_COLOR, fontStyle: HEX_LABEL_FONT_STYLE,
      }).setOrigin(0.5).setDepth(DEPTH.WORLD_UI);
      // #270 playtest follow-up: honour the live L-key toggle (ArenaScene `_hexLabelsVisible`,
      // default true) — a hex that enters view AFTER a toggle still comes in hidden/shown
      // correctly, since every newly pooled label picks up the current flag on creation.
      label.setVisible(this._hexLabelsVisible ?? true);
      this._terrainLabelPool.set(key, label);
    }
    for (const [key, label] of this._terrainLabelPool) {
      if (nextKeys.has(key)) continue;
      label.destroy();
      this._terrainLabelPool.delete(key);
    }
  },
};
