// #512: buildable repair outposts — the scene-side half. Pure claim-lookup/cost/repair-math logic
// lives in data/repairOutposts.js; this wires it into the live arena: a proximity check against
// every base the player holds (`this.bases`, the `captured` flag #518's baseCapture.js sets),
// the interact-key build prompt (the SAME T/pad-A INTERACT_BIND #517's post-clear capture choice
// already uses), the scrap spend, and a lightweight world-space marker once one's built.
//
// Deliberately reuses #517's interact pattern rather than inventing a second one. The two never
// fight over the key in practice — a base is either mid-clear-and-not-yet-captured (the #517
// choice) or already `captured` (this file's territory) — but `run.js`'s `_onInteractPressed`
// still checks the #517 choice FIRST and only falls through to `_onRepairInteractPressed` when
// nothing is pending, so a straggling capture choice always wins the same keypress.
import { hexToPixel } from '../../data/hexgrid.js';
import {
  REPAIR_OUTPOST_COST, REPAIR_RADIUS_PX, REPAIR_RATE_PER_SEC,
  hasRepairOutpost, canBuildRepairOutpost, buildRepairOutpost,
} from '../../data/repairOutposts.js';
import { OUTPOSTS_KEY } from '../../data/events.js';
import { saveOutposts } from '../../data/save.js';
import { livePlayersOf } from './players.js';
import { DEPTH } from './shared.js';

export const RepairOutpostsMixin = {
  _initRepairOutposts() {
    this._repairOutpostMarkers = new Map();   // baseId → the marker views drawn for it
    this._repairBuildPromptBase = null;       // the nearest eligible-but-unbuilt held base in range, or null
  },

  // Per frame: for every base the player holds (`captured`), either passively heal any live
  // player standing inside a BUILT outpost's radius, or — for a held base with nothing built yet
  // — check whether a live player is close enough to offer the build prompt. Only the single
  // nearest such candidate is ever offered at once (mirrors #517's one-choice-at-a-time shape).
  _updateRepairOutposts(dt) {
    if (!this.bases?.length) {
      this._repairBuildPromptBase = null;
      this.registry.set('repairOutpostPrompt', null);
      return;
    }
    const outposts = this.registry.get(OUTPOSTS_KEY) ?? [];
    const live = livePlayersOf(this);
    let nearestCandidate = null;
    let nearestDist = Infinity;

    for (const base of this.bases) {
      if (!base.captured) continue;
      const center = hexToPixel(base.center.q, base.center.r);
      if (hasRepairOutpost(outposts, this.biomeId, base.id)) {
        if (!this._repairOutpostMarkers.has(base.id)) this._drawRepairOutpostMarker(base.id, center);
        for (const p of live) {
          if (Math.hypot(p.x - center.x, p.y - center.y) <= REPAIR_RADIUS_PX) {
            p.mech.repairTick(dt, REPAIR_RATE_PER_SEC);
          }
        }
        continue;
      }
      // Defensive: a `captured` base should always have a matching outpost record (that's how
      // `captured` got set), but skip cleanly rather than assume it if not.
      if (!canBuildRepairOutpost(outposts, this.biomeId, base.id)) continue;
      for (const p of live) {
        const d = Math.hypot(p.x - center.x, p.y - center.y);
        if (d <= REPAIR_RADIUS_PX && d < nearestDist) { nearestDist = d; nearestCandidate = base; }
      }
    }

    // #517's post-clear choice owns the interact key while it's up.
    if (this._captureChoiceActive) nearestCandidate = null;
    this._repairBuildPromptBase = nearestCandidate;
    this.registry.set(
      'repairOutpostPrompt',
      nearestCandidate ? { baseId: nearestCandidate.id, cost: REPAIR_OUTPOST_COST } : null,
    );
  },

  // The interact press's repair-build half — called from run.js `_onInteractPressed` AFTER the
  // #517 capture-choice check. No-op with nothing pending (mirrors `_onInteractPressed`'s own
  // no-op-outside-a-choice behaviour).
  _onRepairInteractPressed() {
    const base = this._repairBuildPromptBase;
    if (!base) return;
    const balance = this.run?.currency ?? 0;
    const primary = livePlayersOf(this)[0];
    if (balance < REPAIR_OUTPOST_COST) {
      this._floatText?.(primary?.x ?? 0, (primary?.y ?? 0) - 30, 'NOT ENOUGH SCRAP', '#e2533a');
      return;
    }
    const outposts = this.registry.get(OUTPOSTS_KEY) ?? [];
    const next = buildRepairOutpost(outposts, this.biomeId, base.id);
    if (next === outposts) return;   // shouldn't happen — canBuildRepairOutpost already gated the prompt
    this.registry.set(OUTPOSTS_KEY, next);
    saveOutposts(next);
    // #512: spent from the LIVE run currency (same in-sortie pool salvage/mission payouts feed —
    // scenes/arena/salvage.js `_collectSalvage`), not the banked meta-progression pool the Garage
    // shop spends.
    this.run.currency = balance - REPAIR_OUTPOST_COST;
    this.registry.set('run', this.run);
    this._repairBuildPromptBase = null;
    this.registry.set('repairOutpostPrompt', null);
    this._drawRepairOutpostMarker(base.id, hexToPixel(base.center.q, base.center.r));
    this._floatText?.(primary?.x ?? 0, (primary?.y ?? 0) - 30, 'REPAIR OUTPOST BUILT', '#7bd17b');
  },

  // A small standing marker — same throwaway-Graphics-decal convention as world.js's drop-pod FX
  // (`_drawDropPodFx`), not a new terrain id/texture: a green cross-in-a-ring reads clearly as "a
  // friendly repair station" without a new procedural-art pass. Drawn once per base and cached so
  // a redeploy into an already-built base (or backtracking to one built earlier this sortie)
  // never draws it twice.
  _drawRepairOutpostMarker(baseId, center) {
    if (typeof this.add?.circle !== 'function') return;
    const ring = this.add.circle(center.x, center.y, 34)
      .setStrokeStyle(3, 0x7bd17b, 0.85).setDepth(DEPTH.WORLD_UI);
    const vBar = this.add.rectangle(center.x, center.y, 6, 22, 0x7bd17b, 0.9).setDepth(DEPTH.WORLD_UI);
    const hBar = this.add.rectangle(center.x, center.y, 22, 6, 0x7bd17b, 0.9).setDepth(DEPTH.WORLD_UI);
    this._repairOutpostMarkers.set(baseId, { ring, vBar, hBar });
  },
};
