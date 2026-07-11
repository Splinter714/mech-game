// #85 (rework): browsers require a real user-gesture DOM event (click/keydown/touchstart) to
// resume a suspended WebAudio AudioContext — this is a platform autoplay policy, not something
// our audio code controls. Phaser's own sound manager already covers keyboard/mouse players (it
// installs body-level 'mousedown'/'touchstart'/'keydown' listeners — see
// node_modules/phaser/src/sound/webaudio/WebAudioSoundManager.js#unlock), so this module changes
// nothing for them. The gap is controller-only players: the Gamepad API is poll-only (no native
// "button pressed" event), and per Chrome's own autoplay docs the trusted-gesture event allowlist
// (click/keydown/pointerup/touchend/...) does not include anything gamepad-related — so a
// poll-detected button press can't reliably unlock audio no matter where in the frame loop it's
// called from.
//
// Original #85 shipped a visible "SOUND IS OFF" banner alongside this poll. The owner played it
// and said the banner was unwanted — decision was to drop ALL UI and keep only the silent
// best-effort resume attempt: if the browser blocks it, sound just stays off with no on-screen
// indication. This module is a plain, non-visual helper (no Phaser Scene, no DOM) hooked into the
// boot flow once — it makes a best-effort resume() call off of gamepad activity (button/stick
// poll + the native 'gamepadconnected' event, which DOES fire as a direct consequence of the
// player pressing a button on a previously-inactive pad) in case a given browser is more lenient
// than the documented policy.
import { Audio } from './index.js';

let started = false;

function tryResume() {
  if (Audio.ctx && Audio.ctx.state === 'suspended') Audio.ctx.resume().catch(() => {});
}

function poll() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const pad of pads) {
    if (!pad || !pad.connected) continue;
    const btnDown = pad.buttons.some((b) => b && b.pressed);
    const stickMoved = pad.axes.some((a) => Math.abs(a) > 0.25);
    if (btnDown || stickMoved) { tryResume(); break; }
  }
  requestAnimationFrame(poll);
}

// Idempotent: safe to call more than once (e.g. re-entering Boot), only wires up once.
export function startGamepadAudioUnlock() {
  if (started) return;
  started = true;
  window.addEventListener('gamepadconnected', tryResume);
  requestAnimationFrame(poll);
}
