import { describe, it, expect } from 'vitest';
import {
  trackCoverSpot, coverLeashExpired, COVER_LEASH_MS, COVER_SPOT_RADIUS,
} from './coverLeash.js';

describe('#72 cover leash — enemies cannot camp one cover spot forever', () => {
  it('leash duration is in the tuned 4–6s band', () => {
    expect(COVER_LEASH_MS).toBeGreaterThanOrEqual(4000);
    expect(COVER_LEASH_MS).toBeLessThanOrEqual(6000);
  });

  it('trackCoverSpot: no spot clears the track', () => {
    const prev = { x: 100, y: 50, since: 1000 };
    expect(trackCoverSpot(prev, null, 2000)).toBe(null);
    expect(trackCoverSpot(null, null, 2000)).toBe(null);
  });

  it('trackCoverSpot: starting a camp stamps `since` with now', () => {
    const t = trackCoverSpot(null, { x: 100, y: 50 }, 3000);
    expect(t).toEqual({ x: 100, y: 50, since: 3000 });
  });

  it('trackCoverSpot: re-picking (roughly) the same spot keeps the original timestamp aging', () => {
    const t0 = trackCoverSpot(null, { x: 100, y: 50 }, 1000);
    // A few px of drift — same spot, same track object, since unchanged.
    const t1 = trackCoverSpot(t0, { x: 100 + COVER_SPOT_RADIUS - 1, y: 50 }, 4000);
    expect(t1).toBe(t0);
    expect(t1.since).toBe(1000);
  });

  it('trackCoverSpot: a genuinely different spot resets the leash', () => {
    const t0 = trackCoverSpot(null, { x: 100, y: 50 }, 1000);
    const t1 = trackCoverSpot(t0, { x: 100 + COVER_SPOT_RADIUS * 3, y: 50 }, 4000);
    expect(t1).not.toBe(t0);
    expect(t1.since).toBe(4000);
  });

  it('coverLeashExpired: fires only once the same spot has been held past the leash', () => {
    const t = trackCoverSpot(null, { x: 0, y: 0 }, 1000);
    expect(coverLeashExpired(t, 1000)).toBe(false);
    expect(coverLeashExpired(t, 1000 + COVER_LEASH_MS - 1)).toBe(false);
    expect(coverLeashExpired(t, 1000 + COVER_LEASH_MS)).toBe(true);
    expect(coverLeashExpired(null, 999999)).toBe(false);   // not camping ⇒ never expired
  });

  it('full cycle: camp → leash expires → move to a new spot restarts the clock', () => {
    let track = trackCoverSpot(null, { x: 0, y: 0 }, 0);
    // Sitting at the same spot across several re-decisions...
    for (const now of [1000, 2500, 4000]) track = trackCoverSpot(track, { x: 5, y: -5 }, now);
    expect(coverLeashExpired(track, COVER_LEASH_MS)).toBe(true);
    // ...forced to a fresh spot ⇒ leash restarts.
    track = trackCoverSpot(track, { x: 400, y: 300 }, COVER_LEASH_MS);
    expect(coverLeashExpired(track, COVER_LEASH_MS + 1000)).toBe(false);
  });
});
