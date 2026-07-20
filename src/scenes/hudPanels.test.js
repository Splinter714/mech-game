// #366 — HudScene's per-player panel wiring.
//
// The layout maths is pinned in data/hudLayout.test.js. What this pins is the WIRING, which is
// where the bug the issue warns about lives: the second HUD has to appear when someone presses
// START on gamepad 2 mid-sortie, not only at deploy. #348's player-ring fix had exactly this bug,
// and the fix was re-asking the rule every frame instead of deciding it at construction — so the
// tests here drive `_syncPanels` across a changing player list rather than a single build.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('phaser', () => ({
  default: {
    Scene: class { constructor(key) { this.sceneKey = key; } },
    Math: { Clamp: (v, a, b) => Math.min(b, Math.max(a, v)) },
    Display: { Color: { HexStringToColor: () => ({ color: 0 }) } },
  },
}));

const { default: HudScene } = await import('./HudScene.js');
const { Mech } = await import('../data/Mech.js');
const { PLAYER_COLORS } = await import('../data/players.js');
const { hudPlayerSnapshot } = await import('../data/hudLayout.js');

// A chainable display-object stub: every method returns itself, so the real widget-building code
// runs unmodified against it and we can inspect the positions it asked for.
function stub(extra = {}) {
  const o = {
    x: 0, y: 0, destroyed: false, visible: true, alpha: 1, height: 8,
    ...extra,
    setPosition(x, y) { o.x = x; o.y = y; return o; },
    setOrigin() { return o; },
    setVisible(v) { o.visible = v; return o; },
    setAlpha(a) { o.alpha = a; return o; },
    setText(t) { o.text = t; return o; },
    setColor(c) { o.color = c; return o; },
    setSize() { return o; },
    setScale() { return o; },
    setDepth() { return o; },
    setStrokeStyle() { return o; },
    setFillStyle() { return o; },
    setTexture() { return o; },
    setDisplaySize() { return o; },
    add() { return o; },
    clear() { return o; },
    fillStyle() { return o; },
    fillRect() { return o; },
    lineStyle() { return o; },
    strokeRect() { return o; },
    destroy() { o.destroyed = true; },
  };
  return o;
}

function fakeScene(hudPlayers) {
  const created = [];
  const registry = new Map();
  registry.set('hudPlayers', hudPlayers);
  const scene = Object.assign(Object.create(HudScene.prototype), {
    W: 1280,
    H: 800,
    panels: [],
    _panelCount: 0,
    registry: { get: (k) => registry.get(k), set: (k, v) => registry.set(k, v) },
    add: {
      text: (x, y, t) => { const o = stub({ x, y, text: t, kind: 'text' }); created.push(o); return o; },
      graphics: () => { const o = stub({ kind: 'graphics' }); created.push(o); return o; },
      rectangle: (x, y) => { const o = stub({ x, y, kind: 'rect' }); created.push(o); return o; },
      container: () => { const o = stub({ kind: 'container' }); created.push(o); return o; },
      image: (x, y) => { const o = stub({ x, y, kind: 'image' }); created.push(o); return o; },
    },
  });
  return { scene, created, registry };
}

function snap(id, { dead = false, respawn = null } = {}) {
  return hudPlayerSnapshot({
    id,
    color: PLAYER_COLORS[id],
    mech: new Mech({ chassisId: 'medium' }),
    dead,
    dash: { active: false, cooldown: 0 },
    respawn,
  }, 4);
}

describe('HudScene panels — solo', () => {
  it('builds exactly one panel, with the column where it has always been', () => {
    const { scene } = fakeScene([snap(0)]);
    scene._syncPanels();
    expect(scene.panels).toHaveLength(1);
    expect(scene.panels[0].columnX).toBe(16);
    expect(scene.panels[0].header.text).toBe('INTEGRITY');
  });

  it('rebuilds nothing on subsequent frames', () => {
    const { scene } = fakeScene([snap(0)]);
    scene._syncPanels();
    const panel = scene.panels[0];
    for (let i = 0; i < 10; i++) scene._syncPanels();
    expect(scene.panels[0]).toBe(panel);
    expect(panel.header.destroyed).toBe(false);
  });

  it('falls back to the old singleton channel when nothing publishes hudPlayers', () => {
    const { scene, registry } = fakeScene(null);
    registry.set('playerMech', new Mech({ chassisId: 'medium' }));
    registry.set('dashCooldown', 1.5);
    const snaps = scene._syncPanels();
    expect(snaps).toHaveLength(1);
    expect(scene.panels).toHaveLength(1);
    expect(snaps[0].dash.cooldown).toBe(1.5);
  });

  it('renders no panels at all with no player anywhere', () => {
    const { scene } = fakeScene(null);
    expect(scene._syncPanels()).toEqual([]);
  });
});

describe('HudScene panels — the mid-sortie join (START on gamepad 2)', () => {
  it('grows a second panel the frame the joiner appears, with no redeploy', () => {
    const { scene, registry } = fakeScene([snap(0)]);
    scene._syncPanels();
    expect(scene.panels).toHaveLength(1);

    // Somebody presses START on pad 2: the arena's next publish carries two players.
    registry.set('hudPlayers', [snap(0), snap(1)]);
    scene._syncPanels();

    expect(scene.panels).toHaveLength(2);
    expect(scene.panels[1].columnX).toBeGreaterThan(scene.panels[0].columnX);
  });

  it('gives each panel that player\'s identifying colour and numbered label', () => {
    const { scene } = fakeScene([snap(0), snap(1)]);
    scene._syncPanels();
    expect(scene.panels[0].color).toBe(PLAYER_COLORS[0]);
    expect(scene.panels[1].color).toBe(PLAYER_COLORS[1]);
    expect(scene.panels[0].header.text).toBe('P1 INTEGRITY');
    expect(scene.panels[1].header.text).toBe('P2 INTEGRITY');
  });

  it('destroys the old panel objects on rebuild rather than leaking them on screen', () => {
    const { scene, registry } = fakeScene([snap(0)]);
    scene._syncPanels();
    const soloHeader = scene.panels[0].header;
    registry.set('hudPlayers', [snap(0), snap(1)]);
    scene._syncPanels();
    expect(soloHeader.destroyed).toBe(true);
  });

  it('collapses back to one panel if the joiner leaves', () => {
    const { scene, registry } = fakeScene([snap(0), snap(1)]);
    scene._syncPanels();
    registry.set('hudPlayers', [snap(0)]);
    scene._syncPanels();
    expect(scene.panels).toHaveLength(1);
    expect(scene.panels[0].header.text).toBe('INTEGRITY');
  });

  it('re-asks the player list every frame from update(), not once at construction', () => {
    // The mechanism above only works if update() actually calls it each frame — pinned against
    // the source because that is precisely the line whose removal reintroduces #348's bug.
    const src = readFileSync(new URL('./HudScene.js', import.meta.url), 'utf8');
    const update = src.slice(src.indexOf('\n  update() {'));
    expect(update.slice(0, update.indexOf('\n  }'))).toMatch(/this\._syncPanels\(\)/);
  });
});

describe('HudScene panels — per player readouts', () => {
  it('reads each panel off its OWN mech, not player 1\'s', () => {
    const a = snap(0), b = snap(1);
    b.mech.applyDamage('rightArm', 40);
    const { scene } = fakeScene([a, b]);
    scene._syncPanels();
    scene._updatePanel(scene.panels[0], a);
    scene._updatePanel(scene.panels[1], b);
    expect(scene.panels[0].partTexts.rightArm.text)
      .not.toBe(scene.panels[1].partTexts.rightArm.text);
  });

  it('shows player 2 the PAD binds — they are gamepad-only by construction', () => {
    const { scene, registry } = fakeScene([snap(0), snap(1)]);
    registry.set('inputMode', 'kbm');
    scene._syncPanels();
    expect(scene._panelMode(scene.panels[0])).toBe('kbm');
    expect(scene._panelMode(scene.panels[1])).toBe('pad');
  });

  it('says what a downed player is waiting on, and dims their controls', () => {
    const down = snap(1, { dead: true, respawn: { remainingMs: 9000, waitingOnCombat: false } });
    const { scene } = fakeScene([snap(0), down]);
    scene._syncPanels();
    scene._updatePanel(scene.panels[1], down);
    expect(scene.panels[1].statusText.visible).toBe(true);
    expect(scene.panels[1].statusText.text).toMatch(/RESPAWN 9\.0s/);
    expect(scene.panels[1].skillBar.alpha).toBeLessThan(1);
  });

  it('clears the downed line once that player is back', () => {
    const alive = snap(1);
    const { scene } = fakeScene([snap(0), alive]);
    scene._syncPanels();
    scene._updatePanel(scene.panels[1], snap(1, { dead: true, respawn: { remainingMs: 1000 } }));
    scene._updatePanel(scene.panels[1], alive);
    expect(scene.panels[1].statusText.visible).toBe(false);
    expect(scene.panels[1].skillBar.alpha).toBe(1);
  });

  it('hides a panel with no snapshot rather than drawing stale numbers', () => {
    const { scene } = fakeScene([snap(0), snap(1)]);
    scene._syncPanels();
    scene._updatePanel(scene.panels[1], undefined);
    expect(scene.panels[1].skillBar.visible).toBe(false);
  });
});
