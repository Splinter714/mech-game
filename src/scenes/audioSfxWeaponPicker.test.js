// #470 playtest follow-up — the AUDIO tab's SFX section must let you PICK which weapon you are
// tuning, the way selecting a catalog card in the mech lab used to.
//
// The gap that let the first attempt ship: the weapon block was *constructed* in code, so a
// source-text guard would have passed, but nothing proved a click actually re-pointed the tuner
// panel at the picked weapon. So this test DRIVES the real scene: it runs AudioScene.create()
// against stubbed Phaser display objects, switches to the SFX section, finds the button whose
// label is a real weapon's name, fires its pointerdown handler, and asserts the REAL
// WeaponSfxPanel ends up pointed at that weapon id (only the panel's heavy _build() render is
// stubbed out — setWeapon/setTarget run for real).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('phaser', () => ({
  default: {
    Scene: class { constructor(key) { this.sceneKey = key; } },
    Math: { Clamp: (v, a, b) => Math.min(b, Math.max(a, v)) },
    Display: { Color: { IntegerToColor: () => ({ rgba: '#fff' }) } },
  },
}));
// The tab bar pulls in the whole scene registry; it isn't what's under test here.
vi.mock('../ui/tabBar.js', () => ({
  TAB_BAR_H: 52,
  buildTabBar: () => {},
  attachPadTabCycle: () => {},
}));

const { default: AudioScene } = await import('./AudioScene.js');
const { WeaponSfxPanel } = await import('../ui/weaponSfxPanel.js');
const { WEAPON_IDS } = await import('../data/weapons.js');
const { getItem } = await import('../data/items.js');
const { EXPLOSION_CATEGORIES, explosionSfxId } = await import('../audio/sfxParams.js');

// A chainable display-object stub that remembers the handlers registered on it, so the test can
// fire the same `pointerdown` a real click would.
function stub(extra = {}) {
  const handlers = {};
  const o = {
    x: 0, y: 0, width: 0, height: 0, text: '', children: [], handlers,
    ...extra,
    on(evt, fn) { (handlers[evt] ||= []).push(fn); return o; },
    off(evt) { delete handlers[evt]; return o; },
    emit(evt, ...args) { for (const fn of handlers[evt] || []) fn(...args); return o; },
    setOrigin() { return o; }, setDepth() { return o; }, setAlpha() { return o; },
    setVisible() { return o; }, setScale() { return o; }, setPosition() { return o; },
    setText(t) { o.text = t; return o; }, setColor(c) { o.colorArg = c; return o; },
    setStrokeStyle(...a) { o.strokeArgs = a; return o; },
    setFillStyle(...a) { o.fillArgs = a; return o; },
    setInteractive() { return o; }, setSize() { return o; }, setMask() { return o; },
    add(objs) { o.children.push(...(Array.isArray(objs) ? objs : [objs])); return o; },
    removeAll() { o.children.length = 0; return o; },
    destroy() { o.destroyed = true; return o; },
    clear() { return o; }, fillStyle() { return o; }, fillRect() { return o; },
    lineStyle() { return o; }, strokeRect() { return o; },
    createGeometryMask() { return o; },
  };
  return o;
}

function makeScene() {
  const scene = new AudioScene();
  const made = { rects: [], texts: [], containers: [] };
  scene.registry = new Map();
  scene.registry.get = Map.prototype.get.bind(scene.registry);
  scene.registry.set = Map.prototype.set.bind(scene.registry);
  scene.scale = { width: 1600, height: 900 };
  scene.cameras = { main: { setZoom: () => {}, setOrigin: () => {}, setBackgroundColor: () => {} } };
  scene.add = {
    rectangle: (x, y, w, h) => { const o = stub({ x, y, width: w, height: h, kind: 'rect' }); made.rects.push(o); return o; },
    text: (x, y, t) => { const o = stub({ x, y, text: String(t), kind: 'text' }); made.texts.push(o); return o; },
    container: () => { const o = stub({ kind: 'container' }); made.containers.push(o); return o; },
    graphics: () => stub({ kind: 'graphics' }),
  };
  scene.make = { graphics: () => stub({ kind: 'graphics' }) };
  scene.input = { on: () => {}, off: () => {}, keyboard: { on: () => {} } };
  scene.events = { once: () => {}, on: () => {} };
  scene.tweens = { add: () => {} };
  scene.scene = { start: () => {} };
  scene.game = { events: { emit: () => {} } };
  scene.made = made;
  return scene;
}

// Every rect the scene built, paired with the text drawn at its centre — i.e. the labelled
// buttons a player can actually click.
function labelledButtons(scene) {
  const out = [];
  for (const rect of scene.made.rects) {
    const label = scene.made.texts.find((t) => t.x === rect.x + rect.width / 2 && t.y === rect.y + rect.height / 2);
    if (label) out.push({ rect, label: label.text, textObj: label });
  }
  return out;
}

function clickLabel(scene, label) {
  const btn = labelledButtons(scene).find((b) => b.label === label);
  expect(btn, `no clickable button labelled "${label}"`).toBeTruthy();
  btn.rect.emit('pointerdown');
  return btn;
}

describe('AUDIO tab — SFX weapon picker (#470)', () => {
  let scene;
  let buildSpy;

  beforeEach(() => {
    // Run the panel's real setWeapon/setTarget, but skip its heavy Phaser render pass.
    buildSpy = vi.spyOn(WeaponSfxPanel.prototype, '_build').mockImplementation(function noop() {});
    globalThis.document = {
      createElement: () => stub({
        style: {}, files: [],
        addEventListener() {}, removeEventListener() {}, remove() {}, setAttribute() {},
      }),
      body: { appendChild() {}, removeChild() {} },
    };
    globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    scene = makeScene();
    scene.registry.set('audioSection', 'sfx');
    scene.create();
  });

  afterEach(() => { buildSpy.mockRestore(); });

  it('shows every weapon as its own labelled button', () => {
    const labels = labelledButtons(scene).map((b) => b.label);
    for (const id of WEAPON_IDS) expect(labels).toContain(getItem(id).name);
  });

  it('the SFX section is reachable from the MUSIC section via the switcher', () => {
    const musicScene = makeScene();
    musicScene.registry.set('audioSection', 'music');
    musicScene.create();
    expect(labelledButtons(musicScene).map((b) => b.label)).not.toContain(getItem(WEAPON_IDS[0]).name);
    clickLabel(musicScene, 'SFX');
    expect(labelledButtons(musicScene).map((b) => b.label)).toContain(getItem(WEAPON_IDS[0]).name);
  });

  it('clicking a weapon points the real tuner panel at THAT weapon', () => {
    for (const id of WEAPON_IDS) {
      clickLabel(scene, getItem(id).name);
      expect(scene.panel.weaponId).toBe(id);
      expect(scene.selectedSfxId).toBe(id);
    }
  });

  it('keeps the picked weapon loaded across a section switch (MUSIC → SFX)', () => {
    const id = WEAPON_IDS[2];
    clickLabel(scene, getItem(id).name);
    clickLabel(scene, 'MUSIC');
    clickLabel(scene, 'SFX');
    expect(scene.panel.weaponId).toBe(id);
    expect(scene.selectedSfxId).toBe(id);
  });

  it('opens with a weapon already loaded rather than an empty tuner', () => {
    expect(scene.panel.weaponId).toBe(WEAPON_IDS[0]);
    expect(scene.selectedSfxId).toBe(WEAPON_IDS[0]);
  });

  it('names the weapon being tuned in the picker header, and updates it on click', () => {
    const header = scene.made.texts.find((t) => /TUNING WEAPON/.test(t.text));
    expect(header, 'no header naming the weapon under the cursor of the tuner').toBeTruthy();
    expect(header.text).toContain(getItem(WEAPON_IDS[0]).name.toUpperCase());
    const other = WEAPON_IDS[3];
    clickLabel(scene, getItem(other).name);
    expect(header.text).toContain(getItem(other).name.toUpperCase());
  });

  it('marks the picked weapon button differently from the unpicked ones', () => {
    const id = WEAPON_IDS[4];
    const picked = clickLabel(scene, getItem(id).name);
    const other = labelledButtons(scene).find((b) => b.label === getItem(WEAPON_IDS[5]).name);
    const style = (b) => JSON.stringify([b.rect.fillArgs, b.rect.strokeArgs, b.textObj.colorArg]);
    expect(style(picked)).not.toBe(style(other));
  });

  it('still lets the other sound domains take over the panel', () => {
    const category = EXPLOSION_CATEGORIES[0];
    clickLabel(scene, category[0].toUpperCase() + category.slice(1));
    expect(scene.panel.weaponId).toBe(explosionSfxId(category));
  });
});
