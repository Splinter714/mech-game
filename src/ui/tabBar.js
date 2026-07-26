// Shared top tab bar for the lab scenes (Mech Lab / Audio / Art), with a Deploy
// action pinned to the right. One source of truth so every lab screen gets an identical
// header and navigation reads the same everywhere. Each tab just starts its scene; the
// active tab is highlighted and inert.
//
// #121: the Weapon Lab tab is retired — its catalog + sound-tuning panel now live inside
// GarageScene's own catalog region, so there's no separate scene to navigate to.
//
// Usage (from a scene's create()):
//   buildTabBar(this, { active: 'GarageScene', onDeploy: () => this.deploy(), canDeploy });
// Returns { height } so the caller can lay content out below it.
//
// #445: `actions` adds extra in-row buttons after the tabs — same chrome/size/gap/vertical
// alignment as a tab, but they run a callback instead of starting a scene. They flow in the
// row's own layout rather than being positioned on top of the bar.
//
// Controller (#70): attachPadTabCycle(scene, active) — call ONCE per scene create() (not per
// buildTabBar; the garage rebuilds its bar every refresh) — makes SELECT cycle to the next tab.
// #523: no longer called anywhere — SELECT is now claimed globally by the shared pause menu
// (scenes/PauseMenuScene.js `wirePauseMenu`) in every scene that used this, including the three
// lab scenes. Left intact/retrievable rather than deleted, same as this codebase's other
// superseded-but-kept controls (e.g. Controls.js's TOUCH_STICKS_ENABLED).
//
// #529: TABS is now EMPTY. The three entries that used to live here are gone for good reason,
// not just temporarily hidden:
//   - 'MECH LAB' (→ GarageScene) — replaced by the Mech Lab's own in-column 5-tab system
//     (chassis/weapon/ability/passive/color — see ui/labTabs.js), which isn't a scene-navigation
//     concept at all.
//   - 'AUDIO' (→ AudioScene) and 'ART' (→ ArtPreviewScene) — dev-only authoring tools, moved to
//     the shared pause menu (scenes/PauseMenuScene.js) instead, reachable from any scene via ESC/
//     SELECT rather than only from the three lab scenes' shared header.
// So this bar is now just the Deploy/Ready button (+ any `actions`) — kept as a real (empty) list
// rather than deleted outright since nextTabScene/attachPadTabCycle still read it, and a future
// scene-navigation tab is a one-line add here if one is ever needed again.
import { PadEdges, PAD } from '../input/Controls.js';
import { Audio } from '../audio/index.js';

const TAB_UI = {
  bar: 0x12161d, barEdge: 0x2a333f,
  tab: 0x1a212b, tabHover: 0x232c38, tabActive: 0x2c3744,
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', sel: '#efc14a', off: '#4a525c',
  // #529: the deploy/ready button's own READY visual (see `deployReady` below) — distinct from
  // the plain "click to ready up" accent/sel colours.
  goodBg: 0x1c3a24, good: '#7bd17b',
};

export const TAB_BAR_H = 52;   // logical px

// #505 (fifth rework): exported so a caller (GarageScene's SCRAP readout) can position its own
// chrome relative to the pinned Deploy/Ready button without duplicating its magic numbers.
export const DEPLOY_W = 160;
export const DEPLOY_MARGIN = 16;

// The tabs, in order. `scene` is the Phaser scene key each one navigates to.
// #529: see the file header — every entry that used to live here moved elsewhere (the Mech Lab's
// own 5-tab system, or the shared pause menu). nextTabScene()/attachPadTabCycle() below both
// derive from TABS, so with it empty SELECT/nextTabScene are harmless no-ops.
const TABS = [];

// The scene key SELECT moves to from `active` (wrapping through TABS in order). #529: TABS is
// now empty (see above) — stays a harmless no-op (returns `active` unchanged) rather than a
// division-by-zero/undefined crash if this dead-but-kept path is ever exercised.
export function nextTabScene(active, dir = 1) {
  const n = TABS.length;
  if (n === 0) return active;
  const i = TABS.findIndex((t) => t.scene === active);
  return TABS[((i + dir) % n + n) % n].scene;
}

// Make the gamepad SELECT button cycle the tabs. Polls its own PadEdges on the scene's
// update event (so it works in scenes without an update() method) and detaches on shutdown.
export function attachPadTabCycle(scene, active) {
  const edges = new PadEdges(scene);
  const onUpdate = () => {
    if (edges.pressed(PAD.SELECT)) { Audio.ui('menuNav'); scene.scene.start(nextTabScene(active)); }
  };
  scene.events.on('update', onUpdate);
  scene.events.once('shutdown', () => scene.events.off('update', onUpdate));
}

// Draw the bar across the top of `scene`. `active` is the current scene key. `onDeploy` is
// called when Deploy is clicked; `canDeploy` greys it out + makes it inert when false.
// `deployLabel` (#349) lets the caller relabel the pinned action without adding a second
// button: in co-op the Garage's Deploy becomes "▶ P1 READY" while player 1 is building, which
// IS the handoff step. Keeping it on the existing button is deliberate — the garage is already
// tight at narrow widths (#330/#342) and a new primary control would make that worse.
// `deployReady` (#529): the button now visually reflects a READY state, not just its label text
// — the Garage's per-column ready checkmark icon was removed, and this pinned button (which
// already doubled as the ready toggle for the keyboard/mouse player) is the one place that state
// shows now. Paints the button in the same good/green used elsewhere for "ready"/"ON" rather
// than the plain accent/sel "click to act" colour; `false` (the default) keeps the old look.
export function buildTabBar(scene, {
  active, onDeploy, canDeploy = true, deployLabel = '▶ DEPLOY', deployReady = false, actions = [],
} = {}) {
  const dpr = scene.registry.get('dpr') || 1;
  const W = Math.round(scene.scale.width / dpr);
  const layer = scene.add.container(0, 0).setDepth(50);

  layer.add(scene.add.rectangle(0, 0, W, TAB_BAR_H, TAB_UI.bar).setOrigin(0, 0)
    .setStrokeStyle(1, TAB_UI.barEdge));

  const tabW = 150, tabH = 34, gap = 8, y = (TAB_BAR_H - tabH) / 2;
  let x = 16;
  for (const tab of TABS) {
    const isActive = tab.scene === active;
    const r = scene.add.rectangle(x, y, tabW, tabH, isActive ? TAB_UI.tabActive : TAB_UI.tab)
      .setOrigin(0, 0).setStrokeStyle(isActive ? 2 : 1, isActive ? TAB_UI.accent : TAB_UI.barEdge);
    const t = scene.add.text(x + tabW / 2, y + tabH / 2, tab.key, {
      fontFamily: 'monospace', fontSize: '14px', color: isActive ? TAB_UI.accent : TAB_UI.text,
    }).setOrigin(0.5);
    layer.add([r, t]);
    if (!isActive) {
      r.setInteractive({ useHandCursor: true });
      r.on('pointerover', () => r.setFillStyle(TAB_UI.tabHover));
      r.on('pointerout', () => r.setFillStyle(TAB_UI.tab));
      r.on('pointerdown', () => { Audio.ui('menuNav'); scene.scene.start(tab.scene); });
    }
    x += tabW + gap;
  }

  // #445: the caller's extra actions, continuing the same left-to-right flow the tabs use — same
  // rect size, same y, same gap — so they read as another item in the row. Chrome matches an
  // INACTIVE tab (they never own the bar's "you are here" highlight).
  for (const action of actions) {
    const r = scene.add.rectangle(x, y, tabW, tabH, TAB_UI.tab).setOrigin(0, 0)
      .setStrokeStyle(1, TAB_UI.barEdge).setInteractive({ useHandCursor: true });
    const t = scene.add.text(x + tabW / 2, y + tabH / 2, action.key, {
      fontFamily: 'monospace', fontSize: '14px', color: TAB_UI.text,
    }).setOrigin(0.5);
    layer.add([r, t]);
    r.on('pointerover', () => r.setFillStyle(TAB_UI.tabHover));
    r.on('pointerout', () => r.setFillStyle(TAB_UI.tab));
    r.on('pointerdown', () => { Audio.ui('menuNav'); action.onClick?.(); });
    x += tabW + gap;
  }

  // Deploy, pinned right. Greyed + inert when the build is incomplete (canDeploy === false).
  // #529: when READY (`deployReady`), it paints in the good/green "ON" colour instead of the
  // plain accent/sel — a visual state, not just the label text swap this already did.
  const depW = DEPLOY_W;
  const dx = W - depW - DEPLOY_MARGIN;
  const enabled = canDeploy && !!onDeploy;
  const ready = enabled && deployReady;
  const dr = scene.add.rectangle(dx, y, depW, tabH, ready ? TAB_UI.goodBg : TAB_UI.tab).setOrigin(0, 0)
    .setStrokeStyle(1, !enabled ? TAB_UI.barEdge : ready ? TAB_UI.good : TAB_UI.sel);
  const dt = scene.add.text(dx + depW / 2, y + tabH / 2, deployLabel, {
    fontFamily: 'monospace', fontSize: '14px', color: !enabled ? TAB_UI.off : ready ? TAB_UI.good : TAB_UI.sel,
  }).setOrigin(0.5);
  layer.add([dr, dt]);
  if (enabled) {
    dr.setInteractive({ useHandCursor: true });
    dr.on('pointerover', () => dr.setFillStyle(TAB_UI.tabHover));
    dr.on('pointerout', () => dr.setFillStyle(ready ? TAB_UI.goodBg : TAB_UI.tab));
    dr.on('pointerdown', onDeploy);
  }

  return { height: TAB_BAR_H, layer };
}
