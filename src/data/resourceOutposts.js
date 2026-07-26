// #511: buildable resource outposts — a SIBLING module of #512's repairOutposts.js, same shape,
// same opt-in/scrap-costed pattern layered ON TOP of the #518 captured-base system. Holding a
// base doesn't grant income on its own; the player spends scrap to physically build the
// generator there, from the same captured-base interact prompt #512's repair outpost uses (see
// scenes/arena/resourceOutposts.js and run.js's `_onInteractPressed` chain). This file is the
// pure lookup + cost + income-tick half; the scene side owns the proximity build-prompt, the
// interact wiring, and the world-space marker.
//
// #511's own issue body rescoped this away from a freestanding worldgen terrain-node type into
// "another building option at a captured base" — folding it into the SAME build menu #512 just
// landed, not a new mechanic bolted elsewhere. The two buildings are independent flags
// (`repairBuilt`/`resourceBuilt`) on the SAME outpost record (data/outposts.js `claimOutpost`) —
// a base can hold neither, either, or both. Deliberately thin, mirroring #512's own framing
// ("don't build a generic building-types framework") — one flag, one flat cost, one income rule.
import { outpostForBase } from './outposts.js';

// Priced at the same tier as #512's repair outpost (150 — shop.js's SHOP_COSTS mid-tier weapons
// plasmaLance/swarmRack) since it's the same kind of standing, run-spanning base upgrade, not a
// one-shot consumable. #511 OPEN DESIGN DECISION: whether resource income should actually be
// priced the same as repair (a passive trickle that requires no player presence to keep paying
// out is arguably a stronger convenience than a heal you have to stand still for) is untouched by
// this issue — this is the smallest reasonable choice, not a considered balance decision. Spent
// from the LIVE run currency (`scene.run.currency`), same convention as #512.
export const RESOURCE_OUTPOST_COST = 150;

// Has this held base already got a resource outpost built?
export function hasResourceOutpost(outposts, biomeId, baseId) {
  return !!outpostForBase(outposts, biomeId, baseId)?.resourceBuilt;
}

// Can a resource outpost be built here right now? Only true for a base the player actually holds
// (an outpost record exists) that doesn't already have one. Independent of `repairBuilt` — a base
// can build BOTH buildings, in either order.
export function canBuildResourceOutpost(outposts, biomeId, baseId) {
  const o = outpostForBase(outposts, biomeId, baseId);
  return !!o && !o.resourceBuilt;
}

// Pure transition: flags the held outpost's `resourceBuilt`. No currency check in here — mirrors
// #512's buildRepairOutpost / shop.js's canAfford/purchase split (the caller checks the balance,
// THEN calls the pure mutator). No-op (same array back) if the base isn't held or already has
// one.
export function buildResourceOutpost(outposts, biomeId, baseId) {
  const target = outpostForBase(outposts, biomeId, baseId);
  if (!target || target.resourceBuilt) return outposts;
  return outposts.map((o) => (o === target ? { ...o, resourceBuilt: true } : o));
}

// ── the resource-generation mechanic itself ─────────────────────────────────────────────────
// #511 OPEN DESIGN DECISION (not settled by the issue — Jackson's call at playtest): unlike
// #512's repair outpost, which only heals a player standing IN RANGE, the resource outpost pays
// out passively for every second the mission is live, with NO proximity/player-presence
// requirement — the fiction being that once a supply line is established at a held base, scrap
// flows back regardless of where the player currently is on the map. `RESOURCE_BUILD_RADIUS_PX`
// only gates the BUILD prompt (same "walk up and press interact" convention as repair); it plays
// no part in the ongoing income once built. Open questions this leaves for playtest: is a
// no-presence-required passive trickle too strong relative to repair's stand-still requirement,
// should income be capped per outpost/run, should it scale with `upgradeLevel` (unused today).
export const RESOURCE_BUILD_RADIUS_PX = 300;   // same magnitude as #512's REPAIR_RADIUS_PX — a
                                                // base compound is much bigger than a pickup.
export const RESOURCE_INCOME_PER_SEC = 0.5;    // scrap/second per BUILT resource outpost, stacks
                                                // across multiple held+built outposts — a flat
                                                // placeholder trickle (~30 scrap/min per outpost),
                                                // picked as "noticeable but not run-defining", NOT
                                                // a considered balance number.

// Pure tick: accrues fractional scrap income from `builtCount` built resource outposts over `dt`
// seconds, banking only WHOLE scrap as the running fraction crosses an integer boundary — run
// currency is always displayed/banked as a whole number (see HudScene's runOverBanner), so this
// keeps the live total from ever going fractional while still accruing smoothly frame to frame
// rather than only on whole-second ticks. `carry` is the caller's leftover fraction from the
// previous call; pass the returned `carry` back in next frame.
export function accrueResourceIncome(carry, builtCount, dt, rate = RESOURCE_INCOME_PER_SEC) {
  if (builtCount <= 0 || dt <= 0) return { amount: 0, carry };
  const next = carry + rate * builtCount * dt;
  const whole = Math.floor(next);
  return { amount: whole, carry: next - whole };
}
