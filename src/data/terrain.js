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
// #72 soft cover: terrain that is BOTH passable and LOS-blocking (forest/scrub/drift/wreck/
// fumarole) is "soft cover" — a unit can stand inside it. Two special rules apply, both driven
// purely by the passable+blocksLOS combination (no extra flag to keep in sync):
//   1. Own-hex transparency: a soft-cover hex does NOT protect its own occupant — shots treat
//      the target's (and the shooter's muzzle's) own hex as see-through (`shotBlockedAt`).
//      Deeper soft-cover hexes between shooter and target still block. Solid cover always blocks.
//   2. Destructible + burnable: soft cover has HP (less than an outpost's 60) so gunfire chews
//      firing lanes through it, and FLAME damage (flamethrower gouts, napalm ground fire) is
//      multiplied by FLAME_COVER_MULT so incendiaries are the premier forest-clearing tool.
//      At 0 HP the hex flattens to its biome's cleared/rubble terrain (`rubbleId`), same
//      machinery as a collapsing outpost.
// Adding a terrain type is one entry here + a matching texture. (Future: an external,
// possibly AI-generated, tileset can register more here.) See issue #41.
//
// #269 (issue, section 1): an additive orthogonal vocabulary layered on TOP of the raw fields
// above — every entry ALSO carries:
//   category — 'terrain' (natural ground) vs. 'base' (fabricated structures — dock/alertTower/
//              turretEmplacement/objective today). Purely an art-palette/objective-eligibility
//              signal (BASE_INFRA_COLOR, hexArt.js); it does NOT drive cover/movement — those
//              still key off each entry's own raw fields (see `dock` below: `category: 'base'`
//              but `movement: 'full'`/`cover: 'open'`, exactly like any other open ground).
//   movement — 'full' | 'slow' | 'none', mapped straight from `passable`/`speedFactor`: 'none'
//              for `passable: false`, 'slow' for `speedFactor < 1`, 'full' otherwise. Every
//              'slow' entry shares ONE speed value now (`SLOW_MOVEMENT_FACTOR` below) instead of
//              ~15 individually hand-tuned factors — see that constant's comment for the value
//              and reasoning. Impassable/boundary terrain (deepWater/mesa/ice/collapsed/lava) is
//              'none', so the consolidation never touches it.
//   cover    — 'open' | 'soft' | 'hard', mapped from `blocksLOS`+`passable`: 'open' when
//              `blocksLOS` is false, 'hard' when `blocksLOS` && `!passable` (destructible hard
//              cover — the base-infra structures: alertTower/dockClosed/objective), 'soft' when
//              `blocksLOS` &&
//              `passable` (the walk-through cover: forest/scrub/drift/wreck/fumarole). `hard`
//              cover always blocks a ground unit's LOS; `soft` cover only blocks a SMALL ground
//              unit's LOS — a mech/large unit sees clean over it (issue #269 §1, using the
//              small/large tier added to enemy-kind data by §2) — see `coverBlocksForRay`/
//              `softCoverBlocksLOS` below for how that's wired.
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
  // #227: its OWN rubble (charred plant debris) distinct from a destroyed building's masonry.
  forest:    { id: 'forest',    tex: 'hex_forest',    passable: true,  blocksLOS: true,  speedFactor: SLOW_MOVEMENT_FACTOR,  destructible: true, hp: 40, rubbleId: 'vegRubble',
               category: 'terrain', movement: 'slow', cover: 'soft' },
  // Rubble: what a destroyed building leaves behind — broken masonry chunks, passable, no cover, mild slow.
  // #275: the biome-independent generic fallback (`RUBBLE` below) — still produced by the
  // base-infra destructibles (alertTower/objective/dockClosed) even though the grassland
  // `building` outpost that originally used it is gone.
  rubble:    { id: 'rubble',    tex: 'hex_rubble',    passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },
  // #227: what a destroyed forest hex leaves behind — charred plant debris, visually distinct
  // from the generic rubble's broken-masonry look even though both are passable/no-cover.
  vegRubble: { id: 'vegRubble', tex: 'hex_vegRubble', passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
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
  // entry's comment), a CLOSED dock is a real sealed structure: impassable, blocks LOS, and is
  // destructible — a genuine tactical choice to blow the dome open before it can ever produce a
  // reinforcement (bases.js hooks `_onTerrainCollapsed` into world.js's generic
  // `_damageBuildingAt` collapse path to permanently retire that dock's resupply state the
  // instant this hex is destroyed, even if it hadn't used up its one resupply yet).
  // `hp: 30` sits between alertTower's slim sensor mast (25) and objective's 40 — a sealed bay
  // door is sturdier than a thin mast but still not the real assault target. Collapses to
  // the same uniform `rubble` every other base-infra hex uses (alertTower/objective/dockClosed)
  // so destroyed base infrastructure reads consistently. `setDressing: true` (same precedent as
  // `alertTower`) keeps it OUT of the mission-objective pool — it's a dynamic
  // occupancy state, never a placed assault objective. Owner: hp tunable via playtest.
  dockClosed:{ id: 'dockClosed',tex: 'hex_dockClosed', passable: false, blocksLOS: true,
               destructible: true, hp: 30, rubbleId: 'rubble', setDressing: true,
               category: 'base', movement: 'none', cover: 'hard' },
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
  // player — just cheaper (hp 25) since it's a slim sensor mast, not a whole structure. #269
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
               destructible: true, hp: 25, rubbleId: 'rubble', setDressing: true,
               category: 'base', movement: 'none', cover: 'hard' },

  // #269 playtest follow-up (dock composition): turrets get their OWN dedicated base hex type
  // instead of being just another kind drawn from the generic dock pool (worldgen.js
  // `BASE_EARLY_KIND_POOL`/`BASE_LATE_KIND_POOL` no longer include `'turret'` at all —
  // `placeBases` places `turretEmplacement` hexes via a separate loop). Same reasoning as
  // `dock` above (and the same shape): a pure PLACEMENT MARKER for the dormant `turret` kind
  // stationed there, not a structure of its own — the turret enemy's own body/hp is what you
  // actually fight (it already reads as a stationary "emplacement" via its own zero-locomotion
  // kind def, enemyKinds.js), and every existing turret-cluster spawn path
  // (`_spawnTurretCluster`/`turretClusterHexes`) already assumes turrets sit on ordinary
  // PASSABLE ground — making this hex impassable/hard-cover would be inconsistent with that.
  // Deliberately NOT destructible either, same "a placement marker doesn't need its own HP
  // separate from the unit standing on it" reasoning as `dock` — which also means it's
  // automatically excluded from `isMissionObjective` (that check requires `destructible`), so
  // no `setDressing` flag is needed here (unlike `alertTower`/`dockClosed`, which ARE genuine
  // destructible structures and need the flag to opt out). Its own texture (`hex_turretEmplacement`,
  // art/hexArt.js) is what makes it read as visually distinct from a plain `dock` — a "weapon
  // pad" marking (red ring + crosshair) vs. the dock's landing-pad "H" marking.
  turretEmplacement: { id: 'turretEmplacement', tex: 'hex_turretEmplacement', passable: true, blocksLOS: false, speedFactor: 1,
               category: 'base', movement: 'full', cover: 'open' },

  // #269 playtest follow-up ("objectives are picking an arbitrary hex, not a real target"): a
  // dedicated, DESTRUCTIBLE base hex the mission marker actually points at — previously
  // `_targetCurrentBase` (scenes/arena/mission.js) pointed at `base.center`, which is just the
  // geometric centroid of a base's dock cluster, not necessarily even a real placed hex. `objective`
  // is placed once per base (data/worldgen.js `placeBases`), separate from docks/turretEmplacement/
  // alertTower, and reads as "the real thing to punch through" for that base — a proper structure,
  // not a placement marker, so it's a genuine hard-cover building (mirrors `alertTower`'s shape as
  // a real structure: impassable, blocks LOS) rather than the passable ground markings dock/
  // turretEmplacement use. hp 40 sits above the alert tower's slim-mast 25 and dockClosed's 30 —
  // substantial enough to read as a real objective, not a one-shot. `setDressing` is
  // deliberately OMITTED (unlike alertTower/dockClosed) — this hex IS meant to be `isMissionObjective`-
  // eligible in spirit (it's what the marker targets), though nothing currently drives
  // `isBaseCleared`/win-condition off it directly (kill-all-docked-enemies stays the actual win
  // condition, per the issue's explicit scoping call — this hex only fixes what the marker visually
  // points at). Collapses to the same generic biome-independent `rubble` as the other base-infra
  // structures (alertTower/dockClosed) — a destroyed objective reads as the same kind of
  // wreckage everywhere, not a biome-specific rubble.
  objective: { id: 'objective', tex: 'hex_objective', passable: false, blocksLOS: true,
               destructible: true, hp: 40, rubbleId: 'rubble',
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
  // #227: its own rubble (scattered dead scrub) distinct from the generic rubble's masonry look.
  scrub:     { id: 'scrub',     tex: 'hex_scrub',     passable: true,  blocksLOS: true,  speedFactor: SLOW_MOVEMENT_FACTOR,  destructible: true, hp: 30, rubbleId: 'scrubRubble',
               category: 'terrain', movement: 'slow', cover: 'soft' },
  // #227: what a destroyed scrub hex leaves behind — scattered dead brush, distinct from the
  // generic rubble's masonry look (#275: was originally distinguished from the desert's own
  // `adobe` outpost rubble; that outpost/rubble pair has since been removed).
  scrubRubble:{ id: 'scrubRubble', tex: 'hex_scrubRubble', passable: true, blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },
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
  // #227: its own rubble (broken ice/snow drift chunks) distinct from the generic rubble's
  // masonry look.
  drift:     { id: 'drift',     tex: 'hex_drift',     passable: true,  blocksLOS: true,  speedFactor: SLOW_MOVEMENT_FACTOR,  destructible: true, hp: 30, rubbleId: 'driftRubble',
               category: 'terrain', movement: 'slow', cover: 'soft' },
  // #227: what a destroyed snowdrift hex leaves behind — shattered ice/snow chunks, distinct
  // from the generic rubble's masonry look (#275: was originally distinguished from the arctic's
  // own `iceRuin` outpost rubble; that outpost/rubble pair has since been removed).
  driftRubble:{ id: 'driftRubble', tex: 'hex_driftRubble', passable: true, blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },
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
  // #227: its own rubble (burnt debris scraps) distinct from the generic rubble's masonry look.
  wreck:     { id: 'wreck',     tex: 'hex_wreck',     passable: true,  blocksLOS: true,  speedFactor: SLOW_MOVEMENT_FACTOR, destructible: true, hp: 40, rubbleId: 'wreckRubble',
               category: 'terrain', movement: 'slow', cover: 'soft' },
  // #227: what a destroyed wreck hex leaves behind — burnt debris scraps, distinct from the
  // generic rubble's masonry look (#275: was originally distinguished from urban's own `tower`
  // outpost rubble; that outpost/rubble pair has since been removed).
  wreckRubble:{ id: 'wreckRubble', tex: 'hex_wreckRubble', passable: true, blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },
  // #110: debris field — the urban biome's LESSER in-map hazard, standing in for 'collapsed'
  // now that a collapsed heap is reserved exclusively for the world boundary. Passable but
  // slow (a rubble-strewn street); no LOS block. #275: also urban's `channel` role now (the
  // `road` terrain type was removed — see biomes.js for the reasoning) — a paved lane and a
  // rubble-strewn street both read as "urban hazard/street" well enough to share one id rather
  // than inventing a new distinct paved-road identity for a role that's otherwise gone.
  debris:    { id: 'debris',    tex: 'hex_debris',    passable: true,  blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
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
  // #227: its own rubble (loose ash/cinder scatter) distinct from the generic rubble's masonry look.
  fumarole:  { id: 'fumarole',  tex: 'hex_fumarole',  passable: true,  blocksLOS: true,  speedFactor: SLOW_MOVEMENT_FACTOR, destructible: true, hp: 30, rubbleId: 'fumaroleRubble',
               category: 'terrain', movement: 'slow', cover: 'soft' },
  // #227: what a destroyed fumarole hex leaves behind — loose ash/cinder scatter, distinct
  // from the generic rubble's masonry look (#275: was originally distinguished from volcanic's
  // own `obsidian` outpost rubble; that outpost/rubble pair has since been removed).
  fumaroleRubble:{ id: 'fumaroleRubble', tex: 'hex_fumaroleRubble', passable: true, blocksLOS: false, speedFactor: SLOW_MOVEMENT_FACTOR,
               category: 'terrain', movement: 'slow', cover: 'open' },
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
// #269: is this a fabricated `base`-category hex (dock/dockClosed/alertTower/turretEmplacement/
// objective today)? Purely an art-palette/objective-eligibility signal — does NOT drive
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
// size-tier/own-hex exemptions in `shotBlockedAt`/`coverBlocksForRay` below) rather than the raw
// `blocksLOS` flag.
export function blocksLOS(id) {
  const tier = coverTier(id);
  return tier === 'soft' || tier === 'hard';
}

// Is this a destructible outpost (has HP, becomes rubble when destroyed)?
export function isDestructible(id) {
  const t = id && TERRAIN[id];
  return !!t && !!t.destructible;
}

// Starting hit points for a freshly-seeded destructible hex (0 for non-destructible terrain).
export function buildingHp(id) {
  const t = id && TERRAIN[id];
  return t && t.destructible ? (t.hp ?? 0) : 0;
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
export function isMissionObjective(id) {
  const t = id && TERRAIN[id];
  return !!t && !!t.destructible && !t.setDressing;
}

// #72: soft cover — walk-through concealment (forest/scrub/drift/wreck/fumarole). #269: derived
// from the `cover` tier directly now (was the passable+blocksLOS combination — equivalent, since
// that's exactly how `cover: 'soft'` was assigned per entry above). Unknown ⇒ false.
export function isSoftCover(id) {
  return coverTier(id) === 'soft';
}

// #269 §1/§2: does SOFT cover block LOS, given whether a small ground unit is party to this
// particular ray? Final design: only a small unit's sightline is blocked by soft cover — a
// mech/large unit sees clean over it. `smallUnitInvolved` is computed by callers via
// `isSmallUnit(theLiveEnemy)` (`scenes/arena/shared.js`, the real per-entity size-tier query —
// small = tank/infantry, large = mech/quadruped, per the design doc's confirmed mapping; the
// player is always a mech, implicitly large, so a caller never needs this for the player side
// of a ray) and threaded down through `coverBlocksForRay` below.
export function softCoverBlocksLOS(smallUnitInvolved) {
  return smallUnitInvolved;
}

// #269: the single shared "does this terrain block THIS ray" decision — `shotBlockedAt`,
// world.js's `_isWallForRound`, and `_wallDistanceLos` all defer to this so the cover rule can't
// drift across its three call sites. `ownHexExempt` is #72's own-hex transparency (true when the
// point being tested sits in a hex the caller has marked see-through for this particular shot —
// the shooter's muzzle hex, or a living target's own hex); `smallUnitInvolved` is #269 §1's
// size-tier soft-cover exemption (see `softCoverBlocksLOS` above for why it's currently inert).
// `hard` cover always blocks regardless of either exemption; `open` never blocks.
export function coverBlocksForRay(id, ownHexExempt, smallUnitInvolved = false) {
  if (!blocksLOS(id)) return false;
  if (isSoftCover(id)) {
    if (ownHexExempt) return false;
    return softCoverBlocksLOS(smallUnitInvolved);
  }
  return true; // hard cover — always blocks a ground unit; flying-unit ignoresCover is the
               // caller's concern (firing.js/projectiles.js), orthogonal to this cover-tier rule.
}

// #72 own-hex transparency: does terrain `id` at hex `key` stop a shot, given a Set of hex
// keys treated as see-through for THIS shot (the shooter's muzzle hex + the target's own hex)?
// Soft cover doesn't protect its own occupant — a shot may enter/impact within an exempted
// soft-cover hex — but SOLID cover (alertTower, dockClosed, objective) blocks regardless of
// exemption, and non-exempted soft-cover hexes between shooter and target still block ("deep
// woods"). The
// boundary-only impassable terrains (mesa/collapsed/deepWater/ice/lava) never block LOS at all
// (#221 — they're stamped only at the world's outer edge, never used as an in-map obstacle).
// #269: `smallUnitInvolved` (optional, default false) threads through to the soft-cover size-tier
// exemption via `coverBlocksForRay` — see that function + `softCoverBlocksLOS` for why it's
// currently a no-op regardless of the value passed.
export function shotBlockedAt(id, key, transparent = null, smallUnitInvolved = false) {
  const ownHexExempt = !!(transparent && transparent.has(key));
  return coverBlocksForRay(id, ownHexExempt, smallUnitInvolved);
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
