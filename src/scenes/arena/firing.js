// Arena firing mixin — turning a trigger pull into shots: per-slot/ability handling pulled
// out of update(), the fire dispatch (hitscan beam / melee swing / travelling round), and
// the per-shot helpers (cadence, range falloff, ability activation). Methods use `this`
// (the ArenaScene); composed onto the prototype via Object.assign.
import { CATEGORIES } from '../../data/categories.js';
import { planEmissions, makeProjectile, arrivalSpeedMultiplier, doubleShotEmissions, homingTurnRate, arcMaxDist } from '../../data/delivery.js';
import { traceHitscan } from '../../data/beamTrace.js';
import { drawSlash } from '../../art/index.js';
import { Audio } from '../../audio/index.js';
import { TRAJECTORY_DELAY, hasHeldSfx } from '../../audio/sfxParams.js';
import { scheduleFireCues } from '../../audio/fireCues.js';

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

  // ── Abilities ── the centre-torso ability fires on its button (L3 / Space) off cd. ──
  _handleAbilities(intent, delta) {
    const dashDir = Math.hypot(intent.move.x, intent.move.y) > 0.1
      ? Math.atan2(intent.move.y, intent.move.x) : this.turretAngle;
    for (const ab of this.mech.abilities()) {
      let cd = (this.abilityCd[ab.location] ?? 0) - delta;
      if (intent.fire[ab.location] && cd <= 0) { this._activateAbility(ab, dashDir); cd = ab.equip.cooldown * 1000; }
      this.abilityCd[ab.location] = Math.max(0, cd);
    }
    this.registry.set('abilityCooldowns', this.abilityCd);
    this.registry.set('shieldActive', this.time.now < this.shieldUntil);
  },

  _activateAbility(ab, dir) {
    const e = ab.equip;
    Audio.ability(e.ability);
    if (e.ability === 'dash') {
      this.vx += Math.cos(dir) * e.impulse;
      this.vy += Math.sin(dir) * e.impulse;
      // thruster puff at the mech, opposite the dash
      this.fx.fillStyle(0xffd56b, 0.8).fillCircle(this.px - Math.cos(dir) * 16, this.py - Math.sin(dir) * 16, 6);
      this.time.delayedCall(90, () => this.fx.clear());
    } else if (e.ability === 'shield') {
      this.shieldUntil = this.time.now + e.duration * 1000;
      this._floatText(this.px, this.py - 30, 'SHIELD', '#5ec8e0');
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
  fireWeapon(w) {
    if (!this.scene.isActive()) return;
    const mods = this._buffMods?.() ?? {};
    // #60 Overcharge: while active, weapons don't spend ammo (freeAmmo). Otherwise spend one.
    if (!mods.freeAmmo) this.mech.consumeAmmo(w.location, w.index, 1);

    // The shared delivery sim decides what one trigger pull emits (single / spread fan /
    // tight cluster / multi-pulse burst); each emission is realised from the live muzzle
    // and aim so a slewing turret and aim-assist still apply per sub-shot.
    let plan = planEmissions(w.weapon);
    // #60 Double Shot: every fire emits TWICE for the duration. Each original emission is
    // duplicated with a tiny delay stagger so the pair reads as a genuine double (not one fat
    // shot); spread/cluster offsets are tightened (spreadTighten < 1) so the doubled fan reads
    // as a double rather than just a wider cone.
    if (mods.doubleShot) plan = { ...plan, shots: doubleShotEmissions(plan.shots, mods.spreadTighten ?? 1) };
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
        else if (plan.mode === 'hitscan') this._fireHitscan(w, ox, oy, baseAngle);
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
          if (Audio.getSfxParams(w.weapon.id).trajectory) {
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
  // crescent (shared drawSlash art) instead of a straight line.
  _melee(w, mx, my, angle) {
    const reach = w.weapon.range.max || 32;
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    let target = null, t = 0;
    for (const e of this.enemies) {
      if (e.mech.isDestroyed()) continue;
      const ex = e.x - mx, ey = e.y - my, tt = ex * dirX + ey * dirY, perp = Math.abs(ex * dirY - ey * dirX);
      if (tt > 0 && tt < reach && perp < 44 && (!target || tt < t)) { target = e; t = tt; }
    }
    const color = CATEGORIES[w.weapon.category]?.color ?? 0xcfd6e0;
    if (target) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      this._damageEnemyAt(target, mx + dirX * t, my + dirY * t, dmg, color);
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
    const live = this.beams.find((b) => b.loc === w.location);
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

  _fireHitscan(w, muzzleX, muzzleY, angle) {
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    const color = CATEGORIES[w.weapon.category]?.color ?? 0x9fe8ff;
    const reach = w.weapon.delivery.hit === 'contact' ? (w.weapon.range.max || 32) : 900;

    // Project each living enemy onto the firing ray (forward `t`, perpendicular miss) and
    // take the nearest one actually struck.
    const trace = traceHitscan(muzzleX, muzzleY, angle, reach, this._liveEnemiesForTrace());
    let target = trace.target?.ref ?? null;
    let t = trace.t;
    let hit = !!target;
    let endDist = trace.endDist;
    // Cover: a wall between muzzle and target stops the beam short.
    const wallT = this._hitscanReach(muzzleX, muzzleY, angle, endDist);
    const blocked = wallT < endDist;
    if (blocked) { endDist = wallT; hit = false; }
    const endX = muzzleX + dirX * endDist, endY = muzzleY + dirY * endDist;

    // Persistent beam so sparks can linger after it fades. A continuously-held beam
    // (sustained/stream) keeps ONE beam object that re-pins to the muzzle each shot, so it
    // tracks the mech as it turns/moves; single-shot beams (pulse/rail) push a fresh one.
    const beamTtl = w.weapon.delivery.burst?.wubOn ?? 80;
    const heavy = w.weapon.delivery.kind === 'rail';
    const continuous = w.weapon.delivery.sustained || w.weapon.delivery.pattern === 'stream';
    const live = continuous ? this.beams.find((b) => b.loc === w.location) : null;
    if (live) {
      live.x0 = muzzleX; live.y0 = muzzleY; live.x1 = endX; live.y1 = endY;
      live.ttl = beamTtl;   // age keeps advancing → warble flows continuously
    } else {
      this.beams.push({ x0: muzzleX, y0: muzzleY, x1: endX, y1: endY, color, heavy, ttl: beamTtl, age: 0, loc: continuous ? w.location : null });
    }
    if (hit) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      this._damageEnemyAt(target, endX, endY, dmg, color);
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
  _spawnProjectile(w, x, y, angle, owner = 'player', angleOffset = 0, seekOverride = null, aimAngle = angle) {
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
      // so a fast far-range arc still corners onto the target instead of orbiting it.
      if (round.homing) round.turn = homingTurnRate(round.speed);
    }
    if (owner === 'player') round.homing = round.homing && !!seekTarget;
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
    const pushed = { ...round, owner, trail: [], seekTarget, originHexes };
    this.projectiles.push(pushed);
    return pushed;
  },
};
