// Arena combat mixin — applying damage (to the player and to enemies, mapping a world hit
// point to the nearest body part) and the hit feedback (impact bursts, floating text).
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign.
import { reskinMech, mechLayout, ART_SCALE } from '../../art/index.js';
import { Audio } from '../../audio/index.js';
import { ARENA_MECH_SCALE, DAMAGEABLE } from './shared.js';

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
    this._floatText(this.px, this.py - 20, `-${dmg}`, '#e2533a');
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
    Audio.impact(weaponId);
    const burst = (r0, r1, col, alpha, dur, stroke) => {
      const c = stroke
        ? this.add.circle(x, y, r0).setStrokeStyle(2, col, alpha)
        : this.add.circle(x, y, r0, col, alpha);
      this.tweens.add({ targets: c, scale: r1 / r0, alpha: 0, duration: dur, onComplete: () => c.destroy() });
    };
    burst(3, 9, 0xffffff, 0.9, 120, false); // core flash, every hit

    if (kind === 'missile' || splash > 0) {
      const r = Math.max(10, splash);
      burst(r * 0.4, r * 1.6, 0xff7a18, 0.4, 260, false);  // fireball
      burst(r * 0.5, r * 1.9, 0xffd56b, 0.9, 300, true);   // shock ring
    } else if (kind === 'plasma') {
      burst(4, 18, color, 0.6, 240, false);                // splatter blob
      burst(3, 14, color, 0.9, 220, true);
    } else if (kind === 'beam') {
      burst(2, 7, color, 0.9, 110, false);                 // scorch flash
    } else {                                                // ballistic spark
      burst(2, 9, color, 0.85, 130, false);
      burst(1.5, 7, 0xffffff, 0.7, 100, true);
    }
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
    this._floatText(x, y, `${damage}`, res.destroyed ? '#e2533a' : '#ffd56b');
    if (res.destroyed) Audio.explosion(0.6);   // a part broke off (#36)
    if (e.mech.isDestroyed()) {
      e.view.setAlpha(0.5);
      this._floatText(e.x, e.y - 30, 'DESTROYED', '#e2533a');
      Audio.explosion(1.15);                   // catastrophic kill
      // #60: killing an enemy may drop a timed-buff powerup at its death position (drop chance
      // + weighted type live in data/powerups.js). Source-agnostic — facilities can drop too.
      this._maybeDropPowerup?.(e.x, e.y);
      // #65: killing an enemy may also drop a SCRAP salvage pickup (drop chance + amount live
      // in data/shop.js) — independent roll from the powerup drop, same kill site.
      this._maybeDropSalvage?.(e.x, e.y);
    }
  },

  _floatText(x, y, s, color) {
    const t = this.add.text(x, y, s, { fontFamily: 'monospace', fontSize: '14px', color }).setOrigin(0.5);
    this.tweens.add({ targets: t, y: y - 26, alpha: 0, duration: 700, onComplete: () => t.destroy() });
  },
};
