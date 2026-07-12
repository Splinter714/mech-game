import Phaser from 'phaser';
import { Slider } from './slider.js';
import { isAudible, applyPreviewMuting } from './previewMuting.js';
import { Audio } from '../audio/index.js';
import { TRAJECTORY_DELAY } from '../audio/sfxParams.js';
import {
  storeOverride, clearOverride, hasOverride, getOverrideMeta, getOverride,
  getTrimMs, setTrim, getStartMs, setStart,
} from '../audio/sfxOverrides.js';

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
const STAGES = [['fire', 'FIRE (trigger pull)'], ['trajectory', 'TRAJECTORY (in flight)'], ['impact', 'IMPACT (on landing)']];
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
    this._lastPreviewAt = { fire: 0, trajectory: 0, impact: 0 };
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

  // `label` optionally overrides the header text (used by the destruction-explosion category
  // row — "DEATHEXPLOSIONSMALL" reads badly, "Small (drone / infantry)" doesn't). Omit it for
  // a real weapon id, where the id itself IS the label (unchanged behavior).
  setWeapon(weaponId, label = null) {
    this.weaponId = weaponId;
    this.weaponLabel = label;
    this._scrollY = 0;
    this._mutedSet.clear();
    this._soloedSet.clear();
    this._build();
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

  // #150: the per-stage "real file override" row — shows what's loaded (if anything) and the
  // load/clear controls. `label` isn't a weapon-catalog concept, so this reads the same for a
  // real weapon or a destruction-explosion category (`setWeapon`'s `label` override already
  // handles the header text the same way).
  _buildOverrideRow(ox, y, w, stage) {
    const weaponId = this.weaponId;
    const active = hasOverride(weaponId, stage);
    const meta = active ? getOverrideMeta(weaponId, stage) : null;
    const status = active ? `file override: ${meta?.name || '(loaded)'}` : 'file override: none (procedural)';
    this.scroller.add(this.scene.add.text(ox + 6, y, status, {
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
      const buffer = getOverride(weaponId, stage);
      const fullSec = Math.max(buffer?.duration ?? 0, 0.01);
      const startMs = getStartMs(weaponId, stage);
      const trimMs = getTrimMs(weaponId, stage);
      const startSec = Phaser.Math.Clamp(startMs != null ? startMs / 1000 : 0, 0, fullSec);
      const endSec = Phaser.Math.Clamp(
        trimMs != null ? startSec + trimMs / 1000 : fullSec, startSec, fullSec,
      );
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
          setStart(weaponId, stage, startMsOut);
          setTrim(weaponId, stage, trimMsOut);
          this._toast(startMsOut == null ? `${stage}: starts at 0s` : `${stage}: starts at ${newStart.toFixed(2)}s`);
          this._previewThrottled(stage);
          this._build(); // end slider's min/value depends on the new start
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
          setTrim(weaponId, stage, ms);
          this._toast(ms == null ? `${stage}: plays to end` : `${stage}: ends at ${newEnd.toFixed(2)}s`);
          this._previewThrottled(stage);
        },
      });
      this.scroller.add(endSlider.container);
      this.sliders.push(endSlider);
      y += ROW_H + 8;
    }
    return y;
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
      const label = `${STAGE_ABBR[stage]}·${li + 1}`;
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
      // #150: this component's stage has a real-file override playing instead — its gain/
      // mute/solo controls don't touch anything audible any more.
      if (hasOverride(this.weaponId, stage)) {
        this._greyOut([slider.container, slider.hit, mute.rect, mute.text, solo.rect, solo.text]);
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
    for (const [stage] of STAGES) {
      const layers = params[stage];
      if (!layers) continue;
      layers.forEach((layer, li) => this._components.push({ stage, li, layer }));
    }
    this._gainSliders = {};
    y = this._buildMixerStrip(ox, y, w);

    for (const [stage, label] of STAGES) {
      const layers = params[stage];
      if (!layers || !layers.length) continue;
      const overridden = hasOverride(this.weaponId, stage);
      this.scroller.add(this.scene.add.text(ox, y, label, { fontFamily: 'monospace', fontSize: '11px', color: UI.text }));
      y += 18;
      // #150: the "load sound file / clear" control for this stage — always fully interactive
      // (never greyed), so it's the one thing here you can act on once a stage is overridden.
      y = this._buildOverrideRow(ox, y, w, stage);

      // Everything below (waveform/filter picker + field sliders) tunes the PROCEDURAL layers,
      // which don't sound any more once a real file is overriding this stage — grey it all out
      // rather than remove it (reset/copy still operate on the underlying data untouched).
      const detailStart = this.scroller.list.length;
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
      if (overridden) this._greyOut(this.scroller.list.slice(detailStart));
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
  _playStage(stage) {
    const restore = this._applyPreviewMuting([stage]);
    if (stage === 'fire') Audio.fire({ id: this.weaponId });
    else if (stage === 'trajectory') Audio.trajectory(this.weaponId);
    else Audio.impact(this.weaponId);
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

  _copy() {
    const params = Audio.getSfxParams(this.weaponId);
    const text = `  ${this.weaponId}: ${JSON.stringify(params, null, 2).replace(/\n/g, '\n  ')},`;
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
