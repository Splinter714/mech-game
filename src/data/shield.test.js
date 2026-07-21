import { describe, it, expect } from 'vitest';
import {
  createShield, shieldPresent, damageShield, tickShield, fillShield, shieldFraction,
  grantTempShield, shieldTotalHp, shieldTotalMax,
  layerMultiplier, LAYER_MULTIPLIERS,
  SHIELD_PAUSE_MS, SHIELD_REGEN_FRACTION,
} from './shield.js';

describe('createShield / shieldPresent — config-driven, absent by default', () => {
  it('a zero/absent config is "no shield at all"', () => {
    expect(shieldPresent(createShield())).toBe(false);
    expect(shieldPresent(createShield({}))).toBe(false);
    expect(shieldPresent(createShield({ max: 0 }))).toBe(false);
  });

  it('a positive max config starts full and present — pool SIZE is the only per-kind dial (#382)', () => {
    const s = createShield({ max: 50 });
    expect(shieldPresent(s)).toBe(true);
    expect(s.hp).toBe(50);
    expect(s.max).toBe(50);
    expect(s.pauseRemaining).toBe(0);
    // #382: pause/regen are no longer per-config — they're shared constants, not fields on the shield.
    expect(s.regenPerSec).toBeUndefined();
    expect(s.pauseMs).toBeUndefined();
  });

  it('clamps a negative max to zero rather than going negative', () => {
    const s = createShield({ max: -10 });
    expect(s.max).toBe(0);
  });
});

// #382: ONE shared pause and ONE shared regen rule for ALL shields — player and every enemy kind.
// No per-kind pauseMs/regenPerSec table (that was #380, now removed). Pause = 3000ms for
// everything; regen = 25% of MAX per second, so every pool refills in exactly 4s regardless of
// size. These tests pin the shared model at several pool sizes to prove the invariant.
describe('unified shield pause + regen (#382)', () => {
  it('exposes the shared constants: 3000ms pause, 25%/s regen fraction', () => {
    expect(SHIELD_PAUSE_MS).toBe(3000);
    expect(SHIELD_REGEN_FRACTION).toBe(0.25);
  });

  it('any absorbing hit starts the SAME 3000ms pause regardless of pool size', () => {
    for (const max of [5, 15, 50, 100]) {
      const s = createShield({ max });
      damageShield(s, 1);
      expect(s.pauseRemaining).toBe(3000);
    }
  });

  it('regen is 25% of MAX per second at every pool size (5-pt drone 1.25/s, 100-pt player 25/s)', () => {
    const cases = [[5, 1.25], [15, 3.75], [50, 12.5], [100, 25]];
    for (const [max, perSec] of cases) {
      const s = createShield({ max });
      s.hp = 0;
      tickShield(s, 1);            // one second of regen, no pause active
      expect(s.hp).toBeCloseTo(perSec, 5);
    }
  });

  it('every pool refills fully in ~4s regardless of size (linear percent-of-MAX)', () => {
    for (const max of [5, 15, 50, 100]) {
      const s = createShield({ max });
      s.hp = 0;
      // integrate in small steps up to 4s — should reach exactly max, and not before.
      for (let t = 0; t < 4; t += 0.1) tickShield(s, 0.1);
      expect(s.hp).toBeCloseTo(max, 4);
    }
  });

  it('regen is percent-of-MAX (linear, fully fills) NOT percent-of-current (would asymptote — a bug)', () => {
    const s = createShield({ max: 100 });
    s.hp = 0;
    // percent-of-current from 0 could never leave 0; percent-of-max adds a flat 25/s from empty.
    tickShield(s, 1);
    expect(s.hp).toBeCloseTo(25, 5);   // moved off zero — proves it's not fraction-of-current
    // and it actually reaches full, which an exponential percent-of-current never would.
    for (let t = 0; t < 3; t += 0.1) tickShield(s, 0.1);
    expect(s.hp).toBeCloseTo(100, 4);
  });
});

describe('damageShield — absorb-then-overflow, mirrors the old absorbShieldDamage math', () => {
  it('fully absorbs a hit smaller than remaining shield hp', () => {
    const s = createShield({ max: 60 });
    const r = damageShield(s, 20);
    expect(r).toEqual({ absorbed: 20, overflow: 0 });
    expect(s.hp).toBe(40);
  });

  it('breaks the shield when a hit exceeds remaining hp, passing overflow through', () => {
    const s = createShield({ max: 20 });
    const r = damageShield(s, 34);
    expect(r.absorbed).toBe(20);
    expect(r.overflow).toBe(14);
    expect(s.hp).toBe(0);
  });

  it('an absent shield (no config) absorbs nothing — the whole hit overflows', () => {
    const s = createShield();
    const r = damageShield(s, 25);
    expect(r).toEqual({ absorbed: 0, overflow: 25 });
  });

  it('a hit reaching the shield (absorbed > 0) starts the post-hit pause, even on the breaking hit', () => {
    const s = createShield({ max: 20 });
    damageShield(s, 34);   // breaks it, absorbed 20 > 0
    expect(s.pauseRemaining).toBe(SHIELD_PAUSE_MS);
  });

  it('treats non-positive damage as a no-op', () => {
    const s = createShield({ max: 20 });
    expect(damageShield(s, 0)).toEqual({ absorbed: 0, overflow: 0 });
    expect(damageShield(s, -5)).toEqual({ absorbed: 0, overflow: 0 });
    expect(s.hp).toBe(20);
  });
});

describe('tickShield — passive regen with a brief post-hit pause (#246)', () => {
  it('does nothing to an absent shield', () => {
    const s = createShield();
    tickShield(s, 10);
    expect(s.hp).toBe(0);
  });

  it('regenerates at 25% of max per second once there is no pause', () => {
    const s = createShield({ max: 50 });   // 25% of 50 = 12.5/s
    s.hp = 10;
    tickShield(s, 3);   // +37.5
    expect(s.hp).toBeCloseTo(47.5, 5);
  });

  it('never regenerates past max', () => {
    const s = createShield({ max: 50 });
    s.hp = 40;
    tickShield(s, 10);
    expect(s.hp).toBe(50);
  });

  it('counts the pause down first — no regen accrues while paused', () => {
    const s = createShield({ max: 50 });
    s.hp = 10;
    damageShield(s, 5);                     // absorbed, starts the shared 3000ms pause
    expect(s.pauseRemaining).toBe(SHIELD_PAUSE_MS);
    tickShield(s, 0.5);                     // 500ms of pause consumed, no regen yet
    expect(s.pauseRemaining).toBe(SHIELD_PAUSE_MS - 500);
    expect(s.hp).toBe(5);                   // still just what damageShield left it at
  });

  it('regen resumes exactly once the pause clears — brief interrupt, not a long lockout', () => {
    const s = createShield({ max: 50 });    // 12.5/s regen
    s.hp = 20;
    damageShield(s, 5);                     // hp -> 15, pause starts at 3000ms
    tickShield(s, SHIELD_PAUSE_MS / 1000);  // pause clears exactly this tick — no regen split within it
    expect(s.pauseRemaining).toBe(0);
    expect(s.hp).toBe(15);
    tickShield(s, 1);                       // +12.5 now that the pause is clear
    expect(s.hp).toBeCloseTo(27.5, 5);
  });
});

describe('fillShield / shieldFraction', () => {
  it('fillShield tops an active shield straight to max', () => {
    const s = createShield({ max: 50 });
    s.hp = 5;
    fillShield(s);
    expect(s.hp).toBe(50);
  });

  it('fillShield is a no-op on an absent shield', () => {
    const s = createShield();
    fillShield(s);
    expect(s.hp).toBe(0);
  });

  it('shieldFraction is 0 for an absent shield and hp/max otherwise', () => {
    expect(shieldFraction(createShield())).toBe(0);
    const s = createShield({ max: 40 });
    s.hp = 10;
    expect(shieldFraction(s)).toBe(0.25);
  });
});

// #381: the expendable TEMPORARY pool (D&D temp HP) — outermost layer, spent first, never
// regenerates, never lifts the regen ceiling. As the shield POWERUP grants it (no durationMs) it
// PERSISTS UNTIL SPENT by damage — no time-expiry. A caller may still pass a finite positive
// durationMs to opt into a wall-clock expiry (the retained optional path, exercised below).
describe('temporary shield pool (#381)', () => {
  it('createShield starts with no temp pool', () => {
    const s = createShield({ max: 50 });
    expect(s.temp).toBe(0);
    expect(s.tempExpiryMs).toBe(0);
  });

  it('grantTempShield adds a pool on top of base and tops base to full, leaving base max alone', () => {
    const s = createShield({ max: 40 });
    s.hp = 10;
    grantTempShield(s, 150, 10000);
    expect(s.temp).toBe(150);
    expect(s.tempExpiryMs).toBe(10000);
    expect(s.max).toBe(40);          // base capacity untouched
    expect(s.hp).toBe(40);           // base filled
    expect(shieldTotalHp(s)).toBe(190);
    expect(shieldTotalMax(s)).toBe(190);
  });

  it('damage spends the temp pool FIRST, then base hp, then overflows', () => {
    const s = createShield({ max: 40 });
    grantTempShield(s, 50, 10000);   // total 90
    expect(damageShield(s, 30)).toEqual({ absorbed: 30, overflow: 0 });
    expect(s.temp).toBe(20);
    expect(s.hp).toBe(40);           // base untouched while temp remains
    expect(damageShield(s, 30)).toEqual({ absorbed: 30, overflow: 0 });
    expect(s.temp).toBe(0);
    expect(s.hp).toBe(30);           // dipped into base once temp was gone
    expect(damageShield(s, 40)).toEqual({ absorbed: 30, overflow: 10 });
    expect(s.hp).toBe(0);
  });

  it('the temp pool never regenerates; base hp still regens only up to base max', () => {
    const s = createShield({ max: 40 });   // base regen 25%/s = 10/s
    grantTempShield(s, 60, 10000);
    damageShield(s, 80);             // temp 60->0, base 40->20, starts the 3000ms pause
    tickShield(s, 4);                // one long tick clears the 3s pause (no regen within it)
    tickShield(s, 10);               // now regen runs — 10/s well past the 20 remaining, capped at max
    expect(s.temp).toBe(0);          // spent temp stays gone
    expect(s.hp).toBe(40);           // base refills to base max, no further
  });

  it('the shield-powerup grant (no durationMs) PERSISTS UNTIL SPENT — never time-expires', () => {
    const s = createShield({ max: 40 });
    grantTempShield(s, 150);         // powerup path: no expiry
    expect(s.tempExpiryMs).toBe(Infinity);
    tickShield(s, 60);               // tick well past any 10s window, no damage
    tickShield(s, 60);
    expect(s.temp).toBe(150);        // pool is fully intact
    // ...and it is still spent by damage FIRST, and once depleted it is gone.
    expect(damageShield(s, 150)).toEqual({ absorbed: 150, overflow: 0 });
    expect(s.temp).toBe(0);
    tickShield(s, 10);
    expect(s.temp).toBe(0);          // spent temp stays gone (never regens back)
    expect(s.hp).toBe(40);           // base was never touched
  });

  it('an unspent temp pool with a FINITE opted-in window still expires (retained optional path)', () => {
    const s = createShield({ max: 40 });
    grantTempShield(s, 60, 2000);
    expect(s.tempExpiryMs).toBe(2000);
    tickShield(s, 1.999);
    expect(s.temp).toBe(60);
    tickShield(s, 0.002);            // window elapses
    expect(s.temp).toBe(0);
    expect(s.tempExpiryMs).toBe(0);
  });

  it('a temp pool works even on a shieldless (max 0) body and still absorbs first', () => {
    const s = createShield();        // max 0
    expect(shieldPresent(s)).toBe(false);
    grantTempShield(s, 40, 10000);
    expect(s.temp).toBe(40);
    expect(damageShield(s, 25)).toEqual({ absorbed: 25, overflow: 0 });
    expect(s.temp).toBe(15);
  });

  it('#417: grantTempShield ADDS on top of the live temp pool, UNCAPPED (sums, not max)', () => {
    const s = createShield({ max: 40 });
    grantTempShield(s, 60, 5000);
    damageShield(s, 30);             // temp 60 -> 30
    grantTempShield(s, 60, 8000);    // #417: ADDS its full 60 on top → 90 (was max-of, i.e. 60)
    expect(s.temp).toBe(90);
    expect(s.tempExpiryMs).toBe(8000);
  });

  it('#417: sequential Shield-powerup grants keep stacking the pool with no ceiling', () => {
    const s = createShield({ max: 40 });
    grantTempShield(s, 150);         // powerup path (no expiry)
    grantTempShield(s, 150);
    grantTempShield(s, 150);
    expect(s.temp).toBe(450);        // 3 pickups → 450, uncapped
    expect(s.tempExpiryMs).toBe(Infinity);
  });
});

describe('layerMultiplier — the category-vs-layer forward-compat seam (#246, not implemented yet)', () => {
  it('every category/layer combination defaults to 1.0 with the current (empty) table', () => {
    expect(LAYER_MULTIPLIERS).toEqual({});
    for (const cat of ['energy', 'ballistic', 'missile', 'melee', 'support', undefined]) {
      for (const layer of ['shield', 'armor', 'hp']) {
        expect(layerMultiplier(cat, layer)).toBe(1);
      }
    }
  });
});
