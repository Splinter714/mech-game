// #226 — magnetic pickup radius. Before this fix, a live scrap drop just bobbed/spun in place
// (see _updateSalvage) and only got collected by the flat PICKUP_RADIUS touch check — the player
// had to walk directly onto it. This adds a modest MAGNET_RADIUS: inside it (but outside actual
// pickup range) the drop's underlying position drifts toward the player each frame, while the
// bob/spin visual layers on top unchanged. SalvageMixin has no Phaser dependency in _updateSalvage
// beyond `this.add.*` (only used by _makeSalvageView/_maybeDropSalvage, not exercised here), so we
// drive it against a minimal fake ArenaScene `this` with hand-built salvage entries + fake views.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../audio/index.js', () => ({ Audio: { ui: vi.fn() } }));

import { SalvageMixin, PICKUP_RADIUS, MAGNET_RADIUS } from './salvage.js';

// A fake container view: only tracks the fields _updateSalvage touches (x/y position, the gem
// and ring rotations, alpha, and destroy()).
function fakeView() {
  return {
    x: 0, y: 0,
    _gem: { rotation: 0 },
    _ring: { rotation: 0 },
    alpha: 1,
    setAlpha(a) { this.alpha = a; return this; },
    destroy: vi.fn(),
  };
}

function makeScene(px, py) {
  return Object.assign(
    { px, py, salvage: [], run: { currency: 0 }, registry: { set: vi.fn() }, _floatText: vi.fn() },
    SalvageMixin,
  );
}

function drop(x, y, overrides = {}) {
  return { x, y, amount: 5, ttl: 15000, age: 0, view: fakeView(), ...overrides };
}

describe('_updateSalvage — magnetic pickup radius (#226)', () => {
  it('leaves a drop outside MAGNET_RADIUS stationary', () => {
    const scene = makeScene(0, 0);
    const s = drop(MAGNET_RADIUS + 50, 0);
    scene.salvage.push(s);
    scene._updateSalvage(16);
    expect(s.x).toBe(MAGNET_RADIUS + 50);
    expect(s.y).toBe(0);
  });

  it('pulls a drop inside MAGNET_RADIUS closer to the player each frame', () => {
    const scene = makeScene(0, 0);
    const s = drop(MAGNET_RADIUS - 10, 0);   // inside the magnet radius, outside pickup radius
    scene.salvage.push(s);
    const distBefore = Math.hypot(scene.px - s.x, scene.py - s.y);
    scene._updateSalvage(16);
    const distAfter = Math.hypot(scene.px - s.x, scene.py - s.y);
    expect(distAfter).toBeLessThan(distBefore);
    expect(distAfter).toBeGreaterThan(PICKUP_RADIUS);   // one 16ms frame shouldn't leap into pickup range
    // the drop is still tracked, not collected/destroyed
    expect(scene.salvage.length).toBe(1);
  });

  it('keeps pulling frame after frame until it reaches pickup range and gets collected', () => {
    const scene = makeScene(0, 0);
    const s = drop(MAGNET_RADIUS - 5, 0);
    scene.salvage.push(s);
    for (let i = 0; i < 500 && scene.salvage.length; i++) scene._updateSalvage(16);
    expect(scene.salvage.length).toBe(0);       // eventually collected
    expect(scene.run.currency).toBe(5);          // _collectSalvage ran
    expect(s.view.destroy).toHaveBeenCalled();
  });

  it('applies the bob offset on top of the drifting position, not instead of it', () => {
    const scene = makeScene(1000, 1000);   // far away — no magnet pull at all
    const s = drop(0, 0, { age: 325 });    // BOB_PERIOD/4 → sin peak-ish, non-zero bob offset
    scene.salvage.push(s);
    scene._updateSalvage(16);
    // x is untouched (no drift, no bob-x), but y should differ from the raw position due to bob.
    expect(s.view.x).toBe(s.x);
    expect(s.view.y).not.toBe(s.y);
  });

  it('still collects instantly when already within PICKUP_RADIUS (no magnet needed)', () => {
    const scene = makeScene(0, 0);
    const s = drop(10, 0);   // inside PICKUP_RADIUS already
    scene.salvage.push(s);
    scene._updateSalvage(16);
    expect(scene.salvage.length).toBe(0);
    expect(scene.run.currency).toBe(5);
  });

  it('still expires via PICKUP_TTL when never pulled into pickup range (drop parked outside magnet radius)', () => {
    const scene = makeScene(0, 0);
    const s = drop(MAGNET_RADIUS + 200, 0, { ttl: 10 });   // outside magnet radius, ttl about to expire
    scene.salvage.push(s);
    scene._updateSalvage(16);   // ttl goes to -6, drop never moved (outside magnet radius)
    expect(scene.salvage.length).toBe(0);
    expect(s.view.destroy).toHaveBeenCalled();
    expect(scene.run.currency).toBe(0);   // expired, not collected
  });
});
