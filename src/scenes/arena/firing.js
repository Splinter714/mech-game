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
import { toggleSprint, holdSprint, updateSprintFuel, SPRINT_FUEL_MAX } from '../../data/sprint.js';

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

  // ── Sprint (#188) ── a hardcoded, always-available ability on L3/Space — not
  // mounted/equipped (replaced the old centre-torso ability slot's jumpJet/bubbleShield). A
  // depleting/regenerating fuel bar drains while active and refills while inactive; hitting
  // empty forces it off automatically.
  //
  // Per playtest feedback, the two devices trigger it with DIFFERENT semantics
  // (`intent.mode` tells us which is active, from Controls.js):
  //   - gamepad L3 is press-to-TOGGLE, as before: `intent.sprintPressed` is already
  //     rising-edge-detected by Controls.js, so a toggle only fires once per physical press.
  //   - keyboard Space is HOLD-to-sprint: `intent.sprintHeld` is the raw per-frame key-down
  //     state, so Sprint tracks it directly every frame (via `holdSprint`, gated on fuel like
  //     the toggle's ON case) — active only while held, off the instant it's released.
  //
  // #189: Overclock was redesigned from a flat moveMult/slewMult buff into forcing Sprint on,
  // fuel-free, for its whole duration — so this method also owns that handoff. State machine:
  // `this._sprintForcedByOverclock` tracks whether the mech's CURRENT sprint-active state is
  // "because Overclock is holding it on" (as opposed to the player's own manual input), and
  // `this._overclockWasActive` remembers last frame's buff state so activation is detected as
  // a genuine RISING EDGE (false→true) rather than "buff is active and flag happens to be
  // false" — the latter would misfire every frame after the player reclaims the flag while
  // the buff is still nominally running, immediately re-forcing Sprint back on.
  //   - Rising edge of Overclock claims Sprint: force `active = true` and set the flag,
  //     REGARDLESS of prior state/fuel — Overclock ignores fuel entirely while it owns the
  //     state (fuel-free by design, see data/powerups.js).
  //   - While the flag is set and Sprint is active, fuel math is skipped entirely (not just
  //     zero-drain) — `updateSprintFuel` would otherwise force `active` back to false on a
  //     0-fuel mech via its own empty-tank floor check, even with drainRate 0.
  //   - Manual input ALWAYS wins, even mid-Overclock, but "manual input" means something
  //     different per device:
  //       - gamepad: a toggle PRESS is the discrete moment the player asserts control —
  //         `toggleSprint` flips the CURRENT active state, so pressing while Overclock is
  //         forcing it on reads as "turn it off" (true → false, always succeeds) exactly
  //         like the issue's spec asks.
  //       - keyboard: there's no discrete press to wait for — holding is a continuous
  //         signal, not an edge — so a CHANGE in the raw held state (press OR release) is
  //         what reclaims manual control; while the held state hasn't changed since last
  //         frame (player isn't touching Space either way), Overclock keeps ownership. This
  //         is what makes releasing Space turn Sprint off immediately even mid-Overclock,
  //         while simply not touching Space during Overclock doesn't cancel the forced ride.
  //     Either way, the moment manual ownership is reclaimed, normal drain/regen rules apply
  //     right away, not at Overclock's own expiry (no discontinuity/free lunch — see
  //     sprintOverclock.test.js and sprintHoldToggle.test.js).
  //   - If Overclock's duration ends while the flag is STILL set (no manual input reclaimed
  //     it in between), hand control back exactly as if Overclock had never touched Sprint:
  //     force it off, since the player never asked for it themselves.
  _handleSprint(intent, delta) {
    const dt = delta / 1000;
    const overclockActive = !!this._buffMods?.().overclockActive;
    const overclockRisingEdge = overclockActive && !this._overclockWasActive;
    this._overclockWasActive = overclockActive;

    if (overclockRisingEdge) {
      this.sprint.active = true;
      this._sprintForcedByOverclock = true;
    }

    if (intent.mode === 'kbm') {
      // Hold-to-sprint: only a CHANGE in the raw held state (press or release) counts as
      // the player asserting manual control — holding steady through an Overclock window
      // (in either state) is not itself an assertion, since there's no discrete edge the
      // way a toggle press has one. On the very first call there's no prior frame to compare
      // against, so seed the baseline to the current state (mirrors PadEdges' first-poll
      // handling, #79) rather than assuming "not held" and misreading an already-held key as
      // a fresh press.
      const heldNow = !!intent.sprintHeld;
      const firstPoll = !('_prevKbSprintHeld' in this);
      const heldBefore = firstPoll ? heldNow : !!this._prevKbSprintHeld;
      this._prevKbSprintHeld = heldNow;
      if (heldNow !== heldBefore) this._sprintForcedByOverclock = false;
      if (!this._sprintForcedByOverclock) {
        this.sprint.active = holdSprint(heldNow, this.sprint.fuel);
      }
    } else if (intent.sprintPressed) {
      this.sprint.active = toggleSprint(this.sprint.active, this.sprint.fuel);
      this._sprintForcedByOverclock = false;
    }

    // Free ride only while Overclock is the reason Sprint is currently on — skip the fuel
    // state machine entirely rather than passing drainRate: 0, since updateSprintFuel's
    // empty-tank check (`fuel <= 0 ⇒ active = false`) fires independent of drain rate.
    const wasActive = this.sprint.active;
    if (!(this._sprintForcedByOverclock && this.sprint.active)) {
      this.sprint = updateSprintFuel(this.sprint, dt);
    }

    // Overclock's window closed without the player ever taking the wheel — hand it back off.
    if (!overclockActive && this._sprintForcedByOverclock) {
      this.sprint.active = false;
      this._sprintForcedByOverclock = false;
    }

    // A cue on every real active/inactive transition — a manual toggle, the forced-off at
    // empty fuel, Overclock's auto-activation, or its expiry handoff all count.
    if (this.sprint.active && !wasActive) Audio.ui('sprintOn');
    else if (!this.sprint.active && wasActive) Audio.ui('sprintOff');
    this.registry.set('sprintActive', this.sprint.active);
    this.registry.set('sprintFuel', this.sprint.fuel);
    this.registry.set('sprintFuelMax', SPRINT_FUEL_MAX);
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
    // #257 follow-up to #245: that fix made a FLYING enemy's own shots ignore terrain cover
    // (it's shooting from above), but left the reverse asymmetric — the player's shots still
    // stopped dead on a wall even when aiming at a flyer sitting over/behind that same terrain,
    // making it unhittable from the ground despite being freely able to shoot the player through
    // it. Mirror the mechanism: when the player's current convergence pick (`this.convergeTarget`
    // — the same live target `_fireAngle` already aims muzzles at, set each frame in
    // `_updateLock`) is a flying enemy (`.flying`, enemyKinds.js), the player's own shot ignores
    // cover too, exactly like a flyer's shot does. A destructible-hex convergence target (#250)
    // has no `.flying` property, so it's untouched (stays cover-respecting); a non-flying
    // (ground) enemy target is likewise unaffected.
    const ignoreCover = !!this.convergeTarget?.flying;
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
    const plan = planEmissions(w.weapon);
    // The fire + trajectory AUDIO cues (t=0 cue, per-burst-pulse retriggers, and the
    // trajectory beat) are scheduled in one shared place (audio/fireCues.js) that the Weapon
    // Lab preview calls too, so their timing can't drift; the arena always plays (audible:
    // true). Held/looping weapons (flamethrower/beam laser) get their sound from their loop
    // instead — scheduleFireCues no-ops for them, as it does for the delay:0-only case.
    scheduleFireCues(this, w.weapon, plan, true);
    for (const s of plan.shots) {
      const go = () => {
        if (!this.scene.isActive()) return;
        const m = this._muzzle(w.location);
        const aimAngle = this._fireAngle(w, m);
        const baseAngle = aimAngle + s.angleOffset;
        const perp = baseAngle + Math.PI / 2;
        const ox = m.x + Math.cos(perp) * s.lateral, oy = m.y + Math.sin(perp) * s.lateral;
        if (plan.mode === 'contact') this._melee(w, ox, oy, baseAngle);
        else if (plan.mode === 'hitscan') this._fireHitscan(w, ox, oy, baseAngle, 'player', 'player', ignoreCover);
        else {
          // Pass the weapon's un-offset aim angle (aimAngle) alongside this shot's actual
          // launch angle (baseAngle) — see _spawnProjectile's arcing maxDist comment for why
          // a wide-fan shot (Swarm Rack) needs the CENTRE bearing for its target-ahead test.
          const round = this._spawnProjectile(w, ox, oy, baseAngle, 'player', s.angleOffset, null, aimAngle, ignoreCover);
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
  _hitscanReach(muzzleX, muzzleY, angle, endDist) {
    const transparent = new Set([this._hexKeyAt(muzzleX, muzzleY), this._hexKeyAt(this.px, this.py)]);
    for (const e of this.enemies) if (!e.mech.isDestroyed()) transparent.add(this._hexKeyAt(e.x, e.y));
    return this._wallDistance(muzzleX, muzzleY, angle, endDist, transparent);
  },

  // Re-aim a held continuous beam's existing line at the current muzzle/angle, every render
  // frame while the trigger is held — independent of the weapon's own (much slower) fire
  // cadence, which only governs damage ticks via fireWeapon/_fireHitscan. Purely visual: no
  // damage, no ammo, no impact fx. If no fire tick has created the beam yet (the very first
  // frame it's held), there's nothing to reposition — fireWeapon creates it.
  _trackHeldBeam(w) {
    const live = this.beams.find((b) => b.loc === `player:${w.location}`);
    if (!live) return;
    const m = this._muzzle(w.location);
    const angle = this._fireAngle(w, m);
    const reach = w.weapon.delivery.hit === 'contact' ? (w.weapon.range.max || 32) : 900;
    const trace = traceHitscan(m.x, m.y, angle, reach, this._liveEnemiesForTrace());
    let endDist = trace.endDist;
    const wallT = this._hitscanReach(m.x, m.y, angle, endDist);
    if (wallT < endDist) endDist = wallT;
    live.x0 = m.x; live.y0 = m.y;
    live.x1 = m.x + Math.cos(angle) * endDist;
    live.y1 = m.y + Math.sin(angle) * endDist;
  },

  // `owner`/`shooterKey` (#117): generalizes the player's beam-fire path for an ENEMY mech's
  // hitscan weapons. The player fires against `this.enemies` and damages via `_damageEnemyAt`;
  // an enemy fires at the single player point and damages via `_damagePlayerAt` — everything
  // else (trace, cover-blocking, beam persistence, impact fx) is the same machinery either way.
  // `shooterKey` disambiguates the "one live continuous beam per shooter+location" lookup below
  // so two different enemies (or an enemy and the player) mounting the same weapon in the same
  // body location don't stomp each other's beam object.
  // `ignoreCover` (#245): a FLYING enemy (drone/helicopter) shoots from above, so its beam is
  // never blocked by terrain cover — the wall trace below is skipped entirely. The player and
  // ground enemies never pass this, so their beams stop at cover exactly as before.
  _fireHitscan(w, muzzleX, muzzleY, angle, owner = 'player', shooterKey = 'player', ignoreCover = false) {
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
    // Cover: a wall between muzzle and target stops the beam short — unless the shooter flies
    // over it (#245, `ignoreCover` above).
    const wallT = ignoreCover ? Infinity : this._hitscanReach(muzzleX, muzzleY, angle, endDist);
    const blocked = wallT < endDist;
    if (blocked) { endDist = wallT; hit = false; }
    const endX = muzzleX + dirX * endDist, endY = muzzleY + dirY * endDist;

    // Persistent beam so sparks can linger after it fades. A continuously-held beam
    // (sustained/stream) keeps ONE beam object that re-pins to the muzzle each shot, so it
    // tracks the mech as it turns/moves; single-shot beams (pulse/rail) push a fresh one.
    const beamTtl = w.weapon.delivery.burst?.wubOn ?? 80;
    const heavy = w.weapon.delivery.kind === 'rail';
    const continuous = w.weapon.delivery.sustained || w.weapon.delivery.pattern === 'stream';
    const beamKey = `${shooterKey}:${w.location}`;
    const live = continuous ? this.beams.find((b) => b.loc === beamKey) : null;
    if (live) {
      live.x0 = muzzleX; live.y0 = muzzleY; live.x1 = endX; live.y1 = endY;
      live.ttl = beamTtl;   // age keeps advancing → warble flows continuously
    } else {
      this.beams.push({ x0: muzzleX, y0: muzzleY, x1: endX, y1: endY, color, heavy, ttl: beamTtl, age: 0, loc: continuous ? beamKey : null });
    }
    if (hit) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      if (owner === 'enemy') this._damagePlayerAt(dmg);
      else this._damageEnemyAt(target, endX, endY, dmg, color);
      this._impactFx(endX, endY, color, 'beam', 0, w.weapon.id);
    } else if (blocked) {
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
  // `ignoreCover` (#245): true only for a round fired by a FLYING enemy (kindDef.flying —
  // drone/helicopter) — the round is stamped `ignoresCover` so the in-flight wall check
  // (projectiles.js) never detonates it on terrain cover; it flies over, same as its shooter.
  _spawnProjectile(w, x, y, angle, owner = 'player', angleOffset = 0, seekOverride = null, aimAngle = angle, ignoreCover = false) {
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
    const pushed = { ...round, owner, trail: [], seekTarget, originHexes, ignoresCover: !!ignoreCover };
    this.projectiles.push(pushed);
    return pushed;
  },
};
