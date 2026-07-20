import { describe, it, expect } from 'vitest';
import {
  createShield, shieldPresent, damageShield, tickShield, fillShield, shieldFraction,
  grantTempShield, shieldTotalHp, shieldTotalMax,
  layerMultiplier, LAYER_MULTIPLIERS,
} from './shield.js';

describe('createShield / shieldPresent — config-driven, absent by default', () => {
  it('a zero/absent config is "no shield at all"', () => {
    expect(shieldPresent(createShield())).toBe(false);
    expect(shieldPresent(createShield({}))).toBe(false);
    expect(shieldPresent(createShield({ max: 0 }))).toBe(false);
  });

  it('a positive max config starts full and present', () => {
    const s = createShield({ max: 50, regenPerSec: 2, pauseMs: 900 });
    expect(shieldPresent(s)).toBe(true);
    expect(s.hp).toBe(50);
    expect(s.max).toBe(50);
    expect(s.pauseRemaining).toBe(0);
  });

  it('clamps negative config fields to zero rather than going negative', () => {
    const s = createShield({ max: -10, regenPerSec: -5, pauseMs: -1 });
    expect(s.max).toBe(0);
    expect(s.regenPerSec).toBe(0);
    expect(s.pauseMs).toBe(0);
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
    const s = createShield({ max: 20, pauseMs: 900 });
    damageShield(s, 34);   // breaks it, absorbed 20 > 0
    expect(s.pauseRemaining).toBe(900);
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

  it('regenerates at regenPerSec once there is no pause', () => {
    const s = createShield({ max: 50, regenPerSec: 2 });
    s.hp = 10;
    tickShield(s, 3);   // +6
    expect(s.hp).toBeCloseTo(16, 5);
  });

  it('never regenerates past max', () => {
    const s = createShield({ max: 50, regenPerSec: 100 });
    s.hp = 40;
    tickShield(s, 10);
    expect(s.hp).toBe(50);
  });

  it('counts the pause down first — no regen accrues while paused', () => {
    const s = createShield({ max: 50, regenPerSec: 10, pauseMs: 1000 });
    s.hp = 10;
    damageShield(s, 5);           // absorbed, starts the 1000ms pause
    expect(s.pauseRemaining).toBe(1000);
    tickShield(s, 0.5);           // 500ms of pause consumed, no regen yet
    expect(s.pauseRemaining).toBe(500);
    expect(s.hp).toBe(5);         // still just what damageShield left it at
  });

  it('regen resumes exactly once the pause clears — brief interrupt, not a long lockout', () => {
    const s = createShield({ max: 50, regenPerSec: 10, pauseMs: 300 });
    s.hp = 20;
    damageShield(s, 5);           // hp -> 15, pause starts at 300ms
    tickShield(s, 0.3);           // pause clears exactly this tick — no regen split within it
    expect(s.pauseRemaining).toBe(0);
    expect(s.hp).toBe(15);
    tickShield(s, 1);             // +10 now that the pause is clear
    expect(s.hp).toBeCloseTo(25, 5);
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
// regenerates, never lifts the regen ceiling, expires with its window if unspent.
describe('temporary shield pool (#381)', () => {
  it('createShield starts with no temp pool', () => {
    const s = createShield({ max: 50 });
    expect(s.temp).toBe(0);
    expect(s.tempExpiryMs).toBe(0);
  });

  it('grantTempShield adds a pool on top of base and tops base to full, leaving base max/regen alone', () => {
    const s = createShield({ max: 40, regenPerSec: 2 });
    s.hp = 10;
    grantTempShield(s, 150, 10000);
    expect(s.temp).toBe(150);
    expect(s.tempExpiryMs).toBe(10000);
    expect(s.max).toBe(40);          // base capacity untouched
    expect(s.regenPerSec).toBe(2);   // base regen untouched
    expect(s.hp).toBe(40);           // base filled
    expect(shieldTotalHp(s)).toBe(190);
    expect(shieldTotalMax(s)).toBe(190);
  });

  it('damage spends the temp pool FIRST, then base hp, then overflows', () => {
    const s = createShield({ max: 40, regenPerSec: 0 });
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
    const s = createShield({ max: 40, regenPerSec: 10, pauseMs: 0 });
    grantTempShield(s, 60, 10000);
    damageShield(s, 80);             // temp 60->0, base 40->20
    tickShield(s, 10);
    expect(s.temp).toBe(0);          // spent temp stays gone
    expect(s.hp).toBe(40);           // base refills to base max, no further
  });

  it('an unspent temp pool expires with its window', () => {
    const s = createShield({ max: 40, regenPerSec: 0 });
    grantTempShield(s, 60, 2000);
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

  it('grantTempShield does not compound the pool size on a duplicate (takes the max, not the sum)', () => {
    const s = createShield({ max: 40 });
    grantTempShield(s, 60, 5000);
    damageShield(s, 30);             // temp 60 -> 30
    grantTempShield(s, 60, 8000);    // duplicate refreshes to 60, not 90
    expect(s.temp).toBe(60);
    expect(s.tempExpiryMs).toBe(8000);
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
