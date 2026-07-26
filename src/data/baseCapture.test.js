import { describe, it, expect } from 'vitest';
import { capturedBaseIdsFor, applyCapturedBases, filterCapturedAlertTowers } from './baseCapture.js';

function outpost(biomeId, baseId) {
  return { id: `outpost-0-${baseId}`, type: 'resource', coord: { q: 0, r: 0 }, biomeId, baseId, upgradeLevel: 0, threatState: 'safe' };
}

function base(id, docks = [], objectiveHex = { q: 1, r: 1 }) {
  return { id, center: { q: 0, r: 0 }, docks, objectiveHex, captured: false };
}

describe('#518 baseCapture — wiring claimed bases back into a fresh worldgen list', () => {
  it('capturedBaseIdsFor collects only this biome\'s claimed base ids', () => {
    const outposts = [outpost('grassland', 'base0'), outpost('desert', 'base1'), outpost('grassland', 'base2')];
    const ids = capturedBaseIdsFor(outposts, 'grassland');
    expect(ids).toEqual(new Set(['base0', 'base2']));
  });

  it('capturedBaseIdsFor ignores outposts with no baseId (pre-#517 saved records)', () => {
    const outposts = [{ id: 'legacy', type: 'resource', coord: { q: 0, r: 0 }, biomeId: 'grassland' }];
    expect(capturedBaseIdsFor(outposts, 'grassland')).toEqual(new Set());
  });

  it('capturedBaseIdsFor on an empty/missing list is a safe empty set', () => {
    expect(capturedBaseIdsFor([], 'grassland')).toEqual(new Set());
    expect(capturedBaseIdsFor(undefined, 'grassland')).toEqual(new Set());
  });

  it('applyCapturedBases marks a captured base and strips its docks/objective', () => {
    const b0 = base('base0', [{ q: 2, r: 0 }, { q: 3, r: 0 }], { q: 1, r: 1 });
    const b1 = base('base1', [{ q: 5, r: 0 }], { q: 4, r: 4 });
    const bases = [b0, b1];
    const keys = applyCapturedBases(bases, new Set(['base0']));

    expect(b0.captured).toBe(true);
    expect(b0.docks).toEqual([]);
    expect(b0.objectiveHex).toBeNull();
    expect(b1.captured).toBe(false);
    expect(b1.docks).toHaveLength(1);
    expect(b1.objectiveHex).toEqual({ q: 4, r: 4 });
    // Every dock hex plus the objective hex of the captured base, and nothing from the other.
    expect(keys.sort()).toEqual(['1,1', '2,0', '3,0'].sort());
  });

  it('a base with no objective hex only returns its dock keys', () => {
    const b0 = base('base0', [{ q: 2, r: 0 }], null);
    const keys = applyCapturedBases([b0], new Set(['base0']));
    expect(keys).toEqual(['2,0']);
  });

  it('no captured ids leaves every base untouched but still marks `captured: false`', () => {
    const b0 = base('base0', [{ q: 2, r: 0 }]);
    const keys = applyCapturedBases([b0], new Set());
    expect(b0.captured).toBe(false);
    expect(b0.docks).toHaveLength(1);
    expect(b0.objectiveHex).toEqual({ q: 1, r: 1 });
    expect(keys).toEqual([]);
  });
});

// #516 (corridor bypass routing): a captured base shouldn't keep a live hostile alert tower —
// no countdown/siren/patrol-spawn for ground the player already holds.
describe('#516 filterCapturedAlertTowers — drop a captured base\'s own tower', () => {
  function tower(q, r, baseId) {
    return { q, r, baseId };
  }

  it('drops a tower whose baseId is captured', () => {
    const towers = [tower(0, 0, 'base0'), tower(5, 0, 'base1')];
    const result = filterCapturedAlertTowers(towers, new Set(['base0']));
    expect(result).toEqual([tower(5, 0, 'base1')]);
  });

  it('keeps every tower when no base is captured', () => {
    const towers = [tower(0, 0, 'base0'), tower(5, 0, 'base1')];
    expect(filterCapturedAlertTowers(towers, new Set())).toEqual(towers);
    expect(filterCapturedAlertTowers(towers, null)).toEqual(towers);
  });

  it('never drops a tower with no baseId at all (defensive — placeGapTowers always stamps one)', () => {
    const towers = [{ q: 0, r: 0 }];   // no baseId field
    expect(filterCapturedAlertTowers(towers, new Set(['base0']))).toEqual(towers);
  });

  it('handles an empty/missing tower list safely', () => {
    expect(filterCapturedAlertTowers([], new Set(['base0']))).toEqual([]);
    expect(filterCapturedAlertTowers(undefined, new Set(['base0']))).toEqual([]);
  });

  it('drops every tower when every base is captured', () => {
    const towers = [tower(0, 0, 'base0'), tower(5, 0, 'base1')];
    expect(filterCapturedAlertTowers(towers, new Set(['base0', 'base1']))).toEqual([]);
  });
});
