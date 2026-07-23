// #348: respawn timing + the out-of-combat gate. The gate is the design (Jackson: it stops a
// respawn landing mid-firefight), so most of what's locked down here is the "timer alone is not
// enough" half of the rule.
import { describe, it, expect } from 'vitest';
import {
  OUT_OF_COMBAT_MS, RESPAWN_DELAY_MS, makeRespawnState, pickRespawnPoint, respawnReadout,
  startRespawn, tickRespawn, respawnHudRows, respawnMarkerLayout, RESPAWN_MARKER,
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

// #394: the in-world countdown drawn at the downed player's wreck reads its display state from
// here, so the arc/seconds/held-hold decision is pure and locked down (the drawing itself is not).
describe('respawnReadout — the in-world countdown display state', () => {
  it('is null when the player is not waiting to respawn', () => {
    expect(respawnReadout(makeRespawnState())).toBeNull();
    expect(respawnReadout(null)).toBeNull();
  });

  it('reports a full ring the frame the clock starts', () => {
    const r = respawnReadout(startRespawn(makeRespawnState()));
    expect(r.fraction).toBe(1);
    expect(r.seconds).toBe(RESPAWN_DELAY_MS / 1000);
    expect(r.holding).toBe(false);
  });

  it('drains the fraction and counts the seconds down as the clock ticks', () => {
    const s = tickRespawn(startRespawn(makeRespawnState()), RESPAWN_DELAY_MS / 2, QUIET).state;
    const r = respawnReadout(s);
    expect(r.fraction).toBeCloseTo(0.5, 6);
    expect(r.seconds).toBeCloseTo(RESPAWN_DELAY_MS / 2000, 6);
    expect(r.holding).toBe(false);
  });

  it('reports HOLDING (not a frozen zero) while the out-of-combat gate is paused', () => {
    // Clock run all the way out, but the survivor took fire this frame — placement is held.
    const s = tickRespawn(startRespawn(makeRespawnState()), RESPAWN_DELAY_MS, 0).state;
    const r = respawnReadout(s);
    expect(r.holding).toBe(true);
    expect(r.fraction).toBe(0);
    expect(r.seconds).toBe(0);
  });

  it('clamps a negative overshoot rather than reporting past zero', () => {
    const r = respawnReadout({ remainingMs: -500, waitingOnCombat: false });
    expect(r.fraction).toBe(0);
    expect(r.seconds).toBe(0);
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

// #348 (playtest 2026-07-19: respawn placed a mech outside the corridor, in impassable terrain).
// The safest-from-threats edge of the view is frequently NOT playable ground since #340 made the
// world a lane narrower than the camera view — so the choice is now filtered by validity.
describe('pickRespawnPoint — constrained to ground the player can stand on (#348)', () => {
  const VIEW = { x: 0, y: 0, width: 1000, height: 600 };
  // A #340-shaped corridor: a horizontal lane far narrower than the view is tall.
  const inCorridor = (x, y) => y > 250 && y < 350;

  it('never returns a point outside the corridor when a valid candidate exists', () => {
    // Threat pinned to the bottom edge, so the UNCONSTRAINED winner is the top edge midpoint —
    // which is outside the lane. The constrained rule must reject it.
    const p = pickRespawnPoint(VIEW, [{ x: 500, y: 600 }], { isValid: inCorridor });
    expect(inCorridor(p.x, p.y)).toBe(true);
  });

  it('still prefers the SAFEST of the valid candidates, not merely the first valid one', () => {
    // Both left and right edge midpoints are in the lane; the threat hugs the left edge.
    const p = pickRespawnPoint(VIEW, [{ x: 0, y: 300 }], { isValid: inCorridor });
    expect(p.x).toBeGreaterThan(VIEW.width / 2);
    expect(inCorridor(p.x, p.y)).toBe(true);
  });

  it('falls back to the view centre when no edge midpoint is valid', () => {
    // A lane so narrow that only the very middle of the view is on playable ground.
    const pinhole = (x, y) => Math.abs(x - 500) < 20 && Math.abs(y - 300) < 20;
    const p = pickRespawnPoint(VIEW, [{ x: 0, y: 0 }], { isValid: pinhole });
    expect(pinhole(p.x, p.y)).toBe(true);
  });

  it('falls back progressively rather than failing when nothing at all is valid', () => {
    const p = pickRespawnPoint(VIEW, [{ x: 0, y: 300 }], { isValid: () => false });
    // Still a usable point (the caller snaps it to the nearest passable hex), and still the
    // safest edge — the original intent survives the degenerate case.
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(p.x).toBeGreaterThan(VIEW.width / 2);
  });

  it('is unchanged from the pre-#348 rule when no predicate is given', () => {
    expect(pickRespawnPoint(VIEW, [{ x: 0, y: 300 }])).toEqual(
      pickRespawnPoint(VIEW, [{ x: 0, y: 300 }], {}),
    );
  });

  it('still accepts a bare margin number as the third argument', () => {
    const p = pickRespawnPoint(VIEW, [{ x: 500, y: 600 }], 100);
    expect(p.y).toBeCloseTo(100, 6);
  });
});

// ── #394 (playtest follow-up): "HUD timer + a better in-world cue" ───────────────────────────
describe('respawnHudRows — the countdown as a powerup-style ring row', () => {
  const down = (over = {}) => ({ dead: true, color: 0x4fc3f7, respawn: startRespawn(makeRespawnState()), ...over });

  it('gives a downed player one row, full at the moment of death', () => {
    const rows = respawnHudRows([down()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].fraction).toBeCloseTo(1, 6);
    expect(rows[0].seconds).toBeCloseTo(RESPAWN_DELAY_MS / 1000, 6);
    expect(rows[0].holding).toBe(false);
  });

  it('drains as the clock runs down, so the ring reads as time left', () => {
    const half = { remainingMs: RESPAWN_DELAY_MS / 2, waitingOnCombat: false };
    expect(respawnHudRows([down({ respawn: half })])[0].fraction).toBeCloseTo(0.5, 6);
  });

  it('shows nothing for a living player, or for one with no clock running', () => {
    expect(respawnHudRows([{ dead: false, respawn: startRespawn(makeRespawnState()) }])).toEqual([]);
    expect(respawnHudRows([{ dead: true, respawn: makeRespawnState() }])).toEqual([]);
    expect(respawnHudRows([])).toEqual([]);
    expect(respawnHudRows()).toEqual([]);
  });

  it('says HOLD on a full ring while the out-of-combat gate is holding placement', () => {
    const held = { remainingMs: 0, waitingOnCombat: true };
    const [row] = respawnHudRows([down({ respawn: held })]);
    expect(row.holding).toBe(true);
    expect(row.fraction).toBe(1);      // never a ring parked at empty
  });

  it('is unnamed in solo and names the pilot in co-op', () => {
    expect(respawnHudRows([down()])[0].label).toBe('RESPAWN');
    const rows = respawnHudRows([{ dead: false }, down()]);
    expect(rows[0].label).toBe('P2 RESPAWN');
  });

  it('takes each downed player\'s own identifying colour', () => {
    const rows = respawnHudRows([down({ color: 0x111111 }), down({ color: 0x222222 })]);
    expect(rows.map((r) => r.color)).toEqual([0x111111, 0x222222]);
  });
});

describe('respawnMarkerLayout — the in-world DROP ZONE that replaced the ground circle', () => {
  const at = (fraction, holding = false) => respawnMarkerLayout({ fraction, seconds: 1, holding });

  it('shows nothing when there is no clock', () => {
    expect(respawnMarkerLayout(null)).toBeNull();
  });

  it('CLOSES IN as the clock runs down — the shape is the countdown', () => {
    expect(at(1).half).toBeCloseTo(RESPAWN_MARKER.farHalf, 6);
    expect(at(0).half).toBeCloseTo(RESPAWN_MARKER.nearHalf, 6);
    expect(at(0.5).half).toBeLessThan(at(1).half);
    expect(at(0.5).half).toBeGreaterThan(at(0).half);
  });

  it('draws four corner brackets, never a closed circle or a filled ring', () => {
    const L = at(0.5);
    expect(L.corners).toHaveLength(4);
    for (const c of L.corners) expect(c.arms).toHaveLength(2);
    // Each corner sits on the square, and both arms run back INTO it rather than around it.
    for (const c of L.corners) {
      expect(Math.abs(c.x)).toBeCloseTo(L.half, 6);
      expect(Math.abs(c.y)).toBeCloseTo(L.half, 6);
      for (const arm of c.arms) {
        expect(Math.hypot(arm.x2, arm.y2)).toBeLessThan(Math.hypot(arm.x1, arm.y1));
      }
    }
  });

  it('stands a beacon column UP out of the wreck, off the ground plane', () => {
    const L = at(0.5);
    expect(L.beam.y1).toBe(0);
    expect(L.beam.y2).toBeLessThan(0);         // screen-up
    expect(L.chevronY).toBeLessThan(0);        // the chevron rides the column, not the floor
  });

  it('slides the chevron down the column with the animation phase', () => {
    expect(at(0.5).chevronY).toBeLessThan(respawnMarkerLayout({ fraction: 0.5, holding: false }, 1).chevronY);
  });

  it('puts the seconds ABOVE the bracket square, clear of the wreck', () => {
    const L = at(0.5);
    expect(L.textY).toBeLessThan(-L.half);
  });

  it('parks the brackets at their tightest while HELD on the combat gate', () => {
    const L = at(1, true);
    expect(L.holding).toBe(true);
    expect(L.half).toBeCloseTo(RESPAWN_MARKER.nearHalf, 6);
  });
});
