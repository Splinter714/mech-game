import Phaser from 'phaser';
import BootScene from './scenes/BootScene.js';
import BaseScene from './scenes/BaseScene.js';
import GarageScene from './scenes/GarageScene.js';
import MissionSelectScene from './scenes/MissionSelectScene.js';
import ArenaScene from './scenes/ArenaScene.js';
import HudScene from './scenes/HudScene.js';
import PauseMenuScene from './scenes/PauseMenuScene.js';

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
  // (0,0) and so never quantize, but the four pivoting parts (both arms, both shoulders) sit at
  // local offsets that sweep continuously as the turret rotates (partSpriteTransform's dx/dy).
  // Each of those four floors independently, crossing its integer boundary at a different turret
  // angle from the others — so a smooth slew made each arm/shoulder POP a whole world pixel
  // (~2-4 device px after DPR + gameplay zoom) against a body that hadn't moved. That is the
  // "components don't align, they jiggle when the torso turns" bug: quantization, not animation.
  //
  // So: keep the filtering, drop the snapping. Everything renders at its true sub-pixel position
  // now, which also retires the hex-seam jitter HEX_BLEED was added to paper over (hexArt.js).
  //
  // #455 SECOND PASS — this setting alone did NOT fix it, because a per-CAMERA override undid it.
  // `Camera.startFollow(target, roundPixels, …)` assigns its second argument straight onto the
  // camera, and the arena passed `true` (arena/coop.js `_initCoop`) — turning the flooring back on
  // for the only camera that renders mechs, a few lines after this config turned it off. Setting
  // `roundPixels` here is therefore necessary but not sufficient: any `startFollow` must pass
  // false too. See arena/mechPartSnap.test.js, which measures the cost and guards that call site.
  // #455 kept `antialias: false` (nearest-neighbour texture filtering) on the "don't blur my art"
  // reasoning inherited from `pixelArt: true`. Live-chat ask (2026-07-31) revisits that, and the
  // arithmetic says nearest is the wrong filter for THIS art:
  //   • A mech part bakes at DESIGN(64) × ART_SCALE(4) = a 256px texture, and draws at
  //     ARENA_MECH_SCALE(0.34) under a camera zoom of dpr × GAMEPLAY_ZOOM(1.3). So it lands on
  //     ~113 device px at DPR 1 and ~226 at DPR 2 — i.e. the art is always MINIFIED, by up to
  //     ~2.3×. Nearest-neighbour minification throws away whichever texels it doesn't land on.
  //   • The parts also ROTATE continuously (turret slew, per-part convergence tilt), so which
  //     texels get dropped changes every frame. That is what reads as crawling/shimmering edges.
  //   • And this is not hand-authored pixel art whose exact texels are the artwork — it is smooth
  //     procedural geometry deliberately super-sampled 4× so it could be filtered down. Nearest
  //     was discarding the very samples ART_SCALE exists to produce.
  // `antialiasGL` stays false: that flag is MSAA on the WebGL context, which antialiases GEOMETRY
  // edges. Everything here is textured quads, so it would cost fill rate and change nothing.
  // If edges still shimmer under motion, the next lever is mipmapping (`mipmapFilter`) — bilinear
  // alone samples only 4 texels, which is a partial fix at >2× minification. Mech parts are 256px
  // (power-of-two, so eligible); other textures would need checking first.
  antialias: true,
  antialiasGL: false,
  roundPixels: false,
  scale: {
    mode: Phaser.Scale.NONE,
    width: window.innerWidth * getDpr(),
    height: window.innerHeight * getDpr(),
  },
  input: { gamepad: true },
  // #505: GarageScene absorbed the simultaneous-co-op-garage build (formerly a separate
  // SimulGarageScene) as its own single layout — there is no second garage scene to register.
  // #523: PauseMenuScene is last so it renders/receives input on top of every other scene it
  // might be launched over (Phaser draws later-registered scenes above earlier ones).
  scene: [
    BootScene, BaseScene, GarageScene, MissionSelectScene, ArenaScene, HudScene,
    PauseMenuScene,
  ],
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

// Live-chat ask (2026-07-31): "can we get the app to respond better to window resizing? right now
// it's janky." FOUR sources below can each fire for the SAME visual change — `resize`,
// `visualViewport`'s own resize, and a ResizeObserver on the container all report a window drag —
// and every one of them called `applySize` synchronously. The no-op guard inside it stops the
// duplicates that arrive at an unchanged size, but during an actual drag the size really is
// different each time, so a single dragged frame could run `game.scale.resize()` two or three
// times over. That call reallocates the WebGL drawing buffer at FULL DPR (on a Retina display,
// several megapixels), which is far and away the most expensive thing here — doing it repeatedly
// within one frame is the jank.
//
// So every source now just marks the size dirty and the real work runs ONCE per animation frame.
// That both collapses the duplicates and aligns the reallocation with paint instead of landing
// mid-frame. `applySize`'s own early-out still short-circuits a tick where nothing actually moved,
// so a settled window costs one cancelled rAF and nothing else.
let sizeRaf = 0;
function requestApplySize() {
  if (sizeRaf) return;
  sizeRaf = requestAnimationFrame(() => { sizeRaf = 0; applySize(); });
}

applySize();
game.events.once('ready', applySize);
window.addEventListener('resize', requestApplySize);
// orientationchange still needs its own delay: the viewport metrics are briefly STALE right after
// the event, so coalescing into the next frame would sample the pre-rotation size.
window.addEventListener('orientationchange', () => setTimeout(applySize, 50));
window.visualViewport?.addEventListener('resize', requestApplySize);
if (window.ResizeObserver && gameEl) new ResizeObserver(requestApplySize).observe(gameEl);

if (import.meta.env.DEV) window.__game = game;

// #545: the dev-only art dissect overlay (globalThis.__dissect, driven from ArtPreviewScene
// gallery clicks) — a dynamic import for the same reason the ART/AUDIO tabs below are dynamic:
// keeps the module (and its DOM/event plumbing) out of the production bundle entirely rather
// than merely unused at runtime. Mirrors the horse game's identical main.js hook exactly.
if (import.meta.env.DEV) {
  import('./dev/dissectOverlay.js').then((m) => m.setupDissectOverlay());
}

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
