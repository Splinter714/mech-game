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
    setInteractive() { return o; },
    add() { return o; },
    removeAll() { return o; },
    clear() { return o; },
    fillStyle() { return o; },
    fillRect() { return o; },
    lineStyle() { return o; },
    strokeRect() { return o; },
    // #452: the console shell, the recessed bays and the rounded skill-tile plates.
    fillRoundedRect() { return o; },
    strokeRoundedRect() { return o; },
    fillCircle() { return o; },
    // #448: the orb readout's globes and the paper doll's draining outlines.
    strokeCircle() { return o; },
    fillPoints(pts) { o.filledPoints = pts; return o; },
    strokePoints(pts) { o.strokedPoints = pts; return o; },
    beginPath() { return o; },
    moveTo() { return o; },
    lineTo() { return o; },
    strokePath() { return o; },
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
    respawn,
  });
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
    const mech = new Mech({ chassisId: 'medium' });
    registry.set('playerMech', mech);
    const snaps = scene._syncPanels();
    expect(snaps).toHaveLength(1);
    expect(scene.panels).toHaveLength(1);
    expect(snaps[0].mech).toBe(mech);
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
    const update = src.slice(src.indexOf('\n  update(time'));
    expect(update.slice(0, update.indexOf('\n  }'))).toMatch(/this\._syncPanels\(\)/);
  });
});

describe('HudScene panels — per player readouts', () => {
  // #448: the readout is BARS ONLY now — no numbers to compare — so "each panel reads its own
  // mech" is pinned on the rectangles each panel's bar layer is actually asked to fill.
  it('reads each panel off its OWN mech, not player 1\'s', () => {
    const a = snap(0), b = snap(1);
    b.mech.applyDamage('rightArm', 40);
    const { scene } = fakeScene([a, b]);
    scene._syncPanels();
    const fillsOf = (panel, s) => {
      const seen = [];
      panel.partBarsGfx.fillRect = (...r) => { seen.push(r); return panel.partBarsGfx; };
      scene._updatePanel(panel, s);
      return seen;
    };
    expect(fillsOf(scene.panels[0], a)).not.toEqual(fillsOf(scene.panels[1], b));
  });

  it('draws no numbers anywhere in the integrity block', () => {
    const { scene } = fakeScene([snap(0)]);
    scene._syncPanels();
    const panel = scene.panels[0];
    scene._updatePanel(panel, snap(0));
    const labels = [panel.header, panel.shieldLabel, ...Object.values(panel.partLabels)];
    for (const t of labels) expect(String(t.text ?? '')).not.toMatch(/\d/);
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

// ── #368: the off-screen lock chevron, per player ────────────────────────────────────────────
//
// The bug: `lockWorld` was published from the primary player only, so player 2 got no off-screen
// indicator for their own target. The fix rides the same `hudPlayers` snapshot array the panels
// do. What is pinned here is (1) SOLO IS UNCHANGED — one chevron, today's colour, today's
// margins, written as RAW NUMBERS rather than re-derived from the module — and (2) co-op paints
// one per player, in each player's own colour.

const LOCK_RETICLE_COLOR = 0xe2533a;   // deliberately a literal: solo must keep exactly this

// Records what `_paintEdgeIndicator` was asked to draw, so a test can read off the chevrons.
function lockScene(hudPlayers) {
  const { scene, registry } = fakeScene(hudPlayers);
  scene._syncPanels();                       // builds `_layout`, which the margins come from
  let cleared = 0;
  scene.lockWayGfx = stub({ kind: 'graphics' });
  scene.lockWayGfx.clear = () => { cleared++; return scene.lockWayGfx; };
  scene._tileTop = 700;
  scene.wayMargins = { top: 116, right: 24, bottom: 800 - 700 + 12, left: 24 };
  scene.lockWayMargins = {
    top: scene.wayMargins.top + 16, right: scene.wayMargins.right + 16,
    bottom: scene.wayMargins.bottom + 16, left: scene.wayMargins.left + 16,
  };
  const painted = [];
  // Mirrors the real `_paintEdgeIndicator`'s early return: no point means no chevron drawn.
  scene._paintEdgeIndicator = (g, point, margin, color) => {
    if (point) painted.push({ g, point, margin, color });
  };
  return { scene, registry, painted, clears: () => cleared };
}

function withLock(id, lock, extra = {}) {
  return { ...snap(id, extra), lock };
}

describe('HudScene lock chevron — solo is byte-identical', () => {
  it('paints exactly one chevron, at today\'s point, colour and margins (raw numbers)', () => {
    const { scene, painted } = lockScene([withLock(0, { x: 4000, y: -250 })]);
    scene._updateLockArrow(scene._playerSnapshots());

    expect(painted).toHaveLength(1);
    expect(painted[0].point).toEqual({ x: 4000, y: -250 });
    expect(painted[0].color).toBe(0xe2533a);            // NOT the player-1 palette colour
    expect(painted[0].margin).toEqual({ top: 132, right: 40, bottom: 128, left: 40 });
    expect(painted[0].g).toBe(scene.lockWayGfx);
  });

  it('clears the layer every frame, and paints nothing with no target', () => {
    const { scene, painted, clears } = lockScene([withLock(0, null)]);
    scene._updateLockArrow(scene._playerSnapshots());
    scene._updateLockArrow(scene._playerSnapshots());
    expect(clears()).toBe(2);
    expect(painted).toHaveLength(0);
  });

  it('still draws from the pre-hudPlayers singleton channel when that is all there is', () => {
    const { scene, registry, painted } = lockScene(null);
    registry.set('playerMech', new Mech({ chassisId: 'medium' }));
    registry.set('lockWorld', { x: 12, y: 34 });
    scene._updateLockArrow(scene._playerSnapshots());
    expect(painted).toHaveLength(1);
    expect(painted[0].point).toEqual({ x: 12, y: 34 });
    expect(painted[0].color).toBe(0xe2533a);
  });
});

describe('HudScene lock chevron — co-op', () => {
  it('paints one chevron PER PLAYER, each at its own target', () => {
    const { scene, painted } = lockScene([
      withLock(0, { x: 100, y: 100 }),
      withLock(1, { x: -900, y: 50 }),
    ]);
    scene._updateLockArrow(scene._playerSnapshots());
    expect(painted.map((p) => p.point)).toEqual([{ x: 100, y: 100 }, { x: -900, y: 50 }]);
  });

  it('colours them per player once there is somebody to be told apart from', () => {
    const { scene, painted } = lockScene([
      withLock(0, { x: 100, y: 100 }),
      withLock(1, { x: -900, y: 50 }),
    ]);
    scene._updateLockArrow(scene._playerSnapshots());
    expect(painted.map((p) => p.color)).toEqual([PLAYER_COLORS[0], PLAYER_COLORS[1]]);
    expect(painted[0].color).not.toBe(LOCK_RETICLE_COLOR);
  });

  it('draws only the player who HAS a target', () => {
    const { scene, painted } = lockScene([withLock(0, null), withLock(1, { x: -900, y: 50 })]);
    scene._updateLockArrow(scene._playerSnapshots());
    expect(painted).toHaveLength(1);
    expect(painted[0].color).toBe(PLAYER_COLORS[1]);
  });

  it('drops a downed player\'s chevron — they have no live pick', () => {
    const down = withLock(1, { x: -900, y: 50 }, { dead: true, respawn: { remainingMs: 9000 } });
    const { scene, painted } = lockScene([withLock(0, { x: 100, y: 100 }), down]);
    scene._updateLockArrow(scene._playerSnapshots());
    expect(painted).toHaveLength(1);
    expect(painted[0].point).toEqual({ x: 100, y: 100 });
  });

  it('picks up a mid-sortie joiner\'s chevron the frame they land', () => {
    const { scene, registry, painted } = lockScene([withLock(0, { x: 100, y: 100 })]);
    scene._updateLockArrow(scene._playerSnapshots());
    expect(painted).toHaveLength(1);
    registry.set('hudPlayers', [withLock(0, { x: 100, y: 100 }), withLock(1, { x: -900, y: 50 })]);
    scene._syncPanels();
    scene._updateLockArrow(scene._playerSnapshots());
    expect(painted).toHaveLength(3);   // 1 from the solo frame + 2 from the co-op frame
  });
});

// ── #448: the switchable health readout ──────────────────────────────────────────────────────
//
// Three readouts (bars / orbs / paper doll) exist to be compared IN PLAY, so what matters here is
// the wiring: H cycles the mode, the mode is shared by every panel, switching actually rebuilds
// the panels at the new geometry, and all three paint against a real Mech without throwing.
describe('HudScene health readout modes (#448)', () => {
  const modeScene = () => {
    const built = fakeScene([snap(0)]);
    built.scene.readoutHint = stub({ kind: 'text' });
    built.scene._syncPanels();
    return built;
  };

  it('starts on the SHIPPED bars readout', () => {
    const { scene } = modeScene();
    expect(scene._readoutMode()).toBe('bars');
    expect(scene.panels[0].mode).toBe('bars');
    expect(scene.panels[0].bars.segments.map((s) => s.loc)).toHaveLength(4);
  });

  it('H cycles bars → orbs → paper doll → bars, rebuilding the panel each time', () => {
    const { scene } = modeScene();
    const first = scene.panels[0].header;
    scene._cycleReadout();
    expect(scene.panels[0].mode).toBe('orbs');
    expect(first.destroyed).toBe(true);       // rebuilt, not left stacked on screen
    scene._cycleReadout();
    expect(scene.panels[0].mode).toBe('paperdoll');
    scene._cycleReadout();
    expect(scene.panels[0].mode).toBe('bars');
  });

  it('keeps the mode in the registry so it survives a redeploy', () => {
    const { scene, registry } = modeScene();
    scene._cycleReadout();
    expect(registry.get('hudReadout')).toBe('orbs');
  });

  it('names the live readout on screen, with the key that switches it', () => {
    const { scene } = modeScene();
    scene._updateReadoutHint();
    expect(scene.readoutHint.text).toMatch(/BARS/);
    expect(scene.readoutHint.text).toMatch(/H/);
    scene._cycleReadout();
    expect(scene.readoutHint.text).toMatch(/ORBS/);
  });

  it('puts BOTH co-op panels on the same readout', () => {
    const { scene, registry } = modeScene();
    scene._cycleReadout();
    registry.set('hudPlayers', [snap(0), snap(1)]);
    scene._syncPanels();
    expect(scene.panels.map((p) => p.mode)).toEqual(['orbs', 'orbs']);
  });

  it('every mode still hands the console shell a header line and a block to frame', () => {
    const { scene } = modeScene();
    for (const mode of ['bars', 'orbs', 'paperdoll']) {
      expect(scene.panels[0].mode).toBe(mode);
      const b = scene.panels[0].bars;
      expect(b.headerY).toBeLessThan(b.top);
      expect(b.w).toBeGreaterThan(0);
      expect(scene.panels[0].header.y).toBe(b.headerY);
      scene._cycleReadout();
    }
  });

  it('the orb readout captions its globes and keeps the shield caption', () => {
    const { scene } = modeScene();
    scene._cycleReadout();
    const p = scene.panels[0];
    expect(p.bars.orbs.map((o) => o.key)).toEqual(['hp', 'armor', 'shield']);
    expect(Object.keys(p.partLabels)).toHaveLength(0);   // aggregate: no per-location segments
    expect(p.extras.map((t) => t.text)).toEqual(['HP', 'AR']);
    expect(p.shieldLabel).not.toBeNull();
  });

  it('the paper doll keeps per-location captions and needs no shield caption', () => {
    const { scene } = modeScene();
    scene._cycleReadout();
    scene._cycleReadout();
    const p = scene.panels[0];
    expect(Object.keys(p.partLabels)).toHaveLength(4);
    expect(p.shieldLabel).toBeNull();          // the shield IS the outline around everything
    expect(p.bars.outline.w).toBeGreaterThan(p.bars.segments[0].w);
  });

  it('paints every mode against a real damaged mech without throwing', () => {
    const { scene } = modeScene();
    const mech = new Mech({ chassisId: 'medium' });
    mech.applyDamage('leftArm', 9999);
    for (let i = 0; i < 3; i++) {
      expect(() => scene._updateIntegrity(scene.panels[0], mech)).not.toThrow();
      scene._cycleReadout();
    }
  });

  it('the paper doll actually strokes a draining outline for a damaged part', () => {
    const { scene } = modeScene();
    scene._cycleReadout();
    scene._cycleReadout();
    const mech = new Mech({ chassisId: 'medium' });
    scene._updateIntegrity(scene.panels[0], mech);
    expect(scene.panels[0].partBarsGfx.strokedPoints.length).toBeGreaterThan(1);
  });
});
