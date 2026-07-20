// Arena firing mixin — turning a trigger pull into shots: per-slot/ability handling pulled
// out of update(), the fire dispatch (hitscan beam / melee swing / travelling round), and
// the per-shot helpers (cadence, range falloff, ability activation). Methods use `this`
// (the ArenaScene); composed onto the prototype via Object.assign.
import { CATEGORIES } from '../../data/categories.js';
import {
  isPlayerRef, livePlayersOf, otherLivePlayers, primaryPlayerOf,
} from './players.js';
import { planEmissions, makeProjectile, arrivalSpeedMultiplier, homingTurnRate, arcMaxDist } from '../../data/delivery.js';
import { traceHitscan } from '../../data/beamTrace.js';
import { canFireWeapon } from '../../data/targetlock.js';
import { drawSlash } from '../../art/index.js';
import { Audio } from '../../audio/index.js';
import { TRAJECTORY_DELAY, hasHeldSfx, WEAPON_TRAJECTORY_SOUNDS_ENABLED } from '../../audio/sfxParams.js';
// #224 (temporary): WEAPON_TRAJECTORY_SOUNDS_ENABLED gates the in-flight trajectory loop
// below — see sfxParams.js for the full list of gated call sites and how to revert.
import { scheduleFireCues } from '../../audio/fireCues.js';
import { updateSprintFuel } from '../../data/sprint.js';
import { triggerDash, updateDash, DASH_COOLDOWN } from '../../data/dash.js';
import { targetHexKeyOf } from './shared.js';
import { targetCoverExempt } from '../../data/visibility.js';

export const FiringMixin = {
  // #338: the SHOT half of the one shared predicate (data/visibility.js `targetCoverExempt`) —
  // the same call target eligibility makes, so "you should only be able to lock what you could
  // actually hit" holds by construction instead of by two files happening to agree.
  //
  // Player-only, and keyed on the frame's live converge/lock pick — enemies have no lock, so
  // there is no second side of the invariant to satisfy for them and cover stays absolute for
  // every enemy shooter (#316's rule, untouched). Ground picks return false here, so a shot at a
  // tank behind a boulder is blocked exactly as before; this opens a lane only while the thing
  // you have locked is genuinely in the air.
  // #348: `player` is the SHOOTER, because the converge pick is now per-player — two players
  // aiming at different things must not share one cover exemption.
  _shotIgnoresCover(owner = 'player', player = primaryPlayerOf(this)) {
    return owner === 'player' && targetCoverExempt(player.convergeTarget);
  },

  // ── Per-slot firing ── each skill slot (body location) has its own button; a held button
  // auto-fires that location's weapon at its own cadence, gated by ammo. ──
  // #347: fires ONE player's slots. `player` defaults to the primary, so every existing caller
  // and test double is unchanged; ArenaScene.update() passes each player explicitly.
  //
  // #348 closes phase 1's scope note: the whole firing chain is per-player now. The cooldown
  // map, the held-audio map, the aim pick and the muzzle geometry all come off `player`, because
  // all of them are downstream of one device's buttons and one turret's facing — which is
  // exactly why phase 1 could not split them until there was a second controller to split for.
  _handleFiring(intent, delta, player = primaryPlayerOf(this)) {
    player.heldAudio ??= {};
    player.fireCooldowns ??= {};
    // Stamp the frame we read the fire input, so the SFX latency debug (window.__sfxDebug)
    // can measure our code-path cost from here to the audio node's start().
    Audio.markTrigger();
    for (const w of player.mech.weapons()) {
      let cd = (player.fireCooldowns[w.location] ?? 0) - delta;
      if (intent.fire[w.location] && cd <= 0 && w.ready) {
        this.fireWeapon(w, player);
        cd = this._fireInterval(w.weapon);
      }
      player.fireCooldowns[w.location] = Math.max(0, cd);

      // Continuous beam visual tracking (#86): a held sustained/stream hitscan (the beam
      // laser) only re-pins its beam line on the block above, which runs at the WEAPON's own
      // fire cadence (e.g. 20Hz) — well below the render frame rate. That made the beam step
      // between angles as the turret swept instead of following it smoothly. This runs every
      // render frame regardless of cadence and re-aims the beam's existing line at the current
      // muzzle/angle; it's purely visual — damage still only applies on the cadence above.
      if (intent.fire[w.location] && w.ready && this._isHeldBeam(w.weapon)) this._trackHeldBeam(w, player);

      // Held/looping fire sound (#53): a genuinely continuous weapon (flamethrower/beam
      // laser, hasHeldSfx) starts its loop on the rising edge (button just pressed) and
      // stops it on the falling edge — button released, OR the weapon ran dry / went
      // offline while held (ammo depleted, part destroyed).
      const held = intent.fire[w.location] && w.ready && hasHeldSfx(w.weapon.id);
      // #348: the held-loop key is per player — two players holding the same weapon in the
      // same slot each own their own loop instead of stopping each other's.
      const audioKey = `${player.id}:${w.location}`;
      const wasHeld = player.heldAudio[w.location];
      if (held && !wasHeld) Audio.startHeld(audioKey, w.weapon.id);
      else if (!held && wasHeld) Audio.stopHeld(audioKey);
      player.heldAudio[w.location] = held;
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
  // #348: per player — each carries its own sprint state and its own Overclock edge tracking.
  // (The BUFF OVERLAY that drives it, `_buffMods`, is still scene-level — see the report: making
  // powerup buffs per-player has not been put to Jackson, so it is deliberately left as-is and
  // both players currently share one Overclock window.)
  _handleSprint(_intent, delta, player = primaryPlayerOf(this)) {
    const dt = delta / 1000;
    const overclockActive = !!this._buffMods?.().overclockActive;
    const overclockRisingEdge = overclockActive && !player.overclockWasActive;
    player.overclockWasActive = overclockActive;

    if (overclockRisingEdge) {
      player.sprint.active = true;
      player.sprintForcedByOverclock = true;
    }

    // Free ride only while Overclock is the reason Sprint is currently on — skip the fuel
    // state machine entirely rather than passing drainRate: 0, since updateSprintFuel's
    // empty-tank check (`fuel <= 0 ⇒ active = false`) fires independent of drain rate.
    const wasActive = player.sprint.active;
    if (!(player.sprintForcedByOverclock && player.sprint.active)) {
      player.sprint = updateSprintFuel(player.sprint, dt);
    }

    // Overclock's window closed — hand it back off (no player-manual sprint left to defer to).
    if (!overclockActive && player.sprintForcedByOverclock) {
      player.sprint.active = false;
      player.sprintForcedByOverclock = false;
    }

    // A cue on every real active/inactive transition — Overclock's auto-activation or its
    // expiry handoff.
    if (player.sprint.active && !wasActive) Audio.ui('sprintOn');
    else if (!player.sprint.active && wasActive) Audio.ui('sprintOff');
    // #368: the `sprintActive`/`sprintFuel`/`sprintFuelMax` publishes that used to sit here are
    // GONE rather than made per-player. Nothing has read them since the HUD's sprint gauge was
    // removed, and #343 deleted the player-facing Sprint controls entirely (Sprint is now an
    // Overclock side effect, never something the player drives), so a per-player channel would
    // just be dead weight in a co-op shape. The state itself still lives on `player.sprint`,
    // which is where locomotion reads it.
  },

  // ── Dash (#261) ── a hardcoded, always-available ability on L3/Space — replaces the old
  // player-facing Sprint. `intent.dashPressed` is already rising-edge-detected by Controls.js
  // (one edge per physical press, on whichever device is currently active), so a single press
  // triggers one burst; pressing again mid-burst or mid-cooldown is a no-op (`triggerDash`
  // itself is a no-op in that case — see data/dash.js). The pure state machine
  // (active/burstRemaining/cooldown) lives entirely in data/dash.js; this just wires the press
  // + per-frame tick and publishes the live state for the HUD's cooldown indicator.
  // #348: per player — each player's own L3/Space, own burst, own cooldown.
  _handleDash(intent, delta, player = primaryPlayerOf(this)) {
    const dt = delta / 1000;
    const wasActive = player.dash.active;
    if (intent.dashPressed) player.dash = triggerDash(player.dash);
    player.dash = updateDash(player.dash, dt);

    // Reuse the existing sprint-on/off cues for the dash's start/end — same "movement ability
    // just engaged/disengaged" cue language, no new SFX plumbing needed for a ~0.2s burst.
    if (player.dash.active && !wasActive) Audio.ui('sprintOn');
    else if (!player.dash.active && wasActive) Audio.ui('sprintOff');

    if (player === primaryPlayerOf(this)) {
      this.registry.set('dashActive', player.dash.active);
      this.registry.set('dashCooldown', player.dash.cooldown);
      this.registry.set('dashCooldownMax', DASH_COOLDOWN);
    }
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
  // #348: `player` is who pulled the trigger. Everything below that used to read a scene
  // singleton — the converge pick, the ammo pool, the muzzle geometry, the noise source, the
  // beam-lane key — now reads that player, so two players firing the same weapon in the same
  // frame never touch each other's state.
  fireWeapon(w, player = primaryPlayerOf(this)) {
    if (!this.scene.isActive()) return;
    // #77, rework #252, #341: a tracking (homing) weapon with no target (i.e. convergence has
    // nothing picked this frame) does not fire — no dumbfire fallback. The trigger pull is a no-op:
    // nothing spawns, no ammo spent, no cooldown-worthy shot actually happened. `convergeTarget`
    // (targeting.js `_updateLock`) is the one target concept — the same pick the reticle draws and
    // homing rounds seek. See data/targetlock.js `canFireWeapon` for exactly which deliveries this
    // gates (only guidance: 'homing' — direct-fire and dumbfire/arcing-lob weapons are unaffected).
    if (!canFireWeapon(w.weapon, player.convergeTarget)) return;
    // #316 reverses #245/#257: there used to be a cover exemption here — when the player's
    // convergence pick was a FLYING enemy, the player's shot ignored terrain cover (mirroring
    // #245, which let a flyer's own shots ignore it). Both directions are gone. Cover is cover
    // for everyone: the player's rounds stop on a wall whether the thing they're aimed at flies
    // or not, and a flyer's rounds do the same. There is no per-shot cover-exemption flag left in
    // this file — the wall trace / in-flight wall check below run unconditionally.
    const mods = this._buffMods?.() ?? {};
    // #381 free ammo: while ANY powerup is active, weapons don't spend ammo (freeAmmo — granted
    // by every powerup now, not the old dedicated Overcharge). Otherwise spend a shot's worth,
    // scaled by cycleMult (#235): Overdrive's cycleMult 0.5 halves the fire interval (shots go out
    // ~2x as often), so scaling consumption by the same factor spends 0.5 ammo/shot — exactly
    // offsetting the faster rate for a net-neutral ammo economy, distinct from free ammo's true
    // unlimited fire. Outside Overdrive cycleMult is 1, so this is the same flat 1-ammo spend.
    if (!mods.freeAmmo) player.mech.consumeAmmo(w.location, w.index, mods.cycleMult ?? 1);
    // #103 noise-aggro: a real shot just went off at the player's position — unaware enemies
    // within NOISE_AGGRO_RANGE of this instant become AWARE (see data/awareness.js), regardless
    // of line-of-sight. Just a timestamp + position; enemies.js reads it each frame.
    this._lastFireAt = this.time.now;
    // #347/#348: the NOISE source that wakes enemies — whoever actually fired.
    this._lastFireX = player.x;
    this._lastFireY = player.y;

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
      this._retireStaleBeamLanes(playerBeamKey(player), w.location, plan.shots.length);
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
        const m = this._muzzle(w.location, player);
        const aimAngle = this._fireAngle(w, m, player);
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
        if (this._muzzleWallBlocked?.(player.x, player.y, ox, oy)) return;
        if (plan.mode === 'contact') this._melee(w, ox, oy, baseAngle, 'player', player);
        // #307: `lane`/`lateral` let a continuously-held beam own ONE persistent beam object
        // PER PARALLEL LANE — under Barrage the beam laser plans 2 lanes, and without this
        // both lanes shared a beam key so the second silently overwrote the first's endpoints
        // (two shots fired, one line drawn).
        else if (plan.mode === 'hitscan') this._fireHitscan(w, ox, oy, baseAngle, 'player', playerBeamKey(player), { lane, lateral: s.lateral, shooter: player });
        else {
          // Pass the weapon's un-offset aim angle (aimAngle) alongside this shot's actual
          // launch angle (baseAngle) — see _spawnProjectile's arcing maxDist comment for why
          // a wide-fan shot (Swarm Rack) needs the CENTRE bearing for its target-ahead test.
          const round = this._spawnProjectile(w, ox, oy, baseAngle, 'player', s.angleOffset, null, aimAngle, player);
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
  // #348: FRIENDLY FIRE IS ON (Jackson). A player's melee sweep therefore scores the other live
  // players alongside the enemies, in exactly the same arc, and the nearest thing in the arc is
  // what gets hit — whichever side it is on. `shooter` is excluded from its own sweep.
  _melee(w, mx, my, angle, owner = 'player', shooter = primaryPlayerOf(this)) {
    const reach = w.weapon.range.max || 32;
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    let target = null, t = 0;
    if (owner === 'enemy') {
      // #347: sweep against every live player and take the nearest one in the arc, mirroring
      // the player-side sweep just below. One player today = the same single test as before.
      for (const p of livePlayersOf(this)) {
        const ex = p.x - mx, ey = p.y - my;
        const tt = ex * dirX + ey * dirY, perp = Math.abs(ex * dirY - ey * dirX);
        if (tt > 0 && tt < reach && perp < 44 && (!target || tt < t)) { target = p; t = tt; }
      }
    } else {
      const candidates = [
        ...this.enemies.filter((e) => !e.mech.isDestroyed()),
        ...otherLivePlayers(this, shooter),
      ];
      for (const e of candidates) {
        const ex = e.x - mx, ey = e.y - my, tt = ex * dirX + ey * dirY, perp = Math.abs(ex * dirY - ey * dirX);
        if (tt > 0 && tt < reach && perp < 44 && (!target || tt < t)) { target = e; t = tt; }
      }
    }
    const color = CATEGORIES[w.weapon.category]?.color ?? 0xcfd6e0;
    if (target) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      if (owner === 'enemy' || isPlayerRef(this, target)) this._damagePlayerAt(dmg, target);
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
  // #348: for a PLAYER's shot the candidate list now also carries the other live players, which
  // is the whole of friendly fire on the hitscan path — a beam simply finds a teammate in the
  // way and stops on them, scored by the same nearest-along-the-ray rule as an enemy.
  _liveTargetsForTrace(owner, shooter = null) {
    if (owner === 'enemy') {
      // #347: every LIVE player is a candidate, each carrying itself as `ref` so the hit
      // resolution downstream knows WHICH player the ray struck. One player today, so this is
      // the same one-item list `traceHitscan` has always been handed.
      return livePlayersOf(this).map((p) => ({ x: p.x, y: p.y, destroyed: false, ref: p }));
    }
    const allies = shooter
      ? otherLivePlayers(this, shooter).map((p) => ({ x: p.x, y: p.y, destroyed: false, ref: p }))
      : [];
    return [...this._liveEnemiesForTrace(), ...allies];
  },

  // How far a beam/wall-blocked ray from `muzzle` at `angle` actually reaches, honoring cover.
  // #72 own-hex transparency: the muzzle's own hex (firing OUT of forest) and any living
  // enemy's hex (a target standing IN forest) don't block the beam — only deeper soft cover
  // and solid walls do.
  // #374: soft cover no longer stops a beam geometrically at all (the `smallUnitInvolved`
  // size-tier parameter is gone) — a target standing in foliage is protected by the per-shot
  // `_softCoverStopsShot` roll instead, applied after this trace resolves. See world.js `_isWall`.
  // #310 `ignoreSpanKey`: the shooter's own wall span, for a wall turret firing off the centreline
  // it is mounted on — see wallEdges.js `wallEdgeCrossing`'s `ignoreKey`. Null for every other
  // shooter, so no one else's beam gains a way through a wall.
  _hitscanReach(muzzleX, muzzleY, angle, endDist, ignoreSpanKey = null) {
    // #348: every LIVE player's own hex, not just the local one — with friendly fire on, a
    // teammate standing in forest is a legitimate target and their hex must be see-through for
    // the same reason an enemy's is.
    const transparent = new Set([this._hexKeyAt(muzzleX, muzzleY)]);
    for (const p of livePlayersOf(this)) transparent.add(this._hexKeyAt(p.x, p.y));
    for (const e of this.enemies) if (!e.mech.isDestroyed()) transparent.add(this._hexKeyAt(e.x, e.y));
    return this._wallDistance(muzzleX, muzzleY, angle, endDist, transparent, ignoreSpanKey);
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
  _trackHeldBeam(w, player = primaryPlayerOf(this)) {
    const prefix = `${playerBeamKey(player)}:${w.location}:`;
    const lanes = this.beams.filter((b) => typeof b.loc === 'string' && b.loc.startsWith(prefix));
    if (!lanes.length) return;
    const m = this._muzzle(w.location, player);
    const angle = this._fireAngle(w, m, player);
    const perp = angle + Math.PI / 2;
    const reach = w.weapon.delivery.hit === 'contact' ? (w.weapon.range.max || 32) : 900;
    for (const live of lanes) {
      const off = live.lateral || 0;
      const mx = m.x + Math.cos(perp) * off, my = m.y + Math.sin(perp) * off;
      // #320: a HELD beam whose emitter has drifted across a span as the mech walks/slews gets
      // clamped to zero length rather than lancing out from the far side of the wall — the
      // continuous-fire counterpart of the spawn-time guard above.
      if (this._muzzleWallBlocked?.(player.x, player.y, mx, my)) {
        live.x0 = mx; live.y0 = my; live.x1 = mx; live.y1 = my;
        continue;
      }
      const trace = traceHitscan(mx, my, angle, reach, this._liveTargetsForTrace('player', player));
      let endDist = trace.endDist;
      // #338: a HELD beam is re-pinned every render frame independently of the fire cadence, so it
      // needs the same cover-exemption branch the fire tick takes — otherwise the damage lands on
      // the airborne target while the drawn beam still stops dead at the wall.
      const wallT = this._shotIgnoresCover('player', player) ? Infinity : this._hitscanReach(mx, my, angle, endDist);
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
  // (#269's `smallUnitInvolved` param — the soft-cover size-tier exemption — was removed by #374
  // along with the geometric soft-cover block it fed; see `_softCoverStopsShot`, rolled below.)
  // `lane`/`lateral` (#307, optional): which PARALLEL LANE of the emission plan this shot is.
  // A continuously-held beam keeps one persistent beam object per lane — keyed by
  // shooter+location+lane — so Barrage's two lanes each own (and re-pin) their own line
  // instead of the second stomping the first. `lateral` is the lane's perpendicular muzzle
  // offset, remembered on the beam so `_trackHeldBeam` can re-derive that lane's own muzzle
  // every render frame. A single-lane hold is lane 0 with lateral 0 — i.e. exactly one
  // tracking object, preserving #86.
  // `shooter` (#348, optional): the PLAYER firing, for the per-player converge pick and for
  // friendly fire (they are excluded from their own candidate list).
  _fireHitscan(w, muzzleX, muzzleY, angle, owner = 'player', shooterKey = 'player', { lane = 0, lateral = 0, ignoreSpanKey = null, shooter = null } = {}) {
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    const color = CATEGORIES[w.weapon.category]?.color ?? 0x9fe8ff;
    const reach = w.weapon.delivery.hit === 'contact' ? (w.weapon.range.max || 32) : 900;

    // Project each living target onto the firing ray (forward `t`, perpendicular miss) and
    // take the nearest one actually struck.
    const trace = traceHitscan(muzzleX, muzzleY, angle, reach, this._liveTargetsForTrace(owner, shooter));
    let target = trace.target?.ref ?? null;
    let t = trace.t;
    let hit = !!target;
    let endDist = trace.endDist;
    // Cover: a wall between muzzle and target stops the beam short. #316: a flying SHOOTER's beam
    // is blocked by hard cover exactly like a ground shooter's (unchanged by #338 — see below,
    // where the exemption is a property of the locked TARGET, not of who is firing).
    //
    // #310 (2026-07-19), ONE exception, and it is not a cover exemption: a beam aimed at a WALL
    // TURRET is not stopped by the span that turret is standing on. Since the gun was centred on
    // its wall line, muzzle-to-gun and muzzle-to-wall are the same distance from every direction,
    // and the wall test runs first — so without this the gun is literally unshootable and its
    // 200hp span becomes the only way to silence it (measured: 4x the cost, from either side).
    // #310 shipped the gun and the span as two separate health pools on purpose; this keeps them
    // that way. Scoped to the span under the thing you are actually aiming at, so it never opens a
    // lane through a wall to anything else — every other span still stops the beam dead.
    //
    // #338, the other exception, and this one IS a cover exemption — a deliberate one: when the
    // player's locked target is airborne the beam is not clamped by the wall trace at all. That is
    // the shot half of the shared predicate; without it the player locks a helicopter over a base
    // wall (which targeting permits by rule) and watches every beam splash on the stone.
    const targetSpanKey = (target && typeof target === 'object' && target.spanKey) || null;
    const wallT = this._shotIgnoresCover(owner, shooter ?? primaryPlayerOf(this)) ? Infinity
      : this._hitscanReach(muzzleX, muzzleY, angle, endDist, ignoreSpanKey ?? targetSpanKey);
    let blocked = wallT < endDist;
    if (blocked) { endDist = wallT; hit = false; }
    // #317, hitscan half of the targeted-hex rule: a beam has no per-step position to test, so its
    // stopping point is solved up front. If the player's converge/lock pick is a standing
    // destructible hex and this ray enters it SHORTER than wherever the beam would otherwise end,
    // the beam terminates there instead. Without this a laser aimed at a locked forest hex passed
    // clean over it for exactly the same reason a bullet did — soft cover doesn't block a mech.
    const tHexKey = owner === 'player' ? targetHexKeyOf((shooter ?? primaryPlayerOf(this)).convergeTarget) : null;
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
    // #374 REWORK: the foliage roll, per soft-cover hex the beam CROSSES (10% each; the target's
    // own hex 25% for a non-mech ground unit, 10% for a mech, 0 for air — which exempts the whole
    // lane). Checked here, AFTER the beam has geometrically resolved onto a unit, because soft
    // cover no longer blocks anything geometrically. The muzzle point is passed as the lane's
    // origin; the muzzle's own hex is also the #72 own-hex exemption. The beam still draws to the
    // target and still sparks (it hit the branches in front of them); it just deals nothing.
    // A held stream asks once per TICK, so it loses ~10% of its DPS per crossed hex rather than
    // being gated all-or-nothing.
    const eaten = hit && this._softCoverStopsShot?.(
      target, [this._hexKeyAt(muzzleX, muzzleY)], { x: muzzleX, y: muzzleY },
    );
    if (hit && !eaten) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      // #348: friendly fire — a player-owned beam that resolved to another PLAYER routes to the
      // player damage sink, not the enemy one.
      if (owner === 'enemy') this._damagePlayerAt(dmg, playerRefOf(this, target));
      else if (isPlayerRef(this, target)) this._damagePlayerAt(dmg, target);
      else this._damageEnemyAt(target, endX, endY, dmg, color);
      this._impactFx(endX, endY, color, 'beam', 0, w.weapon.id);
    } else if (eaten) {
      this._impactFx(endX, endY, color, 'beam', 0, w.weapon.id);   // #374 — splash in the foliage
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
  // (#245's `ignoreCover` PARAM — a caller stamping `ignoresCover` onto a flying enemy's round —
  // was removed by #316 and stays removed. #338 re-derives that stamp below from the shared
  // predicate instead: it is the player's LOCKED TARGET being airborne that opens the lane, never
  // the shooter flying, so there is no parameter for a caller to pass.)
  // (#269's `smallUnitInvolved` param, stamped onto the round for projectiles.js's in-flight cover
  // check, was removed by #374 with the rest of the geometric soft-cover block — an in-flight round
  // now takes its chances with `_softCoverStopsShot` at the moment it resolves onto a target.)
  // `shooter` (#348, optional): the PLAYER who fired, stamped onto the round so its own rounds
  // can never friendly-fire back onto it, and so the round's seek/target-hex come from THAT
  // player's aim rather than a scene singleton.
  _spawnProjectile(w, x, y, angle, owner = 'player', angleOffset = 0, seekOverride = null, aimAngle = angle, shooter = null) {
    const d = w.weapon.delivery;
    let speed = d.velocity || 480;
    const maxRange = (w.weapon.range?.max ?? 400) + 40;
    // Indirect-fire targeting (#31, #62): a player round seeks the MAINTAINED lock's aim point
    // ONLY when the lock is fully charged (red). With LOS that point is the live enemy; while the
    // lock is blind (LOS broken behind cover) it's the target's last-known + dead-reckoned
    // predicted position, so the round arcs over the wall onto where the target probably is. No
    // lock ⇒ no seek, the round dumb-fires straight. An enemy's blind lob passes `seekOverride`.
    const seekTarget = seekOverride || (owner === 'player' ? this._lockAimPoint(shooter ?? primaryPlayerOf(this)) : null);
    // An arcing round lobs to where its target actually is (else to optimal range); straight
    // rounds just run out at max range. This travel budget is what the kinematic round flies.
    let maxDist = maxRange;
    if (d.path === 'arcing') {
      const primary = primaryPlayerOf(this);
      const tgt = owner === 'player' ? (seekTarget ?? { x, y }) : (seekTarget ?? { x: primary.x, y: primary.y });
      // arcMaxDist (data/delivery.js, #77 follow-up) takes `aimAngle` — the weapon's un-offset
      // CENTRE bearing — not `angle` (this shot's own possibly fan-offset launch heading). See
      // that function's comment for why using the shot's own angle here regressed both missile
      // range and Swarm Rack's flight path.
      maxDist = arcMaxDist(x, y, aimAngle, tgt, maxRange, w.weapon.range?.opt ?? 160);
      // #376: CONSTANT HORIZONTAL SPEED. This deliberately replaces the old constant-apex
      // rule ("hold flight time fixed so every arc peaks at the same height", which derived
      // speed as maxDist / (opt / velocity)). That made velocity a function of RANGE — a
      // target twice as far away got a literally twice-as-fast missile, which is exactly the
      // "weirdly fast when the target is further away" Jackson reported in playtest.
      // Now the weapon's `velocity` IS the speed at every range; flight TIME grows with
      // range instead. The visible loft is unaffected: the arc is faked by a sprite-scale
      // pulse (projectiles.js _drawProjectile) driven by the flight FRACTION dist/maxDist,
      // not by elapsed time, so every lob still peaks at the same apparent height at the
      // midpoint of its flight — a far shot simply takes longer to get there. Same for
      // arcHomingBlend (delivery.js), which is also fraction-keyed. Nothing that depended on
      // "constant apex" was actually depending on constant flight TIME.
      // (No speed line here at all any more — `speed` stays the weapon's own `velocity`.)
    }
    // Homing rounds steer toward `seekTarget` (the lock) each frame. A player round only homes
    // when it actually has a lock; without one it dumb-fires straight. Enemy rounds keep their
    // intrinsic homing (they chase the player downrange).
    // #377 follow-up: `angleOffset` (this shot's own offset off the salvo centre bearing) is
    // handed through so a fanned salvo can give each round its own late-converging aim offset
    // — see salvoAimOffset. Every non-fanned caller passes the default 0 and is unaffected.
    const round = makeProjectile(w.weapon, x, y, angle, { maxDist, angleOffset });
    // #376: a lob now flies at its weapon's own `velocity`, identical at every range (see the
    // constant-horizontal-speed comment above). This block is kept — rather than deleted — so
    // the turn-rate re-derive below still runs for arcing rounds, and so a future per-shot
    // speed rule has one place to live.
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
    const targetHexKey = owner === 'player' ? targetHexKeyOf((shooter ?? primaryPlayerOf(this)).convergeTarget) : null;
    // #338: the shot half of the shared predicate, resolved ONCE at spawn and carried by the round
    // (projectiles.js reads it in the in-flight cover check). Spawn-time, not per-frame, on purpose
    // — a shot commits to the geometry it was fired under, which is exactly the rule that keeps
    // case 1 of the issue honest: a round fired at a GROUND target locked in the open still splashes
    // on the wall that target ducks behind, rather than homing through terrain after it.
    const ignoresCover = this._shotIgnoresCover(owner, shooter ?? primaryPlayerOf(this));
    const pushed = {
      ...round, owner, trail: [], seekTarget, originHexes, targetHexKey, ignoresCover,
      // #374 REWORK: where this round was BORN, so the soft-cover lane (world.js
      // `_softCoverLane`) can be walked muzzle→impact when the round resolves onto a unit.
      // Stamped at spawn rather than back-derived from flight, so an arcing/homing round is
      // judged on the lane it was actually fired down.
      originX: x, originY: y,
      // #348: who fired it, so friendly fire (projectiles.js) can skip the shooter themselves.
      shooter: owner === 'player' ? (shooter ?? primaryPlayerOf(this)) : null,
    };
    this.projectiles.push(pushed);
    return pushed;
  },
};

// #348: the beam-lane key prefix for one player. Two players holding the same weapon in the
// same body location must own separate persistent beam objects, or the second silently
// overwrites the first's endpoints (the #307 bug, one player up).
// Player 1 keeps the bare `player` key it has always had, so nothing about single-player beam
// behaviour (or the #86/#307 coverage of it) shifts; only later players get a suffix.
function playerBeamKey(player) { return player?.id ? `player${player.id}` : 'player'; }

// #347: the player a hitscan trace actually struck. `traceHitscan` hands back the candidate it
// hit, whose `ref` is the player object itself (see `_liveTargetsForTrace`). Falls back to the
// primary player for the arena test doubles that stub `traceHitscan` and return a bare target.
function playerRefOf(scene, target) {
  const ref = target?.ref ?? target;
  return (ref && ref.mech && ref.x != null) ? ref : primaryPlayerOf(scene);
}
