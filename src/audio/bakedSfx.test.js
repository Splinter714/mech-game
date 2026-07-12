import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BAKED_SFX, loadAllBaked, getBaked, hasBaked, setAudioContext, _resetForTest,
} from './bakedSfx.js';

// A fake AudioContext mirroring sfxOverrides.test.js: decodeAudioData "decodes" by reading a
// tag back out of the bytes, so we can assert the SAME content round-tripped through fetch,
// and make a garbage asset fail deterministically.
function fakeCtx() {
  return {
    decodeAudioData: async (bytes) => {
      const text = new TextDecoder().decode(bytes);
      if (text === 'CORRUPT') throw new Error('cannot decode');
      return { __decodedFrom: text };
    },
  };
}

// Fake fetch: returns bytes tagged per-URL so loadAllBaked's fetch→arrayBuffer→decode chain is
// exercised without a real network/file fetch (node can't fetch a bundled Vite asset URL). The
// map is keyed by the resolved `asset` value each BAKED_SFX entry holds.
function installFakeFetch(tagByAsset) {
  globalThis.fetch = async (asset) => ({
    arrayBuffer: async () => new TextEncoder().encode(tagByAsset.get(asset) ?? '').buffer,
  });
}

describe('bakedSfx (#173 baked-in SFX assets)', () => {
  beforeEach(() => { _resetForTest(); });
  afterEach(() => { delete globalThis.fetch; });

  describe('BAKED_SFX data table', () => {
    it('registers clusterRocket/fire with a bundled asset and the override-shaped recipe', () => {
      const entry = BAKED_SFX['clusterRocket::fire'];
      expect(entry).toBeTruthy();
      expect(typeof entry.asset).toBe('string');   // Vite resolves the .m4a import to a URL string
      expect(entry.asset.length).toBeGreaterThan(0);
      expect(entry.startMs).toBe(0);
      expect(entry.trimMs).toBeNull();
      expect(entry.processing).toBeNull();
    });
  });

  it('has no baked buffer for a slot until loadAllBaked decodes it (pre-boot / strict no-op)', () => {
    expect(getBaked('clusterRocket', 'fire')).toBeNull();
    expect(hasBaked('clusterRocket', 'fire')).toBe(false);
  });

  it('loadAllBaked fetches + decodes every entry into the cache, exposed via getBaked', async () => {
    const tags = new Map([[BAKED_SFX['clusterRocket::fire'].asset, 'BITBOMB']]);
    installFakeFetch(tags);
    setAudioContext(fakeCtx());

    await loadAllBaked();

    expect(hasBaked('clusterRocket', 'fire')).toBe(true);
    const baked = getBaked('clusterRocket', 'fire');
    expect(baked.buffer).toEqual({ __decodedFrom: 'BITBOMB' });
    // The recipe comes straight from the static table entry.
    expect(baked.startMs).toBe(0);
    expect(baked.trimMs).toBeNull();
    expect(baked.processing).toBeNull();
  });

  it('getBaked is null for a weapon/stage with no baked entry (unaffected — plays procedurally)', async () => {
    installFakeFetch(new Map([[BAKED_SFX['clusterRocket::fire'].asset, 'BITBOMB']]));
    setAudioContext(fakeCtx());
    await loadAllBaked();
    expect(getBaked('autocannon', 'fire')).toBeNull();
    expect(getBaked('clusterRocket', 'impact')).toBeNull();   // right weapon, wrong stage
  });

  it('loadAllBaked is a safe no-op with no context set yet (nothing decodes, never throws)', async () => {
    installFakeFetch(new Map([[BAKED_SFX['clusterRocket::fire'].asset, 'BITBOMB']]));
    // no setAudioContext call
    await expect(loadAllBaked()).resolves.toBeUndefined();
    expect(getBaked('clusterRocket', 'fire')).toBeNull();
  });

  it('loadAllBaked leaves a slot empty (never throws) when its asset fails to decode', async () => {
    installFakeFetch(new Map([[BAKED_SFX['clusterRocket::fire'].asset, 'CORRUPT']]));
    setAudioContext(fakeCtx());
    await expect(loadAllBaked()).resolves.toBeUndefined();
    expect(getBaked('clusterRocket', 'fire')).toBeNull();   // decode threw → falls back to procedural
  });

  it('loadAllBaked never throws when fetch itself fails', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };
    setAudioContext(fakeCtx());
    await expect(loadAllBaked()).resolves.toBeUndefined();
    expect(getBaked('clusterRocket', 'fire')).toBeNull();
  });
});
