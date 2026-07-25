// #506: WeaponCardList's catalog cards now render THREE distinct kinds (weapon/ability/core
// item), not two — core items (data/coreItems.js: shield={name,max}, antiMissile={name,range,
// cooldown}) don't share the ability shape (cooldown/duration) and used to render a near-blank
// stat line under the old ability-shaped branch. This pins the category label + stat line each
// kind gets. Mirrors weaponCardList.autofire.test.js's fake-scene/direct-instantiation pattern.

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

import { WeaponCardList } from './weaponCardList.js';

function makeChainable(seed = {}) {
  const obj = { ...seed };
  for (const key of ['setOrigin', 'setStrokeStyle', 'setInteractive', 'setFillStyle', 'setAlpha',
    'setRotation', 'setDisplaySize', 'setPosition', 'setSize', 'setVisible', 'setColor', 'setX']) {
    obj[key] = () => obj;
  }
  obj.setText = (s) => { obj.text = s; return obj; };
  obj.on = () => {};
  obj.destroy = () => {};
  return obj;
}

function makeFakeScene() {
  return {
    add: {
      container: () => ({ add() {}, destroy() {}, setMask() {}, setPosition() {} }),
      rectangle: () => makeChainable(),
      image: () => makeChainable(),
      text: (x, y, str) => makeChainable({ x, y, text: str }),
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
    time: { now: 0, delayedCall() {} },
    registry: { get: () => 1 },
  };
}

function makeList(ids) {
  const scene = makeFakeScene();
  return new WeaponCardList(scene, { x: 0, y: 0, w: 400, h: 400, ids });
}

describe('WeaponCardList 3-way weapon/ability/core card kind (#506)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('a weapon card keeps its category label and full weapon stat line', () => {
    const list = makeList(['autocannon']);
    const card = list.cards[0];
    expect(card.cat.text).not.toBe('Ability');
    expect(card.cat.text).not.toBe('Core');
    expect(card.stats.text).toMatch(/dmg .* rng .* ammo/);
  });

  it('an ability card is labeled "Ability" with a cooldown/duration stat line', () => {
    const list = makeList(['dash']);
    const card = list.cards[0];
    expect(card.cat.text).toBe('Ability');
    expect(card.stats.text).toMatch(/^ability/);
    expect(card.stats.text).toMatch(/cooldown/);
  });

  it('a shield core card is labeled "Core" with its shield-HP stat, not a blank ability line', () => {
    const list = makeList(['shield']);
    const card = list.cards[0];
    expect(card.cat.text).toBe('Core');
    expect(card.stats.text).toMatch(/^passive/);
    expect(card.stats.text).toMatch(/shield HP/);
  });

  it('an anti-missile core card reads its range/cooldown, not shield/ability fields', () => {
    const list = makeList(['antiMissile']);
    const card = list.cards[0];
    expect(card.cat.text).toBe('Core');
    expect(card.stats.text).toMatch(/px range/);
    expect(card.stats.text).toMatch(/cooldown/);
  });

  it('only weapon cards get a mount-hardware emitter image', () => {
    const list = makeList(['autocannon', 'dash', 'shield']);
    const [weaponCard, abilityCard, coreCard] = list.cards;
    expect(weaponCard.emitter).not.toBeNull();
    expect(abilityCard.emitter).toBeNull();
    expect(coreCard.emitter).toBeNull();
  });
});
