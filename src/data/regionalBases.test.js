import { describe, it, expect } from 'vitest';
import { establishRegionalBase, regionalBaseFor } from './regionalBases.js';

const SITE = { biomeId: 'grassland', baseId: 'base0', coord: { q: 3, r: -1 } };

describe('#517 regionalBases — biome → regional-base pointer', () => {
  it('establishRegionalBase adds a fresh record for a biome with none yet', () => {
    const regionalBases = establishRegionalBase([], SITE);
    expect(regionalBases).toHaveLength(1);
    expect(regionalBases[0]).toMatchObject(SITE);
  });

  it('regionalBaseFor returns null when the biome has no regional base yet', () => {
    expect(regionalBaseFor([], 'grassland')).toBeNull();
    const regionalBases = establishRegionalBase([], { ...SITE, biomeId: 'desert' });
    expect(regionalBaseFor(regionalBases, 'grassland')).toBeNull();
  });

  it('regionalBaseFor finds the matching biome record', () => {
    const regionalBases = establishRegionalBase([], SITE);
    expect(regionalBaseFor(regionalBases, 'grassland')).toMatchObject(SITE);
  });

  it('the FIRST established base wins — a later establish call for the same biome is a no-op', () => {
    let regionalBases = establishRegionalBase([], SITE);
    const later = establishRegionalBase(regionalBases, { biomeId: 'grassland', baseId: 'base2', coord: { q: 9, r: 4 } });
    expect(later).toBe(regionalBases);   // literally the same array reference — a true no-op
    expect(regionalBaseFor(later, 'grassland').baseId).toBe('base0');
  });

  it('different biomes each get their own independent regional base', () => {
    let regionalBases = establishRegionalBase([], SITE);
    regionalBases = establishRegionalBase(regionalBases, { biomeId: 'desert', baseId: 'base1', coord: { q: 1, r: 1 } });
    expect(regionalBases).toHaveLength(2);
    expect(regionalBaseFor(regionalBases, 'grassland').baseId).toBe('base0');
    expect(regionalBaseFor(regionalBases, 'desert').baseId).toBe('base1');
  });
});
