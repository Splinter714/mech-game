// Arena combat mixin — applying damage (to the player and to enemies, mapping a world hit
// point to the nearest body part) and the hit feedback (impact bursts, floating text).
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign.
import { reskinMech, mechLayout, ART_SCALE } from '../../art/index.js';
import { Audio } from '../../audio/index.js';
import { ARENA_MECH_SCALE, DAMAGEABLE, DEPTH, deathScaleFor } from './shared.js';
import { SOUND_THROTTLE_MS, allowByKey, skipImpactBurst } from '../../data/hitFx.js';

// Hard cap on impact-flash circles alive at once (#76). Under concentrated fire the burst-merge
// below already collapses same-point bursts; this pool bounds the WORST case (many enemies) by
// recycling the oldest circle instead of create/destroy-ing one per hit.
const IMPACT_CIRCLE_CAP = 48;

export const CombatMixin = {
  // Incoming damage to the player (used once enemies fire) — fully absorbed while the
  // bubble shield is up.
  damagePlayer(locationId, amount) {
    if (this.time.now < this.shieldUntil) return { applied: 0, shielded: true };
    return this.mech.applyDamage(locationId, amount);
  },

  // Enemy round hits the player: damage a (torso-weighted) random part through the shield.
  _damagePlayerAt(dmg) {
    const parts = ['centerTorso', 'centerTorso', 'leftTorso', 'rightTorso', 'leftArm', 'rightArm', 'head'];
    const loc = parts[Math.floor(Math.random() * parts.length)];
    const res = this.damagePlayer(loc, dmg);
    if (res.shielded) { this._floatText(this.px, this.py - 24, 'shielded', '#5ec8e0'); return; }
    // #71: the mech textures only depend on WHICH parts are destroyed (stumps / vanished
    // weapons), not on continuous health — so only pay the 9-texture procedural rebuild when
    // this hit actually broke a part. Reskinning on every hit was the main combat lag source.
    if (res.destroyed) reskinMech(this, 'playerMech', this.mech);
    // #83: floating damage NUMBERS are off entirely — narrative feedback (shielded/MECH DOWN/
    // DESTROYED/etc. above and below) still floats as before, just not the raw hit amount.
    if (res.destroyed) Audio.explosion(0.6);   // a part broke off (#36)
    // #64: death feedback only — the run mixin (_updateRun, polled every frame) is what
    // actually ends the run and drives the delayed return to the garage, so there's exactly
    // one place owning that transition (and the run-over banner/currency banking with it).
    if (this.mech.isDestroyed() && !this._playerDead) {
      this._playerDead = true;
      this._floatText(this.px, this.py - 36, 'MECH DOWN', '#e2533a');
      Audio.explosion(1.2);
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
    if (allowByKey((this._impactSoundAt ??= {}), weaponId ?? '_', now, SOUND_THROTTLE_MS)) Audio.impact(weaponId);
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
  // damage number floats — the whole unit shares the hp — and its textures are static, no reskin).
  _damageEnemyAt(e, x, y, damage, color) {
    if (e.mech.isDestroyed()) return;
    const isMech = e.kind === 'mech' || e.kind === undefined;
    const dispUnit = ARENA_MECH_SCALE * ART_SCALE;
    const lx = x - e.x, ly = y - e.y;
    const lay = isMech ? mechLayout(e.mech) : e.mech.parts;
    const locs = isMech ? DAMAGEABLE : e.mech.locations();
    let best = null, bestD = Infinity;
    for (const loc of locs) {
      const a = lay[loc];
      const d = Math.hypot(lx - a.x * dispUnit, ly - a.y * dispUnit);
      if (d < bestD) { bestD = d; best = loc; }
    }
    const res = e.mech.applyDamage(best, damage);
    // #71: same as the player path — rebuild the enemy's textures only when a part just broke
    // (that's the only damage state the art shows), not on every single hit.
    if (isMech && res.destroyed) reskinMech(this, e.key, e.mech, { theme: 'enemy' });
    // #83: no floating damage number on enemy hits either — damage still applies above (res),
    // just nothing pops the amount as text. DESTROYED below still floats as narrative feedback.
    if (res.destroyed) Audio.explosion(0.6);   // a part broke off (#36)
    if (e.mech.isDestroyed()) {
      // #87 (corrected per playtest 2026-07-10): a lingering, frozen corpse before cleanup read
      // as "horrible and looks dumb" — the corpse must vanish IMMEDIATELY on death, with the
      // explosion itself (sized to the enemy) AS the death feedback, not a delayed afterthought.
      // Read everything off `e` we still need BEFORE tearing it down.
      const dx = e.x, dy = e.y;
      this._floatText(dx, dy - 30, 'DESTROYED', '#e2533a');   // just floating text, no lingering body
      this._deathFx(dx, dy, deathScaleFor(e));
      // #60: killing an enemy may drop a timed-buff powerup at its death position (drop chance
      // + weighted type live in data/powerups.js). Source-agnostic — facilities can drop too.
      // #90: pass the kill's maxHp (uniform across Mech/HpBody) so the odds scale with how
      // tough the enemy was, instead of a flat roll.
      this._maybeDropPowerup?.(dx, dy, e.mech.maxHp);
      // #65: killing an enemy may also drop a SCRAP salvage pickup (drop chance + amount live
      // in data/shop.js) — independent roll from the powerup drop, same kill site.
      this._maybeDropSalvage?.(dx, dy);
      // Tear the corpse (view + generated textures) down and drop it out of `this.enemies` in
      // the SAME tick the kill registers — no delayed teardown, no frozen body sitting around.
      this._removeEnemy(e);
    }
  },

  // Catastrophic-kill explosion, sized to the dying enemy (`scale`: ~0.7 drone … ~1.35 heavy
  // mech — see `deathScaleFor`). Draws the SAME fireball+shockring burst recipe `_impactFx` uses
  // for missile/splash hits (via the shared `_burst` primitive) rather than inventing new
  // drawing code — just scales the radius/duration and the explosion volume by enemy size.
  // Goes straight through `_burst`, bypassing `_impactFx`'s per-hit sound throttle/burst-merge
  // (tuned for concentrated weapon fire, not a once-per-kill event) so this always renders even
  // when the killing hit's own impact FX just fired at the same point this frame.
  _deathFx(x, y, scale = 1) {
    const r = 26 * scale;
    this._burst(x, y, 4 * scale, 12 * scale, 0xffffff, 0.95, 140, false);     // core flash
    this._burst(x, y, r * 0.4, r * 1.6, 0xff7a18, 0.5, 320 * scale, false);   // fireball
    this._burst(x, y, r * 0.5, r * 1.9, 0xffd56b, 0.9, 360 * scale, true);    // shock ring
    Audio.explosion(1.15 * scale);
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
};
