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
  drone:       { structure: 3,   armor: 0,   shield: 0,   total: 3 },
  turret:      { structure: 35,  armor: 15,  shield: 0,   total: 50 },
  helicopter:  { structure: 35,  armor: 0,   shield: 15,  total: 50 },
  tank:        { structure: 50,  armor: 30,  shield: 0,   total: 80 },
  quadruped:   { structure: 50,  armor: 50,  shield: 50,  total: 150 },
  raider:      { structure: 100, armor: 75,  shield: 25,  total: 200 },
  skirmisher:  { structure: 100, armor: 75,  shield: 25,  total: 200 },
  sniper:      { structure: 150, armor: 150, shield: 50,  total: 350 },
  artillery:   { structure: 200, armor: 225, shield: 75,  total: 500 },
  player:      { structure: 200, armor: 300, shield: 100, total: 600 },
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
  for (const id of ['infantry', 'drone', 'turret', 'helicopter', 'tank', 'quadruped']) {
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
    m.configureShield({ max: PLAYER_SHIELD_MAX, regenPerSec: 2, pauseMs: 1200 });
    expect(mechLayers(m)).toEqual(TABLE.player);
  });
});

describe('#299: the player shield baseline', () => {
  // ArenaScene can't be imported here (it pulls in Phaser), so pin the literal by reading the
  // source — enough to catch the two drifting apart, which is the only failure mode that matters.
  it('PLAYER_SHIELD.max is 100, with the regen behaviour left unchanged', () => {
    const src = readFileSync(new URL('../scenes/ArenaScene.js', import.meta.url), 'utf8');
    expect(src).toMatch(/const PLAYER_SHIELD = \{ max: 100, regenPerSec: 2, pauseMs: 1200 \};/);
  });
});

describe('#299: the player and the enemy medium chassis are genuinely separable', () => {
  // The whole reason chassis/mediumPlayer.js exists. Both are medium weight class, both ride the
  // same movement feel, but their stat blocks differ — which one config could not express.
  it('the player rides mediumPlayer, the Warden rides medium, and they differ', () => {
    expect(ENEMIES.sniper.chassisId).toBe('medium');
    const player = new Mech({ chassisId: 'mediumPlayer' });
    const warden = new Mech(ENEMIES.sniper);
    expect(mechLayers(player).structure).toBe(200);
    expect(mechLayers(player).armor).toBe(300);
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

describe('#299: turrets are armor-only — the owner explicitly ruled out a turret shield', () => {
  it('has armor and no shield at all', () => {
    const t = new HpBody(ENEMY_KINDS.turret);
    expect(t.maxArmor).toBe(15);
    expect(t.hasShield()).toBe(false);
  });
});

describe('#299: the downstream roster bounds re-derive with no edits', () => {
  it('floor is the weakest unit (3) and ceiling the toughest ENEMY (500)', () => {
    // Note the player (600) is deliberately outside this span: rosterBounds reads ENEMIES +
    // ENEMY_KINDS, and the player is in neither, so the ceiling means "the toughest thing you
    // fight" — which is what both consumers (drop chance, explosion size) actually want.
    expect(rosterToughnessBounds()).toEqual({ floor: 3, ceil: 500 });
  });
});
