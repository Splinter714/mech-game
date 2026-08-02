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
//   droneLauncher   REAL COUNT + REAL MOVEMENT, stand-in art. The squad size is `randomDroneCount`
//                   and every drone is flown by the real `stepFriendlyDroneOrbit` on the real
//                   `FRIENDLY_DRONE_TUNING` (scaled to card px), so the swarm churns/separates/
//                   leashes exactly like the summoned one. They draw as small rotor chips rather
//                   than the real Recon Drone airframe: at a card's scale the airframe is ~3px of
//                   mush, and baking a whole vehicle texture set per catalog would cost far more
//                   than the read is worth.
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
//   * the REST between loops is a short fixed gap, not the ability's real 4-15s cooldown, which
//     would leave a card blank for most of its life. A thin sweeping arc around the caster during
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
import { randomDroneCount, stepFriendlyDroneOrbit, FRIENDLY_DRONE_TUNING } from '../data/friendlyDroneAI.js';
import { MEDIUM_PLAYER_CONFIG } from '../data/chassis/player/mediumPlayer.js';
import { drawProjectileBody } from '../art/index.js';
import { aoeBlastRings, interceptRings, ringsDuration, drawFxRings, INTERCEPT_BOLT_COLOR } from '../art/abilityFx.js';
import { ensureSmokeTextures, smokePuffLayout, smokePuffScale } from '../art/smokePuff.js';
import { CasterMech, CasterCloak, CASTER_WORLD_PX, CASTER_BODY_FRAC, CLOAK_ALPHA } from './casterMech.js';

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

// How much WORLD space this ability's effect occupies — the largest of whatever spatial numbers
// its registry entry actually carries.
export function previewExtent(def) {
  return Math.max(
    def.range ?? 0,
    def.radius ?? 0,
    burstDistance(def),
    def.effect === 'droneLauncher' ? FRIENDLY_DRONE_TUNING.leashRadius : 0,
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
    // Two bands inside it, in the arena's own depth order: smoke is ground FX, the mech standing in
    // it draws over it. (The card's fxG — blasts, drones, rounds — is above both.)
    this.smokeLayer = scene.add.container(0, 0);
    this.casterLayer = scene.add.container(0, 0);
    this.layer.add([this.smokeLayer, this.casterLayer]);

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
    // blast fires on the deactivate edge, Smoke Screen's cloud fades out.
    this.settleMs = this.effect === 'jumpBlast' ? ringsDuration(aoeBlastRings(1, 0)) + 60
      : this.effect === 'smokeScreen' ? 420 : 0;
    this.cycleMs = this.activeMs + this.settleMs + REST_MS;

    this.t = -((index * 230) % REST_MS);   // negative = still waiting for its first loop
    this._active = false;
    this._fx = [];        // transient ring sets: { x, y, rings, scale, age, life, bolt }
    this._rounds = [];    // Anti-Missile: live incoming rounds (real delivery-sim projectiles)
    this._drones = [];    // Drone Launcher: live squad (real friendlyDroneAI state)
    this._puffs = [];     // Smoke Screen: stamped Images + their per-puff animation phases
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
    this._placeCaster();
    this._buildSmoke();
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

  // ── Drone Launcher: the real squad size, flown by the real orbit AI ─────────────────────────

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

  // Built ONCE per layout (not per loop) — re-scattering every few seconds would churn ~25
  // GameObjects for no visible gain, since the loop only re-runs the fade envelope.
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
        // drift and a scale/alpha breathe). A card can't afford ~50 live tweens, so the same two
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
      p.view.setScale(p.scale * (0.8 + breathe * 0.5));
      p.view.setAlpha(p.baseAlpha * (1 - breathe * 0.6) * env);
    }
  }

  _destroySmoke() {
    for (const p of this._puffs) p.view.destroy();
    this._puffs.length = 0;
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
    this._updateCaster(a, px, py);
    if (a <= 0) return;

    if (this.effect === 'antiMissile') this._drawEnvelope(g, a);

    for (const p of this._rounds) {
      drawProjectileBody(g, p.x, p.y, p.angle, p.kind, p.color, (p.scale || 1) * 0.7, p.dist);
    }

    if (this.effect === 'droneLauncher') this._drawDrones(g, a);

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

  _drawDrones(g, alpha) {
    // A drone is a fraction of the mech it escorts — the same relationship the chip's own 0.55x
    // drone had to it, restated against the mech that replaced the chip.
    const r = Math.max(1.6, this.casterR * 0.28);
    for (const d of this._drones) {
      g.fillStyle(this.accent, 0.9 * alpha).fillCircle(d.x, d.y, r * 0.55);
      // Two crossed rotor arms spun by the same rate the arena spins the real airframe's blur.
      g.lineStyle(1, this.accent, 0.55 * alpha);
      for (let k = 0; k < 2; k++) {
        const a = d.rotorSpin + k * Math.PI / 2;
        g.lineBetween(d.x - Math.cos(a) * r, d.y - Math.sin(a) * r, d.x + Math.cos(a) * r, d.y + Math.sin(a) * r);
      }
    }
  }

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
    this.layer.destroy();
    this._fx.length = 0;
    this._rounds.length = 0;
    this._drones.length = 0;
    this.stage = null;
  }
}
