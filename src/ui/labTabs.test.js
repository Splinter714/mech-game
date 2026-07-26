import { describe, it, expect } from 'vitest';
import {
  LAB_TABS, LAB_TAB_IDS, nextLabTab, labTabForSlotKind, labTabId, TAB_DEFAULT_SLOT,
} from './labTabs.js';

describe('LAB_TABS (#529) — the Mech Lab\'s 5-tab system', () => {
  it('defines exactly the five confirmed tabs, in order', () => {
    expect(LAB_TAB_IDS).toEqual(['chassis', 'weapon', 'ability', 'passive', 'color']);
  });

  it('nextLabTab wraps forward and backward', () => {
    expect(nextLabTab(0, 1)).toBe(1);
    expect(nextLabTab(4, 1)).toBe(0);
    expect(nextLabTab(0, -1)).toBe(4);
    expect(nextLabTab(2, -1)).toBe(1);
  });

  it('labTabId returns the tab id at an index, wrapping defensively', () => {
    expect(labTabId(0)).toBe('chassis');
    expect(labTabId(4)).toBe('color');
    expect(labTabId(5)).toBe('chassis');
    expect(labTabId(-1)).toBe('color');
  });

  it('labTabForSlotKind maps each mountable slot family to its tab', () => {
    expect(labTabForSlotKind('weapon')).toBe(1);
    expect(labTabForSlotKind('ability')).toBe(2);
    expect(labTabForSlotKind('core')).toBe(3);
    expect(labTabForSlotKind('nonsense')).toBeNull();
  });

  it('TAB_DEFAULT_SLOT gives a real slot for each slot-kind tab', () => {
    expect(TAB_DEFAULT_SLOT.weapon).toBe('leftArm');
    expect(TAB_DEFAULT_SLOT.ability).toBe('abilityY');
    expect(TAB_DEFAULT_SLOT.passive).toBe('core');
  });

  it('every LAB_TABS entry has an id and a label', () => {
    for (const tab of LAB_TABS) {
      expect(typeof tab.id).toBe('string');
      expect(typeof tab.label).toBe('string');
    }
  });
});
