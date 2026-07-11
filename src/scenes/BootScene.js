import Phaser from 'phaser';
import { buildBaseTextures } from '../art/index.js';
import { ROSTER_SPECIES, loadRunCurrency } from '../data/save.js';
import { RUN_CURRENCY_KEY } from '../data/events.js';
import { Audio } from '../audio/index.js';
import { startGamepadAudioUnlock } from '../audio/gamepadUnlock.js';

// Boot: load the saved garage into the registry, build world/UI textures, then open
// the garage. Roster load is registry-driven (data/rosters.js) so adding a saved-build
// slot needs no edit here.
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  create() {
    for (const { registryKey, load } of ROSTER_SPECIES) {
      this.registry.set(registryKey, load());
    }
    // #64: the banked run-currency total (meta-progression pool) persists across page loads.
    this.registry.set(RUN_CURRENCY_KEY, loadRunCurrency());
    buildBaseTextures(this);
    // Procedural audio: adopt Phaser's WebAudio context. The soundtrack starts OFF — the
    // player turns it on with the music panel's play/pause (or it stays silent).
    Audio.init(this.sound.context);
    // Dev-only handle so `__audio.latencyReport()` works from the console, and
    // `__sfxDebug = true` turns on per-shot timing logs. (Not `window.Audio` — that's the
    // browser's built-in HTMLAudioElement constructor.)
    if (import.meta.env.DEV) window.__audio = Audio;
    // #85: silently keep trying to resume the AudioContext off of gamepad activity — covers
    // the controller-only unlock gap (Phaser's own sound manager already unlocks on
    // keyboard/mouse). No UI: if the browser blocks it, sound just stays off.
    startGamepadAudioUnlock();
    // `?lab` boots straight into the weapon art preview (dev tool).
    const lab = new URLSearchParams(window.location.search).has('lab');
    this.scene.start(lab ? 'WeaponLabScene' : 'GarageScene');
  }
}
