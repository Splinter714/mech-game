import Phaser from 'phaser';
import BootScene from './scenes/BootScene.js';
import GarageScene from './scenes/GarageScene.js';
import ArenaScene from './scenes/ArenaScene.js';
import HudScene from './scenes/HudScene.js';
import MusicScene from './scenes/MusicScene.js';

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
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.NONE,
    width: window.innerWidth * getDpr(),
    height: window.innerHeight * getDpr(),
  },
  input: { gamepad: true },
  scene: [BootScene, GarageScene, ArenaScene, HudScene, MusicScene],
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
  game.scene.scenes.forEach((s) => s.cameras?.main?.setZoom(dpr));
}

applySize();
game.events.once('ready', applySize);
window.addEventListener('resize', applySize);
window.addEventListener('orientationchange', () => setTimeout(applySize, 50));
window.visualViewport?.addEventListener('resize', applySize);
if (window.ResizeObserver && gameEl) new ResizeObserver(applySize).observe(gameEl);

if (import.meta.env.DEV) window.__game = game;
