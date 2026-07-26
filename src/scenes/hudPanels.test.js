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

const { default: HudScene, ARMOR_PEEK_PAD } = await import('./HudScene.js');
const { Mech } = await import('../data/Mech.js');
const { PLAYER_COLORS } = await import('../data/players.js');
const { hudPlayerSnapshot, CONSOLE, consoleLayout, INTEGRITY_ORDER } = await import('../data/hudLayout.js');
const { getWeapon } = await import('../data/weapons.js');
const { structureColor, FUSED_DOME_RISE } = await import('../data/healthReadout.js');
const { ABILITY_SLOTS } = await import('../data/anatomy.js');
const { TILE_ORDER, HUD_ABILITY_ORDER } = await import('../ui/skillTiles.js');

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
    fillStyle(color, alpha) { o._fillColor = color; o._fillAlpha = alpha; return o; },
    fillRect() { return o; },
    lineStyle(_w, color) { o._lineColor = color; return o; },
    strokeRect() { return o; },
    // #452: the console shell, the recessed bays and the rounded skill-tile plates.
    // #495: also the fused readout's per-tile HP wash and armor drain overlay — tracked (colour +
    // geometry) so the armor-drain tests below can assert the overlay anchors to the tile's own
    // BOTTOM edge and grows/shrinks in HEIGHT rather than being a stroked outline any more.
    fillRoundedRect(x, y, w, h) {
      (o.fillRuns ??= []).push({ color: o._fillColor, alpha: o._fillAlpha, x, y, w, h });
      return o;
    },
    strokeRoundedRect() { return o; },
    fillCircle() { return o; },
    // #448: the paper doll's draining outlines.
    strokeCircle() { return o; },
    fillPoints(pts) { o.filledPoints = pts; return o; },
    strokePoints(pts) { o.strokedPoints = pts; (o.strokeRuns ??= []).push({ color: o._lineColor, pts }); return o; },
    beginPath() { return o; },
    // #452 (style pass): the target disc's gauge arcs, and the circular clip its pose sits in.
    arc() { return o; },
    createGeometryMask() { return o; },
    setMask() { return o; },
    clearMask() { return o; },
    moveTo() { return o; },
    lineTo() { return o; },
    strokePath() { return o; },
    destroy() { o.destroyed = true; },
  };
  return o;
}

// #448 playtest: the DEFAULT readout is NONE (no integrity block, no header), so a test about the
// bar block has to say so — `readout: 'bars'` is that opt-in, not a special case.
function fakeScene(hudPlayers, { readout } = {}) {
  const created = [];
  const registry = new Map();
  registry.set('hudPlayers', hudPlayers);
  if (readout) registry.set('hudReadout', readout);
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
    // #452 (style pass): the target disc builds a geometry mask, the same way the minimap does.
    make: {
      graphics: () => { const o = stub({ kind: 'graphics' }); created.push(o); return o; },
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
  // #452 (style pass): the readouts no longer hug the screen edges — they are packed into one
  // CENTRED console band that is only as wide as they are, which is exactly what Jackson asked
  // for ("centered and only as wide as it needs to be"), so that is what is pinned.
  it('builds exactly one panel, in a console band centred on the screen', () => {
    const { scene } = fakeScene([snap(0)], { readout: 'bars' });
    scene._syncPanels();
    expect(scene.panels).toHaveLength(1);
    expect(scene.panels[0].header.text).toBe('INTEGRITY');
    // The band is narrower than the screen and sits in the middle of it.
    expect(scene._band.w).toBeLessThan(scene.W);
    expect(Math.abs(scene._band.x + scene._band.w / 2 - scene.W / 2)).toBeLessThanOrEqual(1);
    // ...and the integrity block starts inside it, well clear of the old x=16 screen edge.
    expect(scene.panels[0].columnX).toBeGreaterThan(scene._band.x);
    expect(scene.panels[0].columnX).toBeGreaterThan(100);
  });

  it('hangs the target readout in a top-left disc, mirroring the corner minimap', () => {
    const { scene } = fakeScene([snap(0)]);
    scene._syncPanels();
    const disc = scene.panels[0].pod;
    expect(disc.cy).toBeLessThan(scene.H / 2);        // top of the screen...
    expect(disc.cx).toBeLessThan(scene.W / 2);        // ...on the left.
    expect(disc.rings.map((r) => r.key)).toEqual(['shield', 'armor', 'hp']);  // #478: shield outermost
  });

  it('stacks the second player\'s disc under the first rather than over the map', () => {
    const { scene, registry } = fakeScene([snap(0)]);
    scene._syncPanels();
    registry.set('hudPlayers', [snap(0), snap(1)]);
    scene._syncPanels();
    const [a, b] = scene.panels.map((p) => p.pod);
    expect(b.cx).toBe(a.cx);
    expect(b.cy).toBeGreaterThan(a.cy);
  });

  it('rebuilds nothing on subsequent frames', () => {
    const { scene } = fakeScene([snap(0)], { readout: 'bars' });
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
    const { scene } = fakeScene([snap(0), snap(1)], { readout: 'bars' });
    scene._syncPanels();
    expect(scene.panels[0].color).toBe(PLAYER_COLORS[0]);
    expect(scene.panels[1].color).toBe(PLAYER_COLORS[1]);
    expect(scene.panels[0].header.text).toBe('P1 INTEGRITY');
    expect(scene.panels[1].header.text).toBe('P2 INTEGRITY');
  });

  it('destroys the old panel objects on rebuild rather than leaking them on screen', () => {
    const { scene, registry } = fakeScene([snap(0)], { readout: 'bars' });
    scene._syncPanels();
    const soloHeader = scene.panels[0].header;
    registry.set('hudPlayers', [snap(0), snap(1)]);
    scene._syncPanels();
    expect(soloHeader.destroyed).toBe(true);
  });

  it('collapses back to one panel if the joiner leaves', () => {
    const { scene, registry } = fakeScene([snap(0), snap(1)], { readout: 'bars' });
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
    const { scene } = fakeScene([a, b], { readout: 'bars' });
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
    const { scene } = fakeScene([snap(0)], { readout: 'bars' });
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
// Three modes (none / bars / paper doll) exist to be compared IN PLAY, so what matters here is
// the wiring: H cycles the mode, the mode is shared by every panel, switching actually rebuilds
// the panels at the new geometry, and each one paints against a real Mech without throwing.
// #451 — the ammo line on a skill tile counts PROJECTILES, not trigger pulls. The conversion is
// pinned in data/weaponStats.test.js; what is pinned here is that the HUD actually uses it.
describe('HudScene ammo readout (#451)', () => {
  const armed = (id) => {
    const mech = new Mech({ chassisId: 'medium' });
    mech.mount('rightArm', id);
    return hudPlayerSnapshot({ id: 0, color: PLAYER_COLORS[0], mech, dead: false, respawn: null });
  };
  const subtitles = (created) => created
    .filter((o) => typeof o.text === 'string' && /^\d+\/\d+$/.test(o.text))
    .map((o) => o.text);

  const run = (weaponId) => {
    const built = fakeScene([armed(weaponId)]);
    built.scene._syncPanels();
    built.scene._updateTargetPod = () => {};
    built.scene._updatePanel(built.scene.panels[0], built.scene._playerSnapshots()[0], 16);
    return built;
  };

  it('shows a missile rack\'s TOTAL missiles, not its magazine of pulls', () => {
    const { created } = run('swarmRack');
    const rack = getWeapon('swarmRack');
    const total = rack.ammoMax * rack.delivery.count;
    expect(subtitles(created)).toContain(`${total}/${total}`);
    // …and specifically NOT the old shot count.
    expect(subtitles(created)).not.toContain(`${rack.ammoMax}/${rack.ammoMax}`);
  });

  it('leaves a single-projectile weapon\'s line exactly as it was', () => {
    const { created } = run('autocannon');
    const gun = getWeapon('autocannon');
    expect(subtitles(created)).toContain(`${gun.ammoMax}/${gun.ammoMax}`);
  });
});

describe('HudScene _buildPodArt — the target disc art (#483: hexes + walls join enemies)', () => {
  // A pod scene: a stub panel + the two managers `_buildPodArt` reads (ink bounds, texture
  // existence) and an `add.sprite` that records what was posed. Deliberately minimal — the mech
  // branch (poseMechInto over real chassis art) is out of scope here; this pins the vehicle path is
  // untouched and the new hex/wall path sprites the right baked texture.
  function podScene() {
    const sprites = [];
    const panel = { podArt: stub({ kind: 'container' }), pod: { art: { w: 100, h: 100 } } };
    const scene = Object.assign(Object.create(HudScene.prototype), {
      ink: { union: () => ({ w: 40, h: 40, texW: 64, texH: 64, cx: 32, cy: 32 }), drop() {} },
      textures: { exists: () => true },
      add: {
        sprite: (x, y, key) => { const o = stub({ x, y, key, kind: 'sprite' }); sprites.push(o); return o; },
      },
    });
    return { scene, panel, sprites };
  }

  it('sprites a destructible HEX from its live baked terrain texture', () => {
    const { scene, panel, sprites } = podScene();
    scene._buildPodArt(panel, { kind: 'hex', texKey: 'hex_dockClosed', name: 'DOCK', damageSig: 'dockClosed' });
    expect(sprites.map((s) => s.key)).toEqual(['hex_dockClosed']);
    expect(panel.podAnim.texPrefix).toBe('hex_dockClosed');
  });

  it('sprites a WALL span from the shared wall block', () => {
    const { scene, panel, sprites } = podScene();
    scene._buildPodArt(panel, { kind: 'wall', texKey: 'hex_wall', name: 'WALL', damageSig: '' });
    expect(sprites.map((s) => s.key)).toEqual(['hex_wall']);
  });

  it('leaves the enemy VEHICLE path exactly as it was — hull + turret, not the hex branch', () => {
    const { scene, panel, sprites } = podScene();
    scene._buildPodArt(panel, { kind: 'vehicle', texKey: 'kind_tank', art: 'tank' });
    expect(sprites.map((s) => s.key)).toEqual(['kind_tank_hull', 'kind_tank_turret']);
  });
});

describe('HudScene health readout modes (#448)', () => {
  const modeScene = () => {
    const built = fakeScene([snap(0)]);
    built.scene._syncPanels();
    return built;
  };

  // #495 (2nd playtest round): FUSED is now the DEFAULT — it took the slot over from NONE the
  // same way NONE once took it from nothing (see READOUT_MODES's own comment in
  // healthReadout.js). FUSED has no separate block either (like NONE did), so the console still
  // collapses to just the tile row.
  it('starts on FUSED, with no separate block for the console to frame', () => {
    const { scene } = modeScene();
    expect(scene._readoutMode()).toBe('fused');
    expect(scene.panels[0].mode).toBe('fused');
    expect(scene.panels[0].bars.w).toBe(0);
    expect(scene.panels[0].header).toBeNull();
    expect(scene._band.groups[0].blockW).toBe(0);
  });

  it('H cycles fused → none → bars → paper doll → fused, rebuilding the panel each time', () => {
    const { scene } = modeScene();
    expect(scene.panels[0].mode).toBe('fused');
    scene._cycleReadout();
    expect(scene.panels[0].mode).toBe('none');
    scene._cycleReadout();
    expect(scene.panels[0].mode).toBe('bars');
    expect(scene.panels[0].bars.segments.map((s) => s.loc)).toHaveLength(4);
    const barsHeader = scene.panels[0].header;
    scene._cycleReadout();
    expect(scene.panels[0].mode).toBe('paperdoll');
    expect(barsHeader.destroyed).toBe(true);   // rebuilt, not left stacked on screen
    scene._cycleReadout();
    expect(scene.panels[0].mode).toBe('fused');
  });

  it('keeps the mode in the registry so it survives a redeploy', () => {
    const { scene, registry } = modeScene();
    scene._cycleReadout();
    expect(registry.get('hudReadout')).toBe('none');
  });

  // The ORB readout was deleted; a registry left on it from an earlier session must not strand the
  // HUD on a mode with no layout and no paint path.
  it('falls back to the default when the registry holds the deleted ORBS mode', () => {
    const { scene, registry } = modeScene();
    registry.set('hudReadout', 'orbs');
    scene._syncPanels();
    expect(scene._readoutMode()).toBe('fused');
    expect(scene.panels[0].mode).toBe('fused');
    scene._cycleReadout();
    expect(scene.panels[0].mode).toBe('none');
  });

  // #452 (style pass): the on-screen `READOUT: … [H] to switch` prompt was removed at Jackson's
  // request — the KEY is what has to keep working, so that is what is pinned. Pinned against the
  // source as well, because a prompt is trivially re-added by a later readout change.
  it('cycles on the H key with no on-screen control prompt', () => {
    const { scene } = modeScene();
    expect(scene.readoutHint).toBeUndefined();
    scene._cycleReadout();
    expect(scene.panels[0].mode).toBe('none');
    // Nothing anywhere in the HUD names the key.
    const { created } = modeScene();
    expect(created.filter((o) => typeof o.text === 'string' && /READOUT|\[H\]/.test(o.text))).toEqual([]);
    const src = readFileSync(new URL('./HudScene.js', import.meta.url), 'utf8');
    expect(src).toMatch(/keydown-H/);
  });

  it('puts BOTH co-op panels on the same readout', () => {
    const { scene, registry } = modeScene();
    scene._cycleReadout();
    registry.set('hudPlayers', [snap(0), snap(1)]);
    scene._syncPanels();
    expect(scene.panels.map((p) => p.mode)).toEqual(['none', 'none']);
  });

  it('every DRAWN mode still hands the console shell a header line and a block to frame', () => {
    const { scene } = modeScene();
    scene._cycleReadout();   // fused -> none
    scene._cycleReadout();   // none -> bars
    for (const mode of ['bars', 'paperdoll']) {
      expect(scene.panels[0].mode).toBe(mode);
      const b = scene.panels[0].bars;
      expect(b.headerY).toBeLessThan(b.top);
      expect(b.w).toBeGreaterThan(0);
      expect(scene.panels[0].header.y).toBe(b.headerY);
      scene._cycleReadout();
    }
  });

  it('the paper doll keeps per-location captions and needs no shield caption', () => {
    const { scene } = modeScene();
    scene._cycleReadout();   // fused -> none
    scene._cycleReadout();   // none -> bars
    scene._cycleReadout();   // bars -> paperdoll
    expect(scene.panels[0].mode).toBe('paperdoll');
    const p = scene.panels[0];
    expect(Object.keys(p.partLabels)).toHaveLength(4);
    expect(p.shieldLabel).toBeNull();          // the shield IS the outline around everything
    expect(p.bars.outline.w).toBeGreaterThan(p.bars.segments[0].w);
  });

  it('paints every mode against a real damaged mech without throwing', () => {
    const { scene } = modeScene();
    const mech = new Mech({ chassisId: 'medium' });
    mech.applyDamage('leftArm', 9999);
    for (let i = 0; i < 4; i++) {
      expect(() => scene._updateIntegrity(scene.panels[0], mech)).not.toThrow();
      scene._cycleReadout();
    }
  });

  // #448 playtest: ALL THREE paper-doll layers ride the ONE health ramp, each by its OWN fraction.
  // Structure fill was already ramped; this pins that the per-segment ARMOR outline and the
  // whole-doll SHIELD outline now colour through `structureColor` too — a low-armor outline reads
  // red, a healthy shield reads blue — rather than the old fixed steel/cyan.
  it('colours the paper-doll armor + shield outlines through the SAME structure ramp', () => {
    const { scene } = modeScene();
    scene._cycleReadout();   // fused -> none
    scene._cycleReadout();   // none -> bars
    scene._cycleReadout();   // bars -> paperdoll
    expect(scene.panels[0].mode).toBe('paperdoll');
    const armorFrac = 0.3, shieldFrac = 0.6;   // distinct so their ramp colours differ
    const mech = {
      parts: Object.fromEntries(
        INTEGRITY_ORDER.map((loc) => [loc, { hp: 10, maxHp: 10, armor: 3, maxArmor: 10 }]),
      ),
      isPartDestroyed: () => false,
      hasShield: () => true,
      shield: { hp: 6, max: 10 },
      shieldTotalHp: () => 6,
    };
    scene._paintDollReadout(scene.panels[0], mech);
    const runColors = (scene.panels[0].partBarsGfx.strokeRuns ?? []).map((r) => r.color);
    // the armor lit run for each live segment is stroked at its armor fraction's ramp colour...
    expect(runColors).toContain(structureColor(armorFrac));
    // ...and the shield outline at its own fraction's ramp colour — a different colour, same ramp.
    expect(runColors).toContain(structureColor(shieldFrac));
    expect(structureColor(armorFrac)).not.toBe(structureColor(shieldFrac));
  });

  // ── #448 follow-up: the NONE readout ───────────────────────────────────────────────────────
  // Jackson: "maybe we don't need an integrity readout if the on-mech display is good enough" —
  // so NONE has to hide it ENTIRELY and the console shell has to collapse rather than leave a hole.
  describe('the NONE readout', () => {
    // #495 (2nd playtest round): FUSED, not NONE, is now the DEFAULT — one cycle off a fresh HUD
    // lands on NONE (fused -> none is the first step of the cycle).
    const noneScene = () => {
      const built = modeScene();
      built.scene._cycleReadout();
      expect(built.scene.panels[0].mode).toBe('none');
      return built;
    };

    it('draws no bars, no captions, no shield caption and no header', () => {
      const { scene } = noneScene();
      const p = scene.panels[0];
      expect(p.bars.w).toBe(0);
      expect(p.bars.segments).toEqual([]);
      expect(Object.keys(p.partLabels)).toHaveLength(0);
      expect(p.shieldLabel).toBeNull();
      expect(p.header).toBeNull();
    });

    it('paints nothing at all against a live mech', () => {
      const { scene } = noneScene();
      const p = scene.panels[0];
      const mech = new Mech({ chassisId: 'medium' });
      mech.applyDamage('leftArm', 9999);
      expect(() => scene._updateIntegrity(p, mech)).not.toThrow();
      // Not one stroked run, filled polygon or circle — the mech's own display carries it alone.
      expect(p.partBarsGfx.strokedPoints ?? []).toHaveLength(0);
      expect(p.partBarsGfx.filledPoints ?? []).toHaveLength(0);
    });

    it('collapses the console band to exactly the tile row — no hole where the block was', () => {
      const { scene } = noneScene();
      const g = scene._band.groups[0];
      expect(g.blockW).toBe(0);
      expect(g.tilesX).toBe(scene._band.x + CONSOLE.padX);
      expect(scene._band.w).toBe(g.tilesW + CONSOLE.padX * 2);
      expect(scene._band.x + scene._band.w / 2).toBeCloseTo(scene.W / 2, 0);
    });

    it('takes its console ceiling from the weapon row, not a floating empty header line', () => {
      const { scene } = noneScene();
      const p = scene.panels[0];
      // `_paintConsole` takes the shell's ceiling as min(tileTop, bars.headerY). NONE reserves no
      // header caption (bars.headerY sits on the bare weapon row) — and #506's THIRD rework put
      // the weapon row itself physically highest, so tileTop and bars.headerY now land on the
      // exact same edge (unlike the second rework, where the ability row sat above the weapon row
      // and tileTop was strictly higher than bars.headerY).
      expect(p.tileTop).toBe(p.bars.headerY);
      const shell = consoleLayout(scene.H, Math.min(p.tileTop, p.bars.headerY), scene._band);
      expect(shell.y).toBe(p.tileTop - CONSOLE.padTop);
      // ...and it still runs all the way down to the bottom of the screen.
      expect(shell.y + shell.h).toBe(scene.H - CONSOLE.edgeGap);
    });

    // With no header to take over (bars/paperdoll reuse the header's line; FUSED — #495 — has no
    // separate block either but is pinned in its own describe block below), the downed line has
    // to have somewhere of its own to go — over that player's tile row.
    it('still says what a downed player is waiting on', () => {
      const { scene } = noneScene();
      const p = scene.panels[0];
      const downed = snap(0, { dead: true, respawn: { remainingMs: 4200, waitingOnCombat: false } });
      scene._updateTargetPod = () => {};   // the pod needs real textures; not what this pins
      scene._updatePanel(p, downed, 16);
      expect(p.statusText.visible).toBe(true);
      expect(p.statusText.text).toMatch(/RESPAWN/);
      expect(p.skillBar.alpha).toBe(0.3);
    });
  });

  // ── #495: the FUSED readout — armor/structure/shield painted directly onto the skill tiles ──
  describe('the FUSED readout', () => {
    // #495 (2nd playtest round): FUSED is now the DEFAULT — a fresh HUD is already in this state,
    // no cycling needed (this mirrors NONE's own `noneScene()` helper above, which now needs the
    // one cycle FUSED used to need before it took over the default slot).
    const fusedScene = () => {
      const built = modeScene();
      expect(built.scene.panels[0].mode).toBe('fused');
      return built;
    };

    it('has no separate block, no captions, no shield caption and no header — like NONE', () => {
      const { scene } = fusedScene();
      const p = scene.panels[0];
      expect(p.bars.w).toBe(0);
      expect(p.bars.segments).toEqual([]);
      expect(p.shieldLabel).toBeNull();
      expect(p.header).toBeNull();
    });

    // Unlike NONE, the console shell still has to leave room ABOVE the tile row — not for a
    // caption, but for the shield dome to arc into (`shieldArcLayout`).
    it("reserves headroom above the tile row for the shield dome, pulled up by FUSED_DOME_RISE", () => {
      const { scene } = fusedScene();
      const p = scene.panels[0];
      // #506: `bars.headerY`'s blank-mode fallback is always derived from the weapon row's own
      // top edge (`tiles[0].y`) regardless of which row `weaponAbilityRows` puts on top, so this
      // pins FUSED_DOME_RISE against that edge directly rather than tileTop.
      const rowTop = p.skillRefs.leftArm.rect.y;
      expect(rowTop - p.bars.headerY).toBe(FUSED_DOME_RISE);
    });

    it('builds its own paint layer, only for this mode, so it can draw ON TOP of the tiles', () => {
      const { scene } = fusedScene();
      expect(scene.panels[0].fusedGfx).toBeTruthy();
    });

    it('the downed line still has somewhere of its own — over that player\'s tile row', () => {
      const { scene } = fusedScene();
      const p = scene.panels[0];
      const downed = snap(0, { dead: true, respawn: { remainingMs: 4200, waitingOnCombat: false } });
      scene._updateTargetPod = () => {};
      scene._updatePanel(p, downed, 16);
      expect(p.statusText.visible).toBe(true);
      expect(p.statusText.text).toMatch(/RESPAWN/);
    });

    // #495 2nd playtest round (Jackson: "it should be beneath the ability square in z-order, not
    // a ring on the ability square"): the per-tile armor overlay moved OUT of `fusedGfx` (painted
    // on top of the tile) and into its own `armorBackGfx` layer (painted behind it, built BEFORE
    // the tile row — see `_makePanel`), run against a rect padded `ARMOR_PEEK_PAD` past the
    // tile's own edges rather than the tile's exact footprint. It is still a filled band anchored
    // to the (padded) BOTTOM edge whose height tracks the live armor fraction — top-to-bottom,
    // never sideways/around the frame — that part of the 1st round's fix is unchanged.
    it('drains the per-tile armor overlay from the top down, anchored to the bottom edge, BEHIND the tile', () => {
      const { scene } = fusedScene();
      const mech = new Mech({ chassisId: 'medium' });
      mech.applyDamage('leftArm', 20);   // dents the arm's armor without destroying it
      scene._updateIntegrity(scene.panels[0], mech);
      const rect = scene.panels[0].skillRefs.leftArm.rect;
      const part = mech.parts.leftArm;
      const armorFrac = part.armor / part.maxArmor;
      const peekH = rect.h + ARMOR_PEEK_PAD * 2;
      // Nothing armor-shaped should be painted on TOP of the tile any more.
      const frontRuns = scene.panels[0].fusedGfx.fillRuns ?? [];
      expect(frontRuns.find((r) => Math.abs(r.h - armorFrac * peekH) < 0.5)).toBeUndefined();
      const runs = scene.panels[0].armorBackGfx.fillRuns ?? [];
      const armorRun = runs.find((r) => Math.abs(r.h - armorFrac * peekH) < 0.5);
      expect(armorRun).toBeTruthy();
      // Bottom-pinned: the overlay's bottom edge sits on the PADDED rect's own bottom edge —
      // past the tile's own bottom by ARMOR_PEEK_PAD, so it peeks out from under the tile there.
      expect(armorRun.y + armorRun.h).toBeCloseTo(rect.y + rect.h + ARMOR_PEEK_PAD, 5);
      // ...and its TOP edge has receded DOWN below the padded rect's own top, since armor isn't full.
      expect(armorRun.y).toBeGreaterThan(rect.y - ARMOR_PEEK_PAD);
    });

    it('a full-armor tile is covered top-to-bottom — the backing reaches the padded rect\'s own top edge', () => {
      const { scene } = fusedScene();
      const mech = new Mech({ chassisId: 'medium' });   // undamaged: every location at full armor
      scene._updateIntegrity(scene.panels[0], mech);
      const rect = scene.panels[0].skillRefs.leftArm.rect;
      const peekH = rect.h + ARMOR_PEEK_PAD * 2;
      const runs = scene.panels[0].armorBackGfx.fillRuns ?? [];
      const armorRun = runs.find((r) => Math.abs(r.h - peekH) < 0.5);
      expect(armorRun).toBeTruthy();
      expect(armorRun.y).toBeCloseTo(rect.y - ARMOR_PEEK_PAD, 5);
    });

    it('destroying HudScene tears down the armor-peek layer along with the rest of the panel', () => {
      const { scene } = fusedScene();
      const bg = scene.panels[0].armorBackGfx;
      expect(bg).toBeTruthy();
      scene._destroyPanel(scene.panels[0]);
      expect(bg.destroyed).toBe(true);
    });

    // #495: armor now rides the target disc's own fixed armor tone rather than the structure
    // ramp — a deliberate playtest choice so it reads as a layer distinct from the HP wash, which
    // still rides the ramp. The shield dome is unaffected and still rides the ramp too.
    it('colours the shield dome through the structure ramp but NOT the armor overlay', () => {
      const { scene } = fusedScene();
      const armorFrac = 0.3, shieldFrac = 0.6;
      const mech = {
        parts: Object.fromEntries(
          INTEGRITY_ORDER.map((loc) => [loc, { hp: 10, maxHp: 10, armor: 3, maxArmor: 10 }]),
        ),
        isPartDestroyed: () => false,
        hasShield: () => true,
        shield: { hp: 6, max: 10 },
        shieldTotalHp: () => 6,
      };
      scene._paintFusedReadout(scene.panels[0], mech);
      const strokeColors = (scene.panels[0].fusedGfx.strokeRuns ?? []).map((r) => r.color);
      const fillColors = (scene.panels[0].fusedGfx.fillRuns ?? []).map((r) => r.color);
      expect(strokeColors).toContain(structureColor(shieldFrac));
      expect(fillColors).not.toContain(structureColor(armorFrac));
    });

    it('draws no shield dome at all for a build with no shield — its slot is simply absent', () => {
      const { scene } = fusedScene();
      const mech = {
        parts: Object.fromEntries(
          INTEGRITY_ORDER.map((loc) => [loc, { hp: 10, maxHp: 10, armor: 10, maxArmor: 10 }]),
        ),
        isPartDestroyed: () => false,
        hasShield: () => false,
      };
      expect(() => scene._paintFusedReadout(scene.panels[0], mech)).not.toThrow();
    });
  });

  it('the paper doll actually strokes a draining outline for a damaged part', () => {
    const { scene } = modeScene();
    scene._cycleReadout();   // fused -> none
    scene._cycleReadout();   // none -> bars
    scene._cycleReadout();   // bars -> paperdoll
    const mech = new Mech({ chassisId: 'medium' });
    scene._updateIntegrity(scene.panels[0], mech);
    expect(scene.panels[0].partBarsGfx.strokedPoints.length).toBeGreaterThan(1);
  });
});

// #506 SECOND rework (playtest, superseding the first rework's one-row-of-6): Jackson — "move x/y
// abilities in weapon HUD to double-wide half-height buttons (as compared to the weapon buttons)
// that sit in a single row above the 4 weapon buttons; so the X ability sits above the left sided
// weapons and the Y ability above the right sided weapons." Two rows: a row of the 4 normal-size
// weapon tiles (ui/skillTiles.js TILE_ORDER, unchanged), and a row of 2 ability tiles
// (HUD_ABILITY_ORDER — X then Y), each double-wide/half-height and aligned over its matching
// weapon pair. #506 THIRD rework (playtest experiment, Jackson: "let's try moving [the ability
// row] below the weapon buttons just to check out how that feels") swapped which row is on top —
// the ability row now sits BELOW the weapon row instead of above it; everything else about the
// two-row shape (sizing, span-matching) is unchanged. The passive core slot still gets no HUD
// tile at all during a deployment (it's Garage-only chrome — see GarageScene/SimulGarageScene,
// untouched).
describe('HudScene panels — the two-row ability/weapon block (#506 third rework)', () => {
  it('builds one tile for each of the 4 weapon slots and both ability slots — no core tile', () => {
    const { scene } = fakeScene([snap(0)]);
    scene._syncPanels();
    const refs = scene.panels[0].skillRefs;
    for (const loc of TILE_ORDER) expect(refs[loc]).toBeTruthy();
    for (const slot of ABILITY_SLOTS) expect(refs[slot]).toBeTruthy();
    expect(refs.core).toBeUndefined();
  });

  it('shows the empty "ability" placeholder label and the ability keyboard bind when unmounted', () => {
    const { scene } = fakeScene([snap(0)]);
    scene._syncPanels();
    const refs = scene.panels[0].skillRefs;
    expect(refs.abilityY.subtitle.text).toBe('ability');
    expect(refs.abilityY.bind.text).toBe('1');   // ABILITY_BINDS.abilityY.key
  });

  it('places X below the left weapon pair and Y below the right pair, double-wide/half-height, in their own row below the weapons', () => {
    const { scene } = fakeScene([snap(0)]);
    scene._syncPanels();
    const panel = scene.panels[0];
    expect(HUD_ABILITY_ORDER).toEqual(['abilityX', 'abilityY']);
    const leftArm = panel.skillRefs.leftArm.rect, leftTorso = panel.skillRefs.leftTorso.rect;
    const rightTorso = panel.skillRefs.rightTorso.rect, rightArm = panel.skillRefs.rightArm.rect;
    const x = panel.skillRefs.abilityX.rect, y = panel.skillRefs.abilityY.rect;
    // Same row, below both weapon rows entirely (#506 THIRD rework: swapped from above).
    expect(x.y).toBe(y.y);
    expect(x.y).toBeGreaterThan(leftArm.y);
    expect(x.y).toBe(leftArm.y + leftArm.h + 12);   // rowGap default
    // Half the weapon tile's height.
    expect(x.h).toBe(Math.round(leftArm.h / 2));
    expect(y.h).toBe(x.h);
    // X spans exactly the left pair's combined width; Y spans exactly the right pair's.
    expect(x.x).toBe(leftArm.x);
    expect(x.x + x.w).toBe(leftTorso.x + leftTorso.w);
    expect(y.x).toBe(rightTorso.x);
    expect(y.x + y.w).toBe(rightArm.x + rightArm.w);
  });

  it('folds the ability row into panel.tileTop/tileBox so the console bay recesses behind both rows', () => {
    const { scene } = fakeScene([snap(0)]);
    scene._syncPanels();
    const panel = scene.panels[0];
    // #506 THIRD rework: the weapon row is now physically highest, so it's the block's own top.
    expect(panel.tileTop).toBe(panel.skillRefs.leftArm.rect.y);
    expect(panel.tileTop).toBeLessThan(panel.skillRefs.abilityX.rect.y);
    expect(panel.tileBox.y).toBe(panel.tileTop);
    // The bay's height reaches all the way down to the bottom of the (now lower) ability row.
    const abilityBottom = panel.skillRefs.abilityX.rect.y + panel.skillRefs.abilityX.rect.h;
    expect(panel.tileBox.y + panel.tileBox.h).toBe(abilityBottom);
  });

  it('shows a mounted ability\'s live cooldown countdown, filling the bar as it recharges', () => {
    const mech = new Mech({ chassisId: 'medium', abilityMounts: { abilityY: 'dash' } });
    const snapshot = hudPlayerSnapshot({
      id: 0, color: PLAYER_COLORS[0], mech, dead: false, respawn: null,
      abilityStates: { abilityY: { active: false, burstRemaining: 0, cooldown: 2 } },
    });
    const { scene, registry } = fakeScene([snap(0)]);
    scene._syncPanels();
    registry.set('hudPlayers', [snapshot]);
    scene._updatePanel(scene.panels[0], snapshot);
    const ref = scene.panels[0].skillRefs.abilityY;
    expect(ref.subtitle.text).toBe('2.0s');
    expect(ref.bar.visible).toBe(true);
  });

  it('shows READY once cooldown clears and ACTIVE mid-burst', () => {
    const mech = new Mech({ chassisId: 'medium', abilityMounts: { abilityY: 'dash' } });
    const { scene } = fakeScene([snap(0)]);
    scene._syncPanels();

    const readySnap = hudPlayerSnapshot({
      id: 0, color: PLAYER_COLORS[0], mech, dead: false, respawn: null,
      abilityStates: { abilityY: { active: false, burstRemaining: 0, cooldown: 0 } },
    });
    scene._updatePanel(scene.panels[0], readySnap);
    expect(scene.panels[0].skillRefs.abilityY.subtitle.text).toBe('READY');

    const activeSnap = hudPlayerSnapshot({
      id: 0, color: PLAYER_COLORS[0], mech, dead: false, respawn: null,
      abilityStates: { abilityY: { active: true, burstRemaining: 0.1, cooldown: 4 } },
    });
    scene._updatePanel(scene.panels[0], activeSnap);
    expect(scene.panels[0].skillRefs.abilityY.subtitle.text).toBe('ACTIVE');
  });

  it('never builds a core tile in the arena HUD, even when a core item is mounted', () => {
    const mech = new Mech({ chassisId: 'medium', coreMounts: { core: 'shield' } });
    const snapshot = hudPlayerSnapshot({ id: 0, color: PLAYER_COLORS[0], mech, dead: false, respawn: null });
    const { scene } = fakeScene([snap(0)]);
    scene._syncPanels();
    scene._updatePanel(scene.panels[0], snapshot);
    expect(scene.panels[0].skillRefs.core).toBeUndefined();
  });
});
