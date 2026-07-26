// #511: buildable resource outposts — scene-side proximity build-prompt / interact-build /
// passive-income wiring. Same minimal fake-scene style as repairOutposts.test.js.
import { describe, it, expect, vi } from 'vitest';
import { ResourceOutpostsMixin } from './resourceOutposts.js';
import { claimOutpost } from '../../data/outposts.js';
import { OUTPOSTS_KEY } from '../../data/events.js';
import { RESOURCE_OUTPOST_COST, RESOURCE_BUILD_RADIUS_PX, RESOURCE_INCOME_PER_SEC } from '../../data/resourceOutposts.js';

function fakeGraphic() {
  const obj = { setStrokeStyle: () => obj, setDepth: () => obj, setRotation: () => obj };
  return obj;
}

function fakeScene(overrides = {}) {
  const registryStore = new Map();
  const addCircle = vi.fn(() => fakeGraphic());
  const addRectangle = vi.fn(() => fakeGraphic());
  const scene = Object.assign(
    {
      add: { circle: addCircle, rectangle: addRectangle },
      registry: { get: (k) => registryStore.get(k), set: (k, v) => registryStore.set(k, v) },
      biomeId: 'grassland',
      bases: [],
      run: { currency: 0 },
      px: 0, py: 0, mech: { repairTick: vi.fn() }, _playerDead: false,
      _floatText: vi.fn(),
      _captureChoiceActive: false,
    },
    ResourceOutpostsMixin,
    overrides,
  );
  scene._initResourceOutposts();
  return scene;
}

function heldBase(id, q = 0, r = 0) {
  return { id, center: { q, r }, captured: true };
}

function seedClaim(scene, baseId, extra = {}) {
  const outposts = claimOutpost(scene.registry.get(OUTPOSTS_KEY) ?? [], {
    id: `outpost-0-${baseId}`, type: 'resource', coord: { q: 0, r: 0 }, biomeId: scene.biomeId, baseId, ...extra,
  });
  scene.registry.set(OUTPOSTS_KEY, outposts);
}

describe('#511 resource-outpost build prompt (_updateResourceOutposts)', () => {
  it('offers the build prompt when a live player is near a held, not-yet-built base', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 10, py: 10 });
    seedClaim(scene, 'base0');

    scene._updateResourceOutposts(0.016);

    expect(scene._resourceBuildPromptBase).toBe(base);
    expect(scene.registry.get('resourceOutpostPrompt')).toEqual({ baseId: 'base0', cost: RESOURCE_OUTPOST_COST });
  });

  it('offers nothing when the player is outside the build radius', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: RESOURCE_BUILD_RADIUS_PX + 50, py: 0 });
    seedClaim(scene, 'base0');

    scene._updateResourceOutposts(0.016);

    expect(scene._resourceBuildPromptBase).toBeNull();
    expect(scene.registry.get('resourceOutpostPrompt')).toBeNull();
  });

  it('offers nothing at a base the player has not captured', () => {
    const base = { id: 'base0', center: { q: 0, r: 0 }, captured: false };
    const scene = fakeScene({ bases: [base], px: 0, py: 0 });

    scene._updateResourceOutposts(0.016);

    expect(scene._resourceBuildPromptBase).toBeNull();
  });

  it('offers nothing once a resource outpost is already built there', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0 });
    seedClaim(scene, 'base0', {});
    scene.registry.set(OUTPOSTS_KEY, scene.registry.get(OUTPOSTS_KEY).map((o) => ({ ...o, resourceBuilt: true })));

    scene._updateResourceOutposts(0.016);

    expect(scene._resourceBuildPromptBase).toBeNull();
  });

  it('#517\'s capture choice suppresses the resource-build prompt while it is pending', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0, _captureChoiceActive: true });
    seedClaim(scene, 'base0');

    scene._updateResourceOutposts(0.016);

    expect(scene._resourceBuildPromptBase).toBeNull();
    expect(scene.registry.get('resourceOutpostPrompt')).toBeNull();
  });

  it('pays passive scrap income once built, with NO proximity requirement (unlike repair)', () => {
    const base = heldBase('base0');
    // Player is far outside the build radius entirely — income should still accrue, since #511's
    // resource building deliberately needs no player presence once built (open design decision,
    // see data/resourceOutposts.js).
    const scene = fakeScene({ bases: [base], px: RESOURCE_BUILD_RADIUS_PX * 10, py: 0, run: { currency: 100 } });
    seedClaim(scene, 'base0');
    scene.registry.set(OUTPOSTS_KEY, scene.registry.get(OUTPOSTS_KEY).map((o) => ({ ...o, resourceBuilt: true })));

    const dt = 1 / RESOURCE_INCOME_PER_SEC;   // exactly enough time for 1 whole scrap
    scene._updateResourceOutposts(dt);

    expect(scene.run.currency).toBe(101);
  });

  it('accrues fractional income across frames without losing the remainder', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0, run: { currency: 0 } });
    seedClaim(scene, 'base0');
    scene.registry.set(OUTPOSTS_KEY, scene.registry.get(OUTPOSTS_KEY).map((o) => ({ ...o, resourceBuilt: true })));

    const dt = 1 / RESOURCE_INCOME_PER_SEC / 2;   // half of what's needed for 1 whole unit
    scene._updateResourceOutposts(dt);
    expect(scene.run.currency).toBe(0);   // not yet a whole unit
    scene._updateResourceOutposts(dt);
    expect(scene.run.currency).toBe(1);   // the two halves combine into one whole unit
  });

  it('draws the outpost marker once and does not redraw it on later frames', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0 });
    seedClaim(scene, 'base0');
    scene.registry.set(OUTPOSTS_KEY, scene.registry.get(OUTPOSTS_KEY).map((o) => ({ ...o, resourceBuilt: true })));

    scene._updateResourceOutposts(0.016);
    scene._updateResourceOutposts(0.016);

    expect(scene.add.circle).toHaveBeenCalledTimes(1);
  });
});

describe('#511 resource-outpost build (_onResourceInteractPressed)', () => {
  it('is a no-op with nothing pending', () => {
    const scene = fakeScene();
    expect(() => scene._onResourceInteractPressed()).not.toThrow();
    expect(scene.registry.get(OUTPOSTS_KEY)).toBeUndefined();
  });

  it('spends the cost from the live run currency and flags the outpost built', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0, run: { currency: 500 } });
    seedClaim(scene, 'base0');
    scene._updateResourceOutposts(0.016);   // populates _resourceBuildPromptBase

    scene._onResourceInteractPressed();

    expect(scene.run.currency).toBe(500 - RESOURCE_OUTPOST_COST);
    const outposts = scene.registry.get(OUTPOSTS_KEY);
    expect(outposts.find((o) => o.baseId === 'base0').resourceBuilt).toBe(true);
    expect(scene._resourceBuildPromptBase).toBeNull();
    expect(scene.registry.get('resourceOutpostPrompt')).toBeNull();
    expect(scene.add.circle).toHaveBeenCalledTimes(1);   // marker drawn immediately on build
  });

  it('refuses to build (and floats a warning) when scrap is short, without touching the outpost', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0, run: { currency: 10 } });
    seedClaim(scene, 'base0');
    scene._updateResourceOutposts(0.016);

    scene._onResourceInteractPressed();

    expect(scene.run.currency).toBe(10);
    expect(scene.registry.get(OUTPOSTS_KEY).find((o) => o.baseId === 'base0').resourceBuilt).toBe(false);
    expect(scene._floatText).toHaveBeenCalled();
    expect(scene._floatText.mock.calls[0][2]).toMatch(/NOT ENOUGH SCRAP/);
  });
});
