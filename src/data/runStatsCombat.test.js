import { describe, it, expect } from 'vitest';
import { remainingDurability, overkillFor } from './runStatsCombat.js';

describe('#423 remainingDurability', () => {
  it('sums armor + hp across every part', () => {
    const mech = { parts: { a: { armor: 10, hp: 5 }, b: { armor: 0, hp: 20 } } };
    expect(remainingDurability(mech)).toBe(35);
  });

  it('adds the current shield pool when the unit exposes shieldTotalHp()', () => {
    const mech = { parts: { a: { armor: 0, hp: 10 } }, shieldTotalHp: () => 40 };
    expect(remainingDurability(mech)).toBe(50);
  });

  it('ignores a negative/absent shield reading', () => {
    const mech = { parts: { a: { hp: 10 } }, shieldTotalHp: () => -5 };
    expect(remainingDurability(mech)).toBe(10);
  });

  it('is 0 for a null unit or an empty parts map', () => {
    expect(remainingDurability(null)).toBe(0);
    expect(remainingDurability({ parts: {} })).toBe(0);
  });
});

describe('#423 overkillFor', () => {
  it('is 0 when the hit did not kill', () => {
    expect(overkillFor(100, 40, false)).toBe(0);
  });

  it('is the spill past the durability that was standing on a killing blow', () => {
    expect(overkillFor(100, 40, true)).toBe(60);
  });

  it('is 0 when a kill exactly finishes the unit', () => {
    expect(overkillFor(40, 40, true)).toBe(0);
  });

  it('never goes negative', () => {
    expect(overkillFor(10, 40, true)).toBe(0);
  });
});
