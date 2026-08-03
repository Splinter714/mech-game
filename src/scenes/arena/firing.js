// Arena firing mixin — turning a trigger pull into shots: per-slot/ability handling pulled
// out of update(), the fire dispatch (hitscan beam / melee swing / travelling round), and
// the per-shot helpers (cadence, range falloff, ability activation). Methods use `this`
// (the ArenaScene); composed onto the prototype via Object.assign.
import { CATEGORIES } from '../../data/categories.js';
import {
  isPlayerRef, livePlayersOf, otherLivePlayers, primaryPlayerOf,
} from './players.js';
import { planEmissions, makeProjectile, arrivalSpeedMultiplier, homingTurnRate, arcMaxDist, scatterMaxDist, wrapAngle, chargeConeAngleDeg, chargeWedgeAlpha, nearestChainTarget, beamSpawnFor } from '../../data/delivery.js';
import { computeImpulse } from '../../data/force.js';
import { isMobileEnemy } from '../../data/bases.js';
import { traceHitscan, traceHitscanPiercing } from '../../data/beamTrace.js';
import { canFireWeapon } from '../../data/targetlock.js';
import { drawSlash, drawChargeWedge } from '../../art/index.js';
import { Audio } from '../../audio/index.js';
import { TRAJECTORY_DELAY, hasHeldSfx, WEAPON_TRAJECTORY_SOUNDS_ENABLED } from '../../audio/sfxParams.js';
// #224 (temporary): WEAPON_TRAJECTORY_SOUNDS_ENABLED gates the in-flight trajectory loop
// below — see sfxParams.js for the full list of gated call sites and how to revert.
import { scheduleFireCues } from '../../audio/fireCues.js';
import { updateSprintFuel } from '../../data/sprint.js';
import { updateAbilities } from './abilities.js';
import { isPlayerStealthed } from './stealth.js';
import { targetHexKeyOf } from './shared.js';
import { targetCoverExempt, targetSoftCoverExempt } from '../../data/visibility.js';

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

  // #426: the SOFT-cover-only sibling of the above — also true while the lock is a wall turret,
  // so foliage never eats a shot aimed at one, exactly like a flyer. Deliberately NOT folded into
  // `_shotIgnoresCover`: that one also short-circuits the WALL trace (`wallT = Infinity`), and a
  // wall turret's own wall must still block a shot from behind it. This only feeds the soft-cover
  // block (`_softCoverBeamBlock`'s `airAimed`, and the round's own `airTarget` flag).
  _shotIgnoresSoftCover(owner = 'player', player = primaryPlayerOf(this)) {
    return owner === 'player' && targetSoftCoverExempt(player.convergeTarget);
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
    // #493: per-slot charge state for chargeable weapons. #627 gave it a genuine THIRD state —
    // { charging, elapsed, aimDrift, lastAim, beaming, beamCd } — so Charge Beam can go
    // charging → beaming (full charge, trigger still down) → released. See `_handleChargeFire`.
    player.chargeState ??= {};
    // Live-chat ask: a HUD tile should show when its weapon is actively firing. General on
    // purpose (unlike `heldAudio`, which is narrowed to held-SFX weapons only) — true whenever
    // the trigger is down and the weapon can actually fire, single-shot or continuous alike.
    // Chargeable weapons set their own (see `_handleChargeFire` below, `state.charging`).
    player.firingNow ??= {};
    // Stamp the frame we read the fire input, so the SFX latency debug (window.__sfxDebug)
    // can measure our code-path cost from here to the audio node's start().
    Audio.markTrigger();
    // #409: INFINITE FIRE suppresses the reload gate — an online weapon is treated as ready even
    // mid-reload / dry (its ammo cost is skipped too, in fireWeapon). Otherwise `w.ready` stands.
    const noReload = !!this._buffMods?.().noReload;
    for (const w of player.mech.weapons()) {
      const fireReady = w.ready || (noReload && w.online);
      // #493: a chargeable weapon (delivery.chargeable) bypasses the normal auto-repeat-on-
      // cooldown model entirely — hold to charge, release to fire, no held-beam/held-audio
      // tracking (neither applies to a single charged shot). See `_handleChargeFire` below.
      if (w.weapon.delivery.chargeable) {
        this._handleChargeFire(w, intent, delta, player, fireReady);
        continue;
      }
      let cd = (player.fireCooldowns[w.location] ?? 0) - delta;
      if (intent.fire[w.location] && cd <= 0 && fireReady) {
        this.fireWeapon(w, player);
        cd = this._fireInterval(w.weapon);
      }
      player.fireCooldowns[w.location] = Math.max(0, cd);
      player.firingNow[w.location] = !!(intent.fire[w.location] && fireReady);

      // Continuous beam visual tracking (#86): a held sustained/stream hitscan (the beam
      // laser) only re-pins its beam line on the block above, which runs at the WEAPON's own
      // fire cadence (e.g. 20Hz) — well below the render frame rate. That made the beam step
      // between angles as the turret swept instead of following it smoothly. This runs every
      // render frame regardless of cadence and re-aims the beam's existing line at the current
      // muzzle/angle; it's purely visual — damage still only applies on the cadence above.
      if (intent.fire[w.location] && fireReady && this._isHeldBeam(w.weapon)) this._trackHeldBeam(w, player);

      // Held/looping fire sound (#53): a genuinely continuous weapon (flamethrower/beam
      // laser, hasHeldSfx) starts its loop on the rising edge (button just pressed) and
      // stops it on the falling edge — button released, OR the weapon ran dry / went
      // offline while held (ammo depleted, part destroyed).
      const held = intent.fire[w.location] && fireReady && hasHeldSfx(w.weapon.id);
      // #348: the held-loop key is per player — two players holding the same weapon in the
      // same slot each own their own loop instead of stopping each other's.
      const audioKey = `${player.id}:${w.location}`;
      const wasHeld = player.heldAudio[w.location];
      if (held && !wasHeld) Audio.startHeld(audioKey, w.weapon.id);
      else if (!held && wasHeld) Audio.stopHeld(audioKey);
      player.heldAudio[w.location] = held;
    }
  },

  // ── Hold-to-charge firing (#493) ── holding the trigger accumulates charge (capped at
  // `chargeable.maxTime`); releasing fires ONE shot scaled between `minDamageMult` (at
  // `minTime`) and `maxDamageMult` (at `maxTime`). Releasing before `minTime` wastes the charge
  // — no shot, no ammo spent — so a twitch-tap does nothing on purpose; this is a commitment
  // weapon, not a faster machine gun.
  // Playtest correction (2026-07-25): reaching `maxTime` used to auto-fire immediately. Jackson:
  // "should fire on release, not fire after a duration." Charge now just HOLDS at the cap —
  // nothing is lost by holding past it — and only actually fires on the real button release.
  // While charging, this also tracks how much the AIM ANGLE drifted (see `_fireAngle`) — a
  // steady hold releases a tight, accurate shot; a hold where the reticle wandered releases a
  // wider, less accurate one (`_releaseCharge` turns the accumulated drift into `chargeSpread`).
  // ── #627, the third state ── a `chargeable` weapon that ALSO declares `delivery.beam`
  // (Charge Beam) doesn't just sit at the cap once full: `charging → beaming → released`. Reaching
  // `chargeable.maxTime` with the trigger still down spins up a sustained hitscan beam that ticks
  // on its own `beam.fireRate` cadence (`_tickChargeBeam`), and the release path below then fires
  // the lance exactly as it always has. Charge Lance declares no `beam`, so every branch guarded on
  // it is dead code for that weapon and its behaviour is byte-for-byte unchanged.
  _handleChargeFire(w, intent, delta, player, fireReady) {
    const dt = delta / 1000;
    const held = !!intent.fire[w.location];
    const state = (player.chargeState[w.location] ??= {
      charging: false, elapsed: 0, aimDrift: 0, lastAim: null, beaming: false, beamCd: 0,
    });
    const charge = w.weapon.delivery.chargeable;
    const beam = w.weapon.delivery.beam ?? null;
    if (held && fireReady) {
      if (!state.charging) {
        resetChargeState(state);
        state.charging = true;
        // #627 UP-FRONT CHARGE COST: a hold spends `chargeable.ammoCost` rounds the instant it
        // begins, out of the same single pool the beam then drains. Charge Lance sets no
        // `ammoCost`, so this is a no-op for it (its shot still costs the usual 1 in fireWeapon).
        // Skipped under INFINITE FIRE, same as every other ammo spend.
        const upFront = charge.ammoCost ?? 0;
        if (upFront > 0 && !this._buffMods?.().freeAmmo) {
          player.mech.consumeAmmo(w.location, w.index, upFront);
        }
      }
      player.firingNow[w.location] = true;   // charging reads as "firing" on the HUD tile too
      state.elapsed = Math.min(charge.maxTime, state.elapsed + dt);
      // Optional chaining: a few unit tests (chargeFire.test.js) drive this state machine against
      // a minimal fake scene with no muzzle/aim system at all, on purpose — they're scoped to the
      // charge timing, not real aim. A real ArenaScene always has both, so drift tracking is live
      // in play; a test double without them just never accumulates any (chargeSpread stays 0).
      const m = this._muzzle?.(w.location, player);
      const aim = m ? this._fireAngle(w, m, player) : null;
      if (aim != null) {
        if (state.lastAim != null) state.aimDrift += Math.abs(wrapAngle(aim - state.lastAim));
        state.lastAim = aim;
      }
      // Full charge reached and the trigger is STILL down: the beam phase.
      if (beam && state.elapsed >= charge.maxTime) this._tickChargeBeam(w, player, state, beam, delta);
      return;
    }
    // Not held (a real release) or no longer fireReady (e.g. ammo ran out mid-charge) — resolve
    // whatever charge had accumulated, if any.
    this._stopChargeBeam(w, player, state);
    player.firingNow[w.location] = false;
    // #627 DRAINED DRY — the deliberate edge case, and the whole point of the shared pool: if the
    // beam ate the magazine before the trigger came up there is nothing left to pay for the
    // finisher, so NO lance fires. `fireReady` is already false here (a mag hitting 0 auto-starts
    // the 2s reload, Mech.consumeAmmo), so the player gets the normal empty/reloading feedback plus
    // the beam visibly cutting out. Scoped to beam weapons on purpose — a Charge Lance that runs
    // dry mid-charge still looses its shot exactly as before.
    if (beam && !fireReady && state.charging) { resetChargeState(state); return; }
    // Live-chat ask (2026-07-31): "remove the minimum charge [requirement] for firing." A release
    // below `chargeable.minTime` used to throw the charge away silently — the trigger pull did
    // nothing at all, which is the same dead-button problem the homing lock gate had. Now EVERY
    // release fires; a tap simply lands at `minDamageMult`, because `_releaseCharge`'s ramp
    // fraction already clamps negative values to 0.
    //
    // `minTime` is therefore no longer a firing GATE — it survives purely as the anchor the damage
    // ramp measures from (see `_releaseCharge`), so the existing charge curve is unchanged above it.
    // Left in the data rather than zeroed for exactly that reason: setting it to 0 would silently
    // re-scale the whole ramp and buff every short hold, which is not what was asked for.
    if (state.charging) this._releaseCharge(w, player, state);
  },

  _releaseCharge(w, player, state) {
    const { minTime, maxTime, minDamageMult = 1, maxDamageMult = 1, maxSpreadDeg = 20 } = w.weapon.delivery.chargeable;
    const frac = maxTime > minTime ? (state.elapsed - minTime) / (maxTime - minTime) : 1;
    const mult = minDamageMult + (maxDamageMult - minDamageMult) * Math.max(0, Math.min(1, frac));
    // Aim drift accumulated over a ~1.6s hold rarely exceeds a couple radians for a genuinely
    // steady hand; normalize against a generous "definitely wandered" reference so a rock-steady
    // hold reads as ~0 spread and an actively-swept aim reads as close to the weapon's max.
    const DRIFT_REFERENCE = 1.2; // rad of accumulated drift treated as "fully unsteady"
    const unsteadiness = Math.max(0, Math.min(1, state.aimDrift / DRIFT_REFERENCE));
    const chargeSpread = (unsteadiness * maxSpreadDeg * Math.PI) / 180;
    // #493 follow-up: the fired burst should look like whatever cone the telegraph was
    // showing the instant the button came up — same `elapsed / maxTime` fraction
    // `_drawChargeFor` feeds `chargeConeAngleDeg`, so a shot loosed mid-charge visibly bursts
    // as the wide cone it actually was, and only a full-charge release (frac 1 → 0°) still
    // looks like the clean tight beam.
    const elapsedFrac = maxTime > 0 ? Math.max(0, Math.min(1, state.elapsed / maxTime)) : 1;
    const chargeConeDeg = chargeConeAngleDeg(elapsedFrac);
    this.fireWeapon(w, player, { chargeMult: mult, chargeSpread, chargeConeDeg });
    resetChargeState(state);
  },

  // ── #627 beam phase ── one damage tick per `beam.fireRate`, plus a per-render-frame re-pin of
  // the drawn beam so it follows the turret between ticks (the same #86 problem the Beam Laser
  // has, solved the same way — `_trackHeldBeam`). Each tick is an ordinary `fireWeapon` pull, so
  // it spends one magazine round, books one shot for accuracy stats, breaks Cloak and honours
  // cover/soft-cover exactly like any other shot. Two deviations, both passed as options:
  // `damageOverride` (the beam's own small per-tick damage, not the lance's) and `cue: false` /
  // `beamTick: true` (one continuous beam object and one continuous LOOP, instead of 20 one-shot
  // zaps a second stuttering over each other).
  _tickChargeBeam(w, player, state, beam, delta) {
    if (!state.beaming) {
      state.beaming = true;
      state.beamCd = 0;
      if (beam.sfxId) Audio.startHeld(chargeBeamAudioKey(player, w.location), beam.sfxId);
    }
    state.beamCd -= delta;
    if (state.beamCd <= 0) {
      state.beamCd = beam.fireRate > 0 ? 1000 / beam.fireRate : 100;
      this.fireWeapon(w, player, { damageOverride: beam.damage, cue: false, beamTick: true });
    }
    this._trackHeldBeam(w, player);
  },

  // End the beam phase (trigger released, ran dry, went offline, or the player died). Safe to call
  // when no beam is running — the common case, and every call for a non-beam charge weapon.
  _stopChargeBeam(w, player, state) {
    if (!state?.beaming) return;
    state.beaming = false;
    state.beamCd = 0;
    if (w.weapon.delivery.beam?.sfxId) Audio.stopHeld(chargeBeamAudioKey(player, w.location));
  },

  // #493 playtest follow-up (2026-07-25) — Jackson: "the charge visual doesn't start super wide
  // like it should; I feel like it should start at maybe 90 degrees and then slowly become a
  // straight beam." The telegraph now draws a filled WEDGE (cone), apex at the muzzle, whose
  // full angle comes from `chargeConeAngleDeg` (delivery.js) — 90° at the start of a hold,
  // easing down to 0° by full charge. At 0° the wedge's fill vanishes and its two stroked edges
  // land on each other, so the cone becomes a single centre line — one continuous cone-to-beam
  // narrowing, not a snap between two different drawings. Purely visual; drawn fresh
  // every frame into the scene's dedicated `chargeFx` layer (cleared once per frame by
  // `_updateChargeVisuals` below, called once for the whole scene rather than per-player/slot).
  _drawChargeFor(player) {
    for (const [location, state] of Object.entries(player.chargeState || {})) {
      if (!state.charging) continue;
      // #627: once Charge Beam's beam is actually live, the telegraph has done its job — the real
      // beam IS the visual from then on. Drawing both would stack the telegraph's opaque
      // full-charge line over the beam's first 360px and read as two overlapping beams, and lose the
      // "the cone collapsed into a beam" moment that sells the phase change.
      if (state.beaming) continue;
      const w = player.mech.weapons().find((ww) => ww.location === location);
      if (!w || !w.weapon.delivery.chargeable) continue;
      const { maxTime } = w.weapon.delivery.chargeable;
      const frac = maxTime > 0 ? Math.max(0, Math.min(1, state.elapsed / maxTime)) : 1;
      const m = this._muzzle(location, player);
      const angle = this._fireAngle(w, m, player);
      // 2026-08-01 playtest (Jackson: "the release range and visual charge range for charge beam
      // should be the same"). This used to be `40 + range.max * 0.5 * frac` — HALF the weapon's
      // real reach, so a fully-charged Charge Beam telegraphed 360px and then fired 640px. The
      // telegraph now runs to the same `range.max` the hitscan trace actually uses (see
      // `_fireHitscan`'s own `reach`), so what you aim is what you get. Applies to every chargeable
      // weapon, Charge Lance included — same shared telegraph, same bug, same fix.
      const reach = 40 + ((w.weapon.range.max || 400) - 40) * frac;
      const color = CATEGORIES[w.weapon.category]?.color ?? 0x9fe8ff;
      const g = this.chargeFx;

      // #493 follow-up: rounded far edge + distance-based opacity fade (opaque near the
      // mech, transparent at the tip) — see `drawChargeWedge` (art/projectileArt.js), shared
      // with the fired-burst visual below so both read as the same visual language.
      //
      // #630: this is now the WHOLE telegraph. The separate centre convergence line that used to
      // be drawn over it is gone — the wedge's own two stroked sides converge into that line on
      // their own as the cone shuts, so there is one element instead of two derived independently
      // (which is what produced both of this telegraph's previous playtest bugs). `minHalfPx`-style
      // geometry surgery turned out to be unnecessary; only `drawChargeWedge`'s small-angle
      // early-out had to go.
      //
      // Alpha comes from `chargeWedgeAlpha` (delivery.js) rather than the flat `0.1 + frac * 0.15`
      // this used to pass: with the core line deleted, the wedge has to carry the convergence
      // moment itself, so its opacity ramps up as the cone narrows — diffuse haze while wide,
      // bright focused line once collapsed. It is derived from the cone's own angle, the same
      // quantity driving the shape, so the two cannot drift apart.
      drawChargeWedge(g, m.x, m.y, angle, chargeConeAngleDeg(frac), reach, color, chargeWedgeAlpha(frac));
    }
  },

  _updateChargeVisuals() {
    this.chargeFx.clear();
    for (const player of this.players) {
      // #627: a player who dies mid-hold never runs `_handleFiring` again (ArenaScene.update skips
      // dead players), so nothing would ever clear their charge state — the telegraph would keep
      // drawing at the corpse's last muzzle and a Charge Beam loop would hum until the arena shut
      // down. This runs scene-level every frame, dead players included, so it's the one place that
      // can close both out.
      if (player.dead) this._clearChargeState(player);
      else this._drawChargeFor(player);
    }
  },

  // Drop every live charge/beam on this player's slots (see `_updateChargeVisuals`).
  _clearChargeState(player) {
    for (const [location, state] of Object.entries(player.chargeState || {})) {
      if (state.beaming) {
        state.beaming = false;
        state.beamCd = 0;
        Audio.stopHeld(chargeBeamAudioKey(player, location));
      }
      if (state.charging) resetChargeState(state);
    }
  },

  // ── Manual reload (#402) ── R3/F tops off ALL of this player's weapons at once (the auto-
  // reload on empty is handled in the pure model, Mech.consumeAmmo). `intent.reloadPressed` is
  // already rising-edge-detected in Controls.js (one edge per physical press, on whichever device
  // is active), so this fires once per press. Per player: it reads THIS player's controls and
  // reloads THIS player's mech, so in co-op each driver reloads only their own guns. A no-op when
  // nothing is eligible (every mag already full/reloading, or only unlimited weapons mounted).
  _handleReload(intent, player = primaryPlayerOf(this)) {
    if (!intent?.reloadPressed) return;
    const started = player.mech.reloadAllWeapons();
    if (started > 0) Audio.ui('sprintOn');   // reuse the movement-ability "engaged" cue as a reload chirp
  },

  // ── Sprint (#188, player-trigger removed by #261) ── the Sprint state machine
  // (data/sprint.js) itself is UNCHANGED — it's still a depleting/regenerating fuel bar that
  // drains while active and refills while inactive, hitting empty forces it off. What's gone is
  // the player's own means of turning it on: #261 replaced L3/Space's player-facing ability with
  // a Dash (#506: now just one mountable ability among several, see `_handleAbilities` below and
  // scenes/arena/abilities.js) and removed manual Sprint entirely. The
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

  // ── Abilities (#506) ── the mountable ability slots (data/anatomy.js ABILITY_SLOTS, now just
  // Y/X — see anatomy.js), one per face button. `intent.ability[slot]` is already
  // rising-edge-detected by Controls.js
  // (one edge per physical press, on whichever device is currently active). Replaces the old
  // hardcoded `_handleDash` (#261) — Dash is now just the 'dash' effect kind, mounted like any
  // other ability; see scenes/arena/abilities.js for the generic state-machine wiring and
  // per-effect dispatch (currently just 'dash') that used to live here.
  // #348: per player — each player's own slots, own bursts, own cooldowns.
  _handleAbilities(intent, delta, player = primaryPlayerOf(this)) {
    updateAbilities(this, intent, delta, player);
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
  // #493: `chargeMult` (default 1, from `_releaseCharge` for a chargeable weapon) scales this
  // shot's damage WITHOUT mutating the shared WEAPONS registry entry — `w` is reassigned to a
  // shallow clone carrying a scaled `weapon.damage` for the rest of this call only, so every
  // read below (planEmissions, _spawnProjectile, _fireHitscan, _melee) picks it up for free.
  // `chargeSpread` (radians, default 0): an extra random angular jitter applied to this shot's
  // launch angle, from how much the aim drifted during a charge hold (`_releaseCharge`) — 0 for
  // every non-charging trigger pull.
  // `chargeConeDeg` (degrees, default 0): the charge telegraph's cone width AT THE MOMENT OF
  // RELEASE (`_releaseCharge`) — threaded down to `_fireHitscan`'s beam so the burst visual
  // reflects how charged the shot actually was, not just its damage. 0 for every non-charging
  // trigger pull, and for a full-charge release (the cone has narrowed to a clean beam by then).
  // #627 (Charge Beam's beam phase, `_tickChargeBeam`), three options that only that caller passes:
  // `damageOverride` (absolute per-shot damage, replacing `chargeMult`'s relative scaling — the
  // beam's small per-tick damage has nothing to do with the lance's), `cue: false` (this tick's
  // sound comes from a held LOOP, so don't also schedule a one-shot zap 20x a second), and
  // `beamTick: true` (treat the shot as CONTINUOUS — one persistent beam object re-pinned per tick
  // — even though the weapon's own delivery is a single-shot lance, not a `sustained`/`stream` one).
  fireWeapon(w, player = primaryPlayerOf(this), { chargeMult = 1, chargeSpread = 0, chargeConeDeg = 0, damageOverride = null, cue = true, beamTick = false } = {}) {
    if (!this.scene.isActive()) return;
    if (damageOverride != null) w = { ...w, weapon: { ...w.weapon, damage: damageOverride } };
    else if (chargeMult !== 1) w = { ...w, weapon: { ...w.weapon, damage: w.weapon.damage * chargeMult } };
    // #77, rework #252, #341: a tracking (homing) weapon with no target USED to not fire at all —
    // the trigger pull was a silent no-op. Live-chat ask (2026-07-31) reversed that: "both locking
    // missile types should still be able to dumb-fire." So Swarm Rack and Streak Pod now fire
    // unlocked and their rounds simply fly straight (`_spawnProjectile` only sets `homing` when
    // there IS a seek target). `canFireWeapon` is retained as the seam that answers "is the lock
    // stopping this shot?" — see data/targetlock.js — but today it always says no.
    if (!canFireWeapon(w.weapon, player.convergeTarget)) return;
    // #316 reverses #245/#257: there used to be a cover exemption here — when the player's
    // convergence pick was a FLYING enemy, the player's shot ignored terrain cover (mirroring
    // #245, which let a flyer's own shots ignore it). Both directions are gone. Cover is cover
    // for everyone: the player's rounds stop on a wall whether the thing they're aimed at flies
    // or not, and a flyer's rounds do the same. There is no per-shot cover-exemption flag left in
    // this file — the wall trace / in-flight wall check below run unconditionally.
    const mods = this._buffMods?.() ?? {};
    // #409 free ammo: only INFINITE FIRE grants it (reverting #381's universal window). While it's
    // active weapons don't spend ammo AND ignore the reload gate (see _handleFiring). Otherwise
    // spend a shot's worth,
    // scaled by cycleMult (#235): Overdrive's cycleMult 0.5 halves the fire interval (shots go out
    // ~2x as often), so scaling consumption by the same factor spends 0.5 ammo/shot — exactly
    // offsetting the faster rate for a net-neutral ammo economy, distinct from free ammo's true
    // unlimited fire. Outside Overdrive cycleMult is 1, so this is the same flat 1-ammo spend.
    const cost = mods.cycleMult ?? 1;
    // #423: one trigger pull = one shot fired (regardless of how many projectiles it emits). The
    // returned pull id is threaded to this pull's emissions so a connecting one books the hit
    // exactly once (accuracy). Null on a stubbed test scene with no accumulator.
    const pullId = this._statShotFired?.(w.weapon.id, player) ?? null;
    // (#622/#623 also minted a `pairId` here — an id shared by every round one trigger pull spawns,
    // used to group Link Pylons' launch volley into a single web. #624 made linking field-wide, and
    // #626 deleted linking outright in favour of independent per-tower zapping, so it's gone: no
    // reader remained anywhere.)
    // #500 (playtest follow-up — Jackson: "make cloak last until you fire a weapon instead of
    // lasting a finite amount of time"): the shot that breaks Cloak. Latched on THIS player (co-op:
    // only your own fire drops your own cloak) and consumed by the next ability tick
    // (scenes/arena/abilities.js `updateAbilities`), which runs the break through the same state
    // machine and deactivate edge as any other transition — see the latch's comment there.
    //
    // Deliberately keyed on a REAL SHOT, not a trigger press: this line is only reached once the
    // weapon was ready, in cadence and paid for its ammo, so pulling the trigger on an empty or
    // reloading gun leaves the cloak up. Every firing path funnels through here (auto-repeat, held
    // beams, melee, and a released charge via `_releaseCharge`), so all four triggers count and
    // ONLY weapon triggers do — activating another ability never touches this.
    player.weaponFired = true;

    // #103 noise-aggro: a real shot just went off at the player's position — unaware enemies
    // within NOISE_AGGRO_RANGE of this instant become AWARE (see data/awareness.js), regardless
    // of line-of-sight. Just a timestamp + position; enemies.js reads it each frame.
    // #500/#507: a stealthed shooter (Cloak active, or standing in ANY player's Smoke Screen
    // cloud) doesn't latch this at all — the shot still fires and still deals damage, it just
    // doesn't give the shooter away to a dormant enemy nearby.
    //
    // #500 (playtest follow-up): now that firing is what BREAKS Cloak, the Cloak half of this only
    // covers the one shot that does the breaking (the latch above is consumed a frame later) —
    // near-inert, and deliberately kept anyway (raised with Jackson, who chose "any weapon fire"
    // regardless). The SMOKE SCREEN half is untouched and fully live: a shooter standing in a
    // cloud still fires silently for as long as they stay in it.
    if (!isPlayerStealthed(this, player)) {
      this._lastFireAt = this.time.now;
      // #347/#348: the NOISE source that wakes enemies — whoever actually fired.
      this._lastFireX = player.x;
      this._lastFireY = player.y;
    }

    // The shared delivery sim decides what one trigger pull emits (single / spread fan /
    // tight cluster / multi-pulse burst); each emission is realised from the live muzzle
    // and aim so a slewing turret and aim-assist still apply per sub-shot.
    // #137 Barrage: `countMult` (2 while active) scales the weapon's delivery.count, so one
    // trigger pull emits twice as many things — a wider fan, more parallel lanes, a longer
    // burst — through each pattern's own existing expansion. Outside Barrage it's 1, i.e. the
    // exact plan as before. (Ammo is spent per trigger pull above, not per emitted shot.)
    const plan = planEmissions(w.weapon, { countMult: mods.countMult ?? 1 });
    // #434 PER-BOLT AMMO: a volley weapon (Plasma Arc, delivery.ammoPerShot) spends ONE round per
    // emitted bolt instead of the flat one-round-per-pull every other weapon uses — and TRUNCATES its
    // volley to whatever the magazine can afford, so a pull that can't cover the whole volley fires
    // only the rounds it has and the emptied mag then reloads (Mech.consumeAmmo auto-triggers reload
    // at empty). `w.ammo` is this slot's live magazine (null = unlimited). The whole branch is skipped
    // under free ammo (INFINITE FIRE) — those pulls spend nothing and are never truncated. Every other
    // weapon keeps the historic flat spend below.
    if (!mods.freeAmmo && w.weapon.delivery.ammoPerShot && w.ammo != null) {
      const affordable = Math.max(0, Math.min(plan.shots.length, Math.floor(w.ammo / cost)));
      if (affordable < plan.shots.length) plan.shots = plan.shots.slice(0, affordable);
      player.mech.consumeAmmo(w.location, w.index, affordable * cost);
    } else if (!mods.freeAmmo) {
      player.mech.consumeAmmo(w.location, w.index, cost);
    }
    // #307: a held continuous beam keeps one persistent beam object PER LANE (see
    // `_fireHitscan`). When Barrage expires mid-hold the plan drops from n lanes back to 1, so
    // retire any beam whose lane no longer exists rather than leaving it hanging in place
    // (it would otherwise sit frozen at its last position until its ttl ran out).
    // #627: a Charge Beam beam tick keeps the same per-lane persistent beams, so it needs the same
    // stale-lane retirement — `_isHeldBeam` is false for it (its delivery is a single-shot lance).
    if (plan.mode === 'hitscan' && (beamTick || this._isHeldBeam(w.weapon))) {
      this._retireStaleBeamLanes(playerBeamKey(player), w.location, plan.shots.length);
    }
    // The fire + trajectory AUDIO cues (t=0 cue, per-burst-pulse retriggers, and the
    // trajectory beat) are scheduled in one shared place (audio/fireCues.js) that the Weapon
    // Lab preview calls too, so their timing can't drift; the arena always plays (audible:
    // true). Held/looping weapons (flamethrower/beam laser) get their sound from their loop
    // instead — scheduleFireCues no-ops for them, as it does for the delay:0-only case.
    if (cue) scheduleFireCues(this, w.weapon, plan, true);
    for (const [lane, s] of plan.shots.entries()) {
      const go = () => {
        if (!this.scene.isActive()) return;
        const m = this._muzzle(w.location, player);
        const aimAngle = this._fireAngle(w, m, player);
        // #493: an unsteady charge hold adds a random jitter to the actual launch angle — a
        // steady hold's chargeSpread is 0, so this is a no-op for every ordinary trigger pull.
        const jitter = chargeSpread ? (Math.random() - 0.5) * chargeSpread : 0;
        const baseAngle = aimAngle + s.angleOffset + jitter;
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
        if (plan.mode === 'contact') this._melee(w, ox, oy, baseAngle, 'player', player, { pullId });
        else if (plan.mode === 'wave') this._fireWave(w, ox, oy, baseAngle, player);
        // #307: `lane`/`lateral` let a continuously-held beam own ONE persistent beam object
        // PER PARALLEL LANE — under Barrage the beam laser plans 2 lanes, and without this
        // both lanes shared a beam key so the second silently overwrote the first's endpoints
        // (two shots fired, one line drawn).
        else if (plan.mode === 'hitscan') this._fireHitscan(w, ox, oy, baseAngle, 'player', playerBeamKey(player), { lane, lateral: s.lateral, shooter: player, pullId, burstConeDeg: chargeConeDeg, continuous: beamTick });
        else {
          // Pass the weapon's un-offset aim angle (aimAngle) alongside this shot's actual
          // launch angle (baseAngle) — see _spawnProjectile's arcing maxDist comment for why
          // a wide-fan shot (Swarm Rack) needs the CENTRE bearing for its target-ahead test.
          const round = this._spawnProjectile(w, ox, oy, baseAngle, 'player', s.angleOffset, null, aimAngle, player, { pullId, distOffset: s.distOffset, slot: s.slot });
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
  _melee(w, mx, my, angle, owner = 'player', shooter = primaryPlayerOf(this), meta = {}) {
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
    const color = CATEGORIES[w.weapon.category]?.color ?? CATEGORIES.energy.color;
    if (target) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      if (owner === 'enemy' || isPlayerRef(this, target)) {
        this._damagePlayerAt(dmg, target, { enemyKind: meta.statKind ?? null, weaponId: w.weapon.id, shotId: meta.statShotId ?? null, spawnerKind: meta.spawnerKind ?? null });
      } else {
        this._damageEnemyAt(target, mx + dirX * t, my + dirY * t, dmg, color, false, { weaponId: w.weapon.id, pullId: meta.pullId ?? null });
      }
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

  // #499: Repulsor Pulse's "front-facing wave" — resolves INSTANTLY at the muzzle rather than
  // spawning a travelling round. Every living enemy within `delivery.force.radius` AND inside a
  // `coneDeg`-wide forward cone off `angle` takes a small direct hit and gets shoved by the same
  // push/pull math a travelling force round would tick (data/force.js `computeImpulse`), just
  // applied once instead of over a flight. Player-fired only, matching #491/#499's original
  // scope (no force weapon has been asked for on the enemy side).
  _fireWave(w, mx, my, angle, player) {
    const { radius, strength, sign, coneDeg = 100 } = w.weapon.delivery.force;
    const halfCone = (coneDeg * Math.PI / 180) / 2;
    const color = CATEGORIES[w.weapon.category]?.color ?? 0x9fe8ff;
    for (const e of this.enemies) {
      if (e.mech.isDestroyed()) continue;
      const ex = e.x - mx, ey = e.y - my;
      const dist = Math.hypot(ex, ey);
      if (dist >= radius || dist < 1) continue;
      if (Math.abs(wrapAngle(Math.atan2(ey, ex) - angle)) > halfCone) continue;
      // #491 playtest fix: same stationary-kind exclusion as the pull-side hazard/travel-force
      // ticks in projectiles.js — a turret/wallTurret still takes the wave's damage, it just
      // never gets shoved off its mount.
      if (isMobileEnemy(e)) {
        const { dx, dy } = computeImpulse(mx, my, radius, strength, sign, e.x, e.y, 1);
        e.x += dx; e.y += dy;
      }
      const dmg = Math.max(1, Math.round(w.weapon.damage * (1 - dist / radius)));
      this._damageEnemyAt(e, e.x, e.y, dmg, color, false, { weaponId: w.weapon.id });
    }
    // Sweeping crescent (shared drawSlash art, same as melee) sized to the wave's real radius —
    // reads as a shockwave fanning out in front of the mech rather than a single swing.
    for (const tt of [0.1, 0.35, 0.65, 1.0]) {
      this.time.delayedCall(tt * 120, () => {
        if (!this.scene.isActive()) return;
        this.fx.clear();
        drawSlash(this.fx, mx, my, angle, tt, color, 1, radius);
      });
    }
    this.time.delayedCall(140, () => this.fx.clear());
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
      // #627: mirror `_fireHitscan`'s own pierce branch — a PIERCING held beam (Charge Beam) rests
      // at its raw reach rather than stopping at the nearest body, so the drawn line doesn't snap
      // short onto the first enemy between damage ticks while the damage rakes straight through it.
      const trace = w.weapon.delivery.pierce
        ? { endDist: Math.min(reach, 600) }
        : traceHitscan(mx, my, angle, reach, this._liveTargetsForTrace('player', player));
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
  // `burstConeDeg` (#493 follow-up, degrees, default 0): the charge-lance's release-time cone
  // width — stamped onto the beam so the draw loop (projectiles.js `_updateBeams`) can burst it
  // as a wide, faded wedge instead of a clean beam. 0 for every non-charging weapon/shot, so
  // their beams render exactly as before.
  // `continuous` (#627, optional): force the ONE-persistent-beam-object treatment for a shot whose
  // weapon isn't `sustained`/`stream` in its own data — Charge Beam's beam phase, which is a
  // single-shot lance entry ticked as a held beam by `_tickChargeBeam`. Every other caller leaves
  // it false and the flag is derived from the weapon's delivery exactly as before.
  _fireHitscan(w, muzzleX, muzzleY, angle, owner = 'player', shooterKey = 'player', { lane = 0, lateral = 0, ignoreSpanKey = null, shooter = null, pullId = null, statKind = null, statShotId = null, spawnerKind = null, burstConeDeg = 0, continuous: forceContinuous = false } = {}) {
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    const color = CATEGORIES[w.weapon.category]?.color ?? 0x9fe8ff;
    const reach = w.weapon.delivery.hit === 'contact' ? (w.weapon.range.max || 32) : 900;
    // #537: Charge Lance opts into `pierce` — it hits EVERY living target along the beam, not
    // just the nearest one, so it doesn't stop resolving at the first body the way every other
    // hitscan weapon does below. It still gets stopped by a wall exactly like any other beam
    // (see wallT/blocked further down) — pierce only changes what happens to bodies, not cover.
    const pierce = !!w.weapon.delivery.pierce;
    const targets = this._liveTargetsForTrace(owner, shooter);

    // Project each living target onto the firing ray (forward `t`, perpendicular miss) and
    // take the nearest one actually struck. A piercing weapon skips this single-target pick
    // entirely — its resting distance (before wall clamping below) is just its raw reach, and
    // which targets it actually hits is resolved separately, after the final wall-clamped
    // endDist is known (see the `pierce` branch at the bottom of this method).
    const trace = pierce
      ? { target: null, t: 0, endDist: Math.min(reach, 600) }
      : traceHitscan(muzzleX, muzzleY, angle, reach, targets);
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
    // #426: the target-span exemption only fires from the EXPOSED side of that span — a shot
    // aimed at a wall turret from behind its own wall (inside the compound) gets no pass and is
    // blocked exactly like any other shot at any other span. `ignoreSpanKey` (an explicit caller
    // override, e.g. the turret's OWN beam firing off its centreline) is untouched by this — that
    // is a different rule (#310) and stays unconditional.
    // #426 (revised): wall turrets behave like a FLYING UNIT — always hittable, so the turret's
    // own wall span is ignored from ANY side, including from inside the compound (the earlier
    // exposed-side-only rule wrongly made turrets unshootable from behind their own wall).
    const exposedTargetSpanKey = targetSpanKey;
    const wallT = this._shotIgnoresCover(owner, shooter ?? primaryPlayerOf(this)) ? Infinity
      : this._hitscanReach(muzzleX, muzzleY, angle, endDist, ignoreSpanKey ?? exposedTargetSpanKey);
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
    // #427 (supersedes #412's gate-pip clamp): an OPEN gate is now solid to a beam via `blocksShot`
    // in the wall trace above, so `_hitscanReach` already clamps the beam on it like any other span
    // and the generic `blocked` branch below chips it through `_damageBuildingAt`/`nearestWallEdge`
    // (which now route to open gates too). No locked-pip special case is needed.
    let endX = muzzleX + dirX * endDist, endY = muzzleY + dirY * endDist;

    // #374 REWORK: soft cover eats a beam along its TRACE. A beam resolves instantly, so it can't
    // roll per-step like a travelling round — its whole trace muzzle→endpoint is walked in one pass
    // (`_softCoverBeamBlock`) and the FIRST soft-cover hex that rolls a block stops it THERE, before
    // it reaches whatever it was aimed at. This runs even when the beam hit no unit (`hit` false) —
    // a beam lanced into open woods still puffs and dies in the trees, which is the headline case.
    // A ground target's own hex takes the tier bump (vehicle 25% / mech 10%); intervening hexes are
    // the flat 10%; an air-aimed beam is exempt from the whole lane. Symmetric — an enemy beam obeys
    // it identically (`_shotIgnoresCover` is false for enemies, so `airAimed` is player-only, which
    // is correct: enemies only ever shoot at ground mechs). A held stream asks once per TICK, so it
    // loses ~10% of its DPS per crossed hex rather than being gated all-or-nothing.
    const airAimed = this._shotIgnoresSoftCover?.(owner, shooter ?? primaryPlayerOf(this));
    const eatenAt = this._softCoverBeamBlock?.(muzzleX, muzzleY, endX, endY, hit ? target : null, airAimed);
    if (eatenAt) {
      // Stop the beam at the eating hex — its centre projected onto the ray — so it visibly
      // terminates in the foliage rather than drawing through to the target/wall. The trees stopped
      // it, so it is neither a unit hit nor a wall block: no damage, no terrain chip, just its
      // normal beam impact FX at that clamp point (below).
      const along = Math.max(0, (eatenAt.x - muzzleX) * dirX + (eatenAt.y - muzzleY) * dirY);
      endDist = Math.min(endDist, along);
      endX = muzzleX + dirX * endDist; endY = muzzleY + dirY * endDist;
      hit = false; blocked = false;
    }

    // Persistent beam so sparks can linger after it fades. A continuously-held beam
    // (sustained/stream) keeps ONE beam object that re-pins to the muzzle each shot, so it
    // tracks the mech as it turns/moves; single-shot beams (pulse/rail) push a fresh one.
    // 2026-08-01 playtest (Jackson: "make the laser beam AND held-portions of all laser weapons
    // the same thickness/size/dimensions whatever as the current beam laser, because that one
    // looks right"). `heavy` fattens everything drawBeam draws — glow 17px vs 11, core 4px vs
    // 2.6, and bigger/further-drifting sparks. It was derived from `delivery.kind === 'rail'`,
    // and EVERY rail-kind weapon in the game is a laser (Rail Lance [shelved], Charge Lance,
    // Charge Beam), so that flag only ever fattened the exact weapons he wants matched to Beam
    // Laser. Now always false: every beam, held or released, player or enemy, draws at Beam
    // Laser's dimensions. Note this also thins the wall turret's Rail Lance beam, which is the
    // same consistency and not a regression. `drawBeam` still TAKES the parameter, so a future
    // weapon can opt back into a heavy beam deliberately rather than as a side effect of its
    // projectile kind.
    // #633: both that decision and the beam's TTL now come from `beamSpawnFor` (data/delivery.js)
    // rather than being spelled out here AND again in the catalog card's own beam push — the two
    // had already drifted (the card's TTL fallback was 130, not 80). Values are unchanged on this
    // side; the card is the one that moved.
    const { ttl: beamTtl, heavy } = beamSpawnFor(w.weapon);
    // 2026-08-02 playtest: the beam's END TAPER is pinned to this absolute distance from the muzzle
    // rather than to whatever length the shot actually drew, so a beam clamped short by a wall,
    // a unit or foliage stays full-width into the impact instead of narrowing to a point there.
    // See `fullLen` in drawBeam. The weapon's own max range — the reach it would have with nothing
    // in the way — which is exactly what `endDist` starts as before the clamps above whittle it.
    const beamFullLen = w.weapon.range?.max || endDist;
    const continuous = forceContinuous || w.weapon.delivery.sustained || w.weapon.delivery.pattern === 'stream';
    const beamKey = `${shooterKey}:${w.location}:${lane}`;
    const live = continuous ? this.beams.find((b) => b.loc === beamKey) : null;
    if (live) {
      live.x0 = muzzleX; live.y0 = muzzleY; live.x1 = endX; live.y1 = endY;
      live.lateral = lateral;
      live.ttl = beamTtl;   // age keeps advancing → warble flows continuously
      live.coneDeg = burstConeDeg;
      live.fullLen = beamFullLen;
    } else {
      this.beams.push({ x0: muzzleX, y0: muzzleY, x1: endX, y1: endY, color, heavy, ttl: beamTtl, age: 0, loc: continuous ? beamKey : null, lane, lateral, coneDeg: burstConeDeg, fullLen: beamFullLen });
    }
    if (eatenAt) {
      // #374 — the beam was eaten mid-trace: play its OWN normal beam impact FX at the clamp point
      // where it enters the blocking hex (endX/endY, already clamped above), NOT a puff at the hex
      // centre. No unit damage — the trees simply stopped it right there.
      this._impactFx(endX, endY, color, 'beam', 0, w.weapon.id);
      // #405: the caught beam chips the soft-cover hex that ate it (the hex `eatenAt` marks), so
      // energy loadouts clear woods too. Keyed off the eating hex's own centre, not the clamp point.
      this._damageSoftCoverHex?.(this._hexKeyAt(eatenAt.x, eatenAt.y));
    } else if (pierce) {
      // #537: damage EVERY living target within beam-width tolerance between the muzzle and the
      // final (wall-clamped) endDist — not just the nearest. Each target takes the same full
      // charge-scaled damage (see the `pierce` comment on the weapon entry in weapons.js for why
      // it isn't divided across targets), scored at its OWN distance along the beam so range
      // falloff still applies per-target.
      const pierceHits = traceHitscanPiercing(muzzleX, muzzleY, angle, endDist, targets);
      for (const { target: c, t: ct } of pierceHits) {
        const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, ct)));
        // #348: friendly fire — a player-owned beam that resolved to another PLAYER routes to the
        // player damage sink, not the enemy one. Mirrors the single-target `hit` branch below.
        if (owner === 'enemy') this._damagePlayerAt(dmg, playerRefOf(this, c.ref), { enemyKind: statKind, weaponId: w.weapon.id, shotId: statShotId, spawnerKind });
        else if (isPlayerRef(this, c.ref)) this._damagePlayerAt(dmg, c.ref, { weaponId: w.weapon.id });
        else this._damageEnemyAt(c.ref, c.x, c.y, dmg, color, false, { weaponId: w.weapon.id, pullId });
      }
      // A piercing beam that also got stopped by a wall still chips that wall/span, same as the
      // single-target `blocked` branch below — pierce only changes what happens to bodies.
      if (blocked) this._damageBuildingAt?.(endX, endY, Math.max(1, Math.round(w.weapon.damage)), { flame: false });
      this._impactFx(endX, endY, color, 'beam', 0, w.weapon.id);
    } else if (hit) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      // #348: friendly fire — a player-owned beam that resolved to another PLAYER routes to the
      // player damage sink, not the enemy one.
      if (owner === 'enemy') this._damagePlayerAt(dmg, playerRefOf(this, target), { enemyKind: statKind, weaponId: w.weapon.id, shotId: statShotId, spawnerKind });
      else if (isPlayerRef(this, target)) this._damagePlayerAt(dmg, target, { weaponId: w.weapon.id });
      else this._damageEnemyAt(target, endX, endY, dmg, color, false, { weaponId: w.weapon.id, pullId });
      this._impactFx(endX, endY, color, 'beam', 0, w.weapon.id);
      // #622: Chain Bolt — after the first hit resolves, hop to nearby live enemies. Player-only
      // (no enemy kind mounts this) and only when the first hit actually landed on an ENEMY, not
      // a teammate (co-op friendly fire) — chaining through allies would read as a bug, not a feature.
      if (w.weapon.delivery.chain && owner === 'player' && !isPlayerRef(this, target)) {
        this._fireChainBolt(w, w.weapon.delivery.chain, target, endX, endY, color, beamTtl, pullId);
      }
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

  // #622: Chain Bolt's hop resolution. `firstEnemy` is the live enemy handle the initial beam
  // already struck (from `_liveEnemiesForTrace`'s `ref`) — excluded from every subsequent hop so
  // the bolt never doubles back onto a target it already hit this shot. Each hop repeatedly finds
  // the nearest live enemy within `chain.jumpRange` of the LAST hit position (pure pick via
  // `nearestChainTarget`, data/delivery.js), applies `weapon.damage * chain.falloff^hopIndex`
  // (hopIndex 1 for the 2nd target, 2 for the 3rd — the FIRST hit already dealt its own
  // range-falloff-scaled damage in `_fireHitscan` above and isn't re-touched here), and draws its
  // own `drawBeam` segment chained hit-to-hit (pushed onto `this.beams` exactly like the primary
  // beam, so it fades on the same shared spark-fade path). Stops at `maxJumps` or once no live
  // candidate remains in range.
  _fireChainBolt(w, chain, firstEnemy, x0, y0, color, beamTtl, pullId) {
    const candidates = this.enemies.filter((e) => !e.mech.isDestroyed());
    const excluded = new Set([firstEnemy]);
    let lastX = x0, lastY = y0;
    for (let hopIndex = 1; hopIndex <= chain.maxJumps; hopIndex++) {
      const next = nearestChainTarget(lastX, lastY, chain.jumpRange, candidates, excluded);
      if (!next) break;
      excluded.add(next);
      const dmg = Math.max(1, Math.round(w.weapon.damage * Math.pow(chain.falloff, hopIndex)));
      this._damageEnemyAt(next, next.x, next.y, dmg, color, false, { weaponId: w.weapon.id, pullId });
      this.beams.push({ x0: lastX, y0: lastY, x1: next.x, y1: next.y, color, heavy: false, ttl: beamTtl, age: 0, loc: null, lane: 0, lateral: 0, coneDeg: 0 });
      this._impactFx(next.x, next.y, color, 'beam', 0, w.weapon.id);
      lastX = next.x; lastY = next.y;
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
  _spawnProjectile(w, x, y, angle, owner = 'player', angleOffset = 0, seekOverride = null, aimAngle = angle, shooter = null, meta = {}) {
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
      // Playtest pass (Gravity Well, 2026-07-25): `delivery.fixedRange` opts a lobbed weapon OUT
      // of target-seeking entirely — it always flies its own optimal-range distance, whatever the
      // lock says, so the toss reads as a consistent, repeatable lob rather than one whose length
      // varies with whatever's locked. Skips arcMaxDist's target-ahead check altogether.
      if (d.fixedRange) {
        maxDist = w.weapon.range?.opt ?? 160;
      } else {
        const primary = primaryPlayerOf(this);
        const tgt = owner === 'player' ? (seekTarget ?? { x, y }) : (seekTarget ?? { x: primary.x, y: primary.y });
        // arcMaxDist (data/delivery.js, #77 follow-up) takes `aimAngle` — the weapon's un-offset
        // CENTRE bearing — not `angle` (this shot's own possibly fan-offset launch heading). See
        // that function's comment for why using the shot's own angle here regressed both missile
        // range and Swarm Rack's flight path.
        maxDist = arcMaxDist(x, y, aimAngle, tgt, maxRange, w.weapon.range?.opt ?? 160);
      }
      // Polish pass (Proximity Mines): an opt-in per-shot landing-distance jitter, applied AFTER
      // the shared travel budget above is resolved — see delivery.js `scatterMaxDist`. A no-op
      // for every weapon that doesn't set `delivery.scatterJitter`.
      if (d.scatterJitter) maxDist = scatterMaxDist(maxDist, d.scatterJitter);
      // Plasma Coater's `burstFan` (delivery.js): a FIXED, additive per-shot distance offset (px)
      // so its flanking shots land a constant amount closer than its centre shot — two proximal
      // + one distal, a real triangle instead of a same-range arc. Additive rather than a
      // multiplier on purpose (Jackson: "instead of a multiplier, can we make it a fixed
      // spread") — the triangle's depth stays the same number of px at any range, rather than
      // scaling up the farther the shot flies. A no-op (distOffset defaults to 0) for every
      // other weapon.
      if (meta.distOffset) maxDist = Math.max(0, maxDist + meta.distOffset);
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
    // #377 follow-up / #631: `meta.slot` (this round's normalised −1…+1 position in the volley,
    // as planEmissions stamped it) is handed through so a salvo can give each round its own
    // late-converging lateral aim offset — see salvoAimOffset. This used to be derived from
    // `angleOffset`, which meant a salvo needed a fan to have any lateral spread at all; the
    // index-derived slot works with or without one. Every caller that omits it (the Lab preview,
    // a lone shot) passes the default 0 and is unaffected.
    const round = makeProjectile(w.weapon, x, y, angle, { maxDist, slot: meta.slot ?? 0 });
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
    // #427 removed the `targetGate` stamp: an open gate is now solid to a round via `blocksShot`
    // (projectiles.js `_wallEdgeHit`), so it detonates on the gate like any span — no locked-pip
    // routing needed (superseding #412).
    // #338: the shot half of the shared predicate, resolved ONCE at spawn and carried by the round
    // (projectiles.js reads it in the in-flight cover check). Spawn-time, not per-frame, on purpose
    // — a shot commits to the geometry it was fired under, which is exactly the rule that keeps
    // case 1 of the issue honest: a round fired at a GROUND target locked in the open still splashes
    // on the wall that target ducks behind, rather than homing through terrain after it.
    const ignoresCover = this._shotIgnoresCover(owner, shooter ?? primaryPlayerOf(this));
    const pushed = {
      ...round, owner, trail: [], seekTarget, originHexes, targetHexKey, ignoresCover,
      // #374 REWORK: where this round was BORN (kept for reference / the friendly-fire origin) and
      // the last hex it was seen in, seeded to the muzzle hex so the muzzle's own hex is never
      // in-flight-rolled. projectiles.js rolls the flat per-hex 10% on each NEW soft-cover hex the
      // round enters (`_lastHexKey` is how "new" is detected).
      originX: x, originY: y, _lastHexKey: this._hexKeyAt(x, y),
      // #374 REWORK, #426 follow-up: is this shot exempt from soft cover eating it entirely — in
      // flight and at resolution? True for an AIRBORNE lock (the original rule: a shot aimed at
      // something in the air is no more eaten by trees than it is stopped by walls) OR a WALL
      // TURRET lock (#426: foliage never gates a shot at one, same as a flyer) — see
      // `_shotIgnoresSoftCover`/`targetSoftCoverExempt`. Deliberately NOT the same value as
      // `ignoresCover` any more: that one also licenses the wall-bypass path, and a wall turret's
      // own wall must still block a shot fired from behind it.
      airTarget: this._shotIgnoresSoftCover(owner, shooter ?? primaryPlayerOf(this)),
      // #348: who fired it, so friendly fire (projectiles.js) can skip the shooter themselves.
      shooter: owner === 'player' ? (shooter ?? primaryPlayerOf(this)) : null,
      // #423: the trigger pull this round belongs to (player rounds, for pull-level accuracy) and
      // the shooting enemy's stats kind (enemy rounds, for damage-taken attribution).
      pullId: meta.pullId ?? null,
      _statKind: meta.statKind ?? null,
      // #423 bug1: the enemy trigger pull this round belongs to, so a connecting enemy round books
      // its shot's hit exactly once (spread lanes of one pull share this id).
      _statShotId: meta.statShotId ?? null,
      // #440: the SPAWNER kind of the shooter (a carrier, if this round came from its drone), so a
      // connecting round can cross-attribute its damage to the spawner's "Spawned Dmg". null otherwise.
      _spawnerKind: meta.spawnerKind ?? null,
      // #491: the actual enemy handle that fired this round (enemy-owned shots only — a player
      // round's `shooter` above already serves this role for the player side). Carried onto a
      // planted hazard so its pull loop can exclude its own caster.
      caster: meta.caster ?? null,
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

// #627: the held-audio key for ONE player's Charge Beam beam phase. Deliberately suffixed so it
// can never collide with `_handleFiring`'s own `${player.id}:${location}` held-loop key — a
// chargeable weapon takes the `_handleChargeFire` path and never touches that map, but the two
// keyspaces share one `Audio._heldSounds` registry, so keeping them disjoint is free insurance.
function chargeBeamAudioKey(player, location) { return `${player?.id ?? 0}:${location}:chargeBeam`; }

// #627: reset one slot's charge state to "nothing held". Shared by the release path, the
// rising-edge (re)start, the drained-dry drop and the dead-player cleanup so all four agree on
// what a cleared slot looks like — `beaming`/`beamCd` are new fields those callers must not miss.
// The beam LOOP is stopped separately (`_stopChargeBeam`), since only the scene can reach Audio.
function resetChargeState(state) {
  state.charging = false;
  state.elapsed = 0;
  state.aimDrift = 0;
  state.lastAim = null;
  state.beaming = false;
  state.beamCd = 0;
}

// #347: the player a hitscan trace actually struck. `traceHitscan` hands back the candidate it
// hit, whose `ref` is the player object itself (see `_liveTargetsForTrace`). Falls back to the
// primary player for the arena test doubles that stub `traceHitscan` and return a bare target.
function playerRefOf(scene, target) {
  const ref = target?.ref ?? target;
  return (ref && ref.mech && ref.x != null) ? ref : primaryPlayerOf(scene);
}
