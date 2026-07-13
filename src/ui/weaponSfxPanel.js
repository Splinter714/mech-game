import Phaser from 'phaser';
import { Slider } from './slider.js';
import { isAudible, isStageAudible, applyPreviewMuting } from './previewMuting.js';
import { Audio } from '../audio/index.js';
import { TRAJECTORY_DELAY } from '../audio/sfxParams.js';
import {
  storeOverride, clearOverride, hasOverride,
  setTrim, setStart, getProcessing, setProcessing, setFadeOut, setVolume, setLoopStartMs,
  seedOverrideFromBaked,
} from '../audio/sfxOverrides.js';
import { getOverrideRowState } from './sfxOverridePanelState.js';
import { WEAPON_STAGES } from './weaponSfxStages.js';
import { buildSfxCopyText } from './sfxCopyText.js';

// #107: the destruction-explosion size categories (deathExplosionSmall/Medium/Large/Massive)
// are tuned through this SAME panel — they're just more sfxParams ids (single `fire` stage,
// no trajectory/impact) fed in by GarageScene's category row via setWeapon(id, label). This
// prefix is how the panel tells "a category" from "a real weapon" apart for cosmetic tweaks
// only (the header label, the ▶ button's wording) — everything else (sliders/type-row/reset/
// copy) already works on any sfxParams id unchanged.
const EXPLOSION_ID_PREFIX = 'deathExplosion';

// #121: the sound-tuning panel, formerly the standalone Weapon Lab's right-hand column, now
// embedded directly in GarageScene's catalog region — a column of live sliders for whichever
// weapon is selected in the card list, one section per stage (fire / trajectory / impact), one
// row per tunable field of each stage's layers (see audio/sfxParams.js for the data shape).
// Dragging a slider writes straight to Audio.sfxParams and plays that stage back (throttled)
// so the change is audible immediately. Mirrors the Music tab's tuner (same Slider widget,
// same "copy settings" convention), scoped to one weapon at a time instead of one global mix.
const UI = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', good: '#7bd17b', btn: 0x1a212b, btnHover: 0x232c38, edge: 0x2a333f,
  mute: 0xe08a5e, muteText: '#1a0f08', solo: 0x7bd17b, soloText: '#0b1a0b',
};
const ROW_H = 18;
// #177: the weapon domain's own stage list — now just the DEFAULT `stages` passed to
// setTarget()/setWeapon() rather than a hardcoded assumption baked into the panel itself. Lives
// in its own Phaser-free module (weaponSfxStages.js, imported above) so tests can import it
// directly; re-exported here unchanged for existing callers. A non-weapon sound domain passes
// its own `stages` array of the same `[key, label]` shape instead (see src/audio/sfxDomains.js).
export { WEAPON_STAGES };
const PREVIEW_THROTTLE = 140;   // ms between live-preview replays while dragging a slider

// #131: short per-component labels for the top mixer strip ("fire·1", "traj·2", "impact·1") —
// abbreviated enough to fit next to a compact slider + Mute/Solo buttons.
const STAGE_ABBR = { fire: 'fire', trajectory: 'traj', impact: 'impact' };
const MIX_ROW_H = 22;

// Only numeric fields get a slider; `type`/`kind` (waveform/filter shape) stay fixed —
// hand-edit via "copy settings" if a layer needs a different shape.
const FIELD_SPEC = {
  freq: [20, 4000, 5], freqEnd: [20, 4000, 5], dur: [0.005, 1, 0.005],
  attack: [0, 0.05, 0.001], q: [0.1, 6, 0.05],
};
const FIELD_ORDER = ['freq', 'freqEnd', 'dur', 'attack', 'q'];
const FIELD_LABEL = { freq: 'freq', freqEnd: 'freq end', dur: 'dur', attack: 'attack', q: 'Q' };

// `type` picker options, by layer kind — a tone's oscillator waveform vs. a noise layer's
// filter shape (its BiquadFilterNode type). Distinct sets since they mean different things.
const TONE_TYPES = ['sine', 'triangle', 'sawtooth', 'square'];
const TONE_ABBR = { sine: 'sin', triangle: 'tri', sawtooth: 'saw', square: 'sqr' };
const NOISE_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch'];
const NOISE_ABBR = { lowpass: 'low', highpass: 'high', bandpass: 'band', notch: 'notch' };
const TYPE_ROW_H = 22;

// #172: playback-time processing (pitch/filter/reverb) for a file override. Neutral defaults are
// what the sliders sit at before anything's tuned — chosen so leaving them there stores nothing
// (getProcessing stays null / the field is cleared) and playback is a strict clean passthrough.
// Filter shapes match the procedural noise layers (lowpass/highpass/bandpass) for UI consistency,
// plus an 'off' that removes the filter node entirely.
const PROC_DEFAULT_FILTER_FREQ = 2000;   // Hz
const PROC_DEFAULT_FILTER_Q = 1;
const PROC_DEFAULT_REVERB_SIZE = 1.5;    // seconds of tail
const FILTER_TYPES = ['off', 'lowpass', 'highpass', 'bandpass'];
const FILTER_ABBR = { off: 'off', lowpass: 'low', highpass: 'high', bandpass: 'band' };

// #150: the dim alpha applied to a stage's mixer/detail controls once a real-file override is
// active for it (they're still there — reset/copy still touch the underlying layer data —
// just visually inert, since nothing procedural is actually sounding for that stage any more).
const OVERRIDDEN_ALPHA = 0.35;

// Copy `text` to the clipboard, resolving to whether it actually landed. The async
// Clipboard API only exists in secure contexts (HTTPS/localhost); on plain-HTTP LAN
// (how the game is reached on mobile) `navigator.clipboard` is undefined, so fall back
// to the legacy hidden-textarea + execCommand path. Never throws — always a boolean.
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // secure-context API present but rejected (e.g. permission denied) — try fallback
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export class WeaponSfxPanel {
  constructor(scene, { x, y, w, h }) {
    this.scene = scene;
    this.region = { x, y, w, h };
    this.weaponId = null;
    this.stages = WEAPON_STAGES;   // #177: overridden per-target by setTarget()/setWeapon()
    this._lastPreviewAt = {};
    // #131: transient (never persisted) DAW-style mute/solo for the live-preview only — keyed
    // by `${stage}:${li}`. Reset whenever the selected weapon/category changes (see setWeapon).
    this._mutedSet = new Set();
    this._soloedSet = new Set();
    this._components = [];   // flat [{stage, li, layer}] for the current weapon, rebuilt in _build()
    this._gainSliders = {};  // key -> top-mixer-strip gain Slider ref (#139: the only gain slider now)

    // #150: one shared hidden <input type="file"> reused across every "load sound file"
    // button (a file picker per weapon+stage would mean creating/destroying a DOM element on
    // every rebuild — this one just gets re-targeted via `_pendingLoad` right before `.click()`).
    // Bridging a native file input into Phaser: the button itself is a normal Phaser rectangle
    // (so it looks/behaves like every other panel button); its click programmatically clicks
    // this real hidden input, which is what actually opens the OS file picker.
    this._pendingLoad = null;   // { weaponId, stage } set immediately before the input is clicked
    this._fileInput = document.createElement('input');
    this._fileInput.type = 'file';
    this._fileInput.accept = 'audio/*';
    this._fileInput.style.position = 'fixed';
    this._fileInput.style.left = '-9999px';
    this._fileInput.style.top = '-9999px';
    document.body.appendChild(this._fileInput);
    this._onFileChosen = () => {
      const file = this._fileInput.files?.[0];
      const target = this._pendingLoad;
      this._pendingLoad = null;
      this._fileInput.value = '';   // so choosing the same file again still fires 'change'
      if (!file || !target) return;
      storeOverride(target.weaponId, target.stage, file).then((buffer) => {
        // The selected weapon/category may have changed while the OS picker was open —
        // only toast/rebuild if we're still looking at the same one.
        if (this.weaponId !== target.weaponId) return;
        this._toast(buffer ? `loaded ${file.name}` : `couldn't decode ${file.name}`);
        this._build();
      });
    };
    this._fileInput.addEventListener('change', this._onFileChosen);

    // Both containers stay at world (0,0) — the Slider widget caches absolute world
    // coordinates at construction time (it compares against pointer.worldX directly, not
    // through the container transform), so every child below must be built with the
    // region's x/y baked into its own position rather than relying on a positioned parent
    // container to shift it visually. Only `scroller`'s Y moves (for scroll), since Y never
    // feeds into a slider's value math, so vertical scroll doesn't have this problem.
    this.root = scene.add.container(0, 0);
    this.scroller = scene.add.container(0, 0);
    this.root.add(this.scroller);
    this.sliders = [];
    this._scrollY = 0;
    this._maxScroll = 0;

    this.maskG = scene.make.graphics();
    this._paintMask();
    this.scroller.setMask(this.maskG.createGeometryMask());

    this._onWheel = (p, _o, _dx, dy) => { if (this._inRegion(p)) this._setScroll(this._scrollY + dy); };
    scene.input.on('wheel', this._onWheel);

    this._build();
  }

  _paintMask() {
    const { x, y, w, h } = this.region;
    this.maskG.clear().fillStyle(0xffffff).fillRect(x, y, w, h);
  }

  _inRegion(p) {
    const dpr = this.scene.registry.get('dpr') || 1;
    const { x, y, w, h } = this.region;
    const lx = p.x / dpr, ly = p.y / dpr;
    return lx >= x && lx <= x + w && ly >= y && ly <= y + h;
  }

  _setScroll(y) {
    this._scrollY = Phaser.Math.Clamp(y, 0, this._maxScroll);
    this.scroller.y = -this._scrollY;
  }

  setRegion(x, y, w, h) {
    this.region = { x, y, w, h };
    this._paintMask();
    this._build();
  }

  // #177: the generalized entry point — point the panel at ANY `(id, stages)` target, not just
  // a weapon pulled from the weapons catalog. `stages` is the same `[[key, label], ...]` shape
  // WEAPON_STAGES already used internally; a non-weapon sound domain (src/audio/sfxDomains.js)
  // supplies its own list here (e.g. a single `['nav', 'NAV (menu navigation)']` stage) instead
  // of fire/trajectory/impact. `label` optionally overrides the header text (used by the
  // destruction-explosion category row — "DEATHEXPLOSIONSMALL" reads badly — and available to
  // any other domain); omit it to fall back to the id itself, upper-cased.
  setTarget(id, { label = null, stages = WEAPON_STAGES } = {}) {
    this.weaponId = id;
    this.weaponLabel = label;
    this.stages = stages;
    this._scrollY = 0;
    this._mutedSet.clear();
    this._soloedSet.clear();
    this._build();
  }

  // Thin backward-compat wrapper over setTarget() for the weapon/explosion-category call sites
  // — same signature and behavior as before #177, just always passing the weapon stage list.
  setWeapon(weaponId, label = null) {
    this.setTarget(weaponId, { label, stages: WEAPON_STAGES });
  }

  _button(x, y, w, h, label, onClick, { color = UI.text } = {}) {
    const rect = this.scene.add.rectangle(x, y, w, h, UI.btn).setOrigin(0, 0)
      .setStrokeStyle(1, UI.edge).setInteractive({ useHandCursor: true });
    const text = this.scene.add.text(x + w / 2, y + h / 2, label, { fontFamily: 'monospace', fontSize: '10px', color }).setOrigin(0.5);
    rect.on('pointerover', () => rect.setFillStyle(UI.btnHover));
    rect.on('pointerout', () => rect.setFillStyle(UI.btn));
    rect.on('pointerdown', onClick);
    this.scroller.add([rect, text]);
    return { rect, text };
  }

  // A small two-state toggle button (Mute/Solo in the mixer strip) — filled with `onColor`
  // when active, the normal button chrome otherwise. Unlike `_typeRow`'s in-place repaint,
  // this just triggers a full `_build()` on click (mute/solo toggles are infrequent, so the
  // rebuild cost is a non-issue, and it keeps this path simple).
  _toggleBtn(x, y, w, h, label, active, onColor, onTextColor, onClick) {
    const fill = active ? onColor : UI.btn;
    const rect = this.scene.add.rectangle(x, y, w, h, fill).setOrigin(0, 0)
      .setStrokeStyle(1, active ? onColor : UI.edge).setInteractive({ useHandCursor: true });
    const text = this.scene.add.text(x + w / 2, y + h / 2, label, {
      fontFamily: 'monospace', fontSize: '9px', color: active ? onTextColor : UI.text,
    }).setOrigin(0.5);
    rect.on('pointerover', () => { if (!active) rect.setFillStyle(UI.btnHover); });
    rect.on('pointerout', () => rect.setFillStyle(fill));
    rect.on('pointerdown', onClick);
    this.scroller.add([rect, text]);
    return { rect, text };
  }

  // #150: grey out + disable a control once its stage has a real-file override active — the
  // gain/mute/solo sliders and type-row buttons don't affect anything real any more (nothing
  // procedural is playing for that stage). `objs` is a flat list of Phaser game objects with
  // `setAlpha`; interactive ones (rectangles) also get their input disabled.
  _greyOut(objs) {
    for (const o of objs) {
      o.setAlpha?.(OVERRIDDEN_ALPHA);
      if (o.input) o.disableInteractive();
    }
  }

  // #186: the first edit to ANY override control for a stage that's only showing a shipped
  // bake's values (getOverrideRowState's `source === 'baked'`) must seed a real live override
  // FROM that bake before the edit itself can do anything — sfxOverrides.js's per-field setters
  // (setStart/setTrim/etc.) only take effect once a live override buffer actually exists to
  // attach them to (see sfxOverrides.js's `_persistParams`); with no override yet, playback keeps
  // reading the bake's own static recipe regardless of what the in-memory maps hold. Runs `fn`
  // immediately if a live override already exists (today's exact pre-#186 behavior, no seeding
  // needed); otherwise seeds one from the bake first (buffer + full recipe, so the fresh override
  // starts identical to what was already playing), THEN runs `fn` and rebuilds so the row flips
  // from "(baked)" to a live "file override: baked-…wav" — same as loading any other file by hand.
  _editOverride(weaponId, stage, fn) {
    if (hasOverride(weaponId, stage)) { fn(); return; }
    seedOverrideFromBaked(weaponId, stage).then((ok) => {
      if (this.weaponId !== weaponId || !ok) return;   // selection changed while this resolved, or no bake to seed from
      fn();
      this._build();
    });
  }

  // #150: the per-stage "real file override" row — shows what's loaded (if anything) and the
  // load/clear controls. `label` isn't a weapon-catalog concept, so this reads the same for a
  // real weapon or a destruction-explosion category (`setWeapon`'s `label` override already
  // handles the header text the same way).
  _buildOverrideRow(ox, y, w, stage) {
    const weaponId = this.weaponId;
    // #177: the display/edit state (active?, status text, trim window, fade cap, processing)
    // is computed by a Phaser-free helper shared with tests (sfxOverridePanelState.js) — this
    // method now just renders whatever it returns, so the SAME code the panel draws from is
    // what gets unit-tested against a synthetic non-weapon (id, stage) target.
    const state = getOverrideRowState(weaponId, stage);
    const { active } = state;
    this.scroller.add(this.scene.add.text(ox + 6, y, state.statusText, {
      fontFamily: 'monospace', fontSize: '9px', color: active ? UI.good : UI.dim,
    }));
    y += 13;
    const gap = 4;
    const bw = Math.floor((w - 12 - gap) / 2);
    this._button(ox + 6, y, bw, 20, 'load sound file…', () => {
      this._pendingLoad = { weaponId, stage };
      this._fileInput.click();
    });
    this._button(ox + 6 + bw + gap, y, bw, 20, 'clear override', () => {
      clearOverride(weaponId, stage).then(() => {
        if (this.weaponId !== weaponId) return;   // selection changed while this resolved
        this._toast(`${stage}: reverted to procedural`);   // #166: clearOverride also resets its start/trim
        this._build();
      });
    }, { color: active ? UI.good : UI.dim });
    y += 20 + 8;

    // #166: non-destructive start/end pair — only shown once this stage actually has a file
    // override loaded (mirrors the load/clear controls above and the #150 grey-out convention:
    // nothing trim-related exists for a purely-procedural stage). Shows the loaded file's real
    // full duration so the owner knows the range he's adjusting within, then two sliders: a
    // START point (how far into the buffer playback begins) and an END point (where it stops,
    // expressed as an absolute position for legibility — stored underneath as `trimMs`, a
    // DURATION from the start point, per the sfxOverrides.js contract). Dragging start to 0 or
    // end to the very end clears that side back to "full file" (undefined/null) rather than
    // storing a redundant exact-match value — same end state, cleaner data.
    if (active) {
      const { fullSec, startSec, endSec } = state;
      this.scroller.add(this.scene.add.text(ox + 6, y, `full length: ${fullSec.toFixed(2)}s`, {
        fontFamily: 'monospace', fontSize: '9px', color: UI.dim,
      }));
      y += 13;
      const startSlider = new Slider(this.scene, {
        x: ox + 6, y, w: w - 12, labelW: 40, valueW: 40, label: 'start', min: 0, max: fullSec, step: 0.01,
        value: startSec,
        onChange: (v) => {
          const newStart = Phaser.Math.Clamp(v, 0, fullSec);
          const newEnd = Math.max(endSec, newStart); // never let end sit behind the new start
          const startMsOut = newStart <= 0.005 ? null : Math.round(newStart * 1000);
          const trimMsOut = newEnd >= fullSec - 0.005 ? null : Math.round((newEnd - newStart) * 1000);
          this._editOverride(weaponId, stage, () => {
            setStart(weaponId, stage, startMsOut);
            setTrim(weaponId, stage, trimMsOut);
            this._toast(startMsOut == null ? `${stage}: starts at 0s` : `${stage}: starts at ${newStart.toFixed(2)}s`);
            this._previewThrottled(stage);
            this._build(); // end slider's min/value depends on the new start
          });
        },
      });
      this.scroller.add(startSlider.container);
      this.sliders.push(startSlider);
      y += ROW_H + 4;
      const endSlider = new Slider(this.scene, {
        x: ox + 6, y, w: w - 12, labelW: 40, valueW: 40, label: 'end', min: startSec, max: fullSec, step: 0.01,
        value: endSec,
        onChange: (v) => {
          const newEnd = Phaser.Math.Clamp(v, startSec, fullSec);
          const ms = newEnd >= fullSec - 0.005 ? null : Math.round((newEnd - startSec) * 1000);
          this._editOverride(weaponId, stage, () => {
            setTrim(weaponId, stage, ms);
            this._toast(ms == null ? `${stage}: plays to end` : `${stage}: ends at ${newEnd.toFixed(2)}s`);
            this._previewThrottled(stage);
          });
        },
      });
      this.scroller.add(endSlider.container);
      this.sliders.push(endSlider);
      y += ROW_H + 4;

      // #185: loop-start offset — HELD-LOOP-ONLY (beamLaser/flamethrower use the sustain path;
      // see HELD_WEAPONS in sfxParams.js), but simplest/least-cluttered to always show it here
      // next to the trim controls rather than branching UI per weapon — it's a harmless no-op
      // for one-shot stages (nothing ever reads it outside playBufferLoop). Lets the intro/attack
      // transient (start→end) play once, then loop just `loopStart→end` on every repeat instead
      // of re-looping the WHOLE trimmed window. Range is the played window (start..end); dragging
      // back to the start clears it (null = "loop start = start," today's pre-#185 behavior).
      const loopStartSlider = new Slider(this.scene, {
        x: ox + 6, y, w: w - 12, labelW: 64, valueW: 44, label: 'loop start', min: startSec, max: endSec, step: 0.01,
        value: state.loopStartSec,
        onChange: (v) => {
          const newLoopStart = Phaser.Math.Clamp(v, startSec, endSec);
          const startMsOut = newLoopStart <= startSec + 0.005 ? null : Math.round(newLoopStart * 1000);
          this._editOverride(weaponId, stage, () => {
            setLoopStartMs(weaponId, stage, startMsOut);
            this._toast(startMsOut == null ? `${stage}: loop start = start` : `${stage}: loop starts at ${newLoopStart.toFixed(2)}s`);
            this._previewThrottled(stage);
          });
        },
      });
      this.scroller.add(loopStartSlider.container);
      this.sliders.push(loopStartSlider);
      y += ROW_H + 4;

      // #174: fade-out duration — smooths the click/pop from an early-trimmed cutoff by ramping
      // the gain to silence over the last N ms before the end point. Same conditional pattern as
      // the start/end sliders (only shown once a file override is loaded). The range is capped at
      // the played window (end - start) so the fade can't exceed what actually plays; 0 = no fade
      // (the default hard cut). Stored as `fadeOutMs`; setFadeOut treats 0 as "clear."
      const { fadeMax, fadeMs } = state;
      const fadeSlider = new Slider(this.scene, {
        x: ox + 6, y, w: w - 12, labelW: 52, valueW: 44, label: 'fade-out', min: 0, max: fadeMax, step: 10,
        value: fadeMs,
        onChange: (v) => {
          const ms = Math.round(v);
          this._editOverride(weaponId, stage, () => {
            setFadeOut(weaponId, stage, ms <= 0 ? null : ms);
            this._toast(ms <= 0 ? `${stage}: no fade-out` : `${stage}: fade-out ${ms}ms`);
            this._previewThrottled(stage);
          });
        },
      });
      this.scroller.add(fadeSlider.container);
      this.sliders.push(fadeSlider);
      y += ROW_H + 4;

      // #182: overall volume — a plain linear gain multiplier on top of everything else in the
      // playback chain, same conditional pattern as the other override controls (only shown once
      // a file override is loaded). Range 0-200%; stored as a 0..2 linear multiplier via
      // setVolume (which itself clamps/treats 1.0 as "clear back to default").
      const volumePct = Math.round((state.volume ?? 1) * 100);
      const volumeSlider = new Slider(this.scene, {
        x: ox + 6, y, w: w - 12, labelW: 52, valueW: 44, label: 'volume', min: 0, max: 200, step: 5,
        value: volumePct,
        onChange: (v) => {
          const pct = Math.round(v);
          this._editOverride(weaponId, stage, () => {
            setVolume(weaponId, stage, pct / 100);
            this._toast(`${stage}: volume ${pct}%`);
            this._previewThrottled(stage);
          });
        },
      });
      this.scroller.add(volumeSlider.container);
      this.sliders.push(volumeSlider);
      y += ROW_H + 8;

      // #172: non-destructive playback processing (pitch / filter / reverb) — same conditional
      // pattern as the start/end sliders (only shown once a file override is loaded). Grouped
      // under one header, reusing the Slider widget; each control is a merge-patch into the
      // processing object, and returning them all to neutral restores a clean passthrough.
      y = this._buildProcessingControls(ox, y, w, stage);
    }
    return y;
  }

  // #172: the pitch/filter/reverb controls for a loaded override (called only from within
  // _buildOverrideRow's `active` branch). Reads the live processing object (null-safe) for its
  // starting values and writes changes back via setProcessing (async persist; the in-memory
  // update is synchronous so preview + copy see it immediately). Neutral positions store nothing.
  _buildProcessingControls(ox, y, w, stage) {
    const weaponId = this.weaponId;
    const proc = getProcessing(weaponId, stage) || {};
    this.scroller.add(this.scene.add.text(ox + 6, y, 'PROCESSING (pitch / filter / reverb)', {
      fontFamily: 'monospace', fontSize: '10px', color: UI.dim,
    }));
    y += 15;

    // ── Pitch/rate: detune in cents (pitch+speed coupled). 0 = clear (delete the field). ──
    const pitchSlider = new Slider(this.scene, {
      x: ox + 6, y, w: w - 12, labelW: 48, valueW: 44, label: 'pitch¢', min: -1200, max: 1200, step: 10,
      value: proc.detune ?? 0,
      onChange: (v) => {
        const cents = Math.round(v);
        this._editOverride(weaponId, stage, () => {
          setProcessing(weaponId, stage, { detune: cents === 0 ? null : cents });
          this._toast(cents === 0 ? `${stage}: pitch neutral` : `${stage}: pitch ${cents > 0 ? '+' : ''}${cents}¢`);
          this._previewThrottled(stage);
        });
      },
    });
    this.scroller.add(pitchSlider.container);
    this.sliders.push(pitchSlider);
    y += ROW_H + 4;

    // ── Filter: a shape picker (off / low / high / band) + frequency + Q. 'off' removes the
    // BiquadFilter node entirely; picking a shape seeds freq/Q defaults if none are set yet. ──
    this.scroller.add(this.scene.add.text(ox + 6, y, 'filter', { fontFamily: 'monospace', fontSize: '9px', color: UI.dim }));
    y += 12;
    this._filterTypeRow(ox + 6, y, w - 12, weaponId, stage);
    y += TYPE_ROW_H;
    const freqSlider = new Slider(this.scene, {
      x: ox + 6, y, w: w - 12, labelW: 48, valueW: 44, label: 'freq', min: 40, max: 16000, step: 20,
      value: proc.filterFreq ?? PROC_DEFAULT_FILTER_FREQ,
      onChange: (v) => {
        this._editOverride(weaponId, stage, () => {
          setProcessing(weaponId, stage, { filterFreq: Math.round(v) });
          this._previewThrottled(stage);
        });
      },
    });
    this.scroller.add(freqSlider.container);
    this.sliders.push(freqSlider);
    y += ROW_H + 4;
    const qSlider = new Slider(this.scene, {
      x: ox + 6, y, w: w - 12, labelW: 48, valueW: 44, label: 'Q', min: 0.1, max: 12, step: 0.1,
      value: proc.filterQ ?? PROC_DEFAULT_FILTER_Q,
      onChange: (v) => {
        this._editOverride(weaponId, stage, () => {
          setProcessing(weaponId, stage, { filterQ: +v.toFixed(2) });
          this._previewThrottled(stage);
        });
      },
    });
    this.scroller.add(qSlider.container);
    this.sliders.push(qSlider);
    y += ROW_H + 6;

    // ── Reverb: wet/dry mix (0 = off, removes the reverb nodes) + tail size in seconds. ──
    this.scroller.add(this.scene.add.text(ox + 6, y, 'reverb', { fontFamily: 'monospace', fontSize: '9px', color: UI.dim }));
    y += 12;
    const mixSlider = new Slider(this.scene, {
      x: ox + 6, y, w: w - 12, labelW: 48, valueW: 44, label: 'mix', min: 0, max: 1, step: 0.01,
      value: proc.reverbMix ?? 0,
      onChange: (v) => {
        const mix = +v.toFixed(2);
        this._editOverride(weaponId, stage, () => {
          if (mix <= 0.005) {
            setProcessing(weaponId, stage, { reverbMix: null, reverbSize: null });
            this._toast(`${stage}: reverb off`);
          } else {
            const size = getProcessing(weaponId, stage)?.reverbSize ?? PROC_DEFAULT_REVERB_SIZE;
            setProcessing(weaponId, stage, { reverbMix: mix, reverbSize: size });
          }
          this._previewThrottled(stage);
        });
      },
    });
    this.scroller.add(mixSlider.container);
    this.sliders.push(mixSlider);
    y += ROW_H + 4;
    const sizeSlider = new Slider(this.scene, {
      x: ox + 6, y, w: w - 12, labelW: 48, valueW: 44, label: 'size s', min: 0.1, max: 3, step: 0.1,
      value: proc.reverbSize ?? PROC_DEFAULT_REVERB_SIZE,
      onChange: (v) => {
        this._editOverride(weaponId, stage, () => {
          // Only re-store size when reverb is actually on — a size change with mix 0 stays inert
          // (and mustn't resurrect a cleared reverb), so just remember it for when mix comes up.
          if ((getProcessing(weaponId, stage)?.reverbMix ?? 0) > 0) {
            setProcessing(weaponId, stage, { reverbSize: +v.toFixed(1) });
            this._previewThrottled(stage);
          }
        });
      },
    });
    this.scroller.add(sizeSlider.container);
    this.sliders.push(sizeSlider);
    y += ROW_H + 8;
    return y;
  }

  // #172: the filter-shape picker row (off / low / high / band) for the processing chain.
  // Repaints in place (like _typeRow) so tuning other sliders isn't disturbed. 'off' clears the
  // filter field (no node inserted); any shape sets the type and seeds freq/Q defaults if unset.
  _filterTypeRow(x, y, w, weaponId, stage) {
    const gap = 3;
    const bw = Math.floor((w - (FILTER_TYPES.length - 1) * gap) / FILTER_TYPES.length);
    const btns = [];
    const current = () => getProcessing(weaponId, stage)?.filterType ?? 'off';
    const paint = () => btns.forEach(({ rect, ft }) => {
      const on = current() === ft;
      rect.setFillStyle(on ? 0x1b2430 : UI.btn).setStrokeStyle(1, on ? UI.accent : UI.edge);
    });
    FILTER_TYPES.forEach((ft, i) => {
      const bx = x + i * (bw + gap);
      const rect = this.scene.add.rectangle(bx, y, bw, 16, UI.btn).setOrigin(0, 0)
        .setStrokeStyle(1, UI.edge).setInteractive({ useHandCursor: true });
      const text = this.scene.add.text(bx + bw / 2, y + 8, FILTER_ABBR[ft], { fontFamily: 'monospace', fontSize: '8px', color: UI.text }).setOrigin(0.5);
      rect.on('pointerdown', () => {
        this._editOverride(weaponId, stage, () => {
          if (ft === 'off') {
            setProcessing(weaponId, stage, { filterType: null });
          } else {
            const p = getProcessing(weaponId, stage) || {};
            setProcessing(weaponId, stage, {
              filterType: ft,
              filterFreq: p.filterFreq ?? PROC_DEFAULT_FILTER_FREQ,
              filterQ: p.filterQ ?? PROC_DEFAULT_FILTER_Q,
            });
          }
          paint();
          this._previewThrottled(stage);
        });
      });
      this.scroller.add([rect, text]);
      btns.push({ rect, ft });
    });
    paint();
  }

  // #171: toggling mute/solo must be *immediately audible*, or it reads as "the button does
  // nothing" — the whole point is a live A/B against the mix. Unlike the gain sliders (whose
  // onChange auto-previews via _previewThrottled), the old toggles only rebuilt the strip and
  // played nothing, so the change wasn't heard until the next manual test-fire. Replay the
  // toggled component's own stage right after the rebuild, with the NEW mute/solo state applied
  // (via _playStage → _applyPreviewMuting), so you hear the layer drop in/out on click. `key`
  // is `${stage}:${li}`; preview just that stage. (Overridden stages disable these buttons, so
  // a toggle here never lands on a file-buffer stage — see _buildMixerStrip's _greyOut.)
  _toggleMute(key) {
    this._mutedSet.has(key) ? this._mutedSet.delete(key) : this._mutedSet.add(key);
    this._build();
    this._playStage(key.split(':')[0]);
  }

  _toggleSolo(key) {
    this._soloedSet.has(key) ? this._soloedSet.delete(key) : this._soloedSet.add(key);
    this._build();
    this._playStage(key.split(':')[0]);
  }

  // Whether a component should actually sound in the live preview right now (soloing anything
  // silences every non-soloed component; otherwise it's just "not muted"). Pure logic lives in
  // previewMuting.js so it's unit-testable without a scene; this is the bound convenience.
  _isAudible(key) {
    return isAudible(key, this._mutedSet, this._soloedSet);
  }

  // Transiently zero the inaudible components' real `gain` around a single preview cue, returning
  // the restore closure — see previewMuting.applyPreviewMuting for the timing/invariant contract
  // (mutates the same live layer objects the cue reads; stored params never see the muted 0).
  _applyPreviewMuting(stages) {
    return applyPreviewMuting(this._components, stages, this._mutedSet, this._soloedSet);
  }

  // #171 (re-fix): whether `stage` should play at all right now — see previewMuting.isStageAudible.
  // Needed because gain-zeroing (_applyPreviewMuting) only ever affects PROCEDURAL layers, but a
  // stage with a live override or a shipped bake bypasses those layers entirely (sfx.js's
  // playOverride/playOverrideLoop). Muting/soloing that stage out has to skip the Audio.* call
  // outright to have any audible effect at all.
  _isStageAudible(stage) {
    return isStageAudible(stage, this._components, this._mutedSet, this._soloedSet);
  }

  // The compact DAW-mixer strip at the top of the panel (#131) — one row per component
  // (stage + layer) with a compact gain slider (the ONLY gain slider — #139 removed the
  // redundant per-section one further down), plus Mute/Solo. Built from `this._components`,
  // computed by `_build()`.
  _buildMixerStrip(ox, y, w) {
    if (!this._components.length) return y;
    this.scroller.add(this.scene.add.text(ox, y, 'MIXER (gain / mute / solo)', { fontFamily: 'monospace', fontSize: '10px', color: UI.dim }));
    y += 16;
    const gap = 4, muteW = 28, soloW = 28;
    const sliderW = w - muteW - soloW - gap * 2;
    for (const { stage, li, layer } of this._components) {
      const key = `${stage}:${li}`;
      const label = `${STAGE_ABBR[stage] ?? stage.slice(0, 5)}·${li + 1}`;
      const slider = new Slider(this.scene, {
        x: ox, y, w: sliderW, labelW: 42, valueW: 30, label, min: 0, max: 1, step: 0.01,
        value: layer.gain ?? 0,
        onChange: (v) => {
          Audio.setSfxParam(this.weaponId, stage, li, 'gain', v);
          this._previewThrottled(stage);
        },
      });
      this.scroller.add(slider.container);
      this.sliders.push(slider);
      this._gainSliders[key] = slider;

      const mx = ox + sliderW + gap;
      const mute = this._toggleBtn(mx, y - 3, muteW, MIX_ROW_H - 4, 'M', this._mutedSet.has(key), UI.mute, UI.muteText, () => this._toggleMute(key));
      const solo = this._toggleBtn(mx + muteW + gap, y - 3, soloW, MIX_ROW_H - 4, 'S', this._soloedSet.has(key), UI.solo, UI.soloText, () => this._toggleSolo(key));
      // #150/#171: this component's stage has a real-file override playing instead of its
      // procedural layer — the GAIN slider is dead weight (Audio.setSfxParam only ever touches
      // the procedural layer, which nothing reads while an override is active), so it stays
      // greyed out. Mute/Solo are different: _playStage now skips the Audio.* call outright for
      // a fully-inaudible stage (see isStageAudible), so they genuinely silence an overridden
      // stage's preview too — leave them fully interactive.
      if (hasOverride(this.weaponId, stage)) {
        this._greyOut([slider.container, slider.hit]);
      }
      y += MIX_ROW_H;
    }
    return y + 8;
  }

  // A row of small buttons picking `layer.type` — a tone's waveform or a noise layer's
  // filter shape, whichever `layer.kind` calls for. Repaints in place (no full rebuild) so
  // dragging sliders elsewhere in the panel isn't disturbed by a waveform change.
  _typeRow(x, y, w, layer, weaponId, stage, li) {
    const isNoise = layer.kind === 'noise';
    const types = isNoise ? NOISE_TYPES : TONE_TYPES;
    const abbr = isNoise ? NOISE_ABBR : TONE_ABBR;
    const gap = 3;
    const bw = Math.floor((w - (types.length - 1) * gap) / types.length);
    const btns = [];
    const paint = () => btns.forEach(({ rect, tw }) => {
      const on = layer.type === tw;
      rect.setFillStyle(on ? 0x1b2430 : UI.btn).setStrokeStyle(1, on ? UI.accent : UI.edge);
    });
    types.forEach((tw, i) => {
      const bx = x + i * (bw + gap);
      const rect = this.scene.add.rectangle(bx, y, bw, 16, UI.btn).setOrigin(0, 0)
        .setStrokeStyle(1, UI.edge).setInteractive({ useHandCursor: true });
      const text = this.scene.add.text(bx + bw / 2, y + 8, abbr[tw], { fontFamily: 'monospace', fontSize: '8px', color: UI.text }).setOrigin(0.5);
      rect.on('pointerdown', () => {
        Audio.setSfxParam(weaponId, stage, li, 'type', tw);   // mutates the same layer object
        paint();
        this._previewThrottled(stage);
      });
      this.scroller.add([rect, text]);
      btns.push({ rect, tw });
    });
    paint();
  }

  _build() {
    for (const s of this.sliders) s.destroy();
    this.sliders = [];
    this.scroller.removeAll(true);
    const { x: ox, y: oy, w } = this.region;   // origin to bake into every child below

    if (!this.weaponId) {
      this.scroller.add(this.scene.add.text(ox, oy, 'Select a weapon\nto tune its sound.', {
        fontFamily: 'monospace', fontSize: '12px', color: UI.dim, lineSpacing: 6,
      }));
      this._maxScroll = 0;
      return;
    }

    const isExplosion = this.weaponId.startsWith(EXPLOSION_ID_PREFIX);
    let y = oy;
    this.scroller.add(this.scene.add.text(ox, y, this.weaponLabel ?? this.weaponId.toUpperCase(), { fontFamily: 'monospace', fontSize: '13px', color: UI.accent }));
    y += 4;
    const bw = Math.floor((w - 8) / 3);
    this._button(ox, y + 18, bw, 22, isExplosion ? '▶ test boom' : '▶ test fire', () => this._testFire(), { color: UI.good });
    this._button(ox + bw + 4, y + 18, bw, 22, 'reset', () => this._reset());
    this._button(ox + (bw + 4) * 2, y + 18, bw, 22, 'copy', () => this._copy(), { color: UI.good });
    y += 50;

    const params = Audio.getSfxParams(this.weaponId);

    // #131: flatten every stage's layers into one list up front so the mixer strip can render
    // all of them before the detailed per-stage sections below (which still use `params`
    // directly, unchanged). `_gainSliders` is rebuilt alongside so stale refs from a previous
    // weapon/rebuild never leak into the new sync wiring.
    this._components = [];
    for (const [stage] of this.stages) {
      const layers = params[stage];
      if (!layers) continue;
      layers.forEach((layer, li) => this._components.push({ stage, li, layer }));
    }
    this._gainSliders = {};
    y = this._buildMixerStrip(ox, y, w);

    // #177: iterate the panel's own `stages` list (weapon fire/trajectory/impact by default,
    // whatever a non-weapon target supplied via setTarget otherwise) rather than the module
    // constant. The file-override row (load/clear/trim/fade/processing) no longer requires
    // procedural `layers` to exist for the stage — a sound domain with no procedural synthesis
    // data at all (e.g. a placeholder UI stage) still gets a working override row; only the
    // waveform/field-slider detail block below it is procedural-layer-dependent.
    for (const [stage, label] of this.stages) {
      const layers = params[stage];
      this.scroller.add(this.scene.add.text(ox, y, label, { fontFamily: 'monospace', fontSize: '11px', color: UI.text }));
      y += 18;
      // #150: the "load sound file / clear" control for this stage — always fully interactive
      // (never greyed), so it's the one thing here you can act on once a stage is overridden.
      y = this._buildOverrideRow(ox, y, w, stage);
      if (!layers || !layers.length) { y += 6; continue; }

      // #181: hide the procedural layer-editing controls once EITHER a file override or a
      // baked sound is active for this stage — a real file is what's actually playing, so the
      // original procedural synthesis sliders are dead weight. `proceduralControlsVisible` is
      // computed by the same pure state helper the override row above renders from (it checks
      // both hasOverride AND hasBaked, unlike the old override-only check this replaces).
      const proceduralVisible = getOverrideRowState(this.weaponId, stage).proceduralControlsVisible;
      if (!proceduralVisible) { y += 6; continue; }
      // Everything below (waveform/filter picker + field sliders) tunes the PROCEDURAL layers
      // used to author the ORIGINAL synthesis def — reset/copy still operate on that underlying
      // data untouched even while it's hidden here.
      layers.forEach((layer, li) => {
        this.scroller.add(this.scene.add.text(ox + 6, y, `layer ${li + 1} · ${layer.kind ?? 'tone'}`, {
          fontFamily: 'monospace', fontSize: '9px', color: UI.dim,
        }));
        y += 14;
        this._typeRow(ox + 6, y, w - 16, layer, this.weaponId, stage, li);
        y += TYPE_ROW_H;
        for (const field of FIELD_ORDER) {
          if (!(field in layer)) continue;
          const [min, max, step] = FIELD_SPEC[field];
          const s = new Slider(this.scene, {
            x: ox + 10, y, w: w - 10, labelW: 56, valueW: 44, label: FIELD_LABEL[field], min, max, step,
            value: layer[field],
            onChange: (v) => {
              Audio.setSfxParam(this.weaponId, stage, li, field, v);
              this._previewThrottled(stage);
            },
          });
          this.scroller.add(s.container);
          this.sliders.push(s);
          y += ROW_H;
        }
        y += 8;
      });
      y += 6;
    }
    this._maxScroll = Math.max(0, y - oy - this.region.h + 12);
    this._setScroll(this._scrollY);
  }

  // Play ONE stage's live preview with the current mute/solo state applied. The mute window is
  // opened and closed synchronously around the single Audio call: _applyPreviewMuting zeros the
  // inaudible layers' `gain` in place, the cue reads those gains at schedule time (playLayers →
  // tone/noise bake gain then), and the restore closure puts the real values back immediately —
  // so the STORED params are never left mutated (copy/reset/persist always see the true gains).
  // The three weapon-domain stage names have a dedicated Audio.* playback entry point
  // (Audio.fire/trajectory/impact are weapon-shaped calls, not generic-by-id); any other
  // stage (e.g. a non-weapon domain's 'play') routes through #178's generic Audio.ui(id,
  // stage) instead, which resolves the SAME override/bake-then-procedural precedence keyed
  // by whatever id/stage this panel is currently targeting (see src/audio/sfxDomains.js).
  _playStage(stage) {
    // #171 (re-fix): a stage muted-out entirely (or silenced by a solo elsewhere) must not play
    // AT ALL — gain-zeroing below only reaches procedural layers, which a live override or baked
    // sound for this stage bypasses completely (see isStageAudible's doc comment).
    if (!this._isStageAudible(stage)) return;
    const restore = this._applyPreviewMuting([stage]);
    if (stage === 'fire') Audio.fire({ id: this.weaponId });
    else if (stage === 'trajectory') Audio.trajectory(this.weaponId);
    else if (stage === 'impact') Audio.impact(this.weaponId);
    else Audio.ui(this.weaponId, stage);
    restore();
  }

  _previewThrottled(stage) {
    const t = this.scene.time.now;
    if (t - this._lastPreviewAt[stage] < PREVIEW_THROTTLE) return;
    this._lastPreviewAt[stage] = t;
    this._playStage(stage);
  }

  // Fires the full sequence in context (fire -> trajectory -> impact), like a real shot. Each
  // stage's mute override is applied/restored right around its own (possibly delayed) call —
  // not all up front — since a stage's mute/solo state could only change via a full _build()
  // rebuild anyway, but this keeps the override window as tight as possible per stage.
  _testFire() {
    this._playStage('fire');
    this.scene.time.delayedCall(TRAJECTORY_DELAY, () => this._playStage('trajectory'));
    this.scene.time.delayedCall(300, () => this._playStage('impact'));
  }

  _reset() {
    Audio.resetSfxParams(this.weaponId);
    this._build();
    this._toast('reset to defaults');
  }

  // #170: per-stage-aware copy. Any stage with an active file override (#150/#166) emits a
  // labeled FILE block (weapon/category id + stage + verbatim filename + start/end trim in ms)
  // instead of that stage's procedural JSON — a payload the owner pastes to Claude to bake the
  // real trimmed file into the repo. Stages still procedural keep emitting their synthesis JSON,
  // and a weapon with no overrides copies exactly as before (see sfxCopyText.js). Dual-output
  // (clipboard + console) and the copied/failed toast are unchanged.
  // #183: pass this.stages through — the target's REAL registered stage list (weapon
  // fire/trajectory/impact by default, or whatever setTarget supplied for a non-weapon domain
  // like a single-stage #178 UI cue) — so the export can't fabricate stages that don't exist.
  _copy() {
    const params = Audio.getSfxParams(this.weaponId);
    const text = buildSfxCopyText(this.weaponId, params, this.stages);
    console.log(`[SFX TUNER] ${this.weaponId}:\n` + text);
    copyToClipboard(text).then((ok) => {
      this._toast(ok ? 'copied! (also in console)' : 'copy failed — see console');
    });
  }

  _toast(msg) {
    this._toastText?.destroy();
    const { x, y, w, h } = this.region;
    this._toastText = this.scene.add.text(x + w / 2, y + h - 16, msg, {
      fontFamily: 'monospace', fontSize: '11px', color: UI.good, backgroundColor: '#161b22', padding: { x: 6, y: 3 },
    }).setOrigin(0.5).setScrollFactor(0);
    this.root.add(this._toastText);
    this.scene.tweens.add({ targets: this._toastText, alpha: 0, delay: 1200, duration: 400, onComplete: () => this._toastText?.destroy() });
  }

  destroy() {
    this.scene.input.off('wheel', this._onWheel);
    for (const s of this.sliders) s.destroy();
    this.root.destroy();
    this.maskG.destroy();
    this._fileInput.removeEventListener('change', this._onFileChosen);
    this._fileInput.remove();
  }
}
