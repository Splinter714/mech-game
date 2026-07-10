import Phaser from 'phaser';
import { Audio } from '../audio/index.js';

// #85: browsers require a real user-gesture DOM event (click/keydown/touchstart) to resume
// a suspended WebAudio AudioContext — this is a platform autoplay policy, not something our
// audio code controls. Phaser's own sound manager already covers keyboard/mouse players (it
// installs body-level 'mousedown'/'touchstart'/'keydown' listeners — see
// node_modules/phaser/src/sound/webaudio/WebAudioSoundManager.js#unlock), so THIS scene changes
// nothing for them. The gap is controller-only players: the Gamepad API is poll-only (no
// native "button pressed" event), and per Chrome's own autoplay docs the trusted-gesture event
// allowlist (click/keydown/pointerup/touchend/...) does not include anything gamepad-related —
// so a poll-detected button press can't reliably unlock audio no matter where in the frame loop
// it's called from.
//
// Fix: a tiny, non-blocking banner that (a) tells a controller-only player they need one real
// key/click/tap to switch sound on, and (b) still makes a best-effort resume() attempt off of
// gamepad activity (button poll + the native 'gamepadconnected' event, which DOES fire as a
// direct consequence of the player pressing a button on a previously-inactive pad) in case a
// given browser is more lenient than the documented policy. Runs in parallel with
// Garage/Arena — never delays or gates scene transitions, so kbm play (and the smoke test,
// which drives scenes programmatically and never touches this scene) is unaffected.
export default class AudioUnlockScene extends Phaser.Scene {
  constructor() {
    super('AudioUnlockScene');
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);

    this.bg = this.add.rectangle(this.W / 2, this.H - 28, this.W, 44, 0x0d1014, 0.78).setOrigin(0.5);
    this.label = this.add.text(this.W / 2, this.H - 28,
      'SOUND IS OFF — press any key, click, or a controller button to enable audio',
      { fontFamily: 'monospace', fontSize: '13px', color: '#efc14a' }).setOrigin(0.5);

    // Best-effort resume attempts: a real trusted gesture (pointerdown/keydown) always works —
    // Phaser's own listener already resumes the context before ours even runs, so these two are
    // just redundant/no-op safety nets, not the actual fix.
    this.input.on('pointerdown', () => this._resume());
    this.input.keyboard?.on('keydown', () => this._resume());

    // The actual new path: attempt resume() off gamepad activity. Won't satisfy Chrome's
    // documented trusted-gesture allowlist (gamepad isn't in it), but costs nothing to try, and
    // some browsers/future Chromium versions may be more permissive.
    this._onGamepadConnected = () => this._resume();
    window.addEventListener('gamepadconnected', this._onGamepadConnected);
    this.events.once('shutdown', () => window.removeEventListener('gamepadconnected', this._onGamepadConnected));
  }

  update() {
    const pad = this.input.gamepad?.total ? this.input.gamepad.getPad(0) : null;
    if (pad && pad.connected) {
      const btnDown = pad.buttons.some((b) => b && b.pressed);
      const stickMoved = (pad.leftStick?.length() > 0.25) || (pad.rightStick?.length() > 0.25);
      if (btnDown || stickMoved) this._resume();
    }
    const unlocked = !Audio.ctx || Audio.ctx.state === 'running';
    this.bg.setVisible(!unlocked);
    this.label.setVisible(!unlocked);
  }

  _resume() {
    if (Audio.ctx && Audio.ctx.state === 'suspended') Audio.ctx.resume().catch(() => {});
  }
}
