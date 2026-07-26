// #512: buildable repair outposts — scene-side proximity prompt / interact-build / passive-heal
// wiring. Same minimal fake-scene style as outpostClaim.test.js — a plain `this`-based mixin bag,
// no real Phaser, `add.circle`/`add.rectangle` stubbed just enough to count marker draws.
import { describe, it, expect, vi } from 'vitest';
import { RepairOutpostsMixin } from './repairOutposts.js';
import { claimOutpost } from '../../data/outposts.js';
import { OUTPOSTS_KEY } from '../../data/events.js';
import { REPAIR_OUTPOST_COST, REPAIR_RADIUS_PX } from '../../data/repairOutposts.js';

function fakeGraphic() {
  const obj = { setStrokeStyle: () => obj, setDepth: () => obj };
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
    RepairOutpostsMixin,
    overrides,
  );
  scene._initRepairOutposts();
  return scene;
}

function heldBase(id, q = 0, r = 0) {
  return { id, center: { q, r }, captured: true };
}

// A base whose outpost record is already claimed (so `canBuildRepairOutpost`/`hasRepairOutpost`
// have something real to look at), seeded straight into the registry the way run.js `_establishBase`
// would have left it.
function seedClaim(scene, baseId, extra = {}) {
  const outposts = claimOutpost(scene.registry.get(OUTPOSTS_KEY) ?? [], {
    id: `outpost-0-${baseId}`, type: 'repair', coord: { q: 0, r: 0 }, biomeId: scene.biomeId, baseId, ...extra,
  });
  scene.registry.set(OUTPOSTS_KEY, outposts);
}

describe('#512 repair-outpost build prompt (_updateRepairOutposts)', () => {
  it('offers the build prompt when a live player is near a held, not-yet-built base', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 10, py: 10 });
    seedClaim(scene, 'base0');

    scene._updateRepairOutposts(0.016);

    expect(scene._repairBuildPromptBase).toBe(base);
    expect(scene.registry.get('repairOutpostPrompt')).toEqual({ baseId: 'base0', cost: REPAIR_OUTPOST_COST });
  });

  it('offers nothing when the player is outside the repair radius', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: REPAIR_RADIUS_PX + 50, py: 0 });
    seedClaim(scene, 'base0');

    scene._updateRepairOutposts(0.016);

    expect(scene._repairBuildPromptBase).toBeNull();
    expect(scene.registry.get('repairOutpostPrompt')).toBeNull();
  });

  it('offers nothing at a base the player has not captured', () => {
    const base = { id: 'base0', center: { q: 0, r: 0 }, captured: false };
    const scene = fakeScene({ bases: [base], px: 0, py: 0 });

    scene._updateRepairOutposts(0.016);

    expect(scene._repairBuildPromptBase).toBeNull();
  });

  it('offers nothing once a repair outpost is already built there', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0 });
    seedClaim(scene, 'base0', {});
    scene.registry.set(OUTPOSTS_KEY, scene.registry.get(OUTPOSTS_KEY).map((o) => ({ ...o, repairBuilt: true })));

    scene._updateRepairOutposts(0.016);

    expect(scene._repairBuildPromptBase).toBeNull();
  });

  it('#517\'s capture choice suppresses the repair-build prompt while it is pending', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0, _captureChoiceActive: true });
    seedClaim(scene, 'base0');

    scene._updateRepairOutposts(0.016);

    expect(scene._repairBuildPromptBase).toBeNull();
    expect(scene.registry.get('repairOutpostPrompt')).toBeNull();
  });

  it('passively heals a live player standing inside a BUILT outpost\'s radius', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0 });
    seedClaim(scene, 'base0');
    scene.registry.set(OUTPOSTS_KEY, scene.registry.get(OUTPOSTS_KEY).map((o) => ({ ...o, repairBuilt: true })));

    scene._updateRepairOutposts(0.5);

    expect(scene.mech.repairTick).toHaveBeenCalledTimes(1);
    expect(scene.mech.repairTick.mock.calls[0][0]).toBe(0.5);
  });

  it('draws the outpost marker once and does not redraw it on later frames', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0 });
    seedClaim(scene, 'base0');
    scene.registry.set(OUTPOSTS_KEY, scene.registry.get(OUTPOSTS_KEY).map((o) => ({ ...o, repairBuilt: true })));

    scene._updateRepairOutposts(0.016);
    scene._updateRepairOutposts(0.016);

    expect(scene.add.circle).toHaveBeenCalledTimes(1);
  });
});

describe('#512 repair-outpost build (_onRepairInteractPressed)', () => {
  it('is a no-op with nothing pending', () => {
    const scene = fakeScene();
    expect(() => scene._onRepairInteractPressed()).not.toThrow();
    expect(scene.registry.get(OUTPOSTS_KEY)).toBeUndefined();
  });

  it('spends the cost from the live run currency and flags the outpost built', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0, run: { currency: 500 } });
    seedClaim(scene, 'base0');
    scene._updateRepairOutposts(0.016);   // populates _repairBuildPromptBase

    scene._onRepairInteractPressed();

    expect(scene.run.currency).toBe(500 - REPAIR_OUTPOST_COST);
    const outposts = scene.registry.get(OUTPOSTS_KEY);
    expect(outposts.find((o) => o.baseId === 'base0').repairBuilt).toBe(true);
    expect(scene._repairBuildPromptBase).toBeNull();
    expect(scene.registry.get('repairOutpostPrompt')).toBeNull();
    expect(scene.add.circle).toHaveBeenCalledTimes(1);   // marker drawn immediately on build
  });

  it('refuses to build (and floats a warning) when scrap is short, without touching the outpost', () => {
    const base = heldBase('base0');
    const scene = fakeScene({ bases: [base], px: 0, py: 0, run: { currency: 10 } });
    seedClaim(scene, 'base0');
    scene._updateRepairOutposts(0.016);

    scene._onRepairInteractPressed();

    expect(scene.run.currency).toBe(10);
    expect(scene.registry.get(OUTPOSTS_KEY).find((o) => o.baseId === 'base0').repairBuilt).toBe(false);
    expect(scene._floatText).toHaveBeenCalled();
    expect(scene._floatText.mock.calls[0][2]).toMatch(/NOT ENOUGH SCRAP/);
  });
});
