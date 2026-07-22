// #299 — the balance table, asserted exactly.
//
// Every number here came directly from the repo owner in a live pass and is settled. This file
// is the single place that pins them, so a future retune has one obvious thing to update rather
// than a scattering of literals across a dozen suites (which is precisely the drift #106/#301
// already had to clean up).
//
// The table is stated once, as data, and checked layer-by-layer AND as a total — a total-only
// check would happily pass if armor and structure were swapped.
import { describe, it, expect } from 'vitest';
import { Mech } from './Mech.js';
import { HpBody } from './HpBody.js';
import { ENEMIES } from './enemies.js';
import { ENEMY_KINDS } from './enemyKinds.js';
import { LOCATIONS } from './anatomy.js';
import { CHASSIS } from './chassis/index.js';
import { rosterToughnessBounds } from './rosterBounds.js';
import { tickShield, SHIELD_PAUSE_MS, SHIELD_REGEN_FRACTION } from './shield.js';
import { readFileSync } from 'node:fs';

// The player's shield is configured at deploy time rather than on the chassis (it predates this
// pass — see PLAYER_SHIELD in scenes/ArenaScene.js). Mirrored here so the player's row can be
// asserted as a whole; the value is cross-checked against the scene below.
const PLAYER_SHIELD_MAX = 100;

// structure / armor / shield, exactly as the owner gave them.
const TABLE = {
  infantry:    { structure: 3,   armor: 0,   shield: 0,   total: 3 },
  // #370 (owner-set): drone went 3 -> 5 structure + 5 shield = 10 total ("10 total, 5 of each",
  // having just picked shields over armor).
  drone:       { structure: 5,   armor: 0,   shield: 5,   total: 10 },
  turret:      { structure: 35,  armor: 15,  shield: 0,   total: 50 },
  helicopter:  { structure: 35,  armor: 0,   shield: 15,  total: 50 },
  tank:        { structure: 50,  armor: 30,  shield: 0,   total: 80 },
  // #436: shield -> armor, same value (50). 50 structure / 100 armor = 150 total, unchanged.
  carrier:   { structure: 50,  armor: 100, shield: 0,   total: 150 },
  raider:      { structure: 100, armor: 75,  shield: 25,  total: 200 },
  skirmisher:  { structure: 100, armor: 75,  shield: 25,  total: 200 },
  sniper:      { structure: 150, armor: 150, shield: 50,  total: 350 },
  artillery:   { structure: 200, armor: 225, shield: 75,  total: 500 },
  // #324: the player's row as it ACTUALLY is. The owner set 200/300/100 in the #299 pass, but
  // ArenaScene then multiplied armor+structure by 7 at deploy (#64's `boostHealth`), so the mech
  // on the field was never the 600 this table claimed. The multiplier is now folded into the
  // chassis and boostHealth is gone; effective toughness is unchanged at 3500 (+100 shield).
  player:      { structure: 1400, armor: 2100, shield: 100, total: 3600 },
};

// A mech's structure/armor are per-location; sum them the way the balance table means them.
function mechLayers(m) {
  const structure = LOCATIONS.reduce((s, l) => s + m.parts[l].maxHp, 0);
  const armor = LOCATIONS.reduce((s, l) => s + m.parts[l].maxArmor, 0);
  return { structure, armor, shield: m.shield?.max ?? 0, total: m.toughness };
}

function bodyLayers(b) {
  return { structure: b.maxHp, armor: b.maxArmor, shield: b.shield?.max ?? 0, total: b.toughness };
}

describe('#299: every unit hits its confirmed structure / armor / shield numbers', () => {
  for (const id of ['infantry', 'drone', 'turret', 'helicopter', 'tank', 'carrier']) {
    it(`${id} (vehicle kind)`, () => {
      expect(bodyLayers(new HpBody(ENEMY_KINDS[id]))).toEqual(TABLE[id]);
    });
  }

  for (const id of ['raider', 'skirmisher', 'sniper', 'artillery']) {
    it(`${id} (enemy mech)`, () => {
      expect(mechLayers(new Mech(ENEMIES[id]))).toEqual(TABLE[id]);
    });
  }

  it('the player mech', () => {
    const m = new Mech({ chassisId: 'mediumPlayer' });
    m.configureShield({ max: PLAYER_SHIELD_MAX });
    expect(mechLayers(m)).toEqual(TABLE.player);
  });
});

describe('#299: the player shield baseline', () => {
  // ArenaScene can't be imported here (it pulls in Phaser), so pin the literal by reading the
  // source — enough to catch the two drifting apart, which is the only failure mode that matters.
  it('PLAYER_SHIELD is just a 100-point pool (#382: pause/regen are shared constants in shield.js)', () => {
    const src = readFileSync(new URL('../scenes/ArenaScene.js', import.meta.url), 'utf8');
    expect(src).toMatch(/const PLAYER_SHIELD = \{ max: 100 \};/);
  });
});

describe('#299: the player and the enemy medium chassis are genuinely separable', () => {
  // The whole reason chassis/mediumPlayer.js exists. Both are medium weight class, both ride the
  // same movement feel, but their stat blocks differ — which one config could not express.
  it('the player rides mediumPlayer, the Warden rides medium, and they differ', () => {
    expect(ENEMIES.sniper.chassisId).toBe('medium');
    const player = new Mech({ chassisId: 'mediumPlayer' });
    const warden = new Mech(ENEMIES.sniper);
    expect(mechLayers(player).structure).toBe(1400);
    expect(mechLayers(player).armor).toBe(2100);
    expect(mechLayers(warden).structure).toBe(150);
    expect(mechLayers(warden).armor).toBe(150);
  });

  it('but they still share medium\'s movement feel verbatim (only the stats forked)', () => {
    // #403: the player's step cadence is quicker than the shared medium (its stepInterval was
    // tuned before #159 doubled maxSpeed) — the ONLY movement field allowed to diverge.
    const { stepInterval: pStep, ...pRest } = CHASSIS.mediumPlayer.movement;
    const { stepInterval: mStep, ...mRest } = CHASSIS.medium.movement;
    expect(pRest).toEqual(mRest);
    expect(pStep).toBe(250);
    expect(pStep).toBeLessThan(mStep);
    expect(CHASSIS.mediumPlayer.weightClass).toBe('medium');
  });
});

describe('#299/#382: enemy mechs now carry a regenerating shield', () => {
  // They had NONE before this pass. The pause is the lever that makes bursting correct: any hit
  // that touches the shield restarts it, so under sustained fire the shield never ticks at all.
  // #382: pause and regen are now shared across ALL shields (no per-kind rate), so the only
  // per-kind dial is the pool SIZE.
  it.each([
    ['raider', 25], ['skirmisher', 25], ['sniper', 50], ['artillery', 75],
  ])('%s has a %i-point shield that actually regenerates', (id, max) => {
    const s = new Mech(ENEMIES[id]).shield;
    expect(s.max).toBe(max);
    // regen is a shared 25%-of-max fraction; a positive pool therefore regenerates.
    const before = ((s.hp = 0), s.hp);
    tickShield(s, 1);
    expect(s.hp).toBeGreaterThan(before);
  });

  it('every enemy-mech shield refills in the SAME 4s regardless of pool size (#382)', () => {
    for (const id of ['raider', 'skirmisher', 'sniper', 'artillery']) {
      const s = new Mech(ENEMIES[id]).shield;
      s.hp = 0;
      for (let t = 0; t < 4; t += 0.1) tickShield(s, 0.1);
      expect(s.hp, id).toBeCloseTo(s.max, 4);
    }
  });
});

describe('#370: the drone is HP+SHIELD, reusing the helicopter\'s regen tuning', () => {
  it('carries a 5-point shield in front of 5 structure, no armor', () => {
    const d = new HpBody(ENEMY_KINDS.drone);
    expect(d.maxHp).toBe(5);
    expect(d.maxArmor).toBe(0);
    expect(d.hasShield()).toBe(true);
    expect(d.shield.max).toBe(5);
    expect(d.toughness).toBe(10);
  });

  // #382 unified the rate: drone and helicopter now share the SAME pause and the SAME
  // percent-of-max regen, so both refill in exactly 4s — the drone no longer refills faster.
  it('shares the unified refill time with the helicopter (both 4s, #382)', () => {
    const refill = (kind) => {
      const s = new HpBody(ENEMY_KINDS[kind]).shield;
      s.hp = 0;
      for (let t = 0; t < 4; t += 0.1) tickShield(s, 0.1);
      return s.hp / s.max;   // fraction reached at 4s
    };
    expect(refill('drone')).toBeCloseTo(1, 4);
    expect(refill('helicopter')).toBeCloseTo(1, 4);
  });

  it('absorbs on the shield first, then refills after the hit-pause clears', () => {
    const d = new HpBody(ENEMY_KINDS.drone);
    const res = d.applyDamage('body', 4);
    expect(res.shieldAbsorbed).toBe(4);
    expect(d.hp).toBe(5);                  // structure untouched
    expect(d.shield.hp).toBe(1);
    d.tickShield(2);                       // #382: still inside the shared 3000ms pause
    expect(d.shield.hp).toBe(1);
    d.tickShield(1);                       // pause clears (3s total)
    d.tickShield(4);                       // #382: 25%/s of the 5 pool over 4s caps out at 5
    expect(d.shield.hp).toBe(5);
  });
});

describe('#299: turrets are armor-only — the owner explicitly ruled out a turret shield', () => {
  it('has armor and no shield at all', () => {
    const t = new HpBody(ENEMY_KINDS.turret);
    expect(t.maxArmor).toBe(15);
    expect(t.hasShield()).toBe(false);
  });
});

describe('#299: the downstream roster bounds re-derive with no edits', () => {
  it('floor is the weakest unit (3) and ceiling the toughest ENEMY (500)', () => {
    // Note the player (3500 + shield) is deliberately outside this span: rosterBounds reads ENEMIES +
    // ENEMY_KINDS, and the player is in neither, so the ceiling means "the toughest thing you
    // fight" — which is what both consumers (drop chance, explosion size) actually want.
    expect(rosterToughnessBounds()).toEqual({ floor: 3, ceil: 500 });
  });
});

// ── #382: ONE shared pause + regen for every shield ───────────────────────────────────────
// Jackson, playtest 2026-07-20: "why do we have different shield pauses for different types of
// things? that should all be the same for all enemies and player, for now" + "rate should maybe
// be a percentage instead of a number?". This REPLACES #380's per-kind table with a single rule:
// a 3000ms pause and a 25%-of-MAX-per-second regen for EVERY shield. Because regen is a fraction
// of max, every pool — 5-point drone to 100-point player — refills in exactly 4s. Only the pool
// SIZE stays per-kind. #380's shape (long pause, fast refill, break-contact-to-recharge) is kept;
// only the per-kind VARIATION is removed.
describe('#382: every shield shares one pause and one percent-of-max regen', () => {
  // Just the pool sizes now — pause and regen are constants, not per-kind data.
  // #436: the carrier dropped out of this table — it's armor-only now, no shield pool.
  const POOLS = {
    player: 100, raider: 25, skirmisher: 25, sniper: 50, artillery: 75,
    drone: 5, helicopter: 15,
  };

  it('the shared constants are the unified values (3000ms pause, 25%/s regen)', () => {
    expect(SHIELD_PAUSE_MS).toBe(3000);
    expect(SHIELD_REGEN_FRACTION).toBe(0.25);
  });

  for (const id of ['raider', 'skirmisher', 'sniper', 'artillery']) {
    it(`${id} (enemy mech) carries only a pool size, sharing pause+regen`, () => {
      const s = new Mech(ENEMIES[id]).shield;
      expect(s.max).toBe(POOLS[id]);
      expect(s.regenPerSec).toBeUndefined();   // no per-kind rate field any more
      expect(s.pauseMs).toBeUndefined();
    });
  }

  for (const id of ['drone', 'helicopter']) {
    it(`${id} (enemy vehicle) carries only a pool size, sharing pause+regen`, () => {
      const s = new HpBody(ENEMY_KINDS[id]).shield;
      expect(s.max).toBe(POOLS[id]);
      expect(s.regenPerSec).toBeUndefined();
      expect(s.pauseMs).toBeUndefined();
    });
  }

  it('every shielded kind refills from empty in the SAME 4s regardless of pool size', () => {
    const refill = (s) => {
      s.hp = 0;
      for (let t = 0; t < 4; t += 0.1) tickShield(s, 0.1);
      return s.hp / s.max;
    };
    for (const id of ['raider', 'skirmisher', 'sniper', 'artillery']) {
      expect(refill(new Mech(ENEMIES[id]).shield), id).toBeCloseTo(1, 4);
    }
    for (const id of ['drone', 'helicopter']) {
      expect(refill(new HpBody(ENEMY_KINDS[id]).shield), id).toBeCloseTo(1, 4);
    }
  });

  it('regen is percent-of-MAX (linear, fully fills) NOT percent-of-current (would asymptote)', () => {
    const s = new Mech(ENEMIES.sniper).shield;   // 50 pool
    s.hp = 0;
    tickShield(s, 1);
    expect(s.hp).toBeCloseTo(12.5, 5);   // 25% of MAX 50, off zero — not fraction-of-current
  });

  // The behaviour, not just the literals: chipping away keeps the shield down; breaking off
  // brings it all the way back fast. This is the actual point of the change, unchanged by #382.
  it('the player shield does NOT tick at all under sustained chip damage', () => {
    const m = new Mech({ chassisId: 'mediumPlayer' });
    m.configureShield({ max: POOLS.player });
    m.applyDamage('leftArm', 40);
    const after = m.shield.hp;
    expect(after).toBe(60);
    // Ten 0.25s frames (2.5s total, under the 3000ms pause) with a chip hit each second.
    for (let i = 0; i < 10; i++) {
      if (i % 4 === 0) m.applyDamage('leftArm', 1);
      m.tickShield(0.25);
    }
    expect(m.shield.hp).toBeLessThanOrEqual(after);   // never regained ground
  });

  it('the player shield is FULL again ~7s after the last hit (3s pause + 4s refill)', () => {
    const m = new Mech({ chassisId: 'mediumPlayer' });
    m.configureShield({ max: POOLS.player });
    m.applyDamage('leftArm', 100);
    expect(m.shield.hp).toBe(0);
    // Still pausing at 2.9s: nothing has come back yet.
    for (let i = 0; i < 29; i++) m.tickShield(0.1);
    expect(m.shield.hp).toBe(0);
    // By 7.0s total the 4-second refill has completed.
    for (let i = 0; i < 41; i++) m.tickShield(0.1);
    expect(m.shield.hp).toBeCloseTo(100, 4);
  });

  it('a drone gets its 5-point shield back on the SAME 3s pause + 4s refill as everything else', () => {
    const d = new HpBody(ENEMY_KINDS.drone);
    d.applyDamage('body', 5);
    expect(d.shield.hp).toBe(0);
    for (let i = 0; i < 29; i++) d.tickShield(0.1);   // 2.9s — still inside the shared 3s pause
    expect(d.shield.hp).toBe(0);
    for (let i = 0; i < 41; i++) d.tickShield(0.1);   // 7.0s total — 4s refill done
    expect(d.shield.hp).toBeCloseTo(5, 4);
  });
});
