// Arena firing mixin — turning a trigger pull into shots: per-slot/ability handling pulled
// out of update(), the fire dispatch (hitscan beam / melee swing / travelling round), and
// the per-shot helpers (cadence, range falloff, ability activation). Methods use `this`
// (the ArenaScene); composed onto the prototype via Object.assign.
import { CATEGORIES } from '../../data/categories.js';
import { planEmissions, makeProjectile, arrivalSpeedMultiplier, homingTurnRate, arcMaxDist } from '../../data/delivery.js';
import { traceHitscan } from '../../data/beamTrace.js';
import { canFireWeapon } from '../../data/targetlock.js';
import { drawSlash } from '../../art/index.js';
import { Audio } from '../../audio/index.js';
import { TRAJECTORY_DELAY, hasHeldSfx, WEAPON_TRAJECTORY_SOUNDS_ENABLED } from '../../audio/sfxParams.js';
// #224 (temporary): WEAPON_TRAJECTORY_SOUNDS_ENABLED gates the in-flight trajectory loop
// below — see sfxParams.js for the full list of gated call sites and how to revert.
import { scheduleFireCues } from '../../audio/fireCues.js';
import { updateSprintFuel, SPRINT_FUEL_MAX } from '../../data/sprint.js';
import { triggerDash, updateDash, DASH_COOLDOWN } from '../../data/dash.js';
import { targetHexKeyOf } from './shared.js';

export const FiringMixin = {
  // ── Per-slot firing ── each skill slot (body location) has its own button; a held button
  // auto-fires that location's weapon at its own cadence, gated by ammo. ──
  _handleFiring(intent, delta) {
    this._heldAudio ??= {};
    // Stamp the frame we read the fire input, so the SFX latency debug (window.__sfxDebug)
    // can measure our code-path cost from here to the audio node's start().
    Audio.markTrigger();
    for (const w of this.mech.weapons()) {
      let cd = (this.fireCooldowns[w.location] ?? 0) - delta;
      if (intent.fire[w.location] && cd <= 0 && w.ready) {
        this.fireWeapon(w);
        cd = this._fireInterval(w.weapon);
      }
      this.fireCooldowns[w.location] = Math.max(0, cd);

      // Continuous beam visual tracking (#86): a held sustained/stream hitscan (the beam
      // laser) only re-pins its beam line on the block above, which runs at the WEAPON's own
      // fire cadence (e.g. 20Hz) — well below the render frame rate. That made the beam step
      // between angles as the turret swept instead of following it smoothly. This runs every
      // render frame regardless of cadence and re-aims the beam's existing line at the current
      // muzzle/angle; it's purely visual — damage still only applies on the cadence above.
      if (intent.fire[w.location] && w.ready && this._isHeldBeam(w.weapon)) this._trackHeldBeam(w);

      // Held/looping fire sound (#53): a genuinely continuous weapon (flamethrower/beam
      // laser, hasHeldSfx) starts its loop on the rising edge (button just pressed) and
      // stops it on the falling edge — button released, OR the weapon ran dry / went
      // offline while held (ammo depleted, part destroyed).
      const held = intent.fire[w.location] && w.ready && hasHeldSfx(w.weapon.id);
      const wasHeld = this._heldAudio[w.location];
      if (held && !wasHeld) Audio.startHeld(w.location, w.weapon.id);
      else if (!held && wasHeld) Audio.stopHeld(w.location);
      this._heldAudio[w.location] = held;
    }
  },

  // ── Sprint (#188, player-trigger removed by #261) ── the Sprint state machine
  // (data/sprint.js) itself is UNCHANGED — it's still a depleting/regenerating fuel bar that
  // drains while active and refills while inactive, hitting empty forces it off. What's gone is
  // the player's own means of turning it on: #261 replaced L3/Space's player-facing ability with
  // a Dash (see `_handleDash` below and data/dash.js) and removed manual Sprint entirely. The
  // ONLY thing that can still set `this.sprint.active` is Overclock's force-activation, so this
  // method now purely owns that handoff — no more per-device toggle/hold branches driven by
  // player input.
  //
  // #189: Overclock force-activates Sprint, fuel-free, for its whole duration. State machine:
  // `this._sprintForcedByOverclock` tracks whether the mech's CURRENT sprint-active state is
  // "because Overclock is holding it on", and `this._overclockWasActive` remembers last frame's
  // buff state so activation is detected as a genuine RISING EDGE (false→true).
  //   - Rising edge of Overclock claims Sprint: force `active = true` and set the flag,
  //     REGARDLESS of prior state/fuel — Overclock ignores fuel entirely while it owns the
  //     state (fuel-free by design, see data/powerups.js).
  //   - While the flag is set and Sprint is active, fuel math is skipped entirely (not just
  //     zero-drain) — `updateSprintFuel` would otherwise force `active` back to false on a
  //     0-fuel mech via its own empty-tank floor check, even with drainRate 0.
  //   - If Overclock's duration ends while the flag is STILL set, hand control back exactly as
  //     if Overclock had never touched Sprint: force it off (there's no player-manual state to
  //     fall back to any more — see sprintOverclock.test.js for the coverage that remains).
  _handleSprint(_intent, delta) {
    const dt = delta / 1000;
    const overclockActive = !!this._buffMods?.().overclockActive;
    const overclockRisingEdge = overclockActive && !this._overclockWasActive;
    this._overclockWasActive = overclockActive;

    if (overclockRisingEdge) {
      this.sprint.active = true;
      this._sprintForcedByOverclock = true;
    }

    // Free ride only while Overclock is the reason Sprint is currently on — skip the fuel
    // state machine entirely rather than passing drainRate: 0, since updateSprintFuel's
    // empty-tank check (`fuel <= 0 ⇒ active = false`) fires independent of drain rate.
    const wasActive = this.sprint.active;
    if (!(this._sprintForcedByOverclock && this.sprint.active)) {
      this.sprint = updateSprintFuel(this.sprint, dt);
    }

    // Overclock's window closed — hand it back off (no player-manual sprint left to defer to).
    if (!overclockActive && this._sprintForcedByOverclock) {
      this.sprint.active = false;
      this._sprintForcedByOverclock = false;
    }

    // A cue on every real active/inactive transition — Overclock's auto-activation or its
    // expiry handoff.
    if (this.sprint.active && !wasActive) Audio.ui('sprintOn');
    else if (!this.sprint.active && wasActive) Audio.ui('sprintOff');
    this.registry.set('sprintActive', this.sprint.active);
    this.registry.set('sprintFuel', this.sprint.fuel);
    this.registry.set('sprintFuelMax', SPRINT_FUEL_MAX);
  },

  // ── Dash (#261) ── a hardcoded, always-available ability on L3/Space — replaces the old
  // player-facing Sprint. `intent.dashPressed` is already rising-edge-detected by Controls.js
  // (one edge per physical press, on whichever device is currently active), so a single press
  // triggers one burst; pressing again mid-burst or mid-cooldown is a no-op (`triggerDash`
  // itself is a no-op in that case — see data/dash.js). The pure state machine
  // (active/burstRemaining/cooldown) lives entirely in data/dash.js; this just wires the press
  // + per-frame tick and publishes the live state for the HUD's cooldown indicator.
  _handleDash(intent, delta) {
    const dt = delta / 1000;
    const wasActive = this.dash.active;
    if (intent.dashPressed) this.dash = triggerDash(this.dash);
    this.dash = updateDash(this.dash, dt);

    // Reuse the existing sprint-on/off cues for the dash's start/end — same "movement ability
    // just engaged/disengaged" cue language, no new SFX plumbing needed for a ~0.2s burst.
    if (this.dash.active && !wasActive) Audio.ui('sprintOn');
    else if (!this.dash.active && wasActive) Audio.ui('sprintOff');

    this.registry.set('dashActive', this.dash.active);
    this.registry.set('dashCooldown', this.dash.cooldown);
    this.registry.set('dashCooldownMax', DASH_COOLDOWN);
  },

  // Milliseconds between shots for a weapon: stream weapons use their fire rate, the
  // rest use their cycle time (with a small floor so nothing fires every frame). #60
  // Overdrive scales the interval down (cycleMult < 1 ⇒ faster). This is used by the PLAYER
  // firing path and the enemy firing path alike; enemies pass `mods` explicitly (they have no
  // powerups, so the identity), while the player omits it and picks up the live buff overlay.
  _fireInterval(weapon, mods = this._buffMods?.()) {
    const cycleMult = mods?.cycleMult ?? 1;
    if (weapon.delivery.pattern === 'stream' && weapon.delivery.fireRate > 0) {
      return (1000 / weapon.delivery.fireRate) * cycleMult;
    }
    return Math.max(120 * cycleMult, weapon.cycleTime * cycleMult);
  },

  // Fire one weapon. Hitscan/contact resolve instantly (a beam); projectile weapons
  // spawn travelling rounds that respect velocity, arc, and spread.
  fireWeapon(w) {
    if (!this.scene.isActive()) return;
    // #77, rework #252: a tracking (homing) weapon with no lock (i.e. convergence currently has
    // no target at all) does not fire — no dumbfire fallback. The trigger pull is a no-op: nothing
    // spawns, no ammo spent, no cooldown-worthy shot actually happened. See data/targetlock.js
    // `canFireWeapon` for exactly which deliveries this gates (only guidance: 'homing' —
    // direct-fire and dumbfire/arcing-lob weapons are unaffected).
    if (!canFireWeapon(w.weapon, this.lock)) return;
    // #316 reverses #245/#257: there used to be a cover exemption here — when the player's
    // convergence pick was a FLYING enemy, the player's shot ignored terrain cover (mirroring
    // #245, which let a flyer's own shots ignore it). Both directions are gone. Cover is cover
    // for everyone: the player's rounds stop on a wall whether the thing they're aimed at flies
    // or not, and a flyer's rounds do the same. There is no per-shot cover-exemption flag left in
    // this file — the wall trace / in-flight wall check below run unconditionally.
    const mods = this._buffMods?.() ?? {};
    // #60 Overcharge: while active, weapons don't spend ammo (freeAmmo). Otherwise spend a
    // shot's worth, scaled by cycleMult (#235): Overdrive's cycleMult 0.5 halves the fire
    // interval (shots go out ~2x as often), so scaling consumption by the same factor spends
    // 0.5 ammo/shot — exactly offsetting the faster rate for a net-neutral ammo economy,
    // distinct from Overcharge's true unlimited ammo. Outside Overdrive cycleMult is 1, so
    // this is the same flat 1-ammo spend as before.
    if (!mods.freeAmmo) this.mech.consumeAmmo(w.location, w.index, mods.cycleMult ?? 1);
    // #103 noise-aggro: a real shot just went off at the player's position — unaware enemies
    // within NOISE_AGGRO_RANGE of this instant become AWARE (see data/awareness.js), regardless
    // of line-of-sight. Just a timestamp + position; enemies.js reads it each frame.
    this._lastFireAt = this.time.now;
    this._lastFireX = this.px;
    this._lastFireY = this.py;

    // The shared delivery sim decides what one trigger pull emits (single / spread fan /
    // tight cluster / multi-pulse burst); each emission is realised from the live muzzle
    // and aim so a slewing turret and aim-assist still apply per sub-shot.
    // #137 Barrage: `countMult` (2 while active) scales the weapon's delivery.count, so one
    // trigger pull emits twice as many things — a wider fan, more parallel lanes, a longer
    // burst — through each pattern's own existing expansion. Outside Barrage it's 1, i.e. the
    // exact plan as before. (Ammo is spent per trigger pull above, not per emitted shot.)
    const plan = planEmissions(w.weapon, { countMult: mods.countMult ?? 1 });
    // #307: a held continuous beam keeps one persistent beam object PER LANE (see
    // `_fireHitscan`). When Barrage expires mid-hold the plan drops from n lanes back to 1, so
    // retire any beam whose lane no longer exists rather than leaving it hanging in place
    // (it would otherwise sit frozen at its last position until its ttl ran out).
    if (plan.mode === 'hitscan' && this._isHeldBeam(w.weapon)) {
      this._retireStaleBeamLanes('player', w.location, plan.shots.length);
    }
    // The fire + trajectory AUDIO cues (t=0 cue, per-burst-pulse retriggers, and the
    // trajectory beat) are scheduled in one shared place (audio/fireCues.js) that the Weapon
    // Lab preview calls too, so their timing can't drift; the arena always plays (audible:
    // true). Held/looping weapons (flamethrower/beam laser) get their sound from their loop
    // instead — scheduleFireCues no-ops for them, as it does for the delay:0-only case.
    scheduleFireCues(this, w.weapon, plan, true);
    for (const [lane, s] of plan.shots.entries()) {
      const go = () => {
        if (!this.scene.isActive()) return;
        const m = this._muzzle(w.location);
        const aimAngle = this._fireAngle(w, m);
        const baseAngle = aimAngle + s.angleOffset;
        const perp = baseAngle + Math.PI / 2;
        const ox = m.x + Math.cos(perp) * s.lateral, oy = m.y + Math.sin(perp) * s.lateral;
        // #320: the muzzle ended up on the far side of a standing span from the mech's own chest —
        // the "shoot OVER walls if I stand real close" case. The round would otherwise spawn past
        // the barrier and fly off unblocked. The shot is spent (ammo was consumed at plan time and
        // the fire cue already played), it just doesn't come out — which reads as the wall
        // stopping it. See world.js `_muzzleWallBlocked` for why this guards rather than
        // re-origins the ray. Checked from the LATERAL muzzle actually used, so one lane of a
        // spread can be eaten by a wall corner while its siblings get out.
        if (this._muzzleWallBlocked?.(this.px, this.py, ox, oy)) return;
        if (plan.mode === 'contact') this._melee(w, ox, oy, baseAngle);
        // #307: `lane`/`lateral` let a continuously-held beam own ONE persistent beam object
        // PER PARALLEL LANE — under Barrage the beam laser plans 2 lanes, and without this
        // both lanes shared a beam key so the second silently overwrote the first's endpoints
        // (two shots fired, one line drawn).
        else if (plan.mode === 'hitscan') this._fireHitscan(w, ox, oy, baseAngle, 'player', 'player', false, { lane, lateral: s.lateral });
        else {
          // Pass the weapon's un-offset aim angle (aimAngle) alongside this shot's actual
          // launch angle (baseAngle) — see _spawnProjectile's arcing maxDist comment for why
          // a wide-fan shot (Swarm Rack) needs the CENTRE bearing for its target-ahead test.
          const round = this._spawnProjectile(w, ox, oy, baseAngle, 'player', s.angleOffset, null, aimAngle);
          // Continuous in-flight sound (#56): only weapons with a `trajectory` stage defined
          // (missiles, plasma, napalm) get this — the delayed start doubles as the existing
          // "beat after launch" timing feel. The round is mutable and lives in
          // this.projectiles, so it's safe to attach the stop closure to it once the timer
          // fires; but the round may already have impacted/hit a wall by then (a very short/
          // close shot), so guard against starting an orphaned loop on a dead round.
          // #224 (temporary): trajectory loop start disabled, see WEAPON_TRAJECTORY_SOUNDS_ENABLED.
          if (WEAPON_TRAJECTORY_SOUNDS_ENABLED && Audio.getSfxParams(w.weapon.id).trajectory) {
            this.time.delayedCall(TRAJECTORY_DELAY, () => {
              if (round.dead) return;
              round.stopTrajectorySfx = Audio.startTrajectoryLoop(w.weapon.id);
            });
          }
        }
      };
      if (s.delay > 0) this.time.delayedCall(s.delay, go); else go();
    }
  },

  // Melee swing: same forward-ray hit detection as a beam, but drawn as a sweeping
  // crescent (shared drawSlash art) instead of a straight line. `owner` (#117) generalizes
  // this for an ENEMY mech's melee/contact weapons: the player sweeps against `this.enemies`
  // and damages via `_damageEnemyAt`; an enemy sweeps against the single player point and
  // damages via `_damagePlayerAt` — same forward-ray math either way, just a different
  // target set/damage sink.
  _melee(w, mx, my, angle, owner = 'player') {
    const reach = w.weapon.range.max || 32;
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    let target = null, t = 0;
    if (owner === 'enemy') {
      if (!this.mech.isDestroyed()) {
        const ex = this.px - mx, ey = this.py - my;
        const tt = ex * dirX + ey * dirY, perp = Math.abs(ex * dirY - ey * dirX);
        if (tt > 0 && tt < reach && perp < 44) { target = 'player'; t = tt; }
      }
    } else {
      for (const e of this.enemies) {
        if (e.mech.isDestroyed()) continue;
        const ex = e.x - mx, ey = e.y - my, tt = ex * dirX + ey * dirY, perp = Math.abs(ex * dirY - ey * dirX);
        if (tt > 0 && tt < reach && perp < 44 && (!target || tt < t)) { target = e; t = tt; }
      }
    }
    const color = CATEGORIES[w.weapon.category]?.color ?? 0xcfd6e0;
    if (target) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      if (owner === 'enemy') this._damagePlayerAt(dmg);
      else this._damageEnemyAt(target, mx + dirX * t, my + dirY * t, dmg, color);
    }
    // Animate the crescent across a few frames, then clear.
    for (const tt of [0.15, 0.45, 0.8]) {
      this.time.delayedCall(tt * 150, () => {
        if (!this.scene.isActive()) return;
        this.fx.clear(); drawSlash(this.fx, mx, my, angle, tt, color, 1, reach + 8);
      });
    }
    this.time.delayedCall(170, () => this.fx.clear());
  },

  // Damage multiplier vs. distance: full out to `opt`, falling to ~0.3 at `max` and a
  // touch beyond; below `min` (an arming distance, e.g. missiles) it's reduced too.
  _rangeFactor(range, dist) {
    if (!range) return 1;
    const { min = 0, opt = 0, max = 0 } = range;
    if (min > 0 && dist < min) return 0.4 + 0.6 * (dist / min);
    if (dist <= opt || max <= opt) return 1;
    const t = Math.min(1.2, (dist - opt) / (max - opt));
    return Math.max(0.2, 1 - 0.7 * t);
  },

  // A hitscan weapon held as one continuous beam rather than discrete flickers/pulses
  // (currently just the beam laser). Shared by the damage-tick resolve below and the
  // per-frame visual tracker (#86).
  _isHeldBeam(weapon) {
    return weapon.delivery.hit === 'hitscan' && (weapon.delivery.sustained || weapon.delivery.pattern === 'stream');
  },

  // Enemies as the plain {x,y,destroyed} shape traceHitscan expects, with the live enemy
  // object attached so callers can recover it from the returned target.
  _liveEnemiesForTrace() {
    return this.enemies
      .filter((e) => !e.mech.isDestroyed())
      .map((e) => ({ x: e.x, y: e.y, destroyed: false, ref: e }));
  },

  // #117: same shape as `_liveEnemiesForTrace`, but for an ENEMY's hitscan shot — the player
  // is the only possible target, represented as a one-item candidate list so `traceHitscan`
  // (which only knows about a generic {x,y,destroyed,ref} candidate array) doesn't need to
  // know who's shooting at whom.
  _liveTargetsForTrace(owner) {
    if (owner === 'enemy') {
      return this.mech.isDestroyed() ? [] : [{ x: this.px, y: this.py, destroyed: false, ref: 'player' }];
    }
    return this._liveEnemiesForTrace();
  },

  // How far a beam/wall-blocked ray from `muzzle` at `angle` actually reaches, honoring cover.
  // #72 own-hex transparency: the muzzle's own hex (firing OUT of forest) and any living
  // enemy's hex (a target standing IN forest) don't block the beam — only deeper soft cover
  // and solid walls do.
  // #269: `smallUnitInvolved` (optional) — see world.js `_isWall`; a caller shooting FOR a live
  // enemy should pass `isSmallUnit(e)` so this hot path is ready once the size tier lands.
  // #310 `ignoreSpanKey`: the shooter's own wall span, for a wall turret firing off the centreline
  // it is mounted on — see wallEdges.js `wallEdgeCrossing`'s `ignoreKey`. Null for every other
  // shooter, so no one else's beam gains a way through a wall.
  _hitscanReach(muzzleX, muzzleY, angle, endDist, smallUnitInvolved = false, ignoreSpanKey = null) {
    const transparent = new Set([this._hexKeyAt(muzzleX, muzzleY), this._hexKeyAt(this.px, this.py)]);
    for (const e of this.enemies) if (!e.mech.isDestroyed()) transparent.add(this._hexKeyAt(e.x, e.y));
    return this._wallDistance(muzzleX, muzzleY, angle, endDist, transparent, smallUnitInvolved, ignoreSpanKey);
  },

  // Re-aim a held continuous beam's existing line at the current muzzle/angle, every render
  // frame while the trigger is held — independent of the weapon's own (much slower) fire
  // cadence, which only governs damage ticks via fireWeapon/_fireHitscan. Purely visual: no
  // damage, no ammo, no impact fx. If no fire tick has created the beam yet (the very first
  // frame it's held), there's nothing to reposition — fireWeapon creates it.
  // #307: under Barrage this location may own SEVERAL parallel lanes, so re-pin every one of
  // them, each from its own laterally-offset muzzle (the `lateral` the fire tick stamped on it).
  // With no Barrage there's exactly one lane (lateral 0) and this is the original single-beam
  // reposition, unchanged.
  _trackHeldBeam(w) {
    const prefix = `player:${w.location}:`;
    const lanes = this.beams.filter((b) => typeof b.loc === 'string' && b.loc.startsWith(prefix));
    if (!lanes.length) return;
    const m = this._muzzle(w.location);
    const angle = this._fireAngle(w, m);
    const perp = angle + Math.PI / 2;
    const reach = w.weapon.delivery.hit === 'contact' ? (w.weapon.range.max || 32) : 900;
    for (const live of lanes) {
      const off = live.lateral || 0;
      const mx = m.x + Math.cos(perp) * off, my = m.y + Math.sin(perp) * off;
      // #320: a HELD beam whose emitter has drifted across a span as the mech walks/slews gets
      // clamped to zero length rather than lancing out from the far side of the wall — the
      // continuous-fire counterpart of the spawn-time guard above.
      if (this._muzzleWallBlocked?.(this.px, this.py, mx, my)) {
        live.x0 = mx; live.y0 = my; live.x1 = mx; live.y1 = my;
        continue;
      }
      const trace = traceHitscan(mx, my, angle, reach, this._liveEnemiesForTrace());
      let endDist = trace.endDist;
      const wallT = this._hitscanReach(mx, my, angle, endDist);
      if (wallT < endDist) endDist = wallT;
      live.x0 = mx; live.y0 = my;
      live.x1 = mx + Math.cos(angle) * endDist;
      live.y1 = my + Math.sin(angle) * endDist;
    }
  },

  // Retire persistent beam lanes for `shooterKey`+`location` whose lane index is at or beyond
  // `laneCount` — i.e. lanes that this trigger pull no longer plans (Barrage expiring mid-hold).
  // Zeroing ttl hands them to the normal expiry path in projectiles.js, so they fade out through
  // the same spark-fade every other beam uses instead of vanishing abruptly.
  _retireStaleBeamLanes(shooterKey, location, laneCount) {
    const prefix = `${shooterKey}:${location}:`;
    for (const b of this.beams) {
      if (typeof b.loc === 'string' && b.loc.startsWith(prefix) && b.lane >= laneCount) b.ttl = 0;
    }
  },

  // `owner`/`shooterKey` (#117): generalizes the player's beam-fire path for an ENEMY mech's
  // hitscan weapons. The player fires against `this.enemies` and damages via `_damageEnemyAt`;
  // an enemy fires at the single player point and damages via `_damagePlayerAt` — everything
  // else (trace, cover-blocking, beam persistence, impact fx) is the same machinery either way.
  // `shooterKey` disambiguates the "one live continuous beam per shooter+location" lookup below
  // so two different enemies (or an enemy and the player) mounting the same weapon in the same
  // body location don't stomp each other's beam object.
  // (#245's `ignoreCover` param — a flying shooter's beam skipping the wall trace — was removed
  // by #316: cover blocks every shooter, so the wall trace below is unconditional.)
  // `smallUnitInvolved` (#269, optional): threads to the soft-cover size-tier exemption — see
  // world.js `_isWall`. Enemy callers pass `isSmallUnit(e)`; the player never does (always large).
  // `lane`/`lateral` (#307, optional): which PARALLEL LANE of the emission plan this shot is.
  // A continuously-held beam keeps one persistent beam object per lane — keyed by
  // shooter+location+lane — so Barrage's two lanes each own (and re-pin) their own line
  // instead of the second stomping the first. `lateral` is the lane's perpendicular muzzle
  // offset, remembered on the beam so `_trackHeldBeam` can re-derive that lane's own muzzle
  // every render frame. A single-lane hold is lane 0 with lateral 0 — i.e. exactly one
  // tracking object, preserving #86.
  _fireHitscan(w, muzzleX, muzzleY, angle, owner = 'player', shooterKey = 'player', smallUnitInvolved = false, { lane = 0, lateral = 0, ignoreSpanKey = null } = {}) {
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    const color = CATEGORIES[w.weapon.category]?.color ?? 0x9fe8ff;
    const reach = w.weapon.delivery.hit === 'contact' ? (w.weapon.range.max || 32) : 900;

    // Project each living target onto the firing ray (forward `t`, perpendicular miss) and
    // take the nearest one actually struck.
    const trace = traceHitscan(muzzleX, muzzleY, angle, reach, this._liveTargetsForTrace(owner));
    let target = trace.target?.ref ?? null;
    let t = trace.t;
    let hit = !!target;
    let endDist = trace.endDist;
    // Cover: a wall between muzzle and target stops the beam short. #316: no exceptions — a
    // flying shooter's beam is blocked by hard cover exactly like a ground shooter's.
    //
    // #310 (2026-07-19), ONE exception, and it is not a cover exemption: a beam aimed at a WALL
    // TURRET is not stopped by the span that turret is standing on. Since the gun was centred on
    // its wall line, muzzle-to-gun and muzzle-to-wall are the same distance from every direction,
    // and the wall test runs first — so without this the gun is literally unshootable and its
    // 200hp span becomes the only way to silence it (measured: 4x the cost, from either side).
    // #310 shipped the gun and the span as two separate health pools on purpose; this keeps them
    // that way. Scoped to the span under the thing you are actually aiming at, so it never opens a
    // lane through a wall to anything else — every other span still stops the beam dead.
    const targetSpanKey = (target && typeof target === 'object' && target.spanKey) || null;
    const wallT = this._hitscanReach(muzzleX, muzzleY, angle, endDist, smallUnitInvolved, ignoreSpanKey ?? targetSpanKey);
    let blocked = wallT < endDist;
    if (blocked) { endDist = wallT; hit = false; }
    // #317, hitscan half of the targeted-hex rule: a beam has no per-step position to test, so its
    // stopping point is solved up front. If the player's converge/lock pick is a standing
    // destructible hex and this ray enters it SHORTER than wherever the beam would otherwise end,
    // the beam terminates there instead. Without this a laser aimed at a locked forest hex passed
    // clean over it for exactly the same reason a bullet did — soft cover doesn't block a mech.
    const tHexKey = owner === 'player' ? targetHexKeyOf(this.convergeTarget) : null;
    if (tHexKey && this._destructibleStandingAt?.(tHexKey)) {
      const tt = this._targetHexDistance(muzzleX, muzzleY, angle, endDist, tHexKey);
      if (tt < endDist) { endDist = tt; hit = false; blocked = true; }
    }
    const endX = muzzleX + dirX * endDist, endY = muzzleY + dirY * endDist;

    // Persistent beam so sparks can linger after it fades. A continuously-held beam
    // (sustained/stream) keeps ONE beam object that re-pins to the muzzle each shot, so it
    // tracks the mech as it turns/moves; single-shot beams (pulse/rail) push a fresh one.
    const beamTtl = w.weapon.delivery.burst?.wubOn ?? 80;
    const heavy = w.weapon.delivery.kind === 'rail';
    const continuous = w.weapon.delivery.sustained || w.weapon.delivery.pattern === 'stream';
    const beamKey = `${shooterKey}:${w.location}:${lane}`;
    const live = continuous ? this.beams.find((b) => b.loc === beamKey) : null;
    if (live) {
      live.x0 = muzzleX; live.y0 = muzzleY; live.x1 = endX; live.y1 = endY;
      live.lateral = lateral;
      live.ttl = beamTtl;   // age keeps advancing → warble flows continuously
    } else {
      this.beams.push({ x0: muzzleX, y0: muzzleY, x1: endX, y1: endY, color, heavy, ttl: beamTtl, age: 0, loc: continuous ? beamKey : null, lane, lateral });
    }
    if (hit) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      if (owner === 'enemy') this._damagePlayerAt(dmg);
      else this._damageEnemyAt(target, endX, endY, dmg, color);
      this._impactFx(endX, endY, color, 'beam', 0, w.weapon.id);
    } else if (blocked) {
      // #317: a stopped beam now CHIPS what stopped it, exactly as a round that detonates on cover
      // has always done (projectiles.js). Before this, hitscan weapons could not damage destructible
      // terrain at ALL — no beam/laser path ever called `_damageBuildingAt`, so a blocked beam just
      // played sparks against an outpost/wall forever. That made the "shots pass over forests"
      // complaint doubly true for energy loadouts: aiming at a hex neither stopped the beam nor hurt
      // the hex. `_damageBuildingAt` routes a hit landing on a wall span to that span (#288) and
      // otherwise to the hex under the impact point, so this covers spans and tiles alike.
      // Enemy-fired beams damage terrain the same way their rounds already do — cover is cover for
      // every shooter (#316).
      // Optional chaining: plenty of tests exercise `_fireHitscan` against a bare stub scene with
      // no world mixin at all, the same way the rest of this file guards `_stopTrajectorySfx` etc.
      this._damageBuildingAt?.(endX, endY, Math.max(1, Math.round(w.weapon.damage)), { flame: false });
      this._impactFx(endX, endY, color, 'beam', 0, w.weapon.id);
    }
  },

  // `seekOverride` (#62): a fixed {x,y} aimpoint for indirect fire — the player passes the lock's
  // aim point implicitly (below); an ENEMY firing blind over cover passes the player's predicted
  // last-known position so its homing/arcing rounds lob onto it without LOS. When omitted, the
  // player derives its seek from the lock and the enemy chases the live player as before.
  // `aimAngle` (#77 follow-up): the weapon's un-offset CENTRE bearing, for weapons that fan a
  // spread of simultaneous shots (Swarm Rack) at an angleOffset off that centre — see the
  // maxDist comment below for why this must be the centre bearing, not `angle` (this shot's own
  // launch heading). Defaults to `angle` for every single-shot caller (enemies, non-spread
  // weapons), where the two are identical anyway.
  // (#245's `ignoreCover` param — stamping `ignoresCover` onto a flying enemy's round so the
  // in-flight wall check skipped it — was removed by #316: every round respects cover.)
  // `smallUnitInvolved` (#269, optional): stamped onto the round so projectiles.js's in-flight
  // cover check can pass it to `_isWallForRound` — see world.js `_isWall`. Enemy callers pass
  // `isSmallUnit(e)`; the player never does (always large).
  _spawnProjectile(w, x, y, angle, owner = 'player', angleOffset = 0, seekOverride = null, aimAngle = angle, smallUnitInvolved = false) {
    const d = w.weapon.delivery;
    let speed = d.velocity || 480;
    const maxRange = (w.weapon.range?.max ?? 400) + 40;
    // Indirect-fire targeting (#31, #62): a player round seeks the MAINTAINED lock's aim point
    // ONLY when the lock is fully charged (red). With LOS that point is the live enemy; while the
    // lock is blind (LOS broken behind cover) it's the target's last-known + dead-reckoned
    // predicted position, so the round arcs over the wall onto where the target probably is. No
    // lock ⇒ no seek, the round dumb-fires straight. An enemy's blind lob passes `seekOverride`.
    const seekTarget = seekOverride || (owner === 'player' ? this._lockAimPoint() : null);
    // An arcing round lobs to where its target actually is (else to optimal range); straight
    // rounds just run out at max range. This travel budget is what the kinematic round flies.
    let maxDist = maxRange;
    if (d.path === 'arcing') {
      const tgt = owner === 'player' ? (seekTarget ?? { x, y }) : (seekTarget ?? { x: this.px, y: this.py });
      // arcMaxDist (data/delivery.js, #77 follow-up) takes `aimAngle` — the weapon's un-offset
      // CENTRE bearing — not `angle` (this shot's own possibly fan-offset launch heading). See
      // that function's comment for why using the shot's own angle here regressed both missile
      // range and Swarm Rack's flight path.
      maxDist = arcMaxDist(x, y, aimAngle, tgt, maxRange, w.weapon.range?.opt ?? 160);
      // Constant-apex lobs: hold flight time fixed so every arc peaks at the same height —
      // a far shot therefore launches faster. The weapon's `velocity` is calibrated at its
      // optimal range (T = opt / velocity), and that same airtime is reused at any range.
      const opt = w.weapon.range?.opt || maxDist;
      const flightTime = opt / speed;
      speed = maxDist / flightTime;
    }
    // Homing rounds steer toward `seekTarget` (the lock) each frame. A player round only homes
    // when it actually has a lock; without one it dumb-fires straight. Enemy rounds keep their
    // intrinsic homing (they chase the player downrange).
    const round = makeProjectile(w.weapon, x, y, angle, { maxDist });
    // Constant-flight-time lobs: override the round's speed with the per-shot value computed
    // above so every arc peaks at the same height (a far shot launches faster).
    if (d.path === 'arcing') {
      round.speed = speed;
      round.vx = Math.cos(angle) * speed;
      round.vy = Math.sin(angle) * speed;
      // #77: turn rate follows speed (see makeProjectile) — re-derive it for the lob's real speed
      // so a fast far-range arc still corners onto the target instead of orbiting it. #243: pass
      // the weapon's own homingTurnRadius (if tuned) so the re-derive matches makeProjectile's.
      // #252 follow-up: also re-derive for a `tracksLock` lob (plasma cannon/napalm) — its base
      // `round.homing` is false at this point (they're not `guidance: 'homing'`, on purpose — see
      // weapons.js), so without this OR the recompute below would never touch `round.turn` and
      // it'd fly with the pre-arc-adjustment turn rate makeProjectile stamped on it.
      if (round.homing || d.tracksLock) round.turn = homingTurnRate(round.speed, d.homingTurnRadius);
    }
    // #252 follow-up: a `tracksLock` lob (plasma cannon/napalm) opts INTO live tracking here,
    // per-shot, only when the player actually has a lock right now — same gate a real
    // `guidance: 'homing'` round already gets (`!!seekTarget`). This deliberately does NOT touch
    // `canFireWeapon`/the weapon's own `guidance` field: those weapons still fire unconditionally
    // with no lock (unchanged), they just fly ballistic-only in that case, exactly as before.
    // Enemy-fired rounds (the artillery turret's napalm) are untouched — this whole branch is
    // player-only, so the turret's shells keep their existing non-tracking ballistic arc.
    if (owner === 'player') round.homing = (round.homing || !!d.tracksLock) && !!seekTarget;
    // Swarm Rack simultaneous-arrival (#49): nudge this shot's speed by how much farther
    // its fan angle makes its initial path vs. the centre shot, so the whole salvo (fired
    // from the same point at once) lands together instead of trickling in.
    if (round.homing && seekTarget) {
      const straightDist = Math.hypot(seekTarget.x - x, seekTarget.y - y);
      const mult = arrivalSpeedMultiplier(w.weapon, angleOffset, straightDist);
      round.speed *= mult;
      round.vx *= mult;
      round.vy *= mult;
    }
    // #72 own-hex transparency for the SHOOTER: remember which hex(es) this round was born in —
    // the muzzle's hex plus the shooter's body hex (the muzzle sits ~a part-length ahead of the
    // mech's centre, so back-project along the fire angle). A unit standing inside soft cover
    // can then fire OUT without its own round detonating on its own hex.
    const originHexes = [this._hexKeyAt(x, y), this._hexKeyAt(x - Math.cos(angle) * 24, y - Math.sin(angle) * 24)];
    // #317: stamp the hex the player is actually AIMED AT (when the converge/lock pick is a
    // destructible hex rather than an enemy or a wall span). projectiles.js stops the round the
    // moment it enters that hex, whether or not the terrain there would have blocked it — which is
    // the whole fix: soft cover never blocks a mech's ray, so before this a locked forest hex was
    // targetable and literally unhittable. Player-only: an enemy has no convergence pick, and the
    // stamp is null for every other target kind, so nothing else changes behaviour.
    const targetHexKey = owner === 'player' ? targetHexKeyOf(this.convergeTarget) : null;
    const pushed = { ...round, owner, trail: [], seekTarget, originHexes, targetHexKey, smallUnitInvolved: !!smallUnitInvolved };
    this.projectiles.push(pushed);
    return pushed;
  },
};
