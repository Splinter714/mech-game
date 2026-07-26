// #523: PauseMenuScene is Phaser-heavy (a real Scene subclass), so — same technique as
// hudPanels.test.js — this drives its prototype methods against hand-built stubs rather than
// spinning up real Phaser. Two things are covered: the SCENE itself (row wiring, cursor,
// activate/close) and `wirePauseMenu` (the half every OTHER scene calls to open it).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('phaser', () => ({
  default: {
    Scene: class { constructor(key) { this.sceneKey = key; } },
  },
}));

const { default: PauseMenuScene, wirePauseMenu } = await import('./PauseMenuScene.js');
const { PAUSE_ROWS } = await import('../data/pauseMenu.js');
const { Audio } = await import('../audio/index.js');

// A chainable display-object stub, mirroring hudPanels.test.js's helper.
function stub(extra = {}) {
  const o = {
    visible: true, fillColor: null, strokeColor: null, text: '', ...extra,
    setOrigin() { return o; },
    setStrokeStyle(_w, color) { o.strokeColor = color; return o; },
    setFillStyle(color) { o.fillColor = color; return o; },
    setInteractive() { return o; },
    setVisible(v) { o.visible = v; return o; },
    setColor(c) { o.color = c; return o; },
    setText(t) { o.text = t; return o; },
    setDepth() { return o; },
    on(evt, fn) { (o._handlers ??= {})[evt] = fn; return o; },
  };
  return o;
}

function fakeScene({ registryValues = {} } = {}) {
  const registry = new Map(Object.entries(registryValues));
  const created = { rects: [], texts: [] };
  const kb = {};
  const gamepad = { total: 1, _pad: { connected: true, buttons: [] } };
  gamepad.getAll = () => [gamepad._pad];
  gamepad.getPad = () => gamepad._pad;
  const scene = Object.assign(Object.create(PauseMenuScene.prototype), {
    W: 800, H: 600,
    registry: { get: (k) => registry.get(k), set: (k, v) => registry.set(k, v) },
    scale: { width: 800, height: 600 },
    cameras: { main: { setZoom() {}, setOrigin() {} } },
    add: {
      rectangle: (...args) => { const o = stub({ kind: 'rect', args }); created.rects.push(o); return o; },
      text: (...args) => { const o = stub({ kind: 'text', args }); created.texts.push(o); return o; },
    },
    input: {
      keyboard: { on: (evt, fn) => { kb[evt] = fn; } },
      gamepad,
    },
  });
  return { scene, created, registry, kb, gamepad };
}

describe('PauseMenuScene — row wiring', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('init() seeds the cursor at 0 and stores the launch data', () => {
    const { scene } = fakeScene();
    scene.init({ returnKey: 'ArenaScene', pauseAlso: ['HudScene'] });
    expect(scene._cursor).toBe(0);
    expect(scene._returnKey).toBe('ArenaScene');
    expect(scene._pauseAlso).toEqual(['HudScene']);
  });

  it('init() with no getPlayers leaves the movement row disabled after create()', () => {
    const { scene } = fakeScene();
    scene.init({ returnKey: 'GarageScene' });
    scene.create();
    const movementRow = scene._rows.find((r) => r.id === 'movement');
    expect(movementRow.enabled).toBe(false);
  });

  it('create() builds exactly the five confirmed rows, in order', () => {
    const { scene } = fakeScene();
    scene.init({ returnKey: 'ArenaScene', getPlayers: () => [{ legacyMovement: true }] });
    scene.create();
    expect(scene._rows.map((r) => r.id)).toEqual(PAUSE_ROWS);
  });

  it('a toggle row (e.g. perf) starts OFF, reading the registry default', () => {
    const { scene } = fakeScene({ registryValues: { showPerf: false } });
    scene.init({ returnKey: 'ArenaScene' });
    scene.create();
    const row = scene._rows.find((r) => r.id === 'perf');
    expect(row.label.text).toContain('OFF');
  });

  it('activating a toggle row flips the registry value and persists it', () => {
    const { scene, registry } = fakeScene({ registryValues: { showPerf: false } });
    scene.init({ returnKey: 'ArenaScene' });
    scene.create();

    scene._activate('perf');

    expect(registry.get('showPerf')).toBe(true);
    const row = scene._rows.find((r) => r.id === 'perf');
    expect(row.label.text).toContain('ON');
  });

  it('activating it again flips it back off', () => {
    const { scene, registry } = fakeScene({ registryValues: { showPerf: false } });
    scene.init({ returnKey: 'ArenaScene' });
    scene.create();

    scene._activate('perf');
    scene._activate('perf');

    expect(registry.get('showPerf')).toBe(false);
  });

  it('the movement row flips every supplied player\'s legacyMovement independently', () => {
    const players = [{ legacyMovement: true }, { legacyMovement: false }];
    const { scene } = fakeScene();
    scene.init({ returnKey: 'ArenaScene', getPlayers: () => players });
    scene.create();

    scene._activate('movement');

    expect(players[0].legacyMovement).toBe(false);
    expect(players[1].legacyMovement).toBe(true);
  });

  it('activating the movement row when disabled (no players) is a no-op', () => {
    const { scene } = fakeScene();
    scene.init({ returnKey: 'GarageScene' });
    scene.create();
    // Must not throw, and no registry channel exists for it — nothing to assert flipped.
    expect(() => scene._activate('movement')).not.toThrow();
  });

  it('_moveCursor wraps around both ends', () => {
    const { scene } = fakeScene();
    scene.init({ returnKey: 'ArenaScene' });
    scene.create();
    scene._cursor = 0;
    scene._moveCursor(-1);
    expect(scene._cursor).toBe(PAUSE_ROWS.length - 1);
    scene._moveCursor(1);
    expect(scene._cursor).toBe(0);
  });

  it('_close resumes the return scene and every pauseAlso scene, then stops itself', () => {
    const { scene } = fakeScene();
    scene.init({ returnKey: 'ArenaScene', pauseAlso: ['HudScene'] });
    scene.create();
    const resume = vi.fn();
    const stop = vi.fn();
    scene.scene = { resume, stop };

    scene._close();

    expect(resume).toHaveBeenCalledWith('ArenaScene');
    expect(resume).toHaveBeenCalledWith('HudScene');
    expect(stop).toHaveBeenCalled();
  });

  it('clicking a row (pointerdown) activates it', () => {
    const { scene, registry } = fakeScene({ registryValues: { showVersion: false } });
    scene.init({ returnKey: 'ArenaScene' });
    scene.create();
    const row = scene._rows.find((r) => r.id === 'version');

    row.rect._handlers.pointerdown();

    expect(registry.get('showVersion')).toBe(true);
  });
});

describe('wirePauseMenu — opening the menu from another scene', () => {
  function fakeCallerScene(key = 'GarageScene') {
    const kb = {};
    const updateHandlers = [];
    const pad = { connected: true, buttons: [] };
    const gamepad = { total: 1, getAll: () => [pad], getPad: () => pad };
    return {
      input: { keyboard: { on: (evt, fn) => { kb[evt] = fn; } }, gamepad },
      events: {
        on: (evt, fn) => { if (evt === 'update') updateHandlers.push(fn); },
        once: () => {},
        off: () => {},
      },
      scene: {
        key,
        launch: vi.fn(),
        pause: vi.fn(),
        isActive: vi.fn(() => false),
      },
      _kb: kb,
      _fireUpdate: () => updateHandlers.forEach((fn) => fn()),
      _pad: pad,
    };
  }

  beforeEach(() => vi.restoreAllMocks());

  it('ESC launches PauseMenuScene and pauses the caller scene', () => {
    const scene = fakeCallerScene('ArenaScene');
    wirePauseMenu(scene, { pauseAlso: ['HudScene'] });

    scene._kb['keydown-ESC']();

    expect(scene.scene.launch).toHaveBeenCalledWith('PauseMenuScene', expect.objectContaining({
      returnKey: 'ArenaScene', pauseAlso: ['HudScene'],
    }));
    expect(scene.scene.pause).toHaveBeenCalledWith();      // pauses itself (no args)
    expect(scene.scene.pause).toHaveBeenCalledWith('HudScene');
  });

  it('gamepad SELECT (edge-detected) also opens it', () => {
    const scene = fakeCallerScene('BaseScene');
    wirePauseMenu(scene);

    scene._fireUpdate();               // seed baseline (button not pressed)
    scene._pad.buttons[8] = { pressed: true };   // PAD.SELECT === 8
    scene._fireUpdate();               // rising edge

    expect(scene.scene.launch).toHaveBeenCalledTimes(1);
  });

  it('does not double-launch while the menu is already active', () => {
    const scene = fakeCallerScene('GarageScene');
    scene.scene.isActive = vi.fn(() => true);
    wirePauseMenu(scene);

    scene._kb['keydown-ESC']();

    expect(scene.scene.launch).not.toHaveBeenCalled();
  });

  it('passes the getPlayers callback through untouched', () => {
    const scene = fakeCallerScene('ArenaScene');
    const getPlayers = () => [{ legacyMovement: true }];
    wirePauseMenu(scene, { getPlayers });

    scene._kb['keydown-ESC']();

    expect(scene.scene.launch).toHaveBeenCalledWith('PauseMenuScene', expect.objectContaining({ getPlayers }));
  });
});
