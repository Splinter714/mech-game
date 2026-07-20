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
  carrier:   { structure: 50,  armor: 50,  shield: 50,  total: 150 },
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
    m.configureShield({ max: PLAYER_SHIELD_MAX, regenPerSec: 25, pauseMs: 3000 });
    expect(mechLayers(m)).toEqual(TABLE.player);
  });
});

describe('#299: the player shield baseline', () => {
  // ArenaScene can't be imported here (it pulls in Phaser), so pin the literal by reading the
  // source — enough to catch the two drifting apart, which is the only failure mode that matters.
  it('PLAYER_SHIELD is the #380 shape: 100 max, 25/sec regen, 3000ms pause', () => {
    const src = readFileSync(new URL('../scenes/ArenaScene.js', import.meta.url), 'utf8');
    expect(src).toMatch(/const PLAYER_SHIELD = \{ max: 100, regenPerSec: 25, pauseMs: 3000 \};/);
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
    expect(CHASSIS.mediumPlayer.movement).toEqual(CHASSIS.medium.movement);
    expect(CHASSIS.mediumPlayer.weightClass).toBe('medium');
  });
});

describe('#299: enemy mechs now carry a regenerating shield', () => {
  // They had NONE before this pass. The pause is the lever that makes bursting correct: any hit
  // that touches the shield restarts it, so under sustained fire the shield never ticks at all.
  it.each([
    ['raider', 25], ['skirmisher', 25], ['sniper', 50], ['artillery', 75],
  ])('%s has a %i-point shield that actually regenerates', (id, max) => {
    const s = new Mech(ENEMIES[id]).shield;
    expect(s.max).toBe(max);
    expect(s.regenPerSec).toBeGreaterThan(0);
    expect(s.pauseMs).toBeGreaterThan(0);
  });

  it('regen is slower per point as the chassis gets heavier (the archetype read)', () => {
    const refill = (id) => { const s = new Mech(ENEMIES[id]).shield; return s.max / s.regenPerSec; };
    expect(refill('raider')).toBeLessThan(refill('sniper'));
    expect(refill('sniper')).toBeLessThan(refill('artillery'));
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

  // #380 forked these: the drone and helicopter no longer share literal regen numbers, because
  // the new shape scales the RATE to each kind's pool. They still share the same SHAPE (long
  // pause, few-second refill) and the drone still refills faster than the helicopter.
  it('still recharges faster than the helicopter, on a shorter pause', () => {
    const d = new HpBody(ENEMY_KINDS.drone).shield;
    const h = new HpBody(ENEMY_KINDS.helicopter).shield;
    expect(d.max / d.regenPerSec).toBeLessThan(h.max / h.regenPerSec);
    expect(d.pauseMs).toBeLessThan(h.pauseMs);
  });

  it('absorbs on the shield first, then refills after the hit-pause clears', () => {
    const d = new HpBody(ENEMY_KINDS.drone);
    const res = d.applyDamage('body', 4);
    expect(res.shieldAbsorbed).toBe(4);
    expect(d.hp).toBe(5);                  // structure untouched
    expect(d.shield.hp).toBe(1);
    d.tickShield(2);                       // #380: still inside the 2200ms pause
    expect(d.shield.hp).toBe(1);
    d.tickShield(0.5);                     // pause clears
    d.tickShield(1);                       // #380: 5/s over 1s caps out at 5
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

// ── #380: shields reward BREAKING CONTACT ─────────────────────────────────────────────────
// Jackson, playtest 2026-07-20: "make shield recharge delay longer, but rate much higher",
// scope confirmed as ALL shields, players and enemies alike. The shape: a long pause after any
// hit that touches the shield, then a refill measured in a FEW SECONDS rather than tens of them.
// Applied proportionally — small pools get small absolute rates buying a comparable refill time,
// NOT the player's absolute numbers. All values are builder-picked playtest dials.
describe('#380: every shield is a long pause then a fast refill', () => {
  // The full table, restated as data so a retune has one obvious place to edit.
  const SHIELDS = {
    player:     { max: 100, regenPerSec: 25,   pauseMs: 3000 },
    raider:     { max: 25,  regenPerSec: 12.5, pauseMs: 2500 },
    skirmisher: { max: 25,  regenPerSec: 12.5, pauseMs: 2500 },
    sniper:     { max: 50,  regenPerSec: 20,   pauseMs: 3000 },
    artillery:  { max: 75,  regenPerSec: 25,   pauseMs: 3500 },
    drone:      { max: 5,   regenPerSec: 5,    pauseMs: 2200 },
    helicopter: { max: 15,  regenPerSec: 7.5,  pauseMs: 2400 },
    carrier:    { max: 50,  regenPerSec: 16,   pauseMs: 3500 },
  };

  for (const id of ['raider', 'skirmisher', 'sniper', 'artillery']) {
    it(`${id} (enemy mech) carries the pinned #380 shield`, () => {
      const s = new Mech(ENEMIES[id]).shield;
      expect({ max: s.max, regenPerSec: s.regenPerSec, pauseMs: s.pauseMs }).toEqual(SHIELDS[id]);
    });
  }

  for (const id of ['drone', 'helicopter', 'carrier']) {
    it(`${id} (enemy vehicle) carries the pinned #380 shield`, () => {
      const s = new HpBody(ENEMY_KINDS[id]).shield;
      expect({ max: s.max, regenPerSec: s.regenPerSec, pauseMs: s.pauseMs }).toEqual(SHIELDS[id]);
    });
  }

  it('every shielded kind now pauses for at least 2 full seconds', () => {
    for (const [id, s] of Object.entries(SHIELDS)) {
      expect(s.pauseMs, id).toBeGreaterThanOrEqual(2000);
    }
  });

  it('every shielded kind refills from empty in under 5 seconds once regen starts', () => {
    for (const [id, s] of Object.entries(SHIELDS)) {
      expect(s.max / s.regenPerSec, id).toBeLessThan(5);
    }
  });

  it('heavier things take longer to START recovering (pause tracks weight/bulk)', () => {
    expect(SHIELDS.drone.pauseMs).toBeLessThan(SHIELDS.helicopter.pauseMs);
    expect(SHIELDS.helicopter.pauseMs).toBeLessThan(SHIELDS.raider.pauseMs);
    expect(SHIELDS.raider.pauseMs).toBeLessThan(SHIELDS.sniper.pauseMs);
    expect(SHIELDS.sniper.pauseMs).toBeLessThan(SHIELDS.artillery.pauseMs);
  });

  it('heavier things also take longer to finish refilling (refill time tracks weight/bulk)', () => {
    const t = (id) => SHIELDS[id].max / SHIELDS[id].regenPerSec;
    expect(t('drone')).toBeLessThan(t('helicopter'));
    expect(t('helicopter')).toBeLessThan(t('sniper'));
    expect(t('sniper')).toBeLessThan(t('artillery'));
  });

  // The behaviour, not just the literals: chipping away keeps the shield down; breaking off
  // brings it all the way back fast. This is the actual point of the change.
  it('the player shield does NOT tick at all under sustained chip damage', () => {
    const m = new Mech({ chassisId: 'mediumPlayer' });
    m.configureShield(SHIELDS.player);
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
    m.configureShield(SHIELDS.player);
    m.applyDamage('leftArm', 100);
    expect(m.shield.hp).toBe(0);
    // Still pausing at 2.9s: nothing has come back yet.
    for (let i = 0; i < 29; i++) m.tickShield(0.1);
    expect(m.shield.hp).toBe(0);
    // By 7.0s total the 4-second refill has completed.
    for (let i = 0; i < 41; i++) m.tickShield(0.1);
    expect(m.shield.hp).toBe(100);
  });

  it('a drone gets its 5-point shield back ~1s after its (shorter) pause clears', () => {
    const d = new HpBody(ENEMY_KINDS.drone);
    d.applyDamage('body', 5);
    expect(d.shield.hp).toBe(0);
    for (let i = 0; i < 21; i++) d.tickShield(0.1);   // 2.1s — still inside the 2.2s pause
    expect(d.shield.hp).toBe(0);
    for (let i = 0; i < 12; i++) d.tickShield(0.1);   // 3.3s total — refill done
    expect(d.shield.hp).toBe(5);
  });
});
