import { describe, it, expect } from 'vitest';
import {
  SFX_DOMAINS, SFX_UI_GROUPS, resolveSfxUiEntry, findSfxDomainEntry,
} from './sfxDomains.js';
import { UI_CUES } from './sfx.js';

// #303: the garage's dev-only sfx panel builds a button per SFX_UI_GROUPS id and reads
// `.label` off the matching SFX_DOMAINS.ui entry. Those are two lists that must agree, and
// nothing enforced it — #137 added a `powerupPickupBarrage` id without its domain entry and
// the whole Garage scene crashed on the dev server. These tests are that enforcement.
describe('SFX_UI_GROUPS <-> SFX_DOMAINS.ui', () => {
  const groupedIds = SFX_UI_GROUPS.flatMap((g) => g.ids);

  it('every grouped id resolves to a real SFX_DOMAINS.ui entry with a label', () => {
    for (const id of groupedIds) {
      const entry = resolveSfxUiEntry(id);
      expect(entry, id).toBeTruthy();
      expect(typeof entry.label, id).toBe('string');
      expect(entry.label.length, id).toBeGreaterThan(0);
      expect(Array.isArray(entry.stages), id).toBe(true);
    }
  });

  it('every SFX_DOMAINS.ui entry appears in exactly one group', () => {
    for (const entry of SFX_DOMAINS.ui) {
      const groups = SFX_UI_GROUPS.filter((g) => g.ids.includes(entry.id));
      expect(groups.map((g) => g.header), entry.id).toHaveLength(1);
    }
  });

  it('has no duplicate ids across groups or within SFX_DOMAINS.ui', () => {
    expect(new Set(groupedIds).size).toBe(groupedIds.length);
    const domainIds = SFX_DOMAINS.ui.map((e) => e.id);
    expect(new Set(domainIds).size).toBe(domainIds.length);
  });

  it('every SFX_DOMAINS.ui id has a registered sound cue', () => {
    for (const entry of SFX_DOMAINS.ui) {
      expect(UI_CUES[entry.id], entry.id).toBeTypeOf('function');
    }
  });

  it('includes the Barrage pickup cue (the #303 regression)', () => {
    expect(findSfxDomainEntry('powerupPickupBarrage')?.label).toBe('Pickup: Barrage');
    expect(SFX_UI_GROUPS.find((g) => g.header === 'PICKUPS').ids)
      .toContain('powerupPickupBarrage');
  });

  it('resolveSfxUiEntry throws an error naming an unknown id', () => {
    expect(() => resolveSfxUiEntry('powerupPickupNope'))
      .toThrow(/powerupPickupNope/);
  });
});
