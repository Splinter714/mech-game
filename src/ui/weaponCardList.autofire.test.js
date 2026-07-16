// #197 (re-scoped): the Garage catalog's WeaponCardList has every visible weapon card
// auto-fire a live shot/beam demo on a loop AND play its real fire/trajectory/impact sound
// automatically — with no way to turn off the sound, that's noisy/distracting just browsing
// the catalog or tuning sounds in the adjacent panel. This adds an "auto-fire demo sound"
// toggle (`list.autoFireEnabled`, OFF by default, persisted via loadAutoFireEnabled/
// saveAutoFireEnabled) that gates ONLY the automatic Audio.fire/impact/trajectory/startHeld
// calls (all routed through _isAudible) — the visual demo itself (the `_tick`/`_fire` sim
// driving each card's shot/beam animation) keeps running unconditionally regardless of the
// toggle's state, per an explicit correction: an earlier pass wrongly gated the whole sim.
//
// WeaponCardList is a Phaser-scene-bound UI class with no existing test coverage (it's
// normally exercised live via GarageScene/the Weapon Lab), so this test constructs it against
// a minimal fake `scene` + fake `localStorage`, mirroring weaponSfxPanel.autoPreview.test.js's
// precedent for a sibling toggle. The per-card draw primitives (drawBeam/drawProjectileBody/
// etc., in ../art/index.js) are mocked to no-ops — irrelevant to whether sound plays — so the
// real _tickWeapon/_fire/_draw code can run without needing a full Phaser Graphics/Canvas
// stack.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('phaser', () => ({
  default: {
    Math: { Clamp: (v, min, max) => Math.min(Math.max(v, min), max) },
    Display: { Color: { IntegerToColor: () => ({ rgba: 'rgba(0,0,0,1)' }) } },
  },
}));

vi.mock('../art/index.js', () => ({
  drawProjectileBody: () => {},
  drawBeam: () => {},
  drawSlash: () => {},
  drawGroundFire: () => {},
  mountIconKey: (id) => `mount:${id}`,
  MOUNT_FRONT_Y: 0,
  DESIGN: 64,
}));

import { Audio } from '../audio/index.js';
import { WeaponCardList } from './weaponCardList.js';

function makeFakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
}

function makeChainable(extra = {}) {
  const stub = { ...extra };
  for (const key of ['setOrigin', 'setStrokeStyle', 'setInteractive', 'setFillStyle', 'setAlpha',
    'setRotation', 'setDisplaySize', 'setPosition', 'setSize', 'setVisible', 'setText', 'setX']) {
    stub[key] = () => stub;
  }
  stub.on = () => {};
  stub.destroy = () => {};
  return stub;
}

function makeFakeScene() {
  return {
    add: {
      container: () => ({ add() {}, destroy() {}, setMask() {}, setPosition() {} }),
      rectangle: () => makeChainable(),
      image: () => makeChainable(),
      text: () => makeChainable(),
      graphics: () => makeChainable({ clear: () => makeChainable() }),
    },
    make: {
      graphics: () => ({
        clear() { return this; },
        fillStyle() { return this; },
        fillRect() { return this; },
        createGeometryMask: () => ({}),
        destroy() {},
      }),
    },
    input: { on() {}, off() {} },
    time: { now: 0, delayedCall(_delay, fn) { fn(); } },
    registry: { get: () => 1 },
  };
}

function makeList(opts = {}) {
  const scene = makeFakeScene();
  return new WeaponCardList(scene, { x: 0, y: 0, w: 400, h: 400, ids: ['autocannon'], ...opts });
}

describe('WeaponCardList auto-fire demo SOUND toggle (#197)', () => {
  beforeEach(() => {
    globalThis.localStorage = makeFakeLocalStorage();
    vi.restoreAllMocks();
  });

  it('defaults to off on a fresh list/session', () => {
    const list = makeList();
    expect(list.autoFireEnabled).toBe(false);
  });

  it('the visual demo sim keeps ticking (cooldown counts down) even while muted', () => {
    const list = makeList({ selectedId: 'autocannon' });
    expect(list.autoFireEnabled).toBe(false);
    const cdBefore = list.cards[0].cd;

    list.update(0, 5000);   // comfortably longer than any weapon's cycle time

    // The sim still ran — cooldown moved (and likely fired/reset), unaffected by the mute.
    expect(list.cards[0].cd).not.toBe(cdBefore);
  });

  it('does NOT play fire/impact sound while muted, even for the selected (audible) card', () => {
    const list = makeList({ selectedId: 'autocannon' });
    const fireSpy = vi.spyOn(Audio, 'fire').mockImplementation(() => {});
    const impactSpy = vi.spyOn(Audio, 'impact').mockImplementation(() => {});

    list.update(0, 5000);

    expect(fireSpy).not.toHaveBeenCalled();
    expect(impactSpy).not.toHaveBeenCalled();
  });

  it('DOES play fire sound for the selected card once switched on', () => {
    const list = makeList({ selectedId: 'autocannon' });
    list.setAutoFireEnabled(true);
    expect(list.autoFireEnabled).toBe(true);

    const fireSpy = vi.spyOn(Audio, 'fire').mockImplementation(() => {});
    list.update(0, 5000);

    expect(fireSpy).toHaveBeenCalled();
  });

  it('switching off mid-loop stops a held sound without touching the visual sim state', () => {
    const list = makeList({ selectedId: 'autocannon' });
    list.setAutoFireEnabled(true);
    const card = list.cards[0];
    card._heldOn = true;   // simulate a live held loop in progress
    card.projectiles = [{ x: 0, y: 0, dist: 5, maxDist: 100 }];   // in-flight visual state
    const stopHeldSpy = vi.spyOn(Audio, 'stopHeld').mockImplementation(() => {});

    list.setAutoFireEnabled(false);

    expect(stopHeldSpy).toHaveBeenCalledWith('autocannon');
    expect(card._heldOn).toBe(false);
    // The visual projectile itself is untouched — only audio was silenced.
    expect(card.projectiles).toHaveLength(1);
  });

  it('persists the toggle choice across list instances via localStorage', () => {
    const listA = makeList();
    listA.setAutoFireEnabled(true);
    expect(listA.autoFireEnabled).toBe(true);

    const listB = makeList();   // fresh instance, same fake localStorage
    expect(listB.autoFireEnabled).toBe(true);
  });

  it('selecting a card for mounting still works regardless of the toggle state', () => {
    const onSelect = vi.fn();
    const list = makeList({ onSelect });
    expect(list.autoFireEnabled).toBe(false);   // toggle stays off
    // The card's panel wires pointerdown -> onSelect(id) in _buildCard; invoke it directly
    // since the fake rectangle stub doesn't actually dispatch Phaser input events.
    list.onSelect('autocannon');
    expect(onSelect).toHaveBeenCalledWith('autocannon');
  });
});
