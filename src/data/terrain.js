// Hex terrain types: the data-driven palette of what a battlefield tile can be. Each entry
// pairs a procedural art texture (built in art/hexArt.js) with gameplay properties:
//   passable    — can the mech drive onto it
//   blocksLOS   — does it stop shots / break line-of-sight (cover)
//   speedFactor — max-speed multiplier for a mech standing on it (1 = normal; <1 = slow;
//                 only meaningful for passable terrain)
//   destructible — some terrain has HP and turns into `rubble` when destroyed (weapon fire or a
//                 mech stomp). `hp` is the starting hit points seeded per building hex.
//   water        — #151: reads visually as actual water (or its frozen/melt equivalent) — NOT
//                 just "slow terrain in general" (forest/scrub/debris/dryRiver/quicksand/crust/
//                 cinderField are all slow but read as earth/ash/rock, not water). Passable water
//                 is meant to be waded by mechs/vehicles, but small ground units (see enemyKinds.js
//                 `avoidWater`) shouldn't voluntarily choose one as an idle-wander destination —
//                 see `isWaterTerrain` below. Marked per-entry rather than inferred from biome
//                 roles because a biome's `channel`/`hazard` role isn't reliably water (desert's
//                 channel is a DRY riverbed; urban's is a paved road; volcanic's is a lava crust).
//
// #72 walk-through cover: terrain that is BOTH passable and LOS-blocking (forest/scrub/drift/
// wreck/fumarole) is cover a unit can stand inside. Two special rules apply, both driven purely
// by the passable+blocksLOS combination (no extra flag to keep in sync):
//   1. Own-hex transparency: a cover hex does NOT protect its own occupant — shots treat
//      the target's (and the shooter's muzzle's) own hex as see-through (`shotBlockedAt`).
//      Deeper cover hexes between shooter and target still block. (#279: this exemption is
//      generalized across BOTH cover tiers — it's applied once, up front, regardless of
//      soft/hard — see the `cover` field note below and `coverBlocksForRay`'s own comment
//      for why the generalization is kept even though terrain cover reverted to `soft`.)
//      #374 carries the same exemption into the new probabilistic rule: `softCoverStopsShot`
//      does not roll when the shooter stands in the target's own cover hex.
//   2. Destructible + burnable: this cover has HP (less than an outpost's 60) so gunfire chews
//      firing lanes through it, and FLAME damage (flamethrower gouts, napalm ground fire) is
//      multiplied by FLAME_COVER_MULT so incendiaries are the premier forest-clearing tool.
//      At 0 HP the hex flattens to its own cleared ground (`clearedId`). (#464 deleted the five
//      `*Rubble` soft-cover debris tiles: #351 made natural terrain indestructible, so the
//      outpost-style collapse path could never reach them — soft cover only ever CLEARS, via
//      #405's caught-shot wear.)
// Adding a terrain type is one entry here + a matching texture. (Future: an external,
// possibly AI-generated, tileset can register more here.) See issue #41.
//
// #269 (issue, section 1): an additive orthogonal vocabulary layered on TOP of the raw fields
// above — every entry ALSO carries:
//   category — 'terrain' (natural ground) vs. 'base' (fabricated structures — dock/alertTower/
//              objective today). Purely an art-palette/objective-eligibility
//              signal (BASE_INFRA_COLOR, hexArt.js); it does NOT drive cover/movement — those
//              still key off each entry's own raw fields (see `dock` below: `category: 'base'`
//              but `movement: 'full'`/`cover: 'open'`, exactly like any other open ground).
//   movement — 'full' | 'slow' | 'none', mapped straight from `passable`/`speedFactor`: 'none'
//              for `passable: false`, 'slow' for `speedFactor < 1`, 'full' otherwise. Every
//              'slow' entry shares ONE speed value now (`SLOW_MOVEMENT_FACTOR` below) instead of
//              ~15 individually hand-tuned factors — see that constant's comment for the value
//              and reasoning. Impassable/boundary terrain (deepWater/mesa/ice/collapsed/lava) is
//              'none', so the consolidation never touches it.
//   cover    — 'open' | 'soft' | 'hard', per-entry (not purely derived from `blocksLOS`+
//              `passable`): 'open' when `blocksLOS` is false; `hard` for the impassable
//              base-infra structures (alertTower/dockClosed/objective) — those always block
//              EVERY ground unit's LOS unconditionally. The walk-through terrain cover
//              (forest/scrub/drift/wreck/fumarole) is `soft`: passable+slow, and (since #374)
//              blocks NO ONE's LOS geometrically — instead EVERY soft-cover hex a shot crosses
//              has its own independent 10% chance of eating that projectile, with the target's
//              own hex worth 25% for a non-mech ground unit and air targets exempt from the whole
//              lane (`SOFT_COVER_HEX_BLOCK_CHANCE`/`SOFT_COVER_OWN_HEX_BLOCK_CHANCE`; the #374
//              rework replaced that issue's first landing, a single target-tier roll of
//              75/25/0). (History: #279 briefly flipped these five
//              to `hard`; a playtest reverted them to `soft`, which then blocked only SMALL units'
//              rays per #269 §1's size tier; #374 removed that size-tiered blocking entirely.) See
//              `coverBlocksForRay`/`softCoverStopsShot`/`isSoftCover` below for how the tiers
//              are wired, and those functions' own comments for the own-hex exemption.
// The raw fields remain the source of truth callers read via `isPassable`/`blocksLOS`/etc.
// below; category/movement/cover are DERIVED from them per-entry (not the other way around) so
// adding a new terrain type is still "one entry, all fields together" — no separate derivation
// step to keep in sync.

// #269: the ONE shared max-speed multiplier every `movement: 'slow'` terrain now uses, replacing
// ~15 individually hand-tuned `speedFactor`s (river 0.5, forest 0.6, dryRiver 0.7, quicksand
// 0.35, snow 0.85, the various rubbles at 0.8, etc.). Picked as a reasonable starting estimate —
// forest's own prior value (0.6) sits comfortably mid-pack among the old spread (0.35-0.9), so it
// reads as "noticeably slower, not a crawl" for everything from a river wade to a rubble-strewn
// street, without being extreme in either direction. Exported so it's the one place a future
// playtest pass retunes, instead of hunting down every consolidated entry again.
export const SLOW_MOVEMENT_FACTOR = 0.6;

// ── #464 SOFT-COVER GROUND TEXTURE: intact and cleared share ONE tile ────────────────────────
// All five soft-cover entries (forest/scrub/drift/wreck/fumarole) point `tex` at their CLEARED
// twin's texture (`hex_forestCleared`, …) instead of having a second near-identical tile of their
// own. Why they were redundant: since #289 the lumps/canopy live in a SEPARATE overlay image, and
// a standing cover hex is never rendered without it (scenes/arena/world.js creates the canopy for
// every cover hex, culls it in lockstep, and destroys it in the same block that re-textures the
// ground on clear). So the intact GROUND tile only ever showed the same under-lump floor the
// cleared tile draws — the two differed by a faint stubble speckle, invisible under a full canopy.
// Owner accepted the two visible costs of the merge: `wreck` loses its ground-level smoulder glow
// and `fumarole` its brighter vent ember relative to their cleared states.
//
// CONSEQUENCE for callers: `TERRAIN[id].tex` is no longer derivable as `'hex_' + id`. Anything
// that needs a terrain's texture must READ `.tex`; anything that needs the canopy overlay must key
// off the terrain ID (`isCoverCanopyId(id)` / `canopyTexKey(id)`), never off `.tex`.
export const TERRAIN = {
  grass:     { id: 'grass',     tex: 'hex_grass',     passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  grassB:    { id: 'grassB',    tex: 'hex_grassB',    passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  // Shallow winding river: drive through it, but it SLOWS the mech; shoot over it (no LOS block).
  river:     { id: 'river',     tex: 'hex_river',     passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR, water: true,
               category: 'terrain', movement: 'slow', cover: 'open' },
  // Deep water (lake/ocean): impassable; still shoot over it (no LOS block).
  deepWater: { id: 'deepWater', tex: 'hex_deepWater', passable: false, blocksLOS: false, water: true,
               category: 'terrain', movement: 'none', cover: 'open' },
  // Forest: walk-through cover — passable but slowing, and it hides you (blocks LOS).
  // #464: shares the CLEARED tile's texture — see the SOFT-COVER GROUND TEXTURE note below.
  forest:    { id: 'forest',    tex: 'hex_forestCleared', passable: true,  blocksLOS: true,  speedFactor: SLOW_MOVEMENT_FACTOR,  destructible: true, hp: 40, clearedId: 'forestCleared',
               category: 'terrain', movement: 'slow', cover: 'soft' },
  // #405 (owner, playtest 2026-07-20): a cleared soft-cover hex shows its OWN under-lump ground
  // (the forest FLOOR that was beneath the trees), lumps removed + a faint stubble of remnants —
  // NOT a swap to the generic biome tile (this used to remap to `grass`). Open, walkable, no cover.
  forestCleared: { id: 'forestCleared', tex: 'hex_forestCleared', passable: true, blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  // #278: grassland's own in-map hazard — every other biome had one already (quicksand/brokenIce/
  // debris/cinderField), grassland was the sole biome with `hazard: null` (its shallow river
  // channel was judged to already cover the "watch your footing" role, but the other biomes'
  // hazards are all distinct-in-map-danger tiles independent of their channel). A boggy mud patch
  // fits grassland thematically (soft ground you sink into) and follows the same passable-but-slow,
  // no-LOS-block, non-destructible shape as every other hazard entry above.
  mud:       { id: 'mud',       tex: 'hex_mud',       passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },
  // #269 §3 (issue: base population rework — dormant docks + alert towers): a GENERIC dock/bay
  // hex — a pure PLACEMENT MARKER for a dormant docked unit (data/worldgen.js `placeBases`), not
  // a structure of its own. Per the issue's explicit call ("NOT rendered as a distinctive
  // structure itself... the docked unit's own art is what shows what's there"), this stays a
  // small ground-level marking rather than a full structure — the SPECIFIC enemy kind stationed
  // at a given dock is world-gen PLACEMENT DATA (`placeBases`' returned `docks` list), never a
  // new terrain entry per kind. #269 playtest follow-up: originally reused the now-removed
  // `helipad`'s texture verbatim (#275), which in play made every dock read as "just another
  // helipad" — now has its own `hex_dock` texture (art/hexArt.js — a rectangular bay pad with a
  // chevron lane marking, distinct from a landing pad's round disc+H mark), while remaining the
  // same kind of subtle ground detail, not an obstacle. A mech can freely walk on/off the pad (the docked unit is a
  // separate enemy record, not the hex itself), so full movement + open cover, same as bare
  // ground. Deliberately NOT destructible: the issue calls out that a dock hex having its own HP
  // separate from the unit docked on it is unnecessary complexity — only the docked UNIT (an
  // ordinary enemy record with its own hp) can be killed; the hex itself just persists as a
  // landing marking whether or not anything is currently standing on it.
  dock:      { id: 'dock',      tex: 'hex_dock',      passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'base', movement: 'full', cover: 'open' },
  // #288 (placement re-spec: "a full ring around the base... the bases should flow with no natural
  // hexes directly behind each wall segment"): the base's own PAVED YARD — the compound floor that
  // fills out a base's hex footprint wherever a dock/turret/objective didn't already claim a hex.
  //
  // This exists because the wall is now the OUTLINE OF THE BASE'S FOOTPRINT (worldgen.js
  // `baseFootprint`/`placeBaseWalls`). Before this, a "base" was just the handful of scattered
  // structure hexes that happened to land on valid ground, so its outline was ragged and mostly
  // bordered plain grass — exactly the "natural hexes directly behind the wall" the owner
  // rejected. Stamping the whole footprint as yard makes the base a solid, compact, deliberate
  // COMPOUND: every hex inside the ring is fabricated ground, so every span backs onto base
  // infrastructure by construction, and the ring itself comes out a clean hexagonal fortification
  // instead of tracing whatever shape the RNG dropped buildings in.
  //
  // Gameplay-wise it is bare drivable ground and nothing more — full movement, open cover, no HP.
  // It must NOT be an obstacle: once the player breaches the wall the interior has to be a real
  // arena to fight across. `setDressing: true` keeps it out of the mission-objective pool (it has
  // no HP to be an objective anyway, but the flag states the intent). `category: 'base'` is what
  // makes it count as base infrastructure for the ring's "nothing natural behind a span"
  // invariant, and gives it the shared neutral BASE_INFRA concrete tone in every biome.
  baseYard:  { id: 'baseYard',  tex: 'hex_baseYard',  passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'base', movement: 'full', cover: 'open', setDressing: true },
  // #269 playtest follow-up ("docks need real open/closed visual + LOS/destructibility states,
  // not just a resupply FX overlay") — the CLOSED state of a dock hex. A dock starts (and
  // reopens after each resupply) as the plain `dock` entry above; the moment its docked
  // unit(s) actually vacate the hex (walk away past a small radius, or die), the scene swaps the
  // hex's terrain data to THIS entry and plays a "steel dome sealing over the hex" FX
  // (scenes/arena/bases.js `_closeDockFx`) — see that file's `_updateDockOpenClose`/
  // `_closeDock`/`_openDock` for the runtime state machine (open ⇄ closed is a live terrain
  // swap at runtime, same `this.terrain.set` + `tileImages.get(k).setTexture` mechanism
  // `_damageBuildingAt` already uses for rubble collapse — never baked into world-gen).
  // Unlike the generic `dock` marker (deliberately non-destructible, no HP of its own — see that
  // entry's comment), a CLOSED dock is a real sealed structure: it blocks LOS and is destructible
  // — a genuine tactical choice to blow the dome open before it can ever produce a reinforcement
  // (bases.js hooks `_onTerrainCollapsed` into world.js's generic `_damageBuildingAt` collapse
  // path to permanently retire that dock's resupply state the instant this hex is destroyed, even
  // if it hadn't used up its one resupply yet). #286: passable-but-slow (not impassable) — a
  // sealed dome still lets a mech walk over/around it (same `SLOW_MOVEMENT_FACTOR` as any other
  // walk-through cover), it just no longer functions as a resupply point until it reopens.
  // `hp: 100` (#363, owner-confirmed retune from #313's 200) — between alertTower's slim snipeable
  // sensor mast (75) and the objective (200), no longer level with the objective. #313 set 200 for
  // a world where docks were OPTIONAL: capped reinforcements, 3-5 per base, so blowing a dome was a
  // real tactical investment you could also just skip. Since then #326 removed the reinforcement
  // caps (a live dock produces enemies forever, so destroying it is the ONLY way to stop the tap)
  // and #333/#354 raised docks to 5-8 per base — a base is now up to 8 domes the player MUST chew
  // through, and 200 each made that a slog rather than a choice. Collapses to
  // the same uniform `rubble` every other base-infra hex uses (alertTower/objective/dockClosed)
  // so destroyed base infrastructure reads consistently. `setDressing: true` (same precedent as
  // `alertTower`) keeps it OUT of the mission-objective pool — it's a dynamic
  // occupancy state, never a placed assault objective. Owner: hp tunable via playtest.
  dockClosed:{ id: 'dockClosed',tex: 'hex_dockClosed', passable: true, blocksLOS: true,
               speedFactor: SLOW_MOVEMENT_FACTOR,
               destructible: true, hp: 100, rubbleId: 'rubble', setDressing: true,
               category: 'base', movement: 'slow', cover: 'hard' },
  // #269 §3: a small, cheap, DESTRUCTIBLE sensor tower — the wake TRIGGER for the base-population
  // system (data/alertTower.js's pure countdown state machine + scenes/arena/bases.js's per-frame
  // tick/wake routing). #275 (redesign): placed solo, one per GAP between successive bases along
  // the corridor's spine progression (data/worldgen.js `placeGapTowers`) — not anchored to any
  // "outpost" concept at all (that terrain/idea was removed entirely). Not owned by or part of any
  // base — the nearest base is still resolved at wake time, once its countdown actually completes.
  // While standing, a player who lingers in its
  // detection radius starts a countdown ("radioing it in"); destroying the tower first cancels
  // it — a real stealth/tension window, not just flavor. Reads as a small emplacement — hard
  // cover, no movement, same shape as the other base-infra structures (dockClosed/objective)
  // since it should feel like a genuine destructible objective-of-opportunity for a stealthy
  // player — just cheaper (hp 75, #313's owner-confirmed retune from 25) since it's a slim sensor
  // mast, not a whole structure. It deliberately stays the most snipeable structure in the game so
  // racing its countdown before it wakes the base remains viable — just no longer trivial. #269
  // playtest follow-up: originally reused the removed `tower` outpost's texture verbatim — the
  // EXACT same texture as an ordinary destructible outpost building — so in play it was
  // indistinguishable from a regular building; players fighting through/near a base destroyed
  // alert towers incidentally without ever noticing, canceling the wake countdown before it
  // could complete. Now has its own `hex_alertTower` texture (art/hexArt.js — a thin sensor mast
  // with an angled dish and a pulsing amber beacon light, deliberately unlike any other base-infra
  // structure's shape) so a player can actually recognize it as a distinct thing worth noticing,
  // either to avoid triggering it or to snipe it before its countdown completes.
  // `setDressing: true` (same precedent as `dockClosed`) keeps it OUT of the mission-objective pool
  // (`isMissionObjective`) — it's a stealth/wake mechanic, never the assault-objective hex.
  alertTower:{ id: 'alertTower',tex: 'hex_alertTower', passable: false, blocksLOS: true,
               destructible: true, hp: 75, rubbleId: 'rubble', setDressing: true,
               category: 'base', movement: 'none', cover: 'hard' },

  // Rubble: what a destroyed base-infra structure leaves behind — broken masonry chunks,
  // passable, no cover, mild slow. #275: the biome-independent generic fallback (`RUBBLE`
  // below) produced by alertTower/objective/dockClosed when destroyed — no longer tied to any
  // specific biome's own outpost (the grassland `building` outpost that originally produced
  // this has been removed).
  rubble:    { id: 'rubble',    tex: 'hex_rubble',    passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },

  // #287 (owner, playtest 2026-07-19: "remove interior base turret hexes now that we have them on
  // walls"): the `turretEmplacement` bunker hex and its `turretRubble` wreck partner USED to live
  // here — a destructible interior gun platform, one or two per base, with a `turret` unit
  // garrisoning each. #310 put rail-lance guns on the base's WALL RING, which made a second,
  // interior turret-bearing structure redundant noise, so both entries (and their textures, their
  // worldgen placement loop and the `_onTerrainCollapsed` garrison-kill wiring) are gone. A base's
  // fixed guns are now exclusively its wall turrets (#469 deleted the free-roaming sentry `turret`
  // enemy KIND too, so `wallTurret` is the only emplacement left).

  // #269 playtest follow-up ("objectives are picking an arbitrary hex, not a real target"): a
  // dedicated, DESTRUCTIBLE base hex the mission marker actually points at — previously
  // `_targetCurrentBase` (scenes/arena/mission.js) pointed at `base.center`, which is just the
  // geometric centroid of a base's dock cluster, not necessarily even a real placed hex. `objective`
  // is placed once per base (data/worldgen.js `placeBases`), separate from the docks and the
  // gap alert towers, and reads as "the real thing to punch through" for that base — a proper
  // structure, not a placement marker, so it's a genuine hard-cover building (mirrors
  // `alertTower`'s shape as a real structure: impassable, blocks LOS) rather than the passable
  // ground marking `dock` uses. hp 200 (#313, owner-confirmed retune from 40) sits above the alert
  // tower's slim-mast 75, level with the sealed dock — the joint
  // toughest structure in the game, and equal to a light mech on #299's unit-toughness scale, so
  // the thing the mission marker points at reads as a real assault target rather than a one-shot.
  // (400 was floated and the owner revised it down to 200 — do not raise this without asking.) `setDressing` is
  // deliberately OMITTED (unlike alertTower/dockClosed) — this hex IS meant to be `isMissionObjective`-
  // eligible in spirit (it's what the marker targets), though nothing currently drives
  // `isBaseCleared`/win-condition off it directly (kill-all-docked-enemies stays the actual win
  // condition, per the issue's explicit scoping call — this hex only fixes what the marker visually
  // points at). Collapses to the same generic biome-independent `rubble` as the other base-infra
  // structures (alertTower/dockClosed) — a destroyed objective reads as the same kind of
  // wreckage everywhere, not a biome-specific rubble.
  objective: { id: 'objective', tex: 'hex_objective', passable: false, blocksLOS: true,
               destructible: true, hp: 200, rubbleId: 'rubble',
               category: 'base', movement: 'none', cover: 'hard' },

  // ── Desert / badlands (#67) — warm sandy palette. Reuses the same ROLES as grassland. ──
  sand:      { id: 'sand',      tex: 'hex_sand',      passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  sandB:     { id: 'sandB',     tex: 'hex_sandB',     passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  // Dry riverbed: the "shallow river" analog — cracked bed, drive-through but slowing.
  dryRiver:  { id: 'dryRiver',  tex: 'hex_dryRiver',  passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },
  // Mesa: a natural rock butte — the impassable deep-water analog, boundary-only (#221: no LOS
  // block, matching deepWater/ice/lava — it never appears in-map so this only affects the
  // world-edge ring, and shooting over the boundary should behave like the other 3 biomes).
  mesa:      { id: 'mesa',      tex: 'hex_mesa',      passable: false, blocksLOS: false,
               category: 'terrain', movement: 'none', cover: 'open' },
  // Scrub: sparse desert brush — walk-through cover (passable + slowing + blocks LOS), like forest.
  // #464: shares the CLEARED tile's texture — see the SOFT-COVER GROUND TEXTURE note above.
  scrub:     { id: 'scrub',     tex: 'hex_scrubCleared', passable: true,  blocksLOS: true,  speedFactor: SLOW_MOVEMENT_FACTOR,  destructible: true, hp: 30, clearedId: 'scrubCleared',
               category: 'terrain', movement: 'slow', cover: 'soft' },
  // #405: cleared scrub — its own brush FLOOR with the bushes gone (was: remap to `sand`).
  scrubCleared: { id: 'scrubCleared', tex: 'hex_scrubCleared', passable: true, blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  // #110: quicksand — the desert's LESSER in-map hazard, standing in for 'mesa' now that mesa
  // is reserved exclusively for the world boundary. Passable but heavily slowing; no LOS block
  // (you sink, you don't hide).
  quicksand: { id: 'quicksand', tex: 'hex_quicksand', passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },

  // ── Snow / arctic (#67) — cold white/blue palette. ──
  snow:      { id: 'snow',      tex: 'hex_snow',      passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  snowB:     { id: 'snowB',     tex: 'hex_snowB',     passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  // Slush: half-frozen melt — the shallow-water analog (passable, slowing, shoot over).
  slush:     { id: 'slush',     tex: 'hex_slush',     passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR, water: true,
               category: 'terrain', movement: 'slow', cover: 'open' },
  // Ice: solid frozen lake — the impassable deep-water analog (you can shoot over it).
  ice:       { id: 'ice',       tex: 'hex_ice',       passable: false, blocksLOS: false, water: true,
               category: 'terrain', movement: 'none', cover: 'open' },
  // Snowdrift / frozen pines: walk-through cover (passable + slowing + LOS block).
  // #464: shares the CLEARED tile's texture — see the SOFT-COVER GROUND TEXTURE note above.
  drift:     { id: 'drift',     tex: 'hex_driftCleared', passable: true,  blocksLOS: true,  speedFactor: SLOW_MOVEMENT_FACTOR,  destructible: true, hp: 30, clearedId: 'driftCleared',
               category: 'terrain', movement: 'slow', cover: 'soft' },
  // #405: cleared snowdrift — its own packed-snow FLOOR with the drifts gone (was: remap to `snow`).
  driftCleared: { id: 'driftCleared', tex: 'hex_driftCleared', passable: true, blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  // #110: broken ice — the arctic's LESSER in-map hazard, standing in for solid 'ice' now that
  // ice is reserved exclusively for the world boundary. Passable but slow (thin/cracked ice);
  // no LOS block. #151: still reads as water (cold water visible through the cracks).
  brokenIce: { id: 'brokenIce', tex: 'hex_brokenIce', passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR, water: true,
               category: 'terrain', movement: 'slow', cover: 'open' },

  // ── Urban ruins (#67) — grey industrial palette; dense destructible cover. ──
  pavement:  { id: 'pavement',  tex: 'hex_pavement',  passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  pavementB: { id: 'pavementB', tex: 'hex_pavementB', passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  // Collapsed tower: an impassable heap (the deep-water/mesa analog for the city), boundary-only
  // (#221: no LOS block, matching deepWater/ice/lava — it never appears in-map).
  collapsed: { id: 'collapsed', tex: 'hex_collapsed', passable: false, blocksLOS: false,
               category: 'terrain', movement: 'none', cover: 'open' },
  // Wreckage: burned-out vehicles / low wall — walk-through cover (passable + slow + LOS).
  // #464: shares the CLEARED tile's texture (and so loses its ground smoulder glow, owner-accepted)
  // — see the SOFT-COVER GROUND TEXTURE note above.
  wreck:     { id: 'wreck',     tex: 'hex_wreckCleared', passable: true,  blocksLOS: true,  speedFactor: SLOW_MOVEMENT_FACTOR, destructible: true, hp: 40, clearedId: 'wreckCleared',
               category: 'terrain', movement: 'slow', cover: 'soft' },
  // #405: cleared wreckage — its own scorched FLOOR with the wreck piles gone (was: remap to `pavement`).
  wreckCleared: { id: 'wreckCleared', tex: 'hex_wreckCleared', passable: true, blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  // #110: debris field — the urban biome's LESSER in-map hazard, standing in for 'collapsed'
  // now that a collapsed heap is reserved exclusively for the world boundary. Passable but
  // slow (a rubble-strewn street); no LOS block. #275: also urban's `channel` role now (the
  // `road` terrain type was removed — see biomes.js for the reasoning) — a paved lane and a
  // rubble-strewn street both read as "urban hazard/street" well enough to share one id rather
  // than inventing a new distinct paved-road identity for a role that's otherwise gone.
  debris:    { id: 'debris',    tex: 'hex_debris',    passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },
  // #278: urban's own dedicated channel — previously `channel` just pointed at `debris` (urban's
  // OWN hazard id), so urban was the one biome sharing a single id across two roles instead of
  // having a distinct channel identity like every other biome (river/dryRiver/slush/crust). A
  // flooded concrete drainage canal/culvert fits "urban ruins" without reintroducing a paved-road
  // identity (deliberately removed in #275) — reads as standing water in a man-made channel, so
  // `water: true` like the other biomes' channel terrain (river/slush).
  canal:     { id: 'canal',     tex: 'hex_canal',     passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR, water: true,
               category: 'terrain', movement: 'slow', cover: 'open' },

  // ── Volcanic wasteland (#67) — dark/ember palette; lava hazards + ash fields. ──
  ash:       { id: 'ash',       tex: 'hex_ash',       passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  ashB:      { id: 'ashB',      tex: 'hex_ashB',      passable: true,  blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  // Cooling lava crust: a hot crackled flow — passable but slowing (the shallow analog).
  crust:     { id: 'crust',     tex: 'hex_crust',     passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },
  // Molten lava: impassable hazard (the deep-water analog); you can shoot over it.
  lava:      { id: 'lava',      tex: 'hex_lava',      passable: false, blocksLOS: false,
               category: 'terrain', movement: 'none', cover: 'open' },
  // Ash dunes / smoke plumes: walk-through cover (passable + slow + LOS block).
  // #464: shares the CLEARED tile's texture (and so its fainter vent ember, owner-accepted) — see
  // the SOFT-COVER GROUND TEXTURE note above.
  fumarole:  { id: 'fumarole',  tex: 'hex_fumaroleCleared', passable: true,  blocksLOS: true,  speedFactor: SLOW_MOVEMENT_FACTOR, destructible: true, hp: 30, clearedId: 'fumaroleCleared',
               category: 'terrain', movement: 'slow', cover: 'soft' },
  // #405: cleared fumarole — its own ashen FLOOR (with the vent's faint ember) and the mounds gone
  // (was: remap to `ash`).
  fumaroleCleared: { id: 'fumaroleCleared', tex: 'hex_fumaroleCleared', passable: true, blocksLOS: false, speedFactor: 1,
               category: 'terrain', movement: 'full', cover: 'open' },
  // #110: cinder field — the volcanic biome's LESSER in-map hazard. Lava itself reads fine as
  // BOTH an occasional in-map pool AND the boundary (Jackson: "lava could work for lava map"),
  // but per-biome consistency (every other biome's severe hazard is boundary-only) this gives
  // volcanic its own lesser in-map danger too — a hot ash/cinder patch, passable but slow, no
  // LOS block — while 'lava' itself is reserved for the boundary ring only (see biomes.js).
  cinderField: { id: 'cinderField', tex: 'hex_cinderField', passable: true, blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },
};

export function getTerrain(id) {
  return TERRAIN[id] ?? TERRAIN.grass;
}

// ── Pure property resolvers (read by collision, LOS, and the movement speed penalty) ──────
// `id` may be undefined (a point outside the arena disc); callers decide what that means.

// #269: the raw `category`/`movement`/`cover` tier readers. Unknown/off-map ⇒ undefined (callers
// that need a definite boolean — `isPassable`, `blocksLOS`, etc., below — special-case that).
export function movementTier(id) {
  const t = id && TERRAIN[id];
  return t ? t.movement : undefined;
}
export function coverTier(id) {
  const t = id && TERRAIN[id];
  return t ? t.cover : undefined;
}
// #269: is this a fabricated `base`-category hex (dock/dockClosed/alertTower/objective today)? Purely an art-palette/objective-eligibility signal — does NOT drive
// cover/movement, see the TERRAIN header comment and `dock`'s own entry above.
export function isBaseCategory(id) {
  const t = id && TERRAIN[id];
  return !!t && t.category === 'base';
}

// Max-speed multiplier of the terrain under a mech. Unknown / off-map ⇒ 1 (the caller handles
// impassability separately). Terrain with no speedFactor is normal (1). #269: derived from the
// `movement` tier (single shared `SLOW_MOVEMENT_FACTOR`) rather than reading each entry's own
// `speedFactor` — every entry's `speedFactor` is already set to that same constant when
// `movement: 'slow'`, so the two stay equivalent; this just removes the last place a per-entry
// speed number could drift from the shared constant.
export function terrainSpeedFactor(id) {
  const tier = movementTier(id);
  return tier === 'slow' ? SLOW_MOVEMENT_FACTOR : 1;
}

// Can a mech stand on this terrain? Unknown / off-map ⇒ false (off the arena disc = blocked).
// #269: derived from the `movement` tier ('none' ⇒ blocked) rather than the raw `passable` flag.
export function isPassable(id) {
  const t = id && TERRAIN[id];
  return !!t && t.movement !== 'none';
}

// #151: does this terrain read visually as actual water (river/deep water/slush/ice/broken ice
// across the 5 biomes) — as opposed to merely slow terrain in general (forest, dryRiver,
// quicksand, debris, crust, cinderField, etc.)? Driven purely by the `water` flag above so this
// stays a single per-entry fact rather than an id list duplicated at every call site. Used to
// keep small ground units (infantry) from voluntarily choosing a water hex as an idle-wander
// destination, while still allowing them to be physically forced across passable water (a river
// is still `passable`, just not a picked as a *destination*).
export function isWaterTerrain(id) {
  const t = id && TERRAIN[id];
  return !!t && !!t.water;
}

// Does this terrain break line-of-sight (cover / projectile blocker)? Unknown ⇒ false. #269:
// derived from the `cover` tier ('open' ⇒ no block; 'soft'/'hard' ⇒ blocks, subject to the
// own-hex exemption in `shotBlockedAt`/`coverBlocksForRay` below — and note #374 makes the `soft`
// tier's block always fall away there) rather than the raw `blocksLOS` flag.
export function blocksLOS(id) {
  const tier = coverTier(id);
  return tier === 'soft' || tier === 'hard';
}

// ── #351 (EXPERIMENT — owner-confirmed 2026-07-19: "nature is permanent, their stuff isn't") ──
// Natural terrain (`category: 'terrain'`) is permanent scenery: it cannot be damaged and cannot be
// TARGETED (convergence/lock never offers it, because targeting reads the same standing-HP maps).
// Only fabricated `category: 'base'` structures — dockClosed/alertTower/objective, plus wall spans,
// which are edge geometry and unaffected by anything here — stay destructible.
//
// This is DESTRUCTIBILITY + TARGETABILITY ONLY. Cover is untouched: `cover`/`blocksLOS`/
// `isSoftCover`/`coverBlocksForRay` all read the `cover` tier, never `destructible`, so forest/
// scrub/drift/wreck/fumarole remain exactly the soft cover they are today. (#374 later DID change
// what that soft tier does — no geometric blocking, a 25% shot-block roll instead — but still
// independently of destructibility; the two axes stay separate.)
//
// TO REVERSE: flip this one constant back to `true`. Every natural destructible keeps its
// `destructible: true` / `hp` fields (#313's retuned HP values: forest 40, wreck 40,
// scrub/drift/fumarole 30), so the old behaviour returns wholesale. Those fields are
// intentionally dead data while the flag is off. (#464 DID delete the five soft-cover `*Rubble`
// tiles those entries used to name in `rubbleId` — unreachable art nothing could render while the
// flag is off. A revert therefore falls back to the generic `RUBBLE` masonry for burnt forest
// rather than charred plant debris; the owner accepted that cost.)
//
// Interactions noted while landing this:
//   • #322's single convergence/lock candidate pool (wall spans + destructible hexes, with a 0.3
//     enemy-range edge) simply gets fewer members; it was already allowed to be EMPTY — the
//     off-base overworld has no destructibles at all today — and `pickConvergeTarget` returns null
//     for an empty pool, which the reticle already handles.
//   • #317's "a TARGETED destructible hex stops fire" path keys off `_destructibleStandingAt`,
//     i.e. the same HP maps. With natural terrain never seeded into them, there is no remaining
//     path that can damage or stop on it.
export const NATURAL_TERRAIN_DESTRUCTIBLE = false;

// #351: is this terrain destructible *right now*, accounting for the natural-terrain experiment
// above? The per-entry `destructible` flag is the raw declaration; this is the live rule.
function destructibleNow(t) {
  if (!t || !t.destructible) return false;
  if (!NATURAL_TERRAIN_DESTRUCTIBLE && t.category === 'terrain') return false;
  return true;
}

// Is this a destructible outpost (has HP, becomes rubble when destroyed)?
export function isDestructible(id) {
  return destructibleNow(id && TERRAIN[id]);
}

// Starting hit points for a freshly-seeded destructible hex (0 for non-destructible terrain).
// Returning 0 is what keeps natural terrain out of worldgen's `buildingHp`/`coverHp` maps
// entirely (#351) — and those maps are what damage, collapse-to-rubble, convergence candidacy
// and lock all read, so one number here is the whole switch.
export function buildingHp(id) {
  const t = id && TERRAIN[id];
  return destructibleNow(t) ? (t.hp ?? 0) : 0;
}

// The default terrain id a destroyed building collapses into (grassland biome).
export const RUBBLE = 'rubble';

// The terrain id a given destructible collapses into — its biome-appropriate rubble
// (declared per destructible as `rubbleId`). Falls back to the default `RUBBLE`. Keeps the
// world mixin free of biome branches: it just asks "what does this outpost leave behind?".
export function rubbleFor(id) {
  const t = id && TERRAIN[id];
  return (t && t.rubbleId) || RUBBLE;
}

// #251: is this destructible hex a genuine assault objective (may be picked as THE mission
// objective, world.js `buildingHp` bucket) rather than atmospheric base-infrastructure
// set-dressing (e.g. `dockClosed`/`alertTower`)? Purely the `destructible && !setDressing`
// combination — a destructible entry opts OUT of objective-eligibility with `setDressing: true`
// rather than objectives opting in, so nothing else needs to change as new destructible terrain
// is added.
// #351: reads the LIVE destructibility rule, so natural terrain can never be picked as the
// mission objective while the experiment is on (it already could not in practice — objectives are
// drawn from the solid/impassable `buildingHp` bucket — but the two now agree by construction).
export function isMissionObjective(id) {
  const t = id && TERRAIN[id];
  return destructibleNow(t) && !t.setDressing;
}

// #72: soft cover — walk-through concealment (forest/scrub/drift/wreck/fumarole). #374: it no
// longer blocks any unit's LOS geometrically; it gives whoever STANDS in it a flat per-shot chance
// of the foliage eating an incoming shot (`softCoverStopsShot`). #269: derived from the `cover`
// tier directly. Unknown ⇒ false.
export function isSoftCover(id) {
  return coverTier(id) === 'soft';
}

// ── #405 (owner, playtest 2026-07-20) — soft cover is DESTRUCTIBLE AGAIN, but ONLY by the shots
// the foliage CATCHES ─────────────────────────────────────────────────────────────────────────
// Soft cover already rolls a per-hex chance to EAT a shot passing through it (#374,
// `softCoverStopsShot` / the scene's in-flight pass-through). #405 gives those caught shots a
// consequence: each one chips the HP of the hex that ate it, so firing through/into a thicket
// gradually wears it down and clears a firing lane. The owner's kid "loved blasting cover down."
//
// This is deliberately INCIDENTAL, not a targeting mechanic:
//   • Soft cover is NEVER seeded into `buildingHp`/`coverHp` (NATURAL_TERRAIN_DESTRUCTIBLE stays
//     false), so it is NOT auto-targeted, NOT lockable, and never enters the convergence/priority
//     pool (`_destructibleTargetsNear`/`_destructibleStandingAt`). Clearing trees can never compete
//     with shooting enemies — it only happens as a side effect of fire the foliage happened to eat.
//   • The scene keeps a SEPARATE `softCoverHp` map (arena/world.js) fed solely by caught-shot
//     damage (`_damageSoftCoverHex`). No stomp, no lock, no flame-multiplier path touches it.
//   • Symmetric: a caught ENEMY round chips a hex exactly as a player round does — the caught-shot
//     sites never read who fired.
// When a hex reaches 0 it CLEARS to its OWN under-lump ground (`clearedSoftCoverFor` — the same
// hex's base floor with the lumps/canopy removed, a subtle "the trees are gone" look, NOT a swap
// to a different biome tile) and stops being cover: no more eating shots, no slow, no conceal.
//
// Owner (2026-07-20 playtest follow-up): the original HP 30 / 20-per-catch (⇒ just TWO caught
// shots) read as TOO SQUISHY. Raised so it takes ~5-6 caught shots to flatten a hex — a thicket
// still comes down satisfyingly, but not from a couple of stray rounds. These two numbers are the
// whole dial; only ~10% of shots passing through are actually CAUGHT, so this still costs many
// rounds FIRED. HP 110 / 20 per catch ⇒ ~6 caught shots.
export const SOFT_COVER_CLEAR_HP = 110;
export const SOFT_COVER_CATCH_DAMAGE = 20;

// #405: what a cleared soft-cover hex becomes — its OWN under-lump ground (declared per soft entry
// as `clearedId`: forest→forestCleared, scrub→scrubCleared, drift→driftCleared, wreck→wreckCleared,
// fumarole→fumaroleCleared) rather than a remap to the generic biome ground (it used to become
// grass/sand/snow/pavement/ash).
//
// #464 CORRECTION: an earlier version of this comment claimed the cleared tile differs from the
// intact one by having the under-lumps removed. It doesn't — the lumps have lived in the SEPARATE
// canopy overlay since #289, so both tiles only ever drew the ground floor. What actually changes
// on clear is that (a) the canopy overlay image is destroyed, and (b) the hex stops being cover
// (no LOS block, no slow, no shot-catching). The ground tile itself is now literally the same
// texture before and after — see the SOFT-COVER GROUND TEXTURE note at the top of TERRAIN.
// Returns null for anything that isn't soft cover.
export function clearedSoftCoverFor(id) {
  const t = id && TERRAIN[id];
  return (t && t.cover === 'soft' && t.clearedId) || null;
}

// ── #374 (owner, playtest 2026-07-20) — soft cover is a PROBABILISTIC SHOT BLOCK, not a
// geometric one ────────────────────────────────────────────────────────────────────────────
// What changed, and why the old rule is gone:
//   • REMOVED: #269 §1's size-tiered geometric blocking. Soft cover used to stop a ray outright
//     whenever a SMALL ground unit (tank/infantry) was party to it, while a mech shot clean over
//     it — the old `softCoverBlocksLOS(smallUnitInvolved)`. Jackson: "that shot blocking
//     shouldn't happen anymore." Soft cover now blocks NOTHING geometrically, for any size tier,
//     and `smallUnitInvolved` no longer exists anywhere in the cover path.
//   • ADDED: `softCoverStopsShot` below — a per-shot chance that a shot AT a target standing in
//     soft cover is stopped by the foliage. Deliberately framed as a BLOCK rather than a damage
//     reduction (Jackson reframed it mid-conversation): same expected damage, but an occasional
//     shot visibly splashing into the trees reads better than every shot uniformly softened.
// Hard cover is untouched: it still blocks everything between two other points, unconditionally.
// (#351's natural-terrain indestructibility is orthogonal — that is destructibility/targetability;
// this is cover behaviour.)
//
// ── #374 REWORK (owner, 2026-07-20) — soft cover is a PER-HEX LANE rule ────────────────────
// This SUPERSEDES the first #374 landing's target-only tiered lookup
// (`SOFT_COVER_BLOCK_CHANCE = { vehicle: 0.75, mech: 0.25, air: 0 }`, a single roll against the
// TARGET's own hex). Jackson, after working the mechanics through: "what if we made it actually
// have a 10% chance of blocking shots that pass over it, unless those shots are at air enemies?
// … have non-mech own hex bump to 25%, and don't give mech own-hex additional bonus; this all
// will apply to enemy shots as well, right?"
//
// The model:
//   • EVERY soft-cover hex the shot's lane crosses gets its OWN independent 10% roll. Three
//     forest hexes between shooter and target ⇒ three rolls ⇒ 1 − 0.9³ ≈ 27.1% blocked. Depth of
//     woods is what protects you, not a flat per-target lookup.
//   • The roll is PER PROJECTILE, never per trigger pull (confirmed with Jackson). A 6-missile
//     salvo across three hexes loses ~1.6 missiles and the rest get through — foliage eating SOME
//     of a volley, which is the read we want; all-or-nothing per-pull would feel arbitrary. The
//     scene calls this once per resolved round / per beam tick, so that falls out for free, and a
//     20/sec stream just loses ~10% of its DPS through one hex.
//   • The TARGET'S OWN HEX is the one special case, and the bump REPLACES the standard 10% for
//     that hex (the interpretation the issue asked to be flagged rather than guessed — a single
//     roll per hex, so 25% INSTEAD OF 10%, never 25% on top):
//        vehicle (non-mech ground: infantry, tank, carrier, turret) — 25%
//        mech    (player + mech-kind enemies)                       — 10%, no bonus at all
//        air                                                        — 0%
//   • AIR TARGETS IGNORE COVER COMPLETELY — the WHOLE lane, not just their own hex. A shot at
//     anything airborne is never blocked no matter how much foliage it crosses. Jackson chose
//     this explicitly over the physically-consistent alternative (rolling the intervening hexes
//     and exempting only the destination).
//   • SYMMETRIC: nothing here reads the shooter's identity, so an enemy's shots obey it exactly
//     as the player's do. Foliage blocks whatever crosses it.
// Hard cover is untouched: it still blocks everything between two other points, unconditionally,
// via `coverBlocksForRay` below. (#351's natural-terrain indestructibility is orthogonal.)
//
// Owner: tunable — these two entries are the whole dial.
export const SOFT_COVER_HEX_BLOCK_CHANCE = 0.10;
export const SOFT_COVER_OWN_HEX_BLOCK_CHANCE = { vehicle: 0.25, mech: 0.10, air: 0 };

// #374: the block chance for ONE crossed soft-cover hex. `ownHex` is true only for the hex the
// target is actually standing in. An unknown tier falls back to the standard per-hex chance on an
// own hex (never a guessed bonus) — a caller that can't classify its target still gets the plain
// lane rule rather than silently eating extra shots.
export function softCoverHexBlockChance(tier, ownHex = false) {
  if (tier === 'air') return 0;
  if (!ownHex) return SOFT_COVER_HEX_BLOCK_CHANCE;
  return SOFT_COVER_OWN_HEX_BLOCK_CHANCE[tier] ?? SOFT_COVER_HEX_BLOCK_CHANCE;
}

// #374: does the foliage eat THIS projectile? Returns the BLOCKING lane hex (the element that
// rolled a block) so the caller can detonate AT that hex — or `null` when nothing in the lane
// blocks. (Originally a bare boolean; #374's block-visual follow-up made it report WHICH hex ate
// the round, because a blocked shot now puffs in the trees at that hex's centre rather than
// splashing at the target. The returned object is the very element handed in via `lane`, so any
// coordinates the scene stamped on it — see `_softCoverLane` — ride along for free. It stays
// truthy-when-blocked / null-when-not, so every truthy/falsy caller, e.g. firing.js's beam
// `eaten` check, is unchanged.)
//   `lane`  — the soft-cover hexes the shot CROSSES, muzzle → target, as
//             `[{ id, ownHex, … }, …]`: `id` is the terrain id of that hex, `ownHex` marks the
//             target's own hex (the scene also stamps a centre `{x, y}` on each entry — carried
//             through untouched). Built by the scene from the geometry it already walks for LOS
//             (arena/world.js `_softCoverLane`); non-soft ids are ignored here so a caller may
//             hand over a whole traversal without pre-filtering it.
//             THE OWN-HEX EXEMPTION (#72/#279) IS EXPRESSED AS AN OMISSION: the shooter's own
//             muzzle hex is simply never put in the lane, so two units brawling inside one
//             thicket produce an EMPTY lane (the target's hex IS the muzzle hex) and no roll is
//             made at all — the same reasoning that lets a unit in cover see and shoot out of it,
//             now falling out of the traversal instead of needing its own flag.
//   `tier`  — the TARGET's tier (`softCoverUnitTier`, arena/shared.js). A property of the thing
//             being shot at, never of the shooter. `air` short-circuits the entire lane.
//   `rng`   — INJECTED (defaults to `Math.random`) so a seeded run is reproducible and the rule is
//             deterministically testable; the same convention `pickPowerupType`/
//             `makeDockResupplyState` use. Pure: no module-level RNG state. Stepped ONCE PER
//             soft-cover hex now, not once per shot — more draws per shot, same discipline.
// Note a wall turret needs no special case: it is emplaced on a wall span, never standing in
// foliage, so its own hex is never soft and only genuine intervening woods can eat a shot at it.
export function softCoverStopsShot(lane, tier, rng = Math.random) {
  if (tier === 'air') return null;           // air ignores the WHOLE lane, not just its own hex
  if (!lane || lane.length === 0) return null;
  for (const hex of lane) {
    if (!hex || !isSoftCover(hex.id)) continue;
    const chance = softCoverHexBlockChance(tier, !!hex.ownHex);
    if (chance <= 0) continue;
    if (rng() < chance) return hex;          // this hex's foliage ate it; no need to roll deeper
  }
  return null;
}

// #269: the single shared "does this terrain block THIS ray" decision — `shotBlockedAt`,
// world.js's `_isWallForRound`, and `_wallDistanceLos` all defer to this so the cover rule can't
// drift across its three call sites. `ownHexExempt` is #72's own-hex transparency (true when the
// point being tested sits in a hex the caller has marked see-through for this particular shot —
// the shooter's muzzle hex, or a living target's own hex).
// #279: the own-hex exemption applies to BOTH cover tiers — originally it only existed under the
// `soft` branch because every `hard`-cover hex was impassable (alertTower/dockClosed/objective),
// so nobody could ever stand inside one and the exemption was moot there. Generalizing it to run
// once, up front, regardless of tier is harmless for both tiers (a unit standing in cover still
// sees/shoots out) and keeps the rule robust if a passable `hard`-cover terrain is ever added.
// #374: after that exemption, soft cover NEVER blocks a ray — its shot-stopping is now the
// probabilistic `softCoverStopsShot` roll above, applied at the target, not a geometric block.
// Hard cover between two other points always blocks unconditionally.
export function coverBlocksForRay(id, ownHexExempt) {
  if (!blocksLOS(id)) return false;
  if (ownHexExempt) return false;
  if (isSoftCover(id)) return false;   // #374 — see above; foliage stops shots by roll, not geometry
  return true; // hard cover between two other points — always blocks a ground unit; flying-unit
               // ignoresCover is the caller's concern (firing.js/projectiles.js), orthogonal to
               // this cover-tier rule.
}

// #72 own-hex transparency: does terrain `id` at hex `key` stop a shot, given a Set of hex
// keys treated as see-through for THIS shot (the shooter's muzzle hex + the target's own hex)?
// Cover doesn't protect its own occupant — a shot may enter/impact within an exempted cover hex,
// regardless of soft/hard tier (#279 generalized this; it used to only apply to soft cover,
// back when every hard-cover hex was impassable and nobody could ever stand inside one — see
// `coverBlocksForRay`'s own comment) — but non-exempted cover hexes between shooter and target
// still block ("deep woods"/hard cover in the way). The boundary-only impassable terrains
// (mesa/collapsed/deepWater/ice/lava) never block LOS at all (#221 — they're stamped only at the
// world's outer edge, never used as an in-map obstacle).
// #374: soft-cover hexes no longer block ANY ray here (the size-tier `smallUnitInvolved`
// parameter is gone) — foliage stops shots via `softCoverStopsShot`'s roll at the target instead.
// So in practice this now answers "is there hard cover in the way."
export function shotBlockedAt(id, key, transparent = null) {
  const ownHexExempt = !!(transparent && transparent.has(key));
  return coverBlocksForRay(id, ownHexExempt);
}

// #72 burnable cover: flame damage (flamethrower gouts, napalm rounds + ground fire) is
// multiplied against SOFT cover so incendiaries clear woods much faster than gunfire.
// Owner: tunable. Solid outposts take flame damage unmultiplied.
export const FLAME_COVER_MULT = 4;
export function flameCoverDamage(amount) {
  return amount * FLAME_COVER_MULT;
}

// Apply `amount` damage to a building hex's current `hp`. Pure: returns the remaining hp and
// whether the hit destroyed it (hp fell to 0 or below). The scene owns the hp Map + the terrain
// swap-to-rubble; this keeps the arithmetic testable.
export function damageBuilding(hp, amount) {
  const remaining = Math.max(0, hp - Math.max(0, amount));
  return { hp: remaining, destroyed: remaining <= 0 };
}
