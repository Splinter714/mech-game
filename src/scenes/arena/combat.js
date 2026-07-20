// Arena combat mixin — applying damage (to the player and to enemies, mapping a world hit
// point to the nearest body part) and the hit feedback (impact bursts, floating text).
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign.
import { reskinMech, mechLayout, ART_SCALE } from '../../art/index.js';
import { Audio } from '../../audio/index.js';
import {
  ARENA_MECH_SCALE, DAMAGEABLE, DEATH_SCALE_MAX, DEPTH, deathScaleFor, explosionCategoryFor,
  resolveHitLocation, pickLiveWeighted,
} from './shared.js';
import { SOUND_THROTTLE_MS, allowByKey, skipImpactBurst } from '../../data/hitFx.js';
import { DORMANT } from '../../data/awareness.js';
// #224 (temporary): WEAPON_IMPACT_SOUNDS_ENABLED lives in sfxParams.js — see the comment
// there for the full list of gated call sites and how to revert.
import { WEAPON_IMPACT_SOUNDS_ENABLED } from '../../audio/sfxParams.js';
import { listenerOf, primaryPlayerOf } from './players.js';
import { playerAccent } from '../../data/players.js';

// Hard cap on impact-flash circles alive at once (#76). Under concentrated fire the burst-merge
// below already collapses same-point bursts; this pool bounds the WORST case (many enemies) by
// recycling the oldest circle instead of create/destroy-ing one per hit.
const IMPACT_CIRCLE_CAP = 48;

// Same worst-case-bounding idea as IMPACT_CIRCLE_CAP, for the death-explosion debris chunks
// (#100): a mass-kill (e.g. an AoE wiping a drone swarm of 18) fires `_deathFx` many times in
// one frame, and each call flings a handful of rectangles, so the concurrent-debris count is
// hard-capped and recycled instead of growing unbounded.
const DEBRIS_CAP = 60;

export const CombatMixin = {
  // Incoming damage to the player (used once enemies fire). #246: the shield is now a real
  // layer living ON the Mech itself (this.mech.shield — a native trait, not just a powerup
  // bolt-on) — Mech.applyDamage already runs the full shield -> armor -> hp pipeline
  // internally, so this is just a thin pass-through (kept as its own method for the arena's
  // other call sites / tests that hang off `damagePlayer`).
  // #347: `player` is WHO is being hit. Defaults to the primary player, which is both today's
  // only player and what every existing caller/test means by "the player".
  damagePlayer(locationId, amount, player = primaryPlayerOf(this)) {
    return player.mech.applyDamage(locationId, amount);
  },

  // Enemy round hits the player: damage a (torso-weighted) random part through the shield.
  // #128: head/centerTorso dropped out of this pool entirely — they're cosmetic only now
  // (no armor/hp, so a hit "on" them would silently no-op) — the side torsos pick up
  // the centre-mass weighting instead, so hits still lean toward the torsos over the arms.
  // #230: was a flat 2:1 torso:arm weighting, which combined with the chassis' own armor+
  // hp totals (side torsos had only ~1.25x an arm's health — see chassis/index.js
  // FACTORS) to make torsos die roughly 1.6x faster than arms in expected-hits terms, so
  // players almost never got to experience losing an arm before the attached torso (and its
  // cascade, see DESTROY_CASCADE) took it anyway. Eased to 1.5:1 here, paired with a bump to
  // FACTORS.leftTorso/rightTorso, so the two changes together land torsos and arms within
  // ~6% of each other's effective destruction rate instead of 60%.
  // #347: takes the player being hit. Enemy fire resolves WHICH player it struck upstream
  // (firing.js `_liveTargetsForTrace`, projectiles.js) and passes it here, so the hit-location
  // roll, the reskin, the death FX and the death latch all act on that player's own mech and
  // view — none of it reads a global any more.
  _damagePlayerAt(dmg, player = primaryPlayerOf(this)) {
    const parts = [
      'leftTorso', 'leftTorso', 'leftTorso',
      'rightTorso', 'rightTorso', 'rightTorso',
      'leftArm', 'leftArm',
      'rightArm', 'rightArm',
    ];
    // #231: a weighted-random pick can land on a location already destroyed (e.g. an arm that
    // cascaded from its torso), which would otherwise waste the whole hit into nothing.
    // `pickLiveWeighted` rerolls among the still-live entries of the same pool instead.
    const loc = pickLiveWeighted(parts, (part) => player.mech.isPartDestroyed(part));
    const res = this.damagePlayer(loc, dmg, player);
    // #348: stamp WHEN this player was last hit. This is the signal the co-op respawn's
    // out-of-combat gate reads (coop.js `_updateRespawns`) — the surviving player must have gone
    // 1-2s without taking fire before a downed teammate is allowed back in. Stamped for every hit
    // including a fully-shielded one: being shot at is being in combat, whether or not it hurt.
    player.lastHitAt = this.time?.now ?? 0;
    // #205: pulse the on-mech shield bubble any time the shield actually absorbed part of this
    // hit — covers both a fully-absorbed hit (shielded, below) and a hit that partially absorbed
    // then broke through (shieldAbsorbed > 0 but not `shielded`, see damagePlayer above).
    if (res.shieldAbsorbed) this._shieldHitFlash(player);
    if (res.shielded) return;
    // #71: the mech textures only depend on WHICH parts are destroyed (stumps / vanished
    // weapons) or which segments have lost their ARMOR plating (#246's armor-shell overlay —
    // see mechArt.js), not on continuous health — so only pay the 9-texture procedural rebuild
    // when this hit actually changed one of those two discrete visual states. Reskinning on
    // every hit was the main combat lag source.
    // #348: preserve this player's identifying accent across the damage re-raster — without the
    // opts a re-skinned player 2 would silently revert to player 1's colours.
    if (res.destroyed || res.armorBrokeNow) {
      reskinMech(this, player.textureKey ?? 'playerMech', player.mech,
        { theme: 'player', accent: playerAccent(player.id ?? 0) });
    }
    // #83: floating damage NUMBERS are off entirely — narrative feedback (shielded/MECH DOWN/
    // DESTROYED/etc. above and below) still floats as before, just not the raw hit amount.
    // #201: a part breaking off now has its own SFX domain trigger (shared for player+enemy
    // part loss — see sfxDomains.js) instead of the generic explosion cue.
    if (res.destroyed) Audio.ui('partDestroyed');
    // #64: death feedback only — the run mixin (_updateRun, polled every frame) is what
    // actually ends the run and drives the delayed return to the garage, so there's exactly
    // one place owning that transition (and the run-over banner/currency banking with it).
    if (player.mech.isDestroyed() && !player.dead) {
      player.dead = true;
      // #225 (playtest: "it needs to really be destroyed in a big explosion, not just have
      // parts missing and still be able to walk around as a husk"): freeze velocity/speed so
      // the stepped-gait animation (_stepGait, locomotion.js) stops dead on this frame's pose
      // instead of continuing to "walk" on stale speed while input is gated off below (see
      // ArenaScene.update()'s `!this._playerDead` guards around _handleSprint/_drive/
      // _handleFiring — the actual input choke point).
      player.vx = 0; player.vy = 0; player.speed = 0;
      // The player's own kill gets the same catastrophic-kill treatment as an enemy death
      // (_deathFx — burst flash, irregular fireball blobs, shock ring, smoke, flung debris —
      // see the big comment above _deathFx) rather than nothing. Always the biggest scale/
      // category regardless of the player's own chassis weight: this is the single most
      // severe moment in a run, distinct from (and bigger than) even a heavy enemy mech's
      // 'massive' kill, which is itself the ceiling `explosionCategoryFor`/`deathScaleFor`
      // ever produce for an enemy — ties into the dedicated `deathExplosionMassive` bake
      // (#180) as the biggest explosion SOUND category that already exists.
      this._deathFx(player.x, player.y, DEATH_SCALE_MAX, 'massive');
      // Mirrors the enemy-death lesson from #87 (corrected 2026-07-10: "a lingering, frozen
      // corpse before cleanup read as horrible and looks dumb — the explosion IS the death
      // feedback, not a delayed afterthought"): hide the player's own mech view the instant it
      // dies rather than leaving the damaged husk standing (and now motionless, per the
      // velocity freeze above) on screen for the whole RUN_OVER_DELAY before the run-over
      // transition. Unlike `_removeEnemy`, this only HIDES (not destroys) the container — the
      // camera's `startFollow(this.playerView, …)` (ArenaScene.create()) still needs a live
      // object to anchor on while the run-over sequence plays out.
      player.view?.setVisible(false);
      // #236: no floating "MECH DOWN" text — the explosion + hidden mech IS the feedback.
      // #201: the player's own mech going down gets its own dedicated, most-severe cue —
      // distinct from an enemy's death (deathExplosionByCategory, #180/#184).
      Audio.ui('mechDestroyed');
    }
  },

  // Impact effect, animated per ordnance type: a bright core flash plus a kind-specific
  // burst (ballistic spark, missile/splash explosion, plasma splatter, laser scorch).
  // `weaponId` drives the SOUND (per-weapon, tunable in the Weapon Lab); `kind` drives the
  // VISUAL burst shape below — they can differ (several weapons share a projectile `kind`).
  _impactFx(x, y, color, kind, splash, weaponId) {
    const now = this.time.now;
    // #76: rate-limit the per-weapon impact SOUND so a frame full of simultaneous hits from one
    // weapon (e.g. four Repeaters into one target) collapses to a bounded ~20 triggers/sec
    // instead of flooding WebAudio with dozens of oscillators at once. Keyed per weapon so two
    // different weapons hitting together still each sound.
    // #224 (temporary): impact sound disabled, see WEAPON_IMPACT_SOUNDS_ENABLED above.
    // #264: real positional audio — the impact's own world position vs. the player (listener)
    // drives distance falloff + stereo pan, so a hit landing far from the player reads quieter.
    if (WEAPON_IMPACT_SOUNDS_ENABLED && allowByKey((this._impactSoundAt ??= {}), weaponId ?? '_', now, SOUND_THROTTLE_MS)) {
      Audio.impact(weaponId, { x, y, ...listenerOf(this) });
    }
    // #76: collapse near-simultaneous bursts at the same point — concentrated fire lands many
    // hits/frame at one spot, and the overlapping identical rings are indistinguishable, so keep
    // only the first and skip the rest (no extra circles/tweens) for one frame's worth of window.
    if (skipImpactBurst(this._lastBurst, x, y, now)) return;
    this._lastBurst = { x, y, t: now };
    this._burst(x, y, 3, 9, 0xffffff, 0.9, 120, false); // core flash, every hit

    if (kind === 'missile' || splash > 0) {
      const r = Math.max(10, splash);
      this._burst(x, y, r * 0.4, r * 1.6, 0xff7a18, 0.4, 260, false);  // fireball
      this._burst(x, y, r * 0.5, r * 1.9, 0xffd56b, 0.9, 300, true);   // shock ring
    } else if (kind === 'plasma') {
      this._burst(x, y, 4, 18, color, 0.6, 240, false);                // splatter blob
      this._burst(x, y, 3, 14, color, 0.9, 220, true);
    } else if (kind === 'beam') {
      this._burst(x, y, 2, 7, color, 0.9, 110, false);                 // scorch flash
    } else {                                                            // ballistic spark
      this._burst(x, y, 2, 9, color, 0.85, 130, false);
      this._burst(x, y, 1.5, 7, 0xffffff, 0.7, 100, true);
    }
  },

  // Shared burst-circle primitive behind `_impactFx`'s per-kind bursts above and `_deathFx`
  // below: acquire a pooled circle at (x, y) with start radius `r0`, tween it out to `r1` while
  // fading, then free it back to the pool.
  _burst(x, y, r0, r1, col, alpha, dur, stroke) {
    const c = this._acquireImpactCircle(x, y, r0, col, alpha, stroke);
    this.tweens.add({ targets: c, scale: r1 / r0, alpha: 0, duration: dur, onComplete: () => this._freeImpactCircle(c) });
  },

  // Apply `damage` to enemy `e`'s part nearest the world point (x, y). Works for BOTH a mech
  // (parts positioned via mechLayout, re-skinned to show damage) and a non-mech HpBody unit
  // (#68: parts carry their own {x,y}; single-pool, so the nearest part only decides where the
  // damage number floats — the whole unit shares the hp — and #300's armor "reskin" is a
  // texture-set swap, not a re-raster).
  // `isCrush` (#106) marks a CRUSH/stomp kill — the player driving over a small ground unit
  // (world.js `_crushGroundEnemyAt`) rather than shooting it. Every weapon-damage caller leaves
  // it false; it only changes the powerup drop roll below (a free kill shouldn't pay out like a
  // fought one), nothing else in the damage/death pipeline.
  _damageEnemyAt(e, x, y, damage, color, isCrush = false) {
    if (e.mech.isDestroyed()) return;
    // #269: being shot is the most unambiguous "you've been noticed" signal there is — a dormant
    // unit taking a hit wakes its whole base (via the BasesMixin `_wakeBase`, composed onto the
    // same scene). Done up front, before applyDamage/teardown below, so it fires even when THIS
    // hit destroys the unit (the destroyed unit is removed from `this.enemies`, but its still-
    // dormant basemates get woken). `_wakeBase` is idempotent, so an already-woken base is a no-op.
    if (e.awareness === DORMANT && e.baseId != null) this._wakeBase(e.baseId);
    const isMech = e.kind === 'mech' || e.kind === undefined;
    const dispUnit = ARENA_MECH_SCALE * ART_SCALE;
    const lx = x - e.x, ly = y - e.y;
    const lay = isMech ? mechLayout(e.mech) : e.mech.parts;
    const locs = isMech ? DAMAGEABLE : e.mech.locations();
    // #231: nearest part to the hit point, redirected to the nearest still-LIVE part if the
    // geometrically-nearest one is already destroyed (see `resolveHitLocation` in shared.js
    // for why that redirect matters — otherwise the hit silently wastes into a dead part).
    const best = resolveHitLocation(lay, locs, lx, ly, dispUnit, (loc) => e.mech.isPartDestroyed(loc));
    const res = e.mech.applyDamage(best, damage);
    // #71: same as the player path — rebuild the enemy's textures only when a part just broke
    // or lost its armor plating (#246 armor-shell overlay), not on every single hit. Vehicle
    // (non-mech) kinds instead swap between two pre-built shared texture sets — see below.
    if (isMech && (res.destroyed || res.armorBrokeNow)) reskinMech(this, e.key, e.mech, { theme: 'enemy' });
    // #300: a non-mech unit (tank/carrier) with an armor pool swaps from its PLATED texture set
    // to the bare one the moment that pool empties, so the player sees the plating strip off.
    else if (!isMech && res.armorBrokeNow) this._reskinVehicle(e);
    // #83: no floating damage number on enemy hits either — damage still applies above (res),
    // just nothing pops the amount as text. DESTROYED below still floats as narrative feedback.
    // #201: same shared part-loss cue as the player path above.
    if (res.destroyed) Audio.ui('partDestroyed');
    if (e.mech.isDestroyed()) {
      // #87 (corrected per playtest 2026-07-10): a lingering, frozen corpse before cleanup read
      // as "horrible and looks dumb" — the corpse must vanish IMMEDIATELY on death, with the
      // explosion itself (sized to the enemy) AS the death feedback, not a delayed afterthought.
      // Read everything off `e` we still need BEFORE tearing it down.
      const dx = e.x, dy = e.y;
      // #100: the red "DESTROYED" floating text read as redundant/noisy on top of the
      // explosion itself (which IS the death feedback) — removed. No lingering body either way.
      this._deathFx(dx, dy, deathScaleFor(e), explosionCategoryFor(e));
      // #60: killing an enemy may drop a timed-buff powerup at its death position (drop chance
      // + weighted type live in data/powerups.js). Source-agnostic — facilities can drop too.
      // #90/#106: pass the kill's TOUGHNESS (structure + armor + shield — uniform across
      // Mech/HpBody) so the odds scale with how tough the enemy actually was, instead of a flat
      // roll; plus the crush flag, which swaps the curve for a flat tiny chance (#106).
      // #336: `e.flying` — a flyer downed over a base wall has no real side of its own, so its
      // drops follow the PLAYER's side; a ground kill's follow its own death position.
      this._maybeDropPowerup?.(dx, dy, e.mech.toughness ?? e.mech.maxHp, isCrush, !!e.flying);
      // #65: killing an enemy may also drop a SCRAP salvage pickup (drop chance + amount live
      // in data/shop.js) — independent roll from the powerup drop, same kill site.
      this._maybeDropSalvage?.(dx, dy, !!e.flying);
      // Tear the corpse (view + generated textures) down and drop it out of `this.enemies` in
      // the SAME tick the kill registers — no delayed teardown, no frozen body sitting around.
      this._removeEnemy(e);
    }
  },

  // Catastrophic-kill explosion, sized to the dying enemy (`scale`: ~0.5 drone … ~1.3 heavy
  // mech — see `deathScaleFor`). #100 (playtest 2026-07-10: "should be more explosion-y, not
  // just an expanding circle"): a plain fireball+shockring pair of clean concentric circles
  // read as too geometric/clean. Now: a SHARP quick flash, several randomly-offset overlapping
  // fireball blobs (irregular silhouette instead of one perfect circle), the shock ring kept
  // (still reads as a shockwave), a lingering drifting smoke puff, and flung debris fragments.
  // Everything scales off the same `scale` so a heavy mech's kill is a bigger, busier, longer
  // event than a drone's, not just a wider version of the same circle. The explosion SOUND
  // (#107) is a discrete tunable `category` (small/medium/large/massive — see
  // `explosionCategoryFor`) instead of continuously scaling one param set, so a heavy mech's
  // kill sounds like ITS OWN tuned boom rather than one formula stretched.
  // Goes straight through `_burst`, bypassing `_impactFx`'s per-hit sound throttle/burst-merge
  // (tuned for concentrated weapon fire, not a once-per-kill event) so this always renders even
  // when the killing hit's own impact FX just fired at the same point this frame.
  _deathFx(x, y, scale = 1, category = 'medium') {
    const r = 26 * scale;
    // Sharp initial flash — brief and near-full-alpha so the very first frame reads as a
    // punch rather than a smooth fade-in.
    this._burst(x, y, 5 * scale, 15 * scale, 0xffffff, 1, 90, false);
    // Irregular fireball: a few overlapping blobs offset at random angles/radii instead of one
    // clean circle, so the burst silhouette reads as ragged rather than geometric.
    const blobCount = 3;
    for (let i = 0; i < blobCount; i++) {
      const ang = Math.random() * Math.PI * 2;
      const off = r * 0.3 * Math.random();
      const bx = x + Math.cos(ang) * off, by = y + Math.sin(ang) * off;
      const r0 = r * (0.3 + Math.random() * 0.2), r1 = r * (1.2 + Math.random() * 0.6);
      this._burst(bx, by, r0, r1, 0xff7a18, 0.4, 260 * scale + Math.random() * 60, false);
    }
    this._burst(x, y, r * 0.5, r * 1.9, 0xffd56b, 0.85, 340 * scale, true);   // shock ring
    this._smokePuff(x, y, scale);
    this._deathDebris(x, y, scale);
    // #264: real positional audio — the kill site vs. the player (listener). The player's own
    // MECH DOWN case (this._deathFx(this.px, this.py, ...) above) naturally resolves to
    // distance 0 / centered pan, i.e. unaffected full volume, exactly as before.
    Audio.deathExplosion(category, { x, y, ...listenerOf(this) });
  },

  // Lingering smoke puff (#100): a soft grey blob that drifts a little and fades out much
  // slower than the flash/fireball, so the kill site doesn't just vanish the instant the
  // bright burst ends. Reuses the shared pooled `_burst` circle primitive (no new pool needed).
  _smokePuff(x, y, scale) {
    const r = 20 * scale;
    const dx = (Math.random() - 0.5) * 14 * scale, dy = (Math.random() - 0.5) * 14 * scale;
    const c = this._acquireImpactCircle(x, y, r * 0.6, 0x555049, 0.3, false);
    this.tweens.add({
      targets: c, x: x + dx, y: y + dy, scale: (r * 1.8) / (r * 0.6), alpha: 0,
      duration: 620 * scale, ease: 'Quad.easeOut', onComplete: () => this._freeImpactCircle(c),
    });
  },

  // Debris fragments flung outward from the kill site (#100), mirroring world.js's
  // `_outpostCollapseFx` rubble-chunk pattern. Pooled + hard-capped (`DEBRIS_CAP`) — a kill's
  // debris only fires once (not per hit), but a mass-kill (e.g. an AoE clearing a drone swarm
  // of 18) can still land many kills in one frame, so the pool bounds the worst case exactly
  // like `_acquireImpactCircle` does for impact bursts (#76 lesson).
  _deathDebris(x, y, scale) {
    const count = Math.min(9, Math.round(4 + scale * 4));
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = (18 + Math.random() * 30) * scale;
      const chunk = this._acquireDebrisChunk(x, y, (2 + Math.random() * 3) * scale, (2 + Math.random() * 3) * scale, 0x3a3733);
      this.tweens.add({
        targets: chunk, x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist,
        angle: Math.random() * 360, alpha: 0, duration: (300 + Math.random() * 260) * scale,
        ease: 'Quad.easeOut', onComplete: () => this._freeDebrisChunk(chunk),
      });
    }
  },

  _floatText(x, y, s, color) {
    const t = this.add.text(x, y, s, { fontFamily: 'monospace', fontSize: '14px', color })
      .setOrigin(0.5).setDepth(DEPTH.IMPACT_FX);   // #99: reads over units/FX, not add-order luck
    this.tweens.add({ targets: t, y: y - 26, alpha: 0, duration: 700, onComplete: () => t.destroy() });
  },

  // #76: capped, recycled pool of impact-flash circles. Reuse a freed circle when available;
  // grow the pool up to IMPACT_CIRCLE_CAP; past the cap, recycle the oldest live one (kill its
  // tween first) so the concurrent-circle count is hard-bounded instead of create/destroy per hit.
  _acquireImpactCircle(x, y, r, col, alpha, stroke) {
    const pool = (this._impactPool ??= []);
    let c = pool.find((o) => !o._busy);
    if (!c) {
      // #99: explicit depth on creation — these are pooled/reused for the life of the arena, so
      // whatever depth they get here is what they keep; previously unset (0), which only read
      // "above units" by the accident of the pool being lazily created after the player/enemy
      // views already existed. Same tier as death FX / floating text (DEPTH.IMPACT_FX).
      if (pool.length < IMPACT_CIRCLE_CAP) { c = this.add.circle(0, 0, 1).setDepth(DEPTH.IMPACT_FX); pool.push(c); }
      else {
        // Pool full: evict the oldest via a round-robin cursor.
        const i = (this._impactRR = ((this._impactRR ?? 0) + 1) % pool.length);
        c = pool[i];
        this.tweens.killTweensOf(c);
      }
    }
    c._busy = true;
    c.setPosition(x, y).setScale(1).setAlpha(alpha).setVisible(true);
    c.setRadius(r);
    if (stroke) { c.setFillStyle(); c.setStrokeStyle(2, col, alpha); }
    else { c.setStrokeStyle(); c.setFillStyle(col, alpha); }
    return c;
  },

  _freeImpactCircle(c) {
    c._busy = false;
    c.setVisible(false);
  },

  // #100: capped, recycled pool of death-explosion debris rectangles — same shape as the
  // impact-circle pool above (acquire a free one, grow up to the cap, then round-robin recycle
  // the oldest live one past that) so a mass-kill's flung fragments can't grow unbounded.
  _acquireDebrisChunk(x, y, w, h, col) {
    const pool = (this._debrisPool ??= []);
    let c = pool.find((o) => !o._busy);
    if (!c) {
      if (pool.length < DEBRIS_CAP) { c = this.add.rectangle(0, 0, 1, 1); pool.push(c); }
      else {
        const i = (this._debrisRR = ((this._debrisRR ?? 0) + 1) % pool.length);
        c = pool[i];
        this.tweens.killTweensOf(c);
      }
    }
    c._busy = true;
    c.setPosition(x, y).setSize(w, h).setRotation(0).setAlpha(1).setFillStyle(col, 1).setVisible(true);
    return c;
  },

  _freeDebrisChunk(c) {
    c._busy = false;
    c.setVisible(false);
  },
};
