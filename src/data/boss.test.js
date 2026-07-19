// #240 boss-battle model tests — the three dismantling rules Jackson asked for, plus the
// summon cadence and the escalation curve.
import { describe, it, expect } from 'vitest';
import {
  BossMech, BOSS_DEF, BOSS_PLATING, CORE_EXPOSE_AT, CORE_MAX_HP, BOSS_SCALE,
  bossEscalation, coreExposed, limbsDestroyed, shouldSummon,
  BOSS_SUMMON_INTERVAL_MS, BOSS_SUMMON_MAX_WAVES, ESCALATION_CADENCE_FLOOR,
} from './boss.js';

// Blow a location off outright, however much health it has.
function wreck(mech, loc) {
  const p = mech.parts[loc];
  mech.applyDamage(loc, p.armor + p.hp);
}

describe('#240 the boss is an oversized mech built from the normal model', () => {
  it('is ~10x the player mech and mounts one weapon per plate', () => {
    expect(BOSS_SCALE).toBe(10);
    const boss = new BossMech();
    expect(boss.chassisId).toBe('colossus');
    for (const loc of BOSS_PLATING) {
      expect(boss.mounts[loc].length, `${loc} should carry exactly one weapon`).toBe(1);
    }
    // Four distinct weapons — blowing a specific limb off removes a specific pressure.
    const ids = BOSS_PLATING.map((loc) => BOSS_DEF.mounts[loc][0]);
    expect(new Set(ids).size).toBe(4);
  });

  it('is far tougher than a heavy player mech (it is a set-piece, not a normal enemy)', () => {
    const boss = new BossMech();
    expect(boss.maxHp).toBeGreaterThan(1500);
  });
});

describe('#240 rule 1 — destroying a limb removes that limb\'s weapon', () => {
  it('the destroyed limb\'s weapon stops being available to fire', () => {
    const boss = new BossMech();
    boss.repairAll();
    const before = boss.readyWeapons().map((w) => w.location);
    expect(before).toContain('rightArm');

    wreck(boss, 'rightArm');
    const after = boss.readyWeapons().map((w) => w.location);
    expect(after).not.toContain('rightArm');
    // …and only that one — the other three plates keep shooting.
    expect(after).toContain('leftArm');
    expect(after).toContain('leftTorso');
    expect(after).toContain('rightTorso');
  });
});

describe('#240 rule 2 — losing a part escalates what survives', () => {
  it('an undamaged boss fires at its weapons\' own tuning', () => {
    const e = bossEscalation(0);
    expect(e.cadenceScale).toBe(1);
    expect(e.extraCount).toBe(0);
  });

  it('each destroyed plate makes the survivors faster and wilder', () => {
    const steps = [0, 1, 2, 3, 4].map(bossEscalation);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].cadenceScale).toBeLessThanOrEqual(steps[i - 1].cadenceScale);
      expect(steps[i].aimJitter).toBeGreaterThan(steps[i - 1].aimJitter);
    }
    expect(steps[4].cadenceScale).toBeGreaterThanOrEqual(ESCALATION_CADENCE_FLOOR);
  });

  it('escalation is driven by the live mech, so it triggers the moment a limb dies', () => {
    const boss = new BossMech();
    boss.repairAll();
    expect(boss.escalation().stage).toBe(0);
    wreck(boss, 'leftArm');
    expect(limbsDestroyed(boss)).toBe(1);
    expect(boss.escalation().stage).toBe(1);
    expect(boss.escalation().cadenceScale).toBeLessThan(1);
  });

  it('half-dismantled, the survivors add an extra emission per volley', () => {
    expect(bossEscalation(1).extraCount).toBe(0);
    expect(bossEscalation(2).extraCount).toBe(1);
  });
});

describe('#240 rule 3 — the plating hides a vulnerable core', () => {
  it('the core starts sealed and is not exposed until enough plates are gone', () => {
    expect(coreExposed(CORE_EXPOSE_AT - 1)).toBe(false);
    expect(coreExposed(CORE_EXPOSE_AT)).toBe(true);

    const boss = new BossMech();
    boss.repairAll();
    expect(boss.coreExposed()).toBe(false);
    wreck(boss, 'leftArm');
    wreck(boss, 'rightArm');
    expect(boss.coreExposed()).toBe(false);
  });

  it('while sealed, damage into wrecked plate space is fully absorbed', () => {
    const boss = new BossMech();
    boss.repairAll();
    wreck(boss, 'leftArm');
    const res = boss.applyDamage('leftArm', 500);
    expect(res.applied).toBe(0);
    expect(res.absorbed).toBe(true);
    expect(boss.core.hp).toBe(CORE_MAX_HP);
    expect(boss.isDestroyed()).toBe(false);
  });

  it('once exposed, that same damage lands on the core', () => {
    const boss = new BossMech();
    boss.repairAll();
    wreck(boss, 'leftArm');
    wreck(boss, 'rightArm');
    wreck(boss, 'leftTorso');
    expect(boss.coreExposed()).toBe(true);

    const res = boss.applyDamage('leftArm', 100);
    expect(res.core).toBe(true);
    expect(res.applied).toBe(100);
    expect(boss.core.hp).toBe(CORE_MAX_HP - 100);
  });

  it('the boss dies from the CORE, never from the ordinary both-torsos mech kill rule', () => {
    const boss = new BossMech();
    boss.repairAll();
    wreck(boss, 'leftTorso');
    wreck(boss, 'rightTorso');
    // A normal mech is dead at this point (anatomy.js LETHAL_GROUPS). The boss is not — this is
    // exactly the moment the kill window OPENS.
    expect(boss.coreExposed()).toBe(true);
    expect(boss.isDestroyed()).toBe(false);

    boss.applyDamage('leftTorso', CORE_MAX_HP);
    expect(boss.core.hp).toBe(0);
    expect(boss.isDestroyed()).toBe(true);
  });

  it('a hit on a still-LIVE plate is ordinary plate damage, never a core hit', () => {
    const boss = new BossMech();
    boss.repairAll();
    wreck(boss, 'leftArm');
    wreck(boss, 'rightArm');
    wreck(boss, 'leftTorso');
    const before = boss.parts.rightTorso.armor;
    const res = boss.applyDamage('rightTorso', 40);
    expect(res.core).toBeUndefined();
    expect(boss.parts.rightTorso.armor).toBe(before - 40);
    expect(boss.core.hp).toBe(CORE_MAX_HP);
  });

  it('repairAll restores the core too, so a redeploy is a fresh fight', () => {
    const boss = new BossMech();
    wreck(boss, 'leftArm'); wreck(boss, 'rightArm'); wreck(boss, 'leftTorso');
    boss.applyDamage('leftArm', 300);
    expect(boss.core.hp).toBeLessThan(CORE_MAX_HP);
    boss.repairAll();
    expect(boss.core.hp).toBe(CORE_MAX_HP);
    expect(boss.limbsDestroyed()).toBe(0);
    expect(boss.coreExposed()).toBe(false);
  });
});

describe('#240 summons are a rare side dish, never the main threat', () => {
  const base = { elapsedSinceLastMs: BOSS_SUMMON_INTERVAL_MS, wavesSoFar: 0, destroyedCount: 1 };

  it('never summons during the opening duel (no limb taken yet)', () => {
    expect(shouldSummon({ ...base, destroyedCount: 0 })).toBe(false);
  });

  it('respects the long interval', () => {
    expect(shouldSummon({ ...base, elapsedSinceLastMs: BOSS_SUMMON_INTERVAL_MS - 1 })).toBe(false);
    expect(shouldSummon(base)).toBe(true);
  });

  it('is hard-capped for the whole fight', () => {
    expect(shouldSummon({ ...base, wavesSoFar: BOSS_SUMMON_MAX_WAVES })).toBe(false);
  });
});
