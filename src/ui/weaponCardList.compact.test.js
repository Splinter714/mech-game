// #505 (second correction): Jackson's second playtest pass on the Garage unification objected
// specifically to the condensed square-icon catalog GarageScene shipped per column — he wanted
// WeaponCardList's row/live-preview cards back, "the rows of weapon firing live preview." Since
// a column can be as narrow as ~1/4 of the screen at 4 players, WeaponCardList gained a
// `compact: true` mode (see COMPACT_* in weaponCardList.js) that shrinks card height/label
// width/gap/emitter size while keeping the exact same card shape (name/category/stats + a live
// mount-hardware emitter that fires real shots/beams through the shared delivery sim).
//
// This pins: (1) compact sizing is genuinely smaller than the Weapon Lab's full-size default,
// (2) the default (used by ArtPreviewScene's standalone Weapon Lab tab) is UNCHANGED by the
// addition of the option, and (3) a compact card's live-fire stage still gets positive width in
// a narrow region where full-size numbers would have gone negative — the actual bug a fixed
// LABEL_W would reintroduce in a 4-player column.
import { describe, it, expect, vi } from 'vitest';

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

function makeList(opts = {}) {
  const scene = makeFakeScene();
  return new WeaponCardList(scene, { x: 0, y: 0, w: 400, h: 400, ids: ['autocannon'], ...opts });
}

describe('WeaponCardList compact mode (#505 second correction)', () => {
  it('defaults to the full-size Weapon Lab numbers when compact is omitted', () => {
    const list = makeList();
    expect(list.compact).toBe(false);
    expect(list.cardH).toBe(96);
    expect(list.cardGap).toBe(12);
    expect(list.labelW).toBe(200);
    expect(list.emitSize).toBe(44);
  });

  it('compact:true shrinks every sizing dial below the full-size default', () => {
    const list = makeList({ compact: true });
    expect(list.compact).toBe(true);
    expect(list.cardH).toBeLessThan(96);
    expect(list.cardGap).toBeLessThan(12);
    expect(list.labelW).toBeLessThan(200);
    expect(list.emitSize).toBeLessThan(44);
  });

  it('a compact card still gets the full live-preview shape: emitter, name, category, stats', () => {
    const list = makeList({ compact: true });
    const card = list.cards[0];
    expect(card.emitter).not.toBeNull();
    expect(card.name.text).toBeTruthy();
    expect(card.stats.text).toMatch(/dmg .* rng .* ammo/);
  });

  it('a narrow column-width region (~1/4 of a 1280-wide screen) still leaves the compact stage positive', () => {
    const scene = makeFakeScene();
    const list = new WeaponCardList(scene, {
      x: 0, y: 0, w: 300, h: 400, ids: ['autocannon'], compact: true,
    });
    const card = list.cards[0];
    expect(card.stageW).toBeGreaterThan(0);
    expect(card.muzzleX).toBeGreaterThan(0);
  });

  it('the SAME narrow region would starve (or go negative on) the full-size stage, which is why compact exists', () => {
    const scene = makeFakeScene();
    const list = new WeaponCardList(scene, {
      x: 0, y: 0, w: 300, h: 400, ids: ['autocannon'], compact: false,
    });
    const card = list.cards[0];
    const compactScene = makeFakeScene();
    const compactList = new WeaponCardList(compactScene, {
      x: 0, y: 0, w: 300, h: 400, ids: ['autocannon'], compact: true,
    });
    const compactCard = compactList.cards[0];
    expect(compactCard.stageW).toBeGreaterThan(card.stageW);
  });
});
