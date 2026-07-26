// #512: buildable repair outposts — an opt-in, scrap-costed upgrade layered ON TOP of the #518
// captured-base system (data/baseCapture.js, data/outposts.js). Holding a base (an outposts.js
// claim record) does NOT grant repair on its own; the player has to spend scrap to physically
// build the outpost there, from the same post-clear/repeat-visit interact prompt #517 already
// uses (scenes/arena/run.js `_presentBaseCaptureChoice` pattern). This file is the pure lookup +
// cost + repair-math half; the scene side (scenes/arena/repairOutposts.js) owns the proximity
// prompt, the interact wiring, and the world-space marker.
//
// Deliberately thin, per the issue's own framing ("don't build a generic building-types
// framework") — one flag on the existing outpost record, one flat cost, one regen rule. Not a
// generalised "buildings you can construct at a base" system; #511's resource-building building
// (data/resourceOutposts.js) is a SIBLING module of the exact same shape, hanging its own
// `resourceBuilt` flag off the same outpost record rather than sharing a generic frame.
import { outpostForBase } from './outposts.js';

// #512 OPEN DESIGN DECISION (not settled by the issue — Jackson's call during playtest, ties into
// #503's still-open repair-mechanic scope): the actual repair mechanic here is a simple flat-rate
// PASSIVE REGEN while a player sits within REPAIR_RADIUS_PX of a built outpost — restores a
// fraction of each location's MISSING armor+hp per second (both, not armor-only like the instant
// Armor Patch powerup — Mech.repairTick), reaching a full heal given enough time, no partial cap,
// no combat gating (heals even mid-fight if the player is standing in range). Picked as the
// smallest thing that reads as "a repair station" — NOT a considered balance decision. Open
// questions this leaves for playtest: should it be faster/slower, should it stop while the player
// is taking fire, should it have a flat per-visit cap instead of unlimited full-heal-over-time.

// Priced alongside shop.js's SHOP_COSTS mid-tier weapons (plasmaLance/swarmRack sit at 150) — a
// repair station is a standing, run-spanning convenience, not a one-shot consumable, so it's
// priced like a real unlock rather than a cheap trinket. Spent from the LIVE run currency
// (`scene.run.currency`, the same in-sortie pool salvage pickups/mission payouts feed —
// scenes/arena/salvage.js), not the banked meta-progression pool the Garage shop spends.
export const REPAIR_OUTPOST_COST = 150;

// #511 follow-up: the (biomeId, baseId) lookup moved to outposts.js (`outpostForBase`) so
// resourceOutposts.js's sibling module can share the exact same lookup instead of keeping its own
// copy that could drift. Re-exported here unchanged so existing callers/imports of this module
// keep working.
export { outpostForBase };

// Has this held base already got a repair outpost built?
export function hasRepairOutpost(outposts, biomeId, baseId) {
  return !!outpostForBase(outposts, biomeId, baseId)?.repairBuilt;
}

// Can a repair outpost be built here right now? Only true for a base the player actually holds
// (an outpost record exists) that doesn't already have one.
export function canBuildRepairOutpost(outposts, biomeId, baseId) {
  const o = outpostForBase(outposts, biomeId, baseId);
  return !!o && !o.repairBuilt;
}

// Pure transition: flags the held outpost's `repairBuilt`. No currency check in here — mirrors
// shop.js's canAfford/purchase split (the caller checks the balance, THEN calls the pure mutator;
// see GarageScene._purchase) so this file never needs to know where the scrap total lives. No-op
// (same array back) if the base isn't held or already has one, same "no-op rather than throw"
// convention every other outposts.js transition uses for an invalid id.
export function buildRepairOutpost(outposts, biomeId, baseId) {
  const target = outpostForBase(outposts, biomeId, baseId);
  if (!target || target.repairBuilt) return outposts;
  return outposts.map((o) => (o === target ? { ...o, repairBuilt: true } : o));
}

// ── the repair mechanic itself ──────────────────────────────────────────────────────────────
export const REPAIR_RADIUS_PX = 300;      // scene-side proximity check radius — a bit past the
                                           // 240px scrap magnet, since a base compound is much
                                           // bigger than a pickup.
export const REPAIR_RATE_PER_SEC = 0.12;  // fraction of MISSING armor+hp restored per second per
                                           // location — a beaten-up mech (missing ~half its
                                           // health) is back to full in well under a minute
                                           // parked at the outpost.
