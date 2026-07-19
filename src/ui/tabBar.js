// Shared top tab bar for the lab scenes (Mech Lab / Music), with a Deploy
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
// Controller (#70): attachPadTabCycle(scene, active) — call ONCE per scene create() (not per
// buildTabBar; the garage rebuilds its bar every refresh) — makes SELECT cycle to the next tab.

import { PadEdges, PAD } from '../input/Controls.js';
import { Audio } from '../audio/index.js';

const TAB_UI = {
  bar: 0x12161d, barEdge: 0x2a333f,
  tab: 0x1a212b, tabHover: 0x232c38, tabActive: 0x2c3744,
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', sel: '#efc14a', off: '#4a525c',
};

export const TAB_BAR_H = 52;   // logical px

// The tabs, in order. `scene` is the Phaser scene key each one navigates to.
// #296: the MUSIC tab (→ MusicScene, the global music/mix tuner) is a dev-only authoring tool —
// included only under `import.meta.env.DEV` (Vite's build-time flag, stripped/dead-code-eliminated
// in `npm run build`), so a production garage shows no MUSIC tab and MusicScene is unreachable via
// the UI. The scene itself stays registered (main.js) — there's just no tab/nav pointing at it.
// nextTabScene()/attachPadTabCycle() below both derive from TABS, so in production the single
// remaining tab makes SELECT a harmless no-op cycle back to the garage.
const TABS = [
  { key: 'MECH LAB', scene: 'GarageScene' },
  ...(import.meta.env.DEV ? [{ key: 'MUSIC', scene: 'MusicScene' }] : []),
];

// The scene key SELECT moves to from `active` (wrapping through TABS in order).
export function nextTabScene(active, dir = 1) {
  const i = TABS.findIndex((t) => t.scene === active);
  const n = TABS.length;
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
//
// #240: `onBossArena` (optional) adds a second pinned action to the LEFT of Deploy — the Boss
// Arena deploy target. It is only rendered when the caller passes a handler at all, so the
// bar is byte-identical for every scene that doesn't offer one; GarageScene owns the decision
// of when it's available (all five biomes cleared, or any dev build).
export function buildTabBar(scene, { active, onDeploy, canDeploy = true, onBossArena = null } = {}) {
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

  // Deploy, pinned right. Greyed + inert when the build is incomplete (canDeploy === false).
  const depW = 160;
  const dx = W - depW - 16;
  // #240: the Boss Arena action sits immediately left of Deploy, in its own alarm-red styling so
  // it never reads as "the normal way to start a run." Same canDeploy gate — you can't walk into
  // the boss fight with an incomplete build either.
  if (onBossArena) {
    const bw = 170, bx = dx - bw - 8;
    const bEnabled = canDeploy;
    const br = scene.add.rectangle(bx, y, bw, tabH, TAB_UI.tab).setOrigin(0, 0)
      .setStrokeStyle(1, bEnabled ? 0xe2533a : TAB_UI.barEdge);
    const bt = scene.add.text(bx + bw / 2, y + tabH / 2, '☠ BOSS ARENA', {
      fontFamily: 'monospace', fontSize: '14px', color: bEnabled ? '#e2533a' : TAB_UI.off,
    }).setOrigin(0.5);
    layer.add([br, bt]);
    if (bEnabled) {
      br.setInteractive({ useHandCursor: true });
      br.on('pointerover', () => br.setFillStyle(TAB_UI.tabHover));
      br.on('pointerout', () => br.setFillStyle(TAB_UI.tab));
      br.on('pointerdown', onBossArena);
    }
  }
  const enabled = canDeploy && !!onDeploy;
  const dr = scene.add.rectangle(dx, y, depW, tabH, TAB_UI.tab).setOrigin(0, 0)
    .setStrokeStyle(1, enabled ? TAB_UI.sel : TAB_UI.barEdge);
  const dt = scene.add.text(dx + depW / 2, y + tabH / 2, '▶ DEPLOY', {
    fontFamily: 'monospace', fontSize: '14px', color: enabled ? TAB_UI.sel : TAB_UI.off,
  }).setOrigin(0.5);
  layer.add([dr, dt]);
  if (enabled) {
    dr.setInteractive({ useHandCursor: true });
    dr.on('pointerover', () => dr.setFillStyle(TAB_UI.tabHover));
    dr.on('pointerout', () => dr.setFillStyle(TAB_UI.tab));
    dr.on('pointerdown', onDeploy);
  }

  return { height: TAB_BAR_H, layer };
}
