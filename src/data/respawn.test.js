// #348: respawn timing + the out-of-combat gate. The gate is the design (Jackson: it stops a
// respawn landing mid-firefight), so most of what's locked down here is the "timer alone is not
// enough" half of the rule.
import { describe, it, expect } from 'vitest';
import {
  OUT_OF_COMBAT_MS, RESPAWN_DELAY_MS, makeRespawnState, pickRespawnPoint, startRespawn, tickRespawn,
} from './respawn.js';

const QUIET = OUT_OF_COMBAT_MS + 1;

describe('respawn clock', () => {
  it('does nothing until a death starts it', () => {
    const s = makeRespawnState();
    expect(s.remainingMs).toBeNull();
    expect(tickRespawn(s, 100000, QUIET).ready).toBe(false);
  });

  it('waits the full 20 seconds', () => {
    let s = startRespawn(makeRespawnState());
    let r = tickRespawn(s, RESPAWN_DELAY_MS - 1, QUIET);
    expect(r.ready).toBe(false);
    r = tickRespawn(r.state, 1, QUIET);
    expect(r.ready).toBe(true);
  });

  it('a second death event does not restart an already-running clock', () => {
    let s = startRespawn(makeRespawnState());
    s = tickRespawn(s, 10000, QUIET).state;
    const again = startRespawn(s);
    expect(again.remainingMs).toBe(s.remainingMs);
  });

  it('clears the clock once it fires, so it only fires once', () => {
    const s = startRespawn(makeRespawnState());
    const r = tickRespawn(s, RESPAWN_DELAY_MS, QUIET);
    expect(r.ready).toBe(true);
    expect(r.state.remainingMs).toBeNull();
    expect(tickRespawn(r.state, 100000, QUIET).ready).toBe(false);
  });
});

describe('the out-of-combat gate — THE point of the design', () => {
  it('holds the respawn while the survivor is still taking fire', () => {
    const s = startRespawn(makeRespawnState());
    const r = tickRespawn(s, RESPAWN_DELAY_MS + 5000, 0);   // hit this very frame
    expect(r.ready).toBe(false);
    expect(r.state.waitingOnCombat).toBe(true);
  });

  it('holds right up to the threshold and releases the moment it is crossed', () => {
    const s = startRespawn(makeRespawnState());
    expect(tickRespawn(s, RESPAWN_DELAY_MS, OUT_OF_COMBAT_MS - 1).ready).toBe(false);
    expect(tickRespawn(s, RESPAWN_DELAY_MS, OUT_OF_COMBAT_MS).ready).toBe(true);
  });

  it('releases as soon as the shooting stops, without adding a second full wait', () => {
    // Under fire for the whole 20s + a bit more, then quiet: the respawn lands on the next
    // frame that reports quiet, not 20 seconds later.
    let r = tickRespawn(startRespawn(makeRespawnState()), RESPAWN_DELAY_MS + 3000, 0);
    expect(r.ready).toBe(false);
    r = tickRespawn(r.state, 16, QUIET);
    expect(r.ready).toBe(true);
  });

  it('the clock keeps running while under fire — taking a hit does not extend the 20s', () => {
    // Ticked entirely under fire, the timer still reaches zero; only placement is held.
    const r = tickRespawn(startRespawn(makeRespawnState()), RESPAWN_DELAY_MS, 0);
    expect(r.state.remainingMs).toBe(0);
    expect(r.state.waitingOnCombat).toBe(true);
  });

  it('a run where nobody has ever been hit counts as out of combat', () => {
    expect(tickRespawn(startRespawn(makeRespawnState()), RESPAWN_DELAY_MS, Infinity).ready).toBe(true);
  });
});

describe('pickRespawnPoint — the far edge of the current view', () => {
  const VIEW = { x: 0, y: 0, width: 1000, height: 600 };

  it('lands inside the view, never outside it', () => {
    const p = pickRespawnPoint(VIEW, [{ x: 500, y: 300 }]);
    expect(p.x).toBeGreaterThanOrEqual(VIEW.x);
    expect(p.x).toBeLessThanOrEqual(VIEW.x + VIEW.width);
    expect(p.y).toBeGreaterThanOrEqual(VIEW.y);
    expect(p.y).toBeLessThanOrEqual(VIEW.y + VIEW.height);
  });

  it('picks the edge furthest from the fighting', () => {
    // Threat hard against the left edge → respawn on the right.
    const p = pickRespawnPoint(VIEW, [{ x: 0, y: 300 }]);
    expect(p.x).toBeGreaterThan(VIEW.width / 2);
  });

  it('measures against the NEAREST threat, so it avoids a crowd rather than its average', () => {
    // Threats top and bottom average to the middle; the winning edge must still be one of the
    // horizontal ones, which is what "nearest threat is furthest away" gives.
    const p = pickRespawnPoint(VIEW, [{ x: 500, y: 0 }, { x: 500, y: 600 }]);
    expect(p.y).toBeCloseTo(300, 6);
  });

  it('is deterministic with no threats at all', () => {
    expect(pickRespawnPoint(VIEW, [])).toEqual(pickRespawnPoint(VIEW, []));
  });

  it('follows the camera — the point is in world space, not screen space', () => {
    const moved = { x: 5000, y: -2000, width: 1000, height: 600 };
    const p = pickRespawnPoint(moved, [{ x: 5000, y: -1700 }]);
    expect(p.x).toBeGreaterThan(5000);
  });
});
