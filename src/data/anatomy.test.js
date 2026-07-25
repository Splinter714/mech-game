import { describe, it, expect } from 'vitest';
import { slotKind, WEAPON_SLOTS, ABILITY_SLOTS, CORE_SLOTS } from './anatomy.js';

describe('slotKind', () => {
  it('classifies every weapon slot as weapon', () => {
    for (const loc of WEAPON_SLOTS) expect(slotKind(loc)).toBe('weapon');
  });

  it('classifies every ability slot as ability', () => {
    for (const loc of ABILITY_SLOTS) expect(slotKind(loc)).toBe('ability');
  });

  it('classifies every core slot as core', () => {
    for (const loc of CORE_SLOTS) expect(slotKind(loc)).toBe('core');
  });

  it('returns null for a non-mountable location or garbage input', () => {
    expect(slotKind('head')).toBe(null);
    expect(slotKind('centerTorso')).toBe(null);
    expect(slotKind('not-a-real-slot')).toBe(null);
    expect(slotKind(undefined)).toBe(null);
  });
});
