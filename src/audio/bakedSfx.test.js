import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BAKED_SFX, loadAllBaked, getBaked, hasBaked, setAudioContext, _resetForTest,
  getBakedVariantCount, pickBakedVariant, _setBakedBufferForTest,
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

    // #175: plasmaLance's fire cue — a trimmed (130ms) + faded (420ms) bake of "Bass wave.wav".
    it('registers plasmaLance/fire with a bundled asset and the #166 trim + #174 fade recipe', () => {
      const entry = BAKED_SFX['plasmaLance::fire'];
      expect(entry).toBeTruthy();
      expect(typeof entry.asset).toBe('string');   // Vite resolves the .m4a import to a URL string
      expect(entry.asset.length).toBeGreaterThan(0);
      expect(entry.startMs).toBe(0);
      expect(entry.trimMs).toBe(130);              // #166 trim
      expect(entry.fadeOutMs).toBe(420);           // #174 fade — literal recipe value (runtime clamps to the 130ms window)
      expect(entry.processing).toBeNull();
    });

    // #176: pulseLaser's fire cue — a start+trimmed (320→380ms) window of "Bass Buzz_warning
    // sound.wav" with the FIRST non-null baked processing chain (+10c detune, 0.25/2.3s reverb)
    // plus a 450ms fade-out.
    it('registers pulseLaser/fire with a bundled asset and the #166 start+trim, #172 processing, #174 fade recipe', () => {
      const entry = BAKED_SFX['pulseLaser::fire'];
      expect(entry).toBeTruthy();
      expect(typeof entry.asset).toBe('string');   // Vite resolves the .m4a import to a URL string
      expect(entry.asset.length).toBeGreaterThan(0);
      expect(entry.startMs).toBe(320);             // #166 start offset (320ms into the file)
      expect(entry.trimMs).toBe(60);               // #166 trim (60ms window → 320-380ms)
      expect(entry.fadeOutMs).toBe(450);           // #174 fade — literal recipe value (runtime clamps to the 60ms window)
      expect(entry.processing).toEqual({ detune: 10, reverbMix: 0.25, reverbSize: 2.3 }); // #172 chain — first NON-null baked processing
    });

    // #180: deathExplosionMassive's fire cue — a trimmed (1490ms) + faded (550ms) bake of
    // "Mecha DAMAGED 2.wav" (kept STEREO, unlike the prior mono weapon-fire bakes).
    it('registers deathExplosionMassive/fire with a bundled asset and the #166 trim + #174 fade recipe', () => {
      const entry = BAKED_SFX['deathExplosionMassive::fire'];
      expect(entry).toBeTruthy();
      expect(typeof entry.asset).toBe('string');   // Vite resolves the .m4a import to a URL string
      expect(entry.asset.length).toBeGreaterThan(0);
      expect(entry.startMs).toBe(0);
      expect(entry.trimMs).toBe(1490);             // #166 trim
      expect(entry.fadeOutMs).toBe(550);           // #174 fade
      expect(entry.processing).toBeNull();
    });

    // #194: the UI domain's deploy cue — a trimmed (1620ms) + faded (930ms) bake of
    // "Mecha TURN ON - OFF 8.wav" (kept STEREO, same as the #180 explosion bake). Key is
    // `deploy::play` — the (id, stage) pair the UI domain's uiCue passes to getBaked.
    it('registers deploy/play with a bundled asset and the #166 trim + #174 fade recipe', () => {
      const entry = BAKED_SFX['deploy::play'];
      expect(entry).toBeTruthy();
      expect(typeof entry.asset).toBe('string');   // Vite resolves the .m4a import to a URL string
      expect(entry.asset.length).toBeGreaterThan(0);
      expect(entry.startMs).toBe(0);
      expect(entry.trimMs).toBe(1620);             // #166 trim
      expect(entry.fadeOutMs).toBe(930);           // #174 fade
      expect(entry.processing).toBeNull();
    });

    // #192: the UI domain's equip cue — the full 689ms file (no actual trim, just the recorded
    // played window) of "Ting_Pitched_Up.wav", pitched up +80 cents and boosted to 1.6x volume.
    it('registers equip/play with a bundled asset and the #172 processing + #182 volume recipe', () => {
      const entry = BAKED_SFX['equip::play'];
      expect(entry).toBeTruthy();
      expect(typeof entry.asset).toBe('string');   // Vite resolves the .m4a import to a URL string
      expect(entry.asset.length).toBeGreaterThan(0);
      expect(entry.startMs).toBe(0);
      expect(entry.trimMs).toBe(689);              // #166 trim — full file length, no actual trim
      expect(entry.processing).toEqual({ detune: 80 }); // #172 chain
      expect(entry.volume).toBe(1.6);              // #182 volume
    });

    // #198: the UI domain's powerupPickupOverclock cue — a trimmed (2590ms) + faded (660ms)
    // bake of "DSGNSynth_CAST-Mecha Speeding_HY_PC-003.wav" (kept STEREO, same as the
    // #180/#194/#192 stereo bakes).
    it('registers powerupPickupOverclock/play with a bundled asset and the #166 trim + #174 fade recipe', () => {
      const entry = BAKED_SFX['powerupPickupOverclock::play'];
      expect(entry).toBeTruthy();
      expect(typeof entry.asset).toBe('string');   // Vite resolves the .m4a import to a URL string
      expect(entry.asset.length).toBeGreaterThan(0);
      expect(entry.startMs).toBe(0);
      expect(entry.trimMs).toBe(2590);             // #166 trim
      expect(entry.fadeOutMs).toBe(660);           // #174 fade
      expect(entry.processing).toBeNull();
    });

    // #199: the UI domain's powerupPickupOverdrive cue (#196 split) — the full 2602ms file
    // (no actual trim, just the recorded played window) of
    // "DSGNSynth_BUFF-Plus Damage_HY_PC-001.wav", no processing/fade changes.
    // #204: reduced to 0.5x (50%) volume per playtest feedback.
    it('registers powerupPickupOverdrive/play with a bundled asset and a no-trim, no-processing recipe', () => {
      const entry = BAKED_SFX['powerupPickupOverdrive::play'];
      expect(entry).toBeTruthy();
      expect(typeof entry.asset).toBe('string');   // Vite resolves the .m4a import to a URL string
      expect(entry.asset.length).toBeGreaterThan(0);
      expect(entry.startMs).toBe(0);
      expect(entry.trimMs).toBe(2602);             // #166 trim — full file length, no actual trim
      expect(entry.processing).toBeNull();
      expect(entry.volume).toBe(0.5);              // #204 volume
    });

    // #206: the UI domain's menuNav cue — a 190ms-trimmed bake of "UIClick_INTERFACE-Strong
    // Click 1_HY_PC-001.wav" (kept STEREO, same as the other UI-domain stereo bakes), with a
    // lowpass filter processing chain and a fade-out longer than the played window (clamped at
    // playback), silenced entirely via 0.00x volume per Jackson's literal copy-recipe.
    it('registers menuNav/play with a bundled asset and the #206 lowpass-filter + fade + silent-volume recipe', () => {
      const entry = BAKED_SFX['menuNav::play'];
      expect(entry).toBeTruthy();
      expect(typeof entry.asset).toBe('string');   // Vite resolves the .m4a import to a URL string
      expect(entry.asset.length).toBeGreaterThan(0);
      expect(entry.startMs).toBe(0);
      expect(entry.trimMs).toBe(190);              // #166 trim — full file is 2500ms
      expect(entry.processing).toEqual({ filterType: 'lowpass', filterFreq: 1700, filterQ: 9 }); // #172 chain
      expect(entry.fadeOutMs).toBe(1070);          // #174 fade — exceeds the 190ms window, clamped at playback
      expect(entry.volume).toBe(0);                // #182 volume — authored silent, literal recipe
    });
  });

  it('has no baked buffer for a slot until loadAllBaked decodes it (pre-boot / strict no-op)', () => {
    expect(getBaked('clusterRocket', 'fire')).toBeNull();
    expect(hasBaked('clusterRocket', 'fire')).toBe(false);
  });

  it('loadAllBaked fetches + decodes every entry into the cache, exposed via getBaked', async () => {
    const tags = new Map([
      [BAKED_SFX['clusterRocket::fire'].asset, 'BITBOMB'],
      [BAKED_SFX['plasmaLance::fire'].asset, 'BASSWAVE'],
      [BAKED_SFX['pulseLaser::fire'].asset, 'BASSBUZZ'],
      [BAKED_SFX['deathExplosionMassive::fire'].asset, 'MECHADAMAGED'],
      [BAKED_SFX['deploy::play'].asset, 'MECHATURNON'],
      [BAKED_SFX['equip::play'].asset, 'TINGPITCHEDUP'],
      [BAKED_SFX['powerupPickupOverclock::play'].asset, 'MECHASPEEDING'],
      [BAKED_SFX['powerupPickupOverdrive::play'].asset, 'PLUSDAMAGE'],
      [BAKED_SFX['menuNav::play'].asset, 'STRONGCLICK1'],
    ]);
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

    // #175: plasmaLance/fire decodes into its own slot carrying the trim + fade recipe.
    expect(hasBaked('plasmaLance', 'fire')).toBe(true);
    const plasma = getBaked('plasmaLance', 'fire');
    expect(plasma.buffer).toEqual({ __decodedFrom: 'BASSWAVE' });
    expect(plasma.startMs).toBe(0);
    expect(plasma.trimMs).toBe(130);
    expect(plasma.fadeOutMs).toBe(420);
    expect(plasma.processing).toBeNull();

    // #176: pulseLaser/fire decodes into its own slot — getBaked must SURFACE the full recipe
    // including the first NON-null baked `processing` chain (proves getBaked doesn't drop it).
    expect(hasBaked('pulseLaser', 'fire')).toBe(true);
    const pulse = getBaked('pulseLaser', 'fire');
    expect(pulse.buffer).toEqual({ __decodedFrom: 'BASSBUZZ' });
    expect(pulse).toMatchObject({
      startMs: 320,
      trimMs: 60,
      fadeOutMs: 450,
      processing: { detune: 10, reverbMix: 0.25, reverbSize: 2.3 },
    });

    // #180: deathExplosionMassive/fire decodes into its own slot carrying the trim + fade recipe.
    expect(hasBaked('deathExplosionMassive', 'fire')).toBe(true);
    const explosion = getBaked('deathExplosionMassive', 'fire');
    expect(explosion.buffer).toEqual({ __decodedFrom: 'MECHADAMAGED' });
    expect(explosion.startMs).toBe(0);
    expect(explosion.trimMs).toBe(1490);
    expect(explosion.fadeOutMs).toBe(550);
    expect(explosion.processing).toBeNull();

    // #194: deploy/play decodes into its own slot carrying the trim + fade recipe — the first
    // UI-domain (non-weapon) bake, proving getBaked's (id, stage) lookup is agnostic to that.
    expect(hasBaked('deploy', 'play')).toBe(true);
    const deploy = getBaked('deploy', 'play');
    expect(deploy.buffer).toEqual({ __decodedFrom: 'MECHATURNON' });
    expect(deploy.startMs).toBe(0);
    expect(deploy.trimMs).toBe(1620);
    expect(deploy.fadeOutMs).toBe(930);
    expect(deploy.processing).toBeNull();

    // #192: equip/play decodes into its own slot carrying the #172 processing + #182 volume recipe.
    expect(hasBaked('equip', 'play')).toBe(true);
    const equip = getBaked('equip', 'play');
    expect(equip.buffer).toEqual({ __decodedFrom: 'TINGPITCHEDUP' });
    expect(equip.startMs).toBe(0);
    expect(equip.trimMs).toBe(689);
    expect(equip.processing).toEqual({ detune: 80 });
    expect(equip.volume).toBe(1.6);

    // #198: powerupPickupOverclock/play decodes into its own slot carrying the trim + fade
    // recipe — one of the 5 #196 per-powerup pickup ids getting its own independent bake.
    expect(hasBaked('powerupPickupOverclock', 'play')).toBe(true);
    const overclock = getBaked('powerupPickupOverclock', 'play');
    expect(overclock.buffer).toEqual({ __decodedFrom: 'MECHASPEEDING' });
    expect(overclock.startMs).toBe(0);
    expect(overclock.trimMs).toBe(2590);
    expect(overclock.fadeOutMs).toBe(660);
    expect(overclock.processing).toBeNull();

    // #199: powerupPickupOverdrive/play decodes into its own slot carrying the plain no-trim,
    // no-processing recipe. #204: now also carries a 0.5x volume adjustment.
    expect(hasBaked('powerupPickupOverdrive', 'play')).toBe(true);
    const overdrive = getBaked('powerupPickupOverdrive', 'play');
    expect(overdrive.buffer).toEqual({ __decodedFrom: 'PLUSDAMAGE' });
    expect(overdrive.startMs).toBe(0);
    expect(overdrive.trimMs).toBe(2602);
    expect(overdrive.processing).toBeNull();
    expect(overdrive.volume).toBe(0.5);

    // #206: menuNav/play decodes into its own slot carrying the lowpass-filter processing +
    // fade + silent-volume recipe.
    expect(hasBaked('menuNav', 'play')).toBe(true);
    const menuNav = getBaked('menuNav', 'play');
    expect(menuNav.buffer).toEqual({ __decodedFrom: 'STRONGCLICK1' });
    expect(menuNav.startMs).toBe(0);
    expect(menuNav.trimMs).toBe(190);
    expect(menuNav.processing).toEqual({ filterType: 'lowpass', filterFreq: 1700, filterQ: 9 });
    expect(menuNav.fadeOutMs).toBe(1070);
    expect(menuNav.volume).toBe(0);
  });

  it('getBaked is null for a weapon/stage with no baked entry (unaffected — plays procedurally)', async () => {
    installFakeFetch(new Map([
      [BAKED_SFX['clusterRocket::fire'].asset, 'BITBOMB'],
      [BAKED_SFX['plasmaLance::fire'].asset, 'BASSWAVE'],
      [BAKED_SFX['pulseLaser::fire'].asset, 'BASSBUZZ'],
      [BAKED_SFX['deathExplosionMassive::fire'].asset, 'MECHADAMAGED'],
      [BAKED_SFX['deploy::play'].asset, 'MECHATURNON'],
      [BAKED_SFX['equip::play'].asset, 'TINGPITCHEDUP'],
      [BAKED_SFX['powerupPickupOverclock::play'].asset, 'MECHASPEEDING'],
      [BAKED_SFX['powerupPickupOverdrive::play'].asset, 'PLUSDAMAGE'],
      [BAKED_SFX['menuNav::play'].asset, 'STRONGCLICK1'],
    ]));
    setAudioContext(fakeCtx());
    await loadAllBaked();
    expect(getBaked('autocannon', 'fire')).toBeNull();
    expect(getBaked('clusterRocket', 'impact')).toBeNull();   // right weapon, wrong stage
    expect(getBaked('plasmaLance', 'impact')).toBeNull();     // #175: impact stays procedural — bake is fire-only
    expect(getBaked('pulseLaser', 'impact')).toBeNull();      // #176: impact stays procedural — bake is fire-only
    expect(getBaked('deathExplosionMassive', 'impact')).toBeNull(); // #180: impact stays procedural — bake is fire-only
    expect(getBaked('deploy', 'showResult')).toBeNull();      // #192: other UI stages stay procedural — bake is deploy/play + equip/play only
    expect(getBaked('powerupPickupOvercharge', 'play')).toBeNull(); // #198/#199: sibling powerup ids (overcharge/armorPatch/shield) stay procedural
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

  // #195: RANDOMIZED VARIANTS for a SHIPPED bake — a BAKED_SFX entry may be an ARRAY of recipe
  // objects instead of a single one, and playback picks uniformly among however many decoded.
  // Every test here temporarily installs a synthetic multi-variant entry under a made-up id
  // (mirroring AudioEngine.test.js's pattern of mutating BAKED_SFX directly, then deleting it in
  // a `finally`) so the REAL shipped table is never touched.
  describe('variant pools (#195)', () => {
    afterEach(() => { delete BAKED_SFX['bangTest::fire']; });

    it('(a) a single-object entry (every existing bake) behaves EXACTLY as before', async () => {
      installFakeFetch(new Map([[BAKED_SFX['clusterRocket::fire'].asset, 'BITBOMB']]));
      setAudioContext(fakeCtx());
      await loadAllBaked();
      expect(getBakedVariantCount('clusterRocket', 'fire')).toBe(1);
      expect(pickBakedVariant('clusterRocket', 'fire')).toEqual(getBaked('clusterRocket', 'fire'));
    });

    it('an untouched (weaponId, stage) has a variant count of 0, and pickBakedVariant returns null', () => {
      expect(getBakedVariantCount('bangTest', 'fire')).toBe(0);
      expect(pickBakedVariant('bangTest', 'fire')).toBeNull();
    });

    it('an ARRAY entry decodes each variant into its own cache slot, addressable via getBaked', async () => {
      BAKED_SFX['bangTest::fire'] = [
        { asset: 'bang0.m4a', startMs: 0, trimMs: 100, processing: null },
        { asset: 'bang1.m4a', startMs: 10, trimMs: 200, processing: { detune: 50 } },
        { asset: 'bang2.m4a', startMs: 20, trimMs: 300, fadeOutMs: 80 },
      ];
      installFakeFetch(new Map([
        ['bang0.m4a', 'BANG0'], ['bang1.m4a', 'BANG1'], ['bang2.m4a', 'BANG2'],
      ]));
      setAudioContext(fakeCtx());
      await loadAllBaked();

      expect(getBakedVariantCount('bangTest', 'fire')).toBe(3);
      expect(getBaked('bangTest', 'fire')).toMatchObject({ startMs: 0, trimMs: 100 });
      expect(getBaked('bangTest', 'fire').buffer).toEqual({ __decodedFrom: 'BANG0' });
      expect(getBaked('bangTest', 'fire#v1')).toMatchObject({ startMs: 10, trimMs: 200, processing: { detune: 50 } });
      expect(getBaked('bangTest', 'fire#v1').buffer).toEqual({ __decodedFrom: 'BANG1' });
      expect(getBaked('bangTest', 'fire#v2')).toMatchObject({ startMs: 20, trimMs: 300, fadeOutMs: 80 });
      expect(getBaked('bangTest', 'fire#v2').buffer).toEqual({ __decodedFrom: 'BANG2' });
      expect(hasBaked('bangTest', 'fire')).toBe(true);
      expect(hasBaked('bangTest', 'fire#v1')).toBe(true);
      expect(hasBaked('bangTest', 'fire#v2')).toBe(true);
      expect(hasBaked('bangTest', 'fire#v3')).toBe(false); // only 3 variants defined
    });

    // (b) statistical test — mock Math.random to prove pickBakedVariant genuinely walks the
    // whole pool, then a real-random pass proving every variant gets hit over many trials.
    it('(b) pickBakedVariant resolves deterministically for a mocked Math.random across the whole pool', async () => {
      BAKED_SFX['bangTest::fire'] = [
        { asset: 'bang0.m4a', startMs: 0 }, { asset: 'bang1.m4a', startMs: 1 }, { asset: 'bang2.m4a', startMs: 2 },
      ];
      installFakeFetch(new Map([['bang0.m4a', 'B0'], ['bang1.m4a', 'B1'], ['bang2.m4a', 'B2']]));
      setAudioContext(fakeCtx());
      await loadAllBaked();

      const spy = vi.spyOn(Math, 'random');
      try {
        spy.mockReturnValue(0);
        expect(pickBakedVariant('bangTest', 'fire').buffer).toEqual({ __decodedFrom: 'B0' });
        spy.mockReturnValue(0.34);
        expect(pickBakedVariant('bangTest', 'fire').buffer).toEqual({ __decodedFrom: 'B1' });
        spy.mockReturnValue(0.99);
        expect(pickBakedVariant('bangTest', 'fire').buffer).toEqual({ __decodedFrom: 'B2' });
      } finally {
        spy.mockRestore();
      }
    });

    it('(b) pickBakedVariant picks among ALL decoded variants over many trials (uniform, no weighting)', () => {
      _setBakedBufferForTest('bangTest', 'fire', { __decodedFrom: 'B0' }, 0);
      _setBakedBufferForTest('bangTest', 'fire', { __decodedFrom: 'B1' }, 1);
      _setBakedBufferForTest('bangTest', 'fire', { __decodedFrom: 'B2' }, 2);
      BAKED_SFX['bangTest::fire'] = [{ startMs: 0 }, { startMs: 1 }, { startMs: 2 }];
      const seen = new Set();
      for (let i = 0; i < 200; i++) seen.add(pickBakedVariant('bangTest', 'fire').buffer.__decodedFrom);
      expect(seen).toEqual(new Set(['B0', 'B1', 'B2']));
    });

    it('a variant that fails to decode truncates the pool (breaks contiguity) rather than leaving a gap', async () => {
      BAKED_SFX['bangTest::fire'] = [
        { asset: 'bang0.m4a', startMs: 0 }, { asset: 'bang1.m4a', startMs: 1 }, { asset: 'bang2.m4a', startMs: 2 },
      ];
      installFakeFetch(new Map([['bang0.m4a', 'B0'], ['bang1.m4a', 'CORRUPT'], ['bang2.m4a', 'B2']]));
      setAudioContext(fakeCtx());
      await loadAllBaked();
      // Variant 1 failed to decode — the contiguous-from-0 count stops there even though
      // variant 2 DID decode (same "no gaps" contract as the live-override pool).
      expect(getBakedVariantCount('bangTest', 'fire')).toBe(1);
      expect(hasBaked('bangTest', 'fire#v2')).toBe(true); // still individually addressable
    });
  });
});
