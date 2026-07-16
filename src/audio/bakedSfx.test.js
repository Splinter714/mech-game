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

    // #199: the UI domain's powerupPickupOverdrive cue (#196 split) — the full 2602ms file
    // (no actual trim, just the recorded played window) of
    // "DSGNSynth_BUFF-Plus Damage_HY_PC-001.wav", no processing/fade/volume changes.
    it('registers powerupPickupOverdrive/play with a bundled asset and a no-trim, no-processing recipe', () => {
      const entry = BAKED_SFX['powerupPickupOverdrive::play'];
      expect(entry).toBeTruthy();
      expect(typeof entry.asset).toBe('string');   // Vite resolves the .m4a import to a URL string
      expect(entry.asset.length).toBeGreaterThan(0);
      expect(entry.startMs).toBe(0);
      expect(entry.trimMs).toBe(2602);             // #166 trim — full file length, no actual trim
      expect(entry.processing).toBeNull();
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
      [BAKED_SFX['powerupPickupOverdrive::play'].asset, 'PLUSDAMAGE'],
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

    // #199: powerupPickupOverdrive/play decodes into its own slot carrying the plain no-trim,
    // no-processing recipe.
    expect(hasBaked('powerupPickupOverdrive', 'play')).toBe(true);
    const overdrive = getBaked('powerupPickupOverdrive', 'play');
    expect(overdrive.buffer).toEqual({ __decodedFrom: 'PLUSDAMAGE' });
    expect(overdrive.startMs).toBe(0);
    expect(overdrive.trimMs).toBe(2602);
    expect(overdrive.processing).toBeNull();
  });

  it('getBaked is null for a weapon/stage with no baked entry (unaffected — plays procedurally)', async () => {
    installFakeFetch(new Map([
      [BAKED_SFX['clusterRocket::fire'].asset, 'BITBOMB'],
      [BAKED_SFX['plasmaLance::fire'].asset, 'BASSWAVE'],
      [BAKED_SFX['pulseLaser::fire'].asset, 'BASSBUZZ'],
      [BAKED_SFX['deathExplosionMassive::fire'].asset, 'MECHADAMAGED'],
      [BAKED_SFX['deploy::play'].asset, 'MECHATURNON'],
      [BAKED_SFX['equip::play'].asset, 'TINGPITCHEDUP'],
      [BAKED_SFX['powerupPickupOverdrive::play'].asset, 'PLUSDAMAGE'],
    ]));
    setAudioContext(fakeCtx());
    await loadAllBaked();
    expect(getBaked('autocannon', 'fire')).toBeNull();
    expect(getBaked('clusterRocket', 'impact')).toBeNull();   // right weapon, wrong stage
    expect(getBaked('plasmaLance', 'impact')).toBeNull();     // #175: impact stays procedural — bake is fire-only
    expect(getBaked('pulseLaser', 'impact')).toBeNull();      // #176: impact stays procedural — bake is fire-only
    expect(getBaked('deathExplosionMassive', 'impact')).toBeNull(); // #180: impact stays procedural — bake is fire-only
    expect(getBaked('deploy', 'showResult')).toBeNull();      // #192: other UI stages stay procedural — bake is deploy/play + equip/play only
    expect(getBaked('powerupPickupOverclock', 'play')).toBeNull(); // #199: sibling powerup cue stays procedural — no bake for it (yet)
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
