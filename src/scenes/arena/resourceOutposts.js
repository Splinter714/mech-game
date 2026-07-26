// #511: buildable resource outposts — the scene-side half, mirroring #512's
// scenes/arena/repairOutposts.js shape closely. Pure claim-lookup/cost/income-math logic lives in
// data/resourceOutposts.js; this wires it into the live arena: a proximity check against every
// base the player holds (`this.bases`, the `captured` flag #518's baseCapture.js sets) for the
// BUILD prompt, the interact-key build wiring, the scrap spend, a lightweight world-space marker
// once one's built, and — the one place this genuinely differs from repair — a per-frame passive
// scrap trickle that needs no player presence once built (see data/resourceOutposts.js's
// RESOURCE_INCOME_PER_SEC comment for the open design call this represents).
//
// Reuses #517/#512's interact-prompt pattern rather than inventing a third one. A freshly
// captured base can offer BOTH the repair and resource build prompts at once (the two flags are
// independent); run.js `_onInteractPressed` gives the repair prompt priority for a single
// keypress at the same base (mirrors the existing capture-choice-before-repair fallthrough) — so
// one press builds one building at a time, never both, and the resource prompt simply stays
// offered for the next press.
import { hexToPixel } from '../../data/hexgrid.js';
import {
  RESOURCE_OUTPOST_COST, RESOURCE_BUILD_RADIUS_PX,
  hasResourceOutpost, canBuildResourceOutpost, buildResourceOutpost, accrueResourceIncome,
} from '../../data/resourceOutposts.js';
import { OUTPOSTS_KEY } from '../../data/events.js';
import { saveOutposts } from '../../data/save.js';
import { livePlayersOf } from './players.js';
import { DEPTH } from './shared.js';

export const ResourceOutpostsMixin = {
  _initResourceOutposts() {
    this._resourceOutpostMarkers = new Map();   // baseId → the marker views drawn for it
    this._resourceBuildPromptBase = null;       // the nearest eligible-but-unbuilt held base in range, or null
    this._resourceIncomeCarry = 0;               // leftover fractional scrap between ticks (accrueResourceIncome)
  },

  // Per frame: every BUILT resource outpost pays out scrap regardless of player position (no
  // proximity requirement, unlike #512's heal-in-radius — this is the mechanic's one deliberate
  // difference from repair, see data/resourceOutposts.js's open-decision comment); a held base
  // with nothing built yet offers the build prompt exactly like #512's, gated on a live player
  // being close enough. Only the single nearest such build candidate is ever offered at once.
  _updateResourceOutposts(dt) {
    if (!this.bases?.length) {
      this._resourceBuildPromptBase = null;
      this.registry.set('resourceOutpostPrompt', null);
      return;
    }
    const outposts = this.registry.get(OUTPOSTS_KEY) ?? [];
    const live = livePlayersOf(this);
    let nearestCandidate = null;
    let nearestDist = Infinity;
    let builtCount = 0;

    for (const base of this.bases) {
      if (!base.captured) continue;
      const center = hexToPixel(base.center.q, base.center.r);
      if (hasResourceOutpost(outposts, this.biomeId, base.id)) {
        builtCount += 1;
        if (!this._resourceOutpostMarkers.has(base.id)) this._drawResourceOutpostMarker(base.id, center);
        continue;
      }
      // Defensive: a `captured` base should always have a matching outpost record (that's how
      // `captured` got set), but skip cleanly rather than assume it if not.
      if (!canBuildResourceOutpost(outposts, this.biomeId, base.id)) continue;
      for (const p of live) {
        const d = Math.hypot(p.x - center.x, p.y - center.y);
        if (d <= RESOURCE_BUILD_RADIUS_PX && d < nearestDist) { nearestDist = d; nearestCandidate = base; }
      }
    }

    // The income trickle runs regardless of proximity/choice-prompt state — it's paid whenever
    // the mission is live, same as any other run-currency source (salvage, objective payout).
    if (builtCount > 0 && this.run) {
      const { amount, carry } = accrueResourceIncome(this._resourceIncomeCarry, builtCount, dt);
      this._resourceIncomeCarry = carry;
      if (amount > 0) {
        this.run.currency = (this.run.currency ?? 0) + amount;
        this.registry.set('run', this.run);
      }
    }

    // #517's post-clear choice owns the interact key while it's up.
    if (this._captureChoiceActive) nearestCandidate = null;
    this._resourceBuildPromptBase = nearestCandidate;
    this.registry.set(
      'resourceOutpostPrompt',
      nearestCandidate ? { baseId: nearestCandidate.id, cost: RESOURCE_OUTPOST_COST } : null,
    );
  },

  // The interact press's resource-build half — called from run.js `_onInteractPressed` AFTER the
  // #517 capture choice AND #512's repair-build prompt (repair wins a shared keypress at the same
  // base; see this file's header comment). No-op with nothing pending.
  _onResourceInteractPressed() {
    const base = this._resourceBuildPromptBase;
    if (!base) return;
    const balance = this.run?.currency ?? 0;
    const primary = livePlayersOf(this)[0];
    if (balance < RESOURCE_OUTPOST_COST) {
      this._floatText?.(primary?.x ?? 0, (primary?.y ?? 0) - 30, 'NOT ENOUGH SCRAP', '#e2533a');
      return;
    }
    const outposts = this.registry.get(OUTPOSTS_KEY) ?? [];
    const next = buildResourceOutpost(outposts, this.biomeId, base.id);
    if (next === outposts) return;   // shouldn't happen — canBuildResourceOutpost already gated the prompt
    this.registry.set(OUTPOSTS_KEY, next);
    saveOutposts(next);
    // Spent from the LIVE run currency, same convention as #512's repair outpost.
    this.run.currency = balance - RESOURCE_OUTPOST_COST;
    this.registry.set('run', this.run);
    this._resourceBuildPromptBase = null;
    this.registry.set('resourceOutpostPrompt', null);
    this._drawResourceOutpostMarker(base.id, hexToPixel(base.center.q, base.center.r));
    this._floatText?.(primary?.x ?? 0, (primary?.y ?? 0) - 30, 'RESOURCE OUTPOST BUILT', '#7bd17b');
  },

  // A small standing marker — same throwaway-Graphics-decal convention as #512's repair marker,
  // in a distinct amber/gold color + diamond shape so the two building types read apart from
  // across the map. Drawn once per base and cached so a redeploy into an already-built base never
  // draws it twice.
  _drawResourceOutpostMarker(baseId, center) {
    if (typeof this.add?.circle !== 'function') return;
    const ring = this.add.circle(center.x, center.y, 34)
      .setStrokeStyle(3, 0xd9a441, 0.85).setDepth(DEPTH.WORLD_UI);
    const diamond = this.add.rectangle(center.x, center.y, 18, 18, 0xd9a441, 0.9)
      .setRotation(Math.PI / 4).setDepth(DEPTH.WORLD_UI);
    this._resourceOutpostMarkers.set(baseId, { ring, diamond });
  },
};
