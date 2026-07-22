// #440 — the PLAYER damage-taken stat must record EFFECTIVE damage (what actually removed
// durability), not raw incoming: the location OVERSHOOT clamped away by Mech.applyDamage is
// wasted and must NOT be booked, while shield-absorbed damage STAYS counted. Drives the real
// CombatMixin._damagePlayerAt against a real Mech with a stubbed stat recorder.
import { describe, it, expect } from 'vitest';
import { CombatMixin } from './combat.js';
import { Mech } from '../../data/Mech.js';

function makePlayer(mechOpts) {
  return { mech: new Mech(mechOpts), dead: false, view: { setVisible() {} } };
}

// A ctx exposing exactly what _damagePlayerAt touches, with the FX seams stubbed and the
// stat recorder capturing the amount that was booked.
function makeCtx() {
  const booked = [];
  const ctx = {
    time: { now: 0 },
    damagePlayer: CombatMixin.damagePlayer,           // real pass-through to mech.applyDamage
    _statPlayerHurt(kind, weaponId, amount) { booked.push(amount); },
    _shieldHitFlash() {},
    _reskinPlayerMech() {},
    _statDeath() {},
    _deathFx() {},
    booked,
  };
  return ctx;
}

describe('#440 player damage-taken excludes location overshoot, keeps shield', () => {
  it('books the full amount for a normal non-destroying hit (no overshoot)', () => {
    const ctx = makeCtx();
    const player = makePlayer({ chassisId: 'heavy' });
    // A modest hit that armor+hp can fully absorb on any location it lands on.
    CombatMixin._damagePlayerAt.call(ctx, 8, player, { enemyKind: 'drone', weaponId: 'r' });
    expect(ctx.booked).toEqual([8]);
  });

  it('books only the effective damage on an overshooting kill, not the wasted excess', () => {
    const ctx = makeCtx();
    // Light chassis, and pre-destroy every mount location EXCEPT one arm so the weighted pick
    // is forced onto a known, nearly-gone part with a small remaining armor+hp.
    const player = makePlayer({ chassisId: 'light' });
    const survivor = 'leftArm';
    for (const loc of ['rightArm', 'leftTorso', 'rightTorso']) {
      const p = player.mech.parts[loc];
      player.mech.applyDamage(loc, p.maxArmor + p.maxHp + 50);
    }
    const arm = player.mech.parts[survivor];
    const remaining = arm.armor + arm.hp;
    const excess = 40;
    CombatMixin._damagePlayerAt.call(ctx, remaining + excess, player, { enemyKind: 'drone' });
    // Effective = raw − overshoot = remaining (the durability actually removed), excess dropped.
    expect(ctx.booked).toEqual([remaining]);
  });

  it('a fully-shielded hit still books its shield-absorbed amount (a landed shot)', () => {
    const ctx = makeCtx();
    const player = makePlayer({ chassisId: 'medium', shield: { max: 50 } });
    CombatMixin._damagePlayerAt.call(ctx, 20, player, { enemyKind: 'drone' });
    expect(ctx.booked).toEqual([20]);   // shield-absorbed is NOT overshoot
  });
});
