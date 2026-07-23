// Small seeded PRNG + draw helpers — the ONE deterministic randomness primitive the pure data
// layer shares. Everything here is a plain function of an injected `rng` (a `() => [0,1)` source),
// so a caller that passes a seeded stream gets reproducible output and its tests never go flaky.
//
// `mulberry32` is the generator (it predates this module in worldgen.js, which now re-exports it
// from here so there is a single copy). The draw helpers below — `randInt`, `pick`, `sampleN` —
// take that `rng` explicitly rather than reaching for `Math.random`, which is the whole point:
// per-spawn randomness (enemy loadout rolls, #474) must be seedable or every test that spawns an
// enemy would be non-deterministic.

// Deterministic given `a`: the same seed always yields the same sequence.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer in [0, n) from the rng.
export function randInt(rng, n) {
  return Math.floor(rng() * n);
}

// One uniformly-random element of `arr` (undefined for an empty array).
export function pick(rng, arr) {
  return arr.length ? arr[randInt(rng, arr.length)] : undefined;
}

// `k` DISTINCT elements of `arr`, drawn without replacement (a partial Fisher–Yates over a copy).
// Returns min(k, arr.length) elements — never throws on k > length. Order is randomized.
export function sampleN(rng, arr, k) {
  const pool = arr.slice();
  const n = Math.min(k, pool.length);
  for (let i = 0; i < n; i += 1) {
    const j = i + randInt(rng, pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
