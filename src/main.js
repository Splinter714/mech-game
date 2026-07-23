import Phaser from 'phaser';
import BootScene from './scenes/BootScene.js';
import GarageScene from './scenes/GarageScene.js';
import ArenaScene from './scenes/ArenaScene.js';
import HudScene from './scenes/HudScene.js';

// `?canvas` forces Phaser's Canvas renderer. Headless browsers (the smoke test)
// often lack WebGL framebuffers, and the game logic we verify there is
// renderer-agnostic. No effect in production.
const forceCanvas = import.meta.env.DEV &&
  new URLSearchParams(window.location.search).has('canvas');

// HiDPI: render the canvas buffer at the device's PHYSICAL pixels so pixel-art is
// crisp on Retina screens, while keeping on-screen size and all game coordinates
// LOGICAL (CSS px) — each scene's camera zoom = DPR compensates. MAX_DPR caps the
// fill-rate cost (2 = full native quality on any iPad/Retina laptop). At DPR 1
// (standard monitors, headless smoke) this is a no-op.
const MAX_DPR = 2;
export const getDpr = () => Math.min(window.devicePixelRatio || 1, MAX_DPR);

const config = {
  type: forceCanvas ? Phaser.CANVAS : Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0d1014',
  // #455: this used to be `pixelArt: true`, which is a SHORTHAND — Phaser expands it to
  // `antialias:false, antialiasGL:false, roundPixels:TRUE` (core/Config.js) and ignores any
  // roundPixels you pass alongside it. The texture-filter half (nearest-neighbour, "don't blur
  // my art") is what this game wanted; the `roundPixels` half is what made the mech's parts
  // jostle whenever the torso turned.
  //
  // Why: with roundPixels on, the renderer does `gx = Math.floor(gameObject.x)` PER TEXTURED
  // GAME OBJECT (MultiPipeline.batchSprite), and for a CONTAINER CHILD that `x` is its LOCAL
  // offset. A mech view is six stacked sprites in a container: hull and turret-body sit at local
  // (0,0) and so never quantize, but the four pivoting parts (both arms, both side torsos) sit at
  // local offsets that sweep continuously as the turret rotates (partSpriteTransform's dx/dy).
  // Each of those four floors independently, crossing its integer boundary at a different turret
  // angle from the others — so a smooth slew made each arm/shoulder POP a whole world pixel
  // (~2-4 device px after DPR + gameplay zoom) against a body that hadn't moved. That is the
  // "components don't align, they jiggle when the torso turns" bug: quantization, not animation.
  //
  // So: keep the filtering, drop the snapping. Everything renders at its true sub-pixel position
  // now, which also retires the hex-seam jitter HEX_BLEED was added to paper over (hexArt.js).
  antialias: false,
  antialiasGL: false,
  roundPixels: false,
  scale: {
    mode: Phaser.Scale.NONE,
    width: window.innerWidth * getDpr(),
    height: window.innerHeight * getDpr(),
  },
  input: { gamepad: true },
  scene: [BootScene, GarageScene, ArenaScene, HudScene],
};

const game = new Phaser.Game(config);
game.registry.set('dpr', getDpr());

const gameEl = document.getElementById('game');
let lastW = 0, lastH = 0;

// Size the renderer to physical pixels while displaying at logical size. Re-run on
// every viewport change; the bogus-size guard stops a transient 0×0 from freezing.
function applySize() {
  const dpr = getDpr();
  const w = Math.round(gameEl?.clientWidth || window.innerWidth);
  const h = Math.round(gameEl?.clientHeight || window.innerHeight);
  if (w <= 0 || h <= 0) return;
  if (w === lastW && h === lastH && game.registry.get('dpr') === dpr) return;
  lastW = w; lastH = h;
  game.registry.set('dpr', dpr);
  game.scale.resize(w * dpr, h * dpr);
  const c = game.canvas;
  if (c) { c.style.width = w + 'px'; c.style.height = h + 'px'; }
  // #149: most scenes just neutralize DPR (zoom = dpr), but ArenaScene layers its own
  // `zoomFactor` (GAMEPLAY_ZOOM, arena/shared.js) on top to frame the world less "vast" — a
  // resize must re-derive `dpr * zoomFactor`, not stomp it back down to the bare dpr every
  // other scene uses.
  game.scene.scenes.forEach((s) => s.cameras?.main?.setZoom(dpr * (s.zoomFactor || 1)));
}

applySize();
game.events.once('ready', applySize);
window.addEventListener('resize', applySize);
window.addEventListener('orientationchange', () => setTimeout(applySize, 50));
window.visualViewport?.addEventListener('resize', applySize);
if (window.ResizeObserver && gameEl) new ResizeObserver(applySize).observe(gameEl);

if (import.meta.env.DEV) window.__game = game;

// #461: the ART PREVIEW gallery is a DEV-only authoring tool (reachable only from the DEV-gated
// ART tab in ui/tabBar.js). It's registered via a DEV-guarded DYNAMIC import rather than a static
// one at the top of this file, because a static import keeps the module in the production bundle
// even when the scene-list entry is dead-code-eliminated: Rollup treats `class X extends
// Phaser.Scene {}` as a side-effecting declaration and can't drop it. With the import inside the
// `import.meta.env.DEV` branch, Vite folds the whole branch away in a production build and the
// module is never emitted at all. Async is harmless — the scene only has to exist by the time
// someone clicks the tab, which is long after boot.
// #470: the AUDIO tab (music tuner + the whole SFX-authoring surface, which #470 moved out of
// GarageScene) is dev-only for exactly the same reason, and is registered exactly the same way —
// a DEV-guarded dynamic import, so neither the scene nor the WeaponSfxPanel/trigger-row code it
// pulls in is emitted into a production bundle at all.
if (import.meta.env.DEV) {
  import('./scenes/ArtPreviewScene.js')
    .then(({ default: ArtPreviewScene }) => game.scene.add('ArtPreviewScene', ArtPreviewScene));
  import('./scenes/AudioScene.js')
    .then(({ default: AudioScene }) => game.scene.add('AudioScene', AudioScene));
}
