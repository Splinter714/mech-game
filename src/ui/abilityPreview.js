// Animated ABILITY previews for the catalog card (#534, "you can see what an ability actually
// does before mounting it"). The weapon half of `ui/weaponCardList.js` already live-fires every
// weapon through the shared delivery sim rather than drawing a canned impression of it; this is
// the ability equivalent, built to the same rule: **replay the real thing wherever the real thing
// can be driven without arena state, and where it genuinely can't, derive the stand-in from the
// ability's own registry data** (radius / range / duration / speedMult) so it can't drift.
//
// What each ability's card actually shows, and how real it is:
//
//   dash            REAL. A dash IS just `speedMult` for `duration` (arena/abilities.js has no FX
//                   for it at all beyond the movement), so replaying the travel — the real burst
//                   distance, at the real burst duration — is the whole effect.
//   shieldBurst     REAL FX. Plays `aoeBlastRings` (art/abilityFx.js) — the SAME ring spec the
//                   arena's `_aoeBlastFx` plays — at the ability's real `radius`, in the same
//                   0x5ec8e0 the arena's shieldBurst branch passes.
//   jumpBlast       REAL FX + real sequencing. The arena fires a small cool-toned pop on the
//                   activate edge, carries the player over `duration`, then a full-radius warm
//                   blast on the deactivate edge; this reproduces that exact two-edge order with
//                   the same ring specs, radii (`radius * 0.55` / `radius`) and tints.
//   antiMissile     REAL LOGIC + REAL FX. Enemy rounds are built and flown with the actual
//                   `makeProjectile`/`stepProjectile` delivery sim, and the actual
//                   `nearestInterceptTarget` (data/interceptor.js) decides what gets shot down
//                   inside the ability's real `range` — the same call the arena's antiMissile
//                   effect makes, against the same envelope, drawing the same `interceptRings`.
//   smokeScreen     REAL ART. The cloud is `smokePuffLayout` at the ability's real `radius`,
//                   stamped from the SAME baked gradient puff textures the arena deploys
//                   (art/smokePuff.js). Only the roiling is different: the card animates drift/
//                   breathe off its own loop clock instead of hanging two repeating tweens per
//                   puff, because a card rebuilds its cloud every few seconds.
//   droneLauncher   REAL, as of #628 — count, movement AND art. The squad size is
//                   `randomDroneCount` and every drone is flown by the real
//                   `stepFriendlyDroneOrbit` on the real `FRIENDLY_DRONE_TUNING` (scaled to card
//                   px), so the swarm churns/separates/leashes exactly like the summoned one; and
//                   each one is now the ACTUAL Recon Drone airframe, raised from the same
//                   `ensureFriendlyDroneTextures` call the arena's own summon makes
//                   (scenes/arena/friendlyDrones.js) — same builder, same dark player-tinted
//                   palette, nosed along its travel direction with its rotor overlay spinning at
//                   the arena's own rate. This replaces the two-crossed-lines "rotor chip" stand-in
//                   #534 drew, on Jackson's reading that the arena looks better than the card did.
//                   The old objection here was that the airframe is "~3px of mush" at card scale —
//                   true only if you scale it by the card's raw world→px factor. Sized against the
//                   CASTER instead (the drone is the same fraction of the mech it escorts that it
//                   is in the arena) it comes out bigger than the chip it replaces, and the
//                   texture-cost objection was answered by #612 already: it is ONE bake per accent
//                   colour, shared by every card and reused by the arena.
//   empTrap         NEW in #628 (it had no card at all — #621 shipped noting the gap: "EMP Trap's
//                   catalog card will just show the idle caster mech with no special animation").
//                   REAL SCATTER + REAL NODE ART: `trapCount` traps ringed around the caster at the
//                   registry's own `scatterRadiusMin`..`Max`, each drawn by `drawMineNode`
//                   (art/abilityFx.js) — literally the same call `_drawHazard` makes for a planted
//                   trap in the arena — and opened with `empCastRings`, the cast burst
//                   `plantEmpTraps` plays. The one thing that is a stand-in is the DETONATION: a
//                   trap fires when an enemy walks into it, and a card has no enemies, so after the
//                   traps have sat armed for a beat the card discharges them itself with the shared
//                   `aoeBlastRings` spec at the trap's own real `hazardRadius`, in the trap's own
//                   colour. Same "derive the stand-in from the ability's own registry data" rule as
//                   everything else here.
//   cloak           REAL, as of #612. The card runs the actual effect on the actual mech: the
//                   per-pixel greyscale re-bake of that build's own part textures
//                   (`desaturateTexture`, the same call arena/abilities.js's `setCloakVisual`
//                   makes), the same muzzle-glow dim/tint, pre-composited into one flattened
//                   RenderTexture for correct occlusion and dimmed ONCE to the real `CLOAK_ALPHA`
//                   — cloakFlatten.js's whole argument, applied to a card. See ui/casterMech.js.
//                   This replaces the outline-only "lit wireframe" chip stand-in the #500 fourth
//                   pass settled on, which existed only because there was no mech here to
//                   desaturate. (#500 playtest follow-up: Cloak has no `duration` at all any more
//                   — it holds until you fire — so the card plays it over the capped preview
//                   window, see PREVIEW_MAX_ACTIVE_MS below.)
//
// THE CASTER (#612). Every card above needs something standing where the ability goes off, and
// that something is now the PLAYER'S OWN LIVE BUILD — this column's chassis, mounted weapons and
// colour — not the ~9x12px accent block with a white dot it was through #534/#500. Jackson: "for
// ability previews, it seems there's a generic green box or something to represent the 'mech'; can
// we instead actually show the mech?" It costs no extra texture bakes (the sprites point at the
// column's already-baked mech textures) and it follows every mount/chassis/colour change — see
// ui/casterMech.js for how, and for why Cloak's card can now run the genuine effect. A preview
// built with no caster source simply shows no caster; everything else on the card is unchanged.
//
// PLAYBACK matches the weapon cards: it loops continuously and unattended, with no hover/select
// gating, so a whole column of cards is animating at once and you can compare them at a glance.
// Two deliberate deviations, both because ability timing is on a completely different scale from a
// weapon's fire cadence:
//   * the REST between loops is a short fixed gap, not the ability's real cooldown (a flat 4s
//     across the whole catalog since #628, previously 4-18s), which would leave a card blank for
//     most of its life. A thin sweeping arc around the caster during
//     that gap says "recharging" without pretending to be a real cooldown readout.
//   * a long `duration` is capped at PREVIEW_MAX_ACTIVE_MS. Drone Launcher's real 12s window on a
//     ~200px card reads as a frozen loop, not as a long ability.
// Everything spatial — travel distance, blast radius, intercept envelope, cloud size — stays the
// ability's own number, scaled by one shared factor per card.
//
// COST: one Graphics redraw per card per frame (the same budget a weapon card already spends),
// plus a handful of stamped Images for Smoke Screen only. No tweens, no timers, no per-frame
// allocation beyond the transient FX list.
import { ABILITIES } from '../data/abilities.js';
import { getWeapon } from '../data/weapons.js';
import { makeProjectile, stepProjectile } from '../data/delivery.js';
import { nearestInterceptTarget } from '../data/interceptor.js';
import {
  randomDroneCount, stepFriendlyDroneOrbit, FRIENDLY_DRONE_TUNING, DRONE_COUNT_MAX,
} from '../data/friendlyDroneAI.js';
import { MEDIUM_PLAYER_CONFIG } from '../data/chassis/player/mediumPlayer.js';
import { drawProjectileBody } from '../art/index.js';
import {
  aoeBlastRings, interceptRings, ringsDuration, drawFxRings, INTERCEPT_BOLT_COLOR,
  empCastRings, drawMineNode, EMP_TRAP_COLOR,
} from '../art/abilityFx.js';
// #628: the arena's OWN friendly-drone texture builder, so a card's squad is the same airframe the
// summon spawns rather than a lookalike. Importing an arena module from the UI is the same shape as
// casterMech.js reaching into arena/abilities.js for the real Cloak constants.
import { ensureFriendlyDroneTextures } from '../scenes/arena/friendlyDrones.js';
import { ensureSmokeTextures, smokePuffLayout, smokePuffScale, SMOKE_BREATHE } from '../art/smokePuff.js';
import {
  CasterMech, CasterCloak, CASTER_WORLD_PX, CASTER_PART_PX, CASTER_BODY_FRAC, CLOAK_ALPHA,
} from './casterMech.js';

// ── Timeline ───────────────────────────────────────────────────────────────────────────────────
const REST_MS = 900;                 // preview-only gap between loops — NOT the real cooldown
const PREVIEW_MAX_ACTIVE_MS = 4000;  // cap on a long `duration` (Drone Launcher's real 12s)
const MIN_ACTIVE_MS = 500;           // floor, so Shield Burst's 0.15s window still holds its blast
const LOOP_FADE_IN_MS = 80;          // barely there — several effects fire on frame one
const LOOP_FADE_OUT_MS = 220;        // covers the loop seam, so the reset doesn't read as a glitch

// Anti-Missile's incoming fire: a real registry weapon (the Swarm Rack's guided missile), so the
// rounds the card shows being shot down are the same kind of round the ability actually kills —
// including its own projectile art/colour, straight out of `makeProjectile`.
const AM_INCOMING_WEAPON = getWeapon('swarmRack');
const AM_SPAWN_MS = 520;             // launch cadence — enough separation to watch each one die

// ── Spatial scaling ────────────────────────────────────────────────────────────────────────────
// Same idea as the weapon cards' CATALOG_MAX_RANGE (#120): scale every ability's extent against
// the biggest one in the catalog so a wide Anti-Missile envelope visibly dwarfs a Shield Burst,
// with a floor so the smallest one is still legible on a compact card.
const EXTENT_MIN_FRAC = 0.35;

// The reference speed a movement burst's distance is computed against — the player chassis' own
// top speed, so Dash's card shows the distance a real dash actually covers.
const BASE_SPEED = MEDIUM_PLAYER_CONFIG.movement.maxSpeed;

// The extent of an ability with no spatial data of its own (Cloak) — the player mech's own body
// length, i.e. "this happens to you, right here", not to an area.
const PERSONAL_EXTENT = MEDIUM_PLAYER_CONFIG.art?.bodyLen ?? 38;

// Ground covered by a movement-burst ability, from its own `speedMult`/`duration` — the same
// product locomotion.js applies in the arena.
export function burstDistance(def) {
  return def.speedMult ? BASE_SPEED * def.speedMult * (def.duration ?? 0) : 0;
}

// #628: how far out an EMP Trap cast actually reaches — the furthest a trap can land, plus that
// trap's own hazard radius, since the card discharges each one at its real radius. Every other
// ability states its extent as a single `range`/`radius`; this one's is two registry fields
// together, so it gets a named derivation rather than a magic entry in the max() below.
export function empTrapExtent(def) {
  return (def.scatterRadiusMax ?? 0) + (def.hazardRadius ?? 0);
}

// How much WORLD space this ability's effect occupies — the largest of whatever spatial numbers
// its registry entry actually carries.
export function previewExtent(def) {
  return Math.max(
    def.range ?? 0,
    def.radius ?? 0,
    burstDistance(def),
    def.effect === 'droneLauncher' ? FRIENDLY_DRONE_TUNING.leashRadius : 0,
    def.effect === 'empTrap' ? empTrapExtent(def) : 0,
    PERSONAL_EXTENT,
  );
}

const ABILITY_MAX_EXTENT = Math.max(...Object.values(ABILITIES).map(previewExtent));

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── The caster's on-card size (#612) ───────────────────────────────────────────────────────────
// The mech is scaled by the SAME world→px factor as every radius/range/travel on its card (see
// setStage's `pxPerWorld`), so a Shield Burst still reads as roughly four mech-lengths across
// exactly as it does in play. Two guards on top of that, both purely about legibility on a ~245x80
// stage: a card whose effect reaches a long way (Anti-Missile's 220px envelope) compresses the
// world hard enough that a strictly proportional mech would be an 11px smudge, and a card whose
// "extent" IS the mech (Cloak, Dash) would otherwise grow past the stage it stands in.
const CASTER_MIN_STAGE_FRAC = 0.32;
const CASTER_MAX_STAGE_FRAC = 0.85;

// The caster radius at which the intercept spark plays at its full authored spec. The chip this
// replaced was ~6px and the spark was `chipR / 14`; a real mech is ~2.5x that, and carrying the
// same ratio over would throw a 32px shockwave across most of the intercept envelope. So the spark
// still grows with the caster — the point of re-deriving it — just on a slacker reference, landing
// near the chip's own absolute spark size for a mech-sized caster instead of 2.5x it.
const FX_REF_CASTER_R = 26;

// Dash's motion ghosts: how many trail the mech, and the alpha the nearest one starts at (each one
// further back gets a share less). Fewer than the chip trail's four — a mech-sized ghost carries
// far more of the read than a 9x12 block did, and the fourth was down at 0.07 alpha anyway.
const DASH_GHOSTS = 3;
const DASH_GHOST_ALPHA = 0.34;

// #628: one drone's texture square as a fraction of the caster's, for the legibility reason
// spelled out at its use in `setStage`. Calibrated so the drawn airframe (about a third of its own
// canvas) lands a little wider than the ~5px vector chip it replaces — recognisably a quad-rotor,
// still clearly an escort rather than a second mech. PLAYTEST DIAL: raise it if the swarm reads as
// specks, lower it if the drones crowd the mech they orbit.
const DRONE_CASTER_FRAC = 0.6;

// #628, EMP Trap: how long the scattered traps sit ARMED on the card before it discharges them.
// The ability's own `duration` is only the 0.15s activation beat (the traps outlive it on their own
// 7s `life`, see data/abilities.js), so without a hold the card would flash and be empty — and 7s
// of motionless dots is the "frozen loop" PREVIEW_MAX_ACTIVE_MS exists to prevent. Long enough to
// read the ring of pulsing warning lights, short enough that the loop keeps moving.
const EMP_TRAP_HOLD_MS = 2200;
// Floors, in card px, for the two things an EMP Trap card draws at the hazard's own radius (55px
// world, which compresses to ~9px on a stage this size). The scatter POSITIONS are never floored —
// where the traps land is spatial data and stays proportional, same rule as every other extent on a
// card; these two are the decoration ON a trap, in the same category as the intercept spark that's
// already sized against the card rather than the world.
//
// The node floor is set from how the arena's own node READS rather than picked: `drawMineNode`
// strokes its ring at 0.28 of the radius it's given, so an arena trap's ring is ~15px against a
// ~65px mech, i.e. a bit under a quarter of the mech's height. 16 puts the card's ring at the same
// fraction of the (legibility-inflated) mech standing next to it.
const EMP_NODE_MIN_PX = 16;
const EMP_BLAST_MIN_PX = 10;

export class AbilityCardPreview {
  // `index` staggers the loop start across a column so several ability cards don't pulse in
  // lockstep — the same trick the weapon cards' `cd: this.cards.length * 120` seed plays.
  // `caster` (#612) is the caller's LIVE handle on whose mech is doing the casting —
  // `{ mech, textureKey }`, read on every pose rather than snapshotted, since GarageScene mutates
  // that same Mech in place. Omitting it (the Weapon Lab, which has no ability cards at all) draws
  // no caster and changes nothing else.
  constructor(scene, id, def, accent, index = 0, caster = null) {
    this.scene = scene;
    this.id = id;
    this.def = def;
    this.effect = def.effect;
    this.accent = accent;
    this.layer = scene.add.container(0, 0);   // everything this preview owns, under the card's fxG
    // Three bands inside it, in the arena's own depth order: smoke, the mech standing in it, and
    // (#628) the drone squad flying over both — the arena's DEPTH.FLYING_UNITS (3.5) sits above the
    // player's DEPTH.UNITS (3) for exactly that reason. The card's fxG — blasts, trap nodes, rounds
    // — is above all three.
    //
    // Smoke stays BELOW the caster here even though #628 lifted the arena's own cloud above every
    // unit (DEPTH.SMOKE): in the arena hiding what's inside it is the entire point of the ability,
    // whereas a catalog card exists to show you the ability AND whose mech is casting it (#612), and
    // burying that mech under the cloud on a ~245x80 stage would defeat the card. Deliberate
    // divergence, not an oversight.
    this.smokeLayer = scene.add.container(0, 0);
    this.casterLayer = scene.add.container(0, 0);
    this.droneLayer = scene.add.container(0, 0);
    this.layer.add([this.smokeLayer, this.casterLayer, this.droneLayer]);

    // The caster mech itself, plus Dash's motion ghosts (its own trail IS the read — Dash has no
    // arena FX beyond the movement) and Cloak's real flatten. All three are per-card sprite stacks
    // over the column's SHARED, already-baked mech textures — no card bakes anything of its own.
    // Ghosts are built FIRST, furthest-back first, so the layer's own child order puts every one of
    // them behind the mech leading the trail.
    this.ghosts = [];
    if (caster && def.effect === 'dash') {
      for (let i = DASH_GHOSTS - 1; i >= 0; i--) this.ghosts[i] = new CasterMech(scene, caster).addTo(this.casterLayer);
    }
    this.caster = caster ? new CasterMech(scene, caster).addTo(this.casterLayer) : null;
    this.cloak = this.caster && def.effect === 'cloak' ? new CasterCloak(scene, this.caster) : null;

    // A movement burst plays out over its REAL duration; everything else gets the clamped window.
    // #500: an UNTIL-BROKEN ability (`duration: null` — Cloak) has no real number to play out at
    // all. A card can't show "indefinite", so it holds the effect for the same capped window a
    // long duration gets rather than collapsing to the MIN_ACTIVE_MS floor — which would make the
    // one ability that can now outlast every other one pulse the fastest on the shelf.
    const previewDurationMs = def.duration == null ? PREVIEW_MAX_ACTIVE_MS : def.duration * 1000;
    this.travelMs = burstDistance(def) > 0 ? (def.duration ?? 0) * 1000 : 0;
    this.activeMs = this.travelMs || clamp(previewDurationMs, MIN_ACTIVE_MS, PREVIEW_MAX_ACTIVE_MS);
    // Extra time after the burst window for a trailing effect to finish: Jump Blast's landing
    // blast fires on the deactivate edge, Smoke Screen's cloud fades out, and (#628) EMP Trap's
    // traps sit armed on the ground long after the 0.15s cast beat that planted them.
    this.settleMs = this.effect === 'jumpBlast' ? ringsDuration(aoeBlastRings(1, 0)) + 60
      : this.effect === 'smokeScreen' ? 420
        : this.effect === 'empTrap' ? EMP_TRAP_HOLD_MS : 0;
    this.cycleMs = this.activeMs + this.settleMs + REST_MS;

    this.t = -((index * 230) % REST_MS);   // negative = still waiting for its first loop
    this._active = false;
    this._fx = [];        // transient ring sets: { x, y, rings, scale, age, life, bolt }
    this._rounds = [];    // Anti-Missile: live incoming rounds (real delivery-sim projectiles)
    this._drones = [];    // Drone Launcher: live squad (real friendlyDroneAI state)
    this._droneViews = []; // #628: one real Recon Drone sprite stack per possible squad member
    this._puffs = [];     // Smoke Screen: stamped Images + their per-puff animation phases
    this._traps = [];      // #628, EMP Trap: the scattered trap nodes, in card px
    this._empFired = false; // #628: has this loop already discharged its traps?
    this._spawnCd = 0;
    this.stage = null;
  }

  // Called from the card list's layout pass with the ability card's whole stage rect (abilities
  // have no muzzle/emitter, so unlike a weapon card they get the full width to work in).
  setStage(x, y, w, h) {
    const cx = x + w / 2, cy = y + h / 2;
    const halfW = Math.max(6, w / 2 - 2), halfH = Math.max(6, h / 2 - 2);
    this.stage = { x, y, w, h, cx, cy, halfW, halfH };

    // ONE world→card-px factor per card, so travel distance, blast radius, intercept envelope and
    // cloud size all stay in proportion to each other exactly as the registry states them.
    //
    // Two things decide it. First, `fit` — the scale at which this ability's own effect would
    // exactly fill the stage. That's per-AXIS, because the stage is much wider than it is tall
    // and a movement burst is a horizontal line while a blast is a disc: a movement ability needs
    // half its travel PLUS its landing radius across, but only its radius down. Sizing everything
    // off `min(w, h) / 2` (the obvious first cut) squeezed Dash and Jump Blast into a few pixels
    // of shuffle while leaving most of the card empty.
    //
    // Second, `frac` — the same cross-catalog compression the weapon cards apply to range (#120):
    // scale down by how big this ability is against the biggest one in the catalog, floored at
    // EXTENT_MIN_FRAC, so Anti-Missile's 220px envelope visibly dwarfs Shield Burst's 90px pop
    // instead of every card filling its stage identically.
    const rad = Math.max(
      this.def.radius ?? 0,
      this.def.range ?? 0,
      this.def.effect === 'droneLauncher' ? FRIENDLY_DRONE_TUNING.leashRadius : 0,
      this.def.effect === 'empTrap' ? empTrapExtent(this.def) : 0,
      PERSONAL_EXTENT / 2,
    );
    const travel = burstDistance(this.def);
    const fit = Math.min(halfW / (travel / 2 + rad), halfH / rad);
    const frac = Math.max(EXTENT_MIN_FRAC, previewExtent(this.def) / ABILITY_MAX_EXTENT);
    this.pxPerWorld = fit * frac;
    this.pxRadius = (this.def.radius ?? 0) * this.pxPerWorld;
    this.pxRange = (this.def.range ?? 0) * this.pxPerWorld;
    this.pxTravel = burstDistance(this.def) * this.pxPerWorld;
    // #612: the caster's own size, and with it everything that used to be measured against the
    // 6px chip. `CASTER_WORLD_PX` is the mech's real arena footprint, so pushing it through this
    // card's own `pxPerWorld` keeps the mech in proportion to the effect around it; the clamp is
    // the legibility guard described at CASTER_MIN_STAGE_FRAC.
    this.casterPx = clamp(CASTER_WORLD_PX * this.pxPerWorld, h * CASTER_MIN_STAGE_FRAC, h * CASTER_MAX_STAGE_FRAC);
    // Half the mech's drawn height — the mech-sized replacement for `chipR` as this card's "how big
    // is the thing standing there" unit.
    this.casterR = Math.max(2.5, (this.casterPx * CASTER_BODY_FRAC) / 2);
    // `interceptRings` are absolute world sizes (a 32px shockwave), because an intercept is a
    // POINT event with no ability-data radius behind it — pushed through `pxPerWorld` they'd come
    // out sub-pixel and the card's whole payoff beat would be invisible. So the one thing here
    // sized against the card rather than the world is that spark, scaled off the caster. The
    // weapon cards already take the same liberty with their own impact circles. Nothing that
    // communicates an ability's REACH (radius, range, travel, cloud) is ever scaled this way.
    this.fxScale = clamp(this.casterR / FX_REF_CASTER_R, 0.35, 1);
    // Dash's ghost spacing, as a fraction of the burst. Tied to the CASTER's own width rather than
    // a flat 11% of travel (what the chip trail used): mech-sized ghosts 11% apart on a short burst
    // are a smear, and the point of the trail is reading distinct positions along the path.
    this.ghostGapFrac = this.pxTravel > 0 ? clamp(this.casterR / this.pxTravel, 0.08, 0.3) : 0;
    // #628: how big one drone's airframe is drawn. Its texture canvas is the same CASTER_PART_PX
    // square a mech part is, so this is a fraction of the caster's own drawn footprint.
    //
    // NOT strictly proportional, and the exception is deliberate. In the arena a drone's sprite is
    // ~0.12 of a mech part's square (friendlyDrones.js), and only about a third of that
    // square is airframe (the canvas carries the rotor-swing headroom every vehicle texture does),
    // so carrying the real ratio onto a card whose whole mech is ~26px tall lands the drone at
    // roughly THREE pixels of visible rotor — which is exactly the "~3px of mush" objection that
    // put a vector chip here in #534 in the first place. The chip it replaces was itself drawn at
    // ~0.28 of the caster's radius for the same reason. So the squad is drawn bigger than life, at
    // a fixed fraction of the caster, in the same spirit as the caster's own legibility clamp above
    // and the intercept spark's card-scaled size below. Nothing SPATIAL is affected — where the
    // drones fly (orbit, leash, separation) is still the real tuning through `pxPerWorld`.
    this.droneSpriteScale = (this.casterPx * DRONE_CASTER_FRAC) / CASTER_PART_PX;
    // EMP Trap's own numbers in card px. The scatter band is spatial (proportional, like every
    // radius/range here); the hazard radius is floored only where it's DRAWN — see the constants.
    this.pxScatterMin = (this.def.scatterRadiusMin ?? 0) * this.pxPerWorld;
    this.pxScatterMax = (this.def.scatterRadiusMax ?? 0) * this.pxPerWorld;
    this.pxHazardRadius = (this.def.hazardRadius ?? 0) * this.pxPerWorld;
    this._placeCaster();
    this._buildSmoke();
    this._buildDrones();
    this._begin();
  }

  // Put the caster (and Dash's ghosts) at the stage centre at this layout's scale. Cloak's flatten
  // is invalidated rather than rebuilt — it re-bakes lazily, the first frame the card actually
  // draws it, so a card that's never scrolled into view never pays for one.
  _placeCaster() {
    if (!this.caster) return;
    const { cx, cy } = this.stage;
    this.caster.place(cx, cy, this.casterPx);
    for (const gh of this.ghosts) { gh.place(cx, cy, this.casterPx); gh.setVisible(false); }
    this.cloak?.invalidate();
  }

  // The column's build changed under us — a mount, a chassis swap, a new colour. The textures
  // themselves re-bake in place under the same keys (GarageScene owns that), so all that's needed
  // here is a re-pose and a fresh Cloak flatten.
  refreshCaster() {
    this.caster?.refresh();
    for (const gh of this.ghosts) gh.refresh();
    this.cloak?.invalidate();
  }

  // ── Loop ────────────────────────────────────────────────────────────────────────────────────

  update(dt) {
    if (!this.stage) return;
    const ms = dt * 1000;
    const prev = this.t;
    this.t += ms;
    if (prev < 0 && this.t >= 0) this._begin();
    else if (this.t >= this.cycleMs) { this.t -= this.cycleMs; this._begin(); }

    const active = this.t >= 0 && this.t < this.activeMs;
    if (this._active && !active) this._onDeactivate();
    this._active = active;

    if (this.effect === 'antiMissile') this._stepAntiMissile(dt, ms);
    else if (this.effect === 'droneLauncher') this._stepDrones(dt);
    else if (this.effect === 'smokeScreen') this._stepSmoke();
    else if (this.effect === 'empTrap') this._stepEmpTraps();

    for (const f of this._fx) f.age += ms;
    if (this._fx.some((f) => f.age >= f.life)) this._fx = this._fx.filter((f) => f.age < f.life);
  }

  // The activate edge — the same instant `arena/abilities.js` fires each effect's `!wasActive`
  // branch. Kept in the same order and with the same arguments, so the card's opening beat is
  // literally the ability's own.
  _begin() {
    this._fx.length = 0;
    this._rounds.length = 0;
    this._spawnCd = 0;
    const { cx, cy } = this.stage;
    if (this.effect === 'shieldBurst') {
      this._pushRings(cx, cy, aoeBlastRings(this.pxRadius, 0x5ec8e0));
    } else if (this.effect === 'jumpBlast') {
      // Launch pop, cool-toned and at 55% radius — telegraphs the leap (arena/abilities.js).
      this._pushRings(cx - this.pxTravel / 2, cy, aoeBlastRings(this.pxRadius * 0.55, 0xbfe8ff));
    } else if (this.effect === 'droneLauncher') {
      this._spawnSquad();
    } else if (this.effect === 'empTrap') {
      this._scatterTraps();
    }
  }

  // The deactivate edge — Jump Blast's blast lands HERE, not at the press, exactly as the arena
  // sequences it (the burst has by now carried the player to the arrival point).
  _onDeactivate() {
    if (this.effect !== 'jumpBlast') return;
    this._pushRings(this.stage.cx + this.pxTravel / 2, this.stage.cy, aoeBlastRings(this.pxRadius, 0xffcf8a));
  }

  _pushRings(x, y, rings, { scale = 1, bolt = null } = {}) {
    this._fx.push({ x, y, rings, scale, bolt, age: 0, life: ringsDuration(rings) });
  }

  // ── Anti-Missile: the real delivery sim + the real target selector ──────────────────────────

  _stepAntiMissile(dt, ms) {
    const { cx, cy } = this.stage;
    if (this._active) {
      this._spawnCd -= ms;
      if (this._spawnCd <= 0) { this._spawnIncoming(); this._spawnCd = AM_SPAWN_MS; }
    }
    for (const p of this._rounds) {
      if (p.dead) continue;
      stepProjectile(p, dt, null);
      if (p.dist >= p.maxDist) p.dead = true;
    }
    // The ACTUAL point-defense pick the arena makes: repeatedly ask `nearestInterceptTarget`
    // against a shrinking candidate list until nothing more is inside the ability's own `range`,
    // destroying every one — a burst window, not a single-target gate.
    if (this._active) {
      const live = this._rounds.filter((p) => !p.dead);
      let target;
      while ((target = nearestInterceptTarget(cx, cy, this.pxRange, live))) {
        target.dead = true;
        this._pushRings(target.x, target.y, interceptRings(), {
          scale: this.fxScale, bolt: { x: cx, y: cy },
        });
        live.splice(live.indexOf(target), 1);
      }
    }
    if (this._rounds.some((p) => p.dead)) this._rounds = this._rounds.filter((p) => !p.dead);
  }

  // One incoming enemy round, launched from the stage edge at the caster. Built by the real
  // `makeProjectile` off a real registry weapon so it flies (and draws) like the thing the
  // ability actually shoots down; its world velocity is mapped into card px by the same
  // `pxPerWorld` everything else here uses, so it stays in proportion to the envelope.
  _spawnIncoming() {
    const { cx, cy, halfW, halfH } = this.stage;
    const a = Math.random() * Math.PI * 2;
    // Distance from the centre to the stage border along `a` — rounds enter from the card's own
    // edge, the card-scale equivalent of "incoming from off-screen".
    const ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a));
    const d = Math.min(ca > 1e-3 ? halfW / ca : Infinity, sa > 1e-3 ? halfH / sa : Infinity);
    const sx = cx + Math.cos(a) * d, sy = cy + Math.sin(a) * d;
    const inward = Math.atan2(cy - sy, cx - sx);
    const p = makeProjectile(AM_INCOMING_WEAPON, sx, sy, inward, { maxDist: d });
    // Everything the round measures in world px gets the same map — speed, and the cosmetic
    // lateral wobble, which would otherwise jiggle a card-scale round several times its own
    // travel per second.
    p.speed *= this.pxPerWorld;
    p.vx *= this.pxPerWorld;
    p.vy *= this.pxPerWorld;
    p.wobbleAmplitude *= this.pxPerWorld;
    this._rounds.push(p);
  }

  // ── Drone Launcher: the real squad size, flown by the real orbit AI, in the real airframe ───

  // #628: one sprite stack per POSSIBLE squad member, built once per layout and then shown/hidden
  // as each loop's `randomDroneCount` lands — a squad respawns every few seconds, and churning
  // GameObjects at that cadence is exactly what `_buildSmoke` already refuses to do. The textures
  // themselves are the arena's own (`ensureFriendlyDroneTextures`): one bake per accent colour for
  // the whole catalog, reused by the arena if the player's colour matches the card's accent.
  _buildDrones() {
    if (this.effect !== 'droneLauncher') return;
    const key = ensureFriendlyDroneTextures(this.scene, this.accent);
    if (!this._droneViews.length) {
      for (let i = 0; i < DRONE_COUNT_MAX; i++) {
        // Hull + rotor overlay, the same two sprites `_spawnFriendlyDrone` assembles. Its third,
        // the ground shadow, is skipped: it's a 0.28-alpha black ellipse, which says "airborne"
        // over lit terrain and says nothing at all over a card's near-black stage.
        const hull = this.scene.add.sprite(0, 0, `${key}_hull`);
        const turret = this.scene.add.sprite(0, 0, `${key}_turret`);
        const view = this.scene.add.container(0, 0, [hull, turret]).setVisible(false);
        view.hull = hull;
        view.turret = turret;
        this.droneLayer.add(view);
        this._droneViews.push(view);
      }
    }
    for (const v of this._droneViews) {
      v.hull.setScale(this.droneSpriteScale);
      v.turret.setScale(this.droneSpriteScale);
    }
  }

  // Pose this frame's squad. Mirrors `_updateFriendlyDrones`: the hull noses along its travel
  // direction (the art points -y at rotation 0, hence the +PI/2 the arena uses too) and the turret
  // overlay is the spinning rotor blur. Views past the live squad size are simply hidden.
  _updateDroneViews(alpha) {
    for (let i = 0; i < this._droneViews.length; i++) {
      const v = this._droneViews[i];
      const d = this._drones[i];
      if (!d || alpha <= 0) { v.setVisible(false); continue; }
      v.setVisible(true);
      v.setAlpha(alpha);
      v.setPosition(d.x, d.y);
      v.hull.rotation = d.angle + Math.PI / 2;
      v.turret.rotation = d.rotorSpin;
    }
  }

  _spawnSquad() {
    const { cx, cy } = this.stage;
    const tuning = this._droneTuning();
    const count = randomDroneCount();
    this._drones = [];
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      this._drones.push({
        x: cx + Math.cos(a) * tuning.orbitRadius * 0.5,
        y: cy + Math.sin(a) * tuning.orbitRadius * 0.5,
        vx: 0, vy: 0, angle: 0,
        orbitAng: Math.random() * Math.PI * 2, orbitR: tuning.orbitRadius,
        jitterAt: 0, handed: Math.random() < 0.5 ? 1 : -1,
        rotorSpin: Math.random() * Math.PI * 2,
      });
    }
  }

  // The arena's own tuning with every DISTANCE/SPEED field mapped into card px — jitter cadence
  // is a time, so it passes through untouched and the squad churns at the real rate.
  _droneTuning() {
    const s = this.pxPerWorld;
    const t = FRIENDLY_DRONE_TUNING;
    return {
      maxSpeed: t.maxSpeed * s, accel: t.accel * s,
      orbitRadius: t.orbitRadius * s, leashRadius: t.leashRadius * s,
      separationRadius: t.separationRadius * s, separationWeight: t.separationWeight,
      jitterMin: t.jitterMin, jitterMax: t.jitterMax,
    };
  }

  _stepDrones(dt) {
    if (!this._active) { this._drones.length = 0; return; }
    const { cx, cy } = this.stage;
    const tuning = this._droneTuning();
    for (const d of this._drones) {
      const siblings = this._drones.filter((o) => o !== d);
      const next = stepFriendlyDroneOrbit(d, cx, cy, dt, tuning, siblings);
      Object.assign(d, next);
      d.rotorSpin += dt * 40;   // matches the arena's ROTOR_SPIN_RATE
    }
  }

  // ── Smoke Screen: the real puff textures + the real cloud scatter ───────────────────────────

  // Built ONCE per layout (not per loop) — re-scattering every few seconds would churn ~75
  // GameObjects (post-#507-density-pass; it was ~30) for no visible gain, since the loop only
  // re-runs the fade envelope. Only ONE card in the catalog is Smoke Screen, so this cost is
  // paid once, and unlike the arena it hangs zero tweens off them.
  _buildSmoke() {
    this._destroySmoke();
    if (this.effect !== 'smokeScreen') return;
    ensureSmokeTextures(this.scene);
    const { cx, cy } = this.stage;
    for (const { ox, oy, r, texKey, baseAlpha } of smokePuffLayout(this.pxRadius)) {
      const scale = smokePuffScale(r);
      const view = this.scene.add.image(cx + ox, cy + oy, texKey)
        .setScale(scale)
        .setRotation(Math.random() * Math.PI * 2)
        .setAlpha(0);
      this.smokeLayer.add(view);
      this._puffs.push({
        x0: cx + ox, y0: cy + oy, scale, baseAlpha, view,
        // The arena hangs two endlessly-repeating yoyo tweens off each puff (a slow positional
        // drift and a scale/alpha breathe). A card can't afford ~150 live tweens, so the same two
        // motions ride the loop clock as sine waves with the same period range and per-puff
        // stagger — visually the same roil, zero tween objects.
        driftAng: Math.random() * Math.PI * 2,
        driftDist: r * (0.5 + Math.random() * 0.6),
        driftMs: 2200 + Math.random() * 2000,
        driftPhase: Math.random() * Math.PI * 2,
        breatheMs: 1000 + Math.random() * 1100,
        breathePhase: Math.random() * Math.PI * 2,
      });
    }
  }

  _stepSmoke() {
    // Fade in as it's deployed, hold for the burst window, dissipate over the settle tail.
    const IN = 300;
    let env = 0;
    if (this.t >= 0) {
      if (this.t < IN) env = this.t / IN;
      else if (this.t < this.activeMs) env = 1;
      else if (this.t < this.activeMs + this.settleMs) env = 1 - (this.t - this.activeMs) / this.settleMs;
    }
    env *= this._loopAlpha();
    for (const p of this._puffs) {
      const drift = Math.sin((this.t / p.driftMs) * Math.PI * 2 + p.driftPhase);
      const breathe = (Math.sin((this.t / p.breatheMs) * Math.PI * 2 + p.breathePhase) + 1) / 2;
      p.view.setPosition(p.x0 + Math.cos(p.driftAng) * p.driftDist * drift,
        p.y0 + Math.sin(p.driftAng) * p.driftDist * drift);
      // Same envelope the arena tweens between, read from the shared `SMOKE_BREATHE` bounds so a
      // density retune moves both surfaces: `breathe` runs 0..1, 0 = full alpha / smallest scale.
      p.view.setScale(p.scale * (SMOKE_BREATHE.scaleMin + breathe * (SMOKE_BREATHE.scaleMax - SMOKE_BREATHE.scaleMin)));
      p.view.setAlpha(p.baseAlpha * (1 - breathe * (1 - SMOKE_BREATHE.alphaFloorFrac)) * env);
    }
  }

  _destroySmoke() {
    for (const p of this._puffs) p.view.destroy();
    this._puffs.length = 0;
  }

  // ── EMP Trap: the real scatter, the real node visual (#628) ─────────────────────────────────

  // The cast. This is `plantEmpTraps` (scenes/arena/abilities.js) with the same arithmetic, in card
  // px: `trapCount` traps spread evenly around a full circle from a random start angle, each with
  // the same +/-20%-of-a-step jitter, at a random distance in the registry's own scatter band. Same
  // opening flash too — `empCastRings` is what `_impactFx` plays for the cast (see art/abilityFx.js).
  _scatterTraps() {
    const { cx, cy } = this.stage;
    const count = this.def.trapCount ?? 5;
    const step = (Math.PI * 2) / count;
    const base = Math.random() * Math.PI * 2;
    this._traps = [];
    this._empFired = false;
    for (let i = 0; i < count; i++) {
      const a = base + i * step + (Math.random() - 0.5) * step * 0.4;
      const d = this.pxScatterMin + Math.random() * (this.pxScatterMax - this.pxScatterMin);
      this._traps.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d });
    }
    this._pushRings(cx, cy, empCastRings(), { scale: this.fxScale });
  }

  // The discharge, once per loop, when the traps' hold window is up. A real trap fires when an
  // enemy walks into it and there are no enemies on a card, so this is the one invented beat on
  // this preview — deliberately built from the ability's OWN data (the shared `aoeBlastRings` spec
  // at the trap's real `hazardRadius`, in the trap's real colour) rather than from a new look, and
  // deliberately at the END of the hold so what the card mostly shows is traps sitting armed, which
  // is what the ability mostly does.
  _stepEmpTraps() {
    if (this._empFired || !this._traps.length) return;
    if (this.t < this.activeMs + this.settleMs) return;
    this._empFired = true;
    const r = Math.max(EMP_BLAST_MIN_PX, this.pxHazardRadius);
    for (const t of this._traps) this._pushRings(t.x, t.y, aoeBlastRings(r, EMP_TRAP_COLOR));
    this._traps = [];
  }

  // Every live trap's armed warning light, straight through the arena's own `drawMineNode`. Drawn
  // into the card's shared fxG (above the caster) rather than into a ground layer of its own the way
  // the arena's hazards sit below every unit: the scatter puts the ring of traps clear of the mech
  // in the middle, so nothing is occluded, and a second Graphics per card for five dots isn't worth
  // the object. The pulse rides the scene clock, so the whole ring throbs in lockstep exactly as a
  // freshly-planted arena scatter does.
  _drawTraps(g, alpha) {
    if (!this._traps.length) return;
    const now = this.scene.time?.now ?? this.t;
    const r = Math.max(EMP_NODE_MIN_PX, this.pxHazardRadius);
    for (const t of this._traps) drawMineNode(g, t.x, t.y, r, EMP_TRAP_COLOR, now, this.fxScale, alpha);
  }

  // ── Draw ────────────────────────────────────────────────────────────────────────────────────

  // A soft cross-fade over the loop seam so the reset (the caster snapping back to its start,
  // the squad vanishing) doesn't read as a glitch.
  _loopAlpha() {
    if (this.t < 0) return 0;
    // Deliberately asymmetric: the fade-IN is barely there, because several effects (Shield
    // Burst's flash, Jump Blast's launch pop) fire on the very first frame and dimming those
    // would be dimming the whole point of the card. The fade-OUT is what actually matters — it
    // covers the reset, where the caster jumps back to its start and the squad vanishes.
    if (this.t < LOOP_FADE_IN_MS) return this.t / LOOP_FADE_IN_MS;
    const toEnd = this.cycleMs - this.t;
    return toEnd < LOOP_FADE_OUT_MS ? toEnd / LOOP_FADE_OUT_MS : 1;
  }

  draw(g) {
    if (!this.stage) return;
    const a = this._loopAlpha();
    const { cx, cy } = this.stage;

    // Where the caster is right now: a movement burst carries it, everything else stays put.
    let px = cx, py = cy;
    if (this.pxTravel > 0) {
      const f = clamp(this.travelMs > 0 ? this.t / this.travelMs : 1, 0, 1);
      px = cx - this.pxTravel / 2 + this.pxTravel * f;
    }

    // #612: the caster is real sprites, not vector work, so it's posed/faded before the alpha
    // early-out below — at a <= 0 it has to be actively HIDDEN, where a Graphics simply isn't drawn.
    // #628: the drone squad is real sprites now too, and hides on the same terms.
    this._updateCaster(a, px, py);
    this._updateDroneViews(a);
    if (a <= 0) return;

    if (this.effect === 'antiMissile') this._drawEnvelope(g, a);

    for (const p of this._rounds) {
      drawProjectileBody(g, p.x, p.y, p.angle, p.kind, p.color, (p.scale || 1) * 0.7, p.dist);
    }

    if (this.effect === 'empTrap') this._drawTraps(g, a);

    for (const f of this._fx) {
      if (f.bolt && f.age < 70) {
        g.lineStyle(1.5, INTERCEPT_BOLT_COLOR, 0.85 * a).lineBetween(f.bolt.x, f.bolt.y, f.x, f.y);
      }
      drawFxRings(g, f.x, f.y, f.rings, f.age, f.scale);
    }

    // Recharge sweep during the rest gap — a "this ability is coming back" beat, deliberately NOT
    // scaled to the real cooldown (see the header).
    const restStart = this.activeMs + this.settleMs;
    if (this.t >= restStart) {
      const f = (this.t - restStart) / REST_MS;
      // Just outside the mech, wherever the mech ended up — same relationship the chip's own
      // 2.6x sweep had to it.
      const r = this.casterR * 1.5;
      g.lineStyle(1, this.accent, 0.45 * a);
      g.beginPath();
      g.arc(px, py, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f);
      g.strokePath();
    }
  }

  // ── The caster (#612): the player's real mech, where the chip used to be ────────────────────

  // Pose/fade the caster's sprites for this frame. Everything else on a card is vector work into
  // one Graphics, so this is the only per-frame sprite bookkeeping — and for the six abilities that
  // don't move the caster, `CasterMech.place` early-outs on an unchanged position.
  _updateCaster(alpha, x, y) {
    if (!this.caster) return;
    if (alpha <= 0) {
      this.caster.setVisible(false);
      for (const gh of this.ghosts) gh.setVisible(false);
      this.cloak?.hide();
      return;
    }
    this.caster.place(x, y, this.casterPx);
    this._updateDashGhosts(alpha);
    if (this.effect === 'cloak') { this._updateCloak(alpha, x, y); return; }
    this.caster.setVisible(true);
    this.caster.setAlpha(alpha);
  }

  // Cloak, for real (see the header and ui/casterMech.js). The mech's own greyed, flattened,
  // CLOAK_ALPHA-dimmed image takes over from the coloured one — a short cross-dissolve at each edge
  // rather than the arena's hard swap, purely because a card loops this every few seconds and a
  // snap reads as a glitch there in a way it doesn't on a deliberate button press.
  _updateCloak(alpha, x, y) {
    const IN = 200;
    let f = 0;
    if (this.t >= 0 && this.t < this.activeMs) {
      f = this.t < IN ? this.t / IN
        : this.t > this.activeMs - IN ? Math.max(0, (this.activeMs - this.t) / IN) : 1;
    }
    if (f <= 0) {
      this.cloak.hide();
      this.caster.setVisible(true);
      this.caster.setAlpha(alpha);
      return;
    }
    // Baked here, not at layout: a card scrolled past and never drawn never pays for a flatten.
    const rt = this.cloak.ensure(this.casterLayer);
    rt.setPosition(x, y);
    rt.setVisible(true);
    rt.setAlpha(alpha * CLOAK_ALPHA * f);
    // The coloured mech fades out UNDER the incoming ghost and is gone entirely at full cloak, so
    // what's left is one flattened image at one alpha — the state cloakFlatten.js exists to reach.
    this.caster.setVisible(f < 1);
    this.caster.setAlpha(alpha * (1 - f));
  }

  // Dash has no arena FX of its own, so the trail IS the read: the mech itself, ghosted along the
  // path it has actually covered so far this burst.
  _updateDashGhosts(alpha) {
    if (!this.ghosts.length) return;
    const { cx, cy } = this.stage;
    const active = this.t >= 0 && this.t <= this.travelMs;
    const f = active ? clamp(this.t / this.travelMs, 0, 1) : 0;
    for (let i = 0; i < this.ghosts.length; i++) {
      const gh = this.ghosts[i];
      const gf = f - (i + 1) * this.ghostGapFrac;
      if (!active || gf <= 0) { gh.setVisible(false); continue; }
      gh.place(cx - this.pxTravel / 2 + this.pxTravel * gf, cy, this.casterPx);
      gh.setVisible(true);
      gh.setAlpha(alpha * DASH_GHOST_ALPHA * (1 - i / this.ghosts.length));
    }
  }

  // #628 removed `_drawDrones` — the vector "rotor chip" (an accent dot with two crossed spinning
  // lines) that stood in for a drone through #534. The squad is the real Recon Drone airframe now;
  // see `_buildDrones`/`_updateDroneViews` above and this module's header.

  // The ability's real `range`, drawn as the point-defense envelope everything inside gets shot
  // down within.
  _drawEnvelope(g, alpha) {
    const { cx, cy } = this.stage;
    g.lineStyle(1, 0x5ec8e0, (this._active ? 0.5 : 0.16) * alpha).strokeCircle(cx, cy, this.pxRange);
  }

  destroy() {
    this._destroySmoke();
    this.cloak?.destroy();
    this.caster?.destroy();
    for (const gh of this.ghosts) gh.destroy();
    this.ghosts.length = 0;
    // #628: the squad's sprite stacks. `this.layer.destroy()` below would take them with it (they're
    // parented into droneLayer), but they're released explicitly for the same reason the caster and
    // the puffs are — this class owns them, so it disposes of them rather than relying on a parent.
    for (const v of this._droneViews) v.destroy();
    this._droneViews.length = 0;
    this.layer.destroy();
    this._fx.length = 0;
    this._rounds.length = 0;
    this._drones.length = 0;
    this._traps.length = 0;
    this.stage = null;
  }
}
