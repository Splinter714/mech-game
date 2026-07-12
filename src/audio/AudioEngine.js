// Procedural audio — every sound is SYNTHESIZED from oscillators + filtered noise with
// envelopes, mirroring the art ethos: ZERO asset files (no .wav/.mp3). One singleton
// engine drives a small bus graph (master → sfx / music) on top of Phaser's WebAudio
// context, so it inherits Phaser's autoplay-unlock handling. Everything no-ops safely
// until the context exists and is running (e.g. before the first user gesture, or in the
// headless smoke run), so callers never need to guard.
//
//   SFX (#32 firing · #33 impacts · #34 footfalls · #35 abilities · #36 explosions)
//   Music (#38): a looping metal arrangement (guitar + bass + leads + drums) on a lookahead clock.

import * as Sfx from './sfx.js';
import {
  distortionCurve, hardClipCurve, foldbackCurve, softClipCurve, degHz,
  TRACKS, TRACK_IDS, DEFAULT_TRACK,
} from './music.js';
import { DEFAULT_SFX, FALLBACK_SFX, loadSfxParams, saveSfxParams } from './sfxParams.js';
import { duckGainAt, DUCK_DEFAULTS } from './duck.js';
import { setAudioContext as setOverrideAudioContext } from './sfxOverrides.js';
import { setAudioContext as setBakedAudioContext } from './bakedSfx.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.music = null;
    this.muted = false;
    this._noiseBuf = null;
    this._musicOn = false;
    this._musicTimer = null;
    this._step = 0;
    this._nextStepTime = 0;
    this._lastStepSound = 0;   // throttles rapid footfalls
    this.track = DEFAULT_TRACK;   // active soundtrack id (a key of TRACKS)
    this._trackDef = TRACKS[DEFAULT_TRACK];
    // DAW-style mixer audibility (separate from the level params, so soloing/muting a track
    // silences it WITHOUT touching its slider value): a per-track 0/1 multiplier from these
    // two sets. Track ids: kick, snare, hat, crash, guitar, lead, lead2, bass.
    this.muteSet = new Set();
    this.soloSet = new Set();
    // Live-tunable music parameters (driven by the in-game audio panel; see setParam).
    // These are the defaults baked into the build — the panel's "copy settings" prints a
    // params object you can paste back here.
    this.params = {
      // master + drums
      master: 1, music: 0.6, tempo: 120,
      drumLevel: 2, kickLevel: 1.37, snareLevel: 1.42, hatLevel: 0.88,
      // per-drum SOUND shaping
      kickPitch: 115, kickDecay: 0.2, kickClick: 0.095,
      snareTone: 1000, snareSnap: 1200, snareDecay: 0.3,
      hatFreq: 7500, hatDecay: 0.32,
      crashLevel: 0.93, crashBright: 4000, crashDecay: 1,
      // rhythm-guitar TONE (the distortion pedal + cab)
      guitarLevel: 0.62, guitarDrive: 40, guitarSat: 600, guitarClip: 1, guitarFold: 0,
      guitarTone: 9000, guitarLowCut: 40,
      // rhythm-guitar VOICING (which overtones make up each power chord)
      guitarFifth: 0.65, guitarFifthDetune: 0, guitarOctave: 1.1, guitarHigh: 0, guitarSquare: 0,
      chugLength: 0.08,
      // LEAD 1 + LEAD 2 — two melodic leads, each with a full guitar-style chain + overtones
      leadLevel: 0.25, leadDrive: 40, leadSat: 600, leadClip: 1, leadFold: 0, leadLowCut: 400, leadTone: 7000,
      leadFifth: 0, leadOct: 1, leadSub: 0, leadPitch: 1, leadLength: 1.3,
      lead2Level: 0.5, lead2Drive: 40, lead2Sat: 600, lead2Clip: 1, lead2Fold: 0, lead2LowCut: 40, lead2Tone: 9000,
      lead2Fifth: 0, lead2Oct: 1.35, lead2Sub: 0, lead2Pitch: 0.25, lead2Length: 1.35,
      // bass / low foundation (+ its own overtones)
      bassLevel: 0.7, bassDrive: 12, bassGrit: 200, bassTone: 2500,
      bassSub: 0.3, bassFifth: 0, bassOctave: 0, bassLength: 0.12,
      // base oscillator waveform per instrument: 'sine' | 'triangle' | 'sawtooth' | 'square'
      guitarWave: 'sawtooth', bassWave: 'sawtooth', leadWave: 'sawtooth', lead2Wave: 'sine',
      // Combat music ducking (#108) — see duck.js for the envelope shape these drive.
      duckDepth: DUCK_DEFAULTS.depth, duckAttack: DUCK_DEFAULTS.attack,
      duckHold: DUCK_DEFAULTS.hold, duckRelease: DUCK_DEFAULTS.release,
    };
    this._fx = {};             // live node references the panel tweaks
    // Live-tunable per-weapon SFX (Weapon Lab sound panel), seeded from localStorage (see
    // sfxParams.js) so tuning survives a reload; falls back to the shipped defaults where
    // nothing's saved. One-shot cues read this fresh at trigger time — unlike music params,
    // no live node graph to update, so setSfxParam is a plain data write.
    this.sfxParams = loadSfxParams();
    this._sfxSaveTimer = null;
    // Held/looping fire sounds (#53) — one continuous source per mount location, so two
    // simultaneous held weapons (e.g. flamethrower in one arm, beam laser in the other)
    // don't collide. Keyed by location; value is the stop() closure Sfx.startHeld returned.
    this._heldSounds = new Map();
    // Combat music ducking (#108) — timestamps (ctx.currentTime) of recent weapon-fire/
    // impact/explosion cues; see duck.js's duckGainAt for how these shape the music gain.
    this._duckTriggers = [];
  }

  // Adopt Phaser's AudioContext (scene.sound.context) and wire the bus graph once. Safe
  // to call repeatedly / with a missing context.
  init(ctx) {
    if (this.ctx || !ctx) return;
    this.ctx = ctx;
    // #150: give the file-override module a context to decode against (loading the actual
    // stored overrides is a separate, async, boot-time step — see sfxOverrides.loadAllOverrides).
    setOverrideAudioContext(ctx);
    // #173: same for the baked-SFX module — the shipped audio assets decode against this context
    // (the actual fetch+decode is a separate, async, boot-time step — see bakedSfx.loadAllBaked).
    setBakedAudioContext(ctx);
    this.master = ctx.createGain(); this.master.gain.value = this.params.master;
    // Master bus: a compressor for broadband leveling, then a soft-clip limiter as the
    // brick wall so even a hot mix can't hard-clip the output.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.25;
    const limiter = ctx.createWaveShaper(); limiter.curve = softClipCurve(); limiter.oversample = 'none';
    this.master.connect(comp).connect(limiter).connect(ctx.destination);
    const P = this.params;
    this.sfx = ctx.createGain(); this.sfx.gain.value = 0.85; this.sfx.connect(this.master);
    this.music = ctx.createGain(); this.music.gain.value = P.music; this.music.connect(this.master);
    this.drums = ctx.createGain(); this.drums.gain.value = P.drumLevel; this.drums.connect(this.music);
    // Distorted-guitar chain for the metal track, built like a real distortion pedal + cab so
    // the sawtooth voices actually SATURATE: voices → guitar bus → preGain (drive) → soft
    // saturate → hard-clip (fizz) → wave-fold (gnarly overtones) → highpass (low cut) →
    // lowpass (cab tone) → postGain (level). All these stages are live-tunable via setParam.
    const fx = this._fx;
    this.guitar = ctx.createGain(); this.guitar.gain.value = 1.0;
    fx.pre = ctx.createGain(); fx.pre.gain.value = P.guitarDrive;
    fx.sat = ctx.createWaveShaper(); fx.sat.curve = distortionCurve(P.guitarSat); fx.sat.oversample = '4x';
    fx.fizz = ctx.createWaveShaper(); fx.fizz.curve = hardClipCurve(P.guitarClip); fx.fizz.oversample = '4x';
    fx.fold = ctx.createWaveShaper(); fx.fold.curve = foldbackCurve(P.guitarFold); fx.fold.oversample = '4x';
    fx.hp = ctx.createBiquadFilter(); fx.hp.type = 'highpass'; fx.hp.frequency.value = P.guitarLowCut;
    fx.cab = ctx.createBiquadFilter(); fx.cab.type = 'lowpass'; fx.cab.frequency.value = P.guitarTone; fx.cab.Q.value = 1.2;
    fx.post = ctx.createGain(); fx.post.gain.value = P.guitarLevel;
    this.guitar.connect(fx.pre).connect(fx.sat).connect(fx.fizz).connect(fx.fold).connect(fx.hp).connect(fx.cab).connect(fx.post).connect(this.music);

    // Parallel LOW-FOUNDATION path (the riff's tonal body): a lightly-overdriven, low-passed
    // layer of the same notes blended under the harsh chain — restores the "bass" tone the
    // heavy distortion eats.
    this.bass = ctx.createGain(); this.bass.gain.value = 1.0;
    fx.bdrive = ctx.createGain(); fx.bdrive.gain.value = P.bassDrive;
    fx.bshape = ctx.createWaveShaper(); fx.bshape.curve = distortionCurve(P.bassGrit); fx.bshape.oversample = '2x';
    fx.blp = ctx.createBiquadFilter(); fx.blp.type = 'lowpass'; fx.blp.frequency.value = P.bassTone;
    fx.bpost = ctx.createGain(); fx.bpost.gain.value = P.bassLevel;
    this.bass.connect(fx.bdrive).connect(fx.bshape).connect(fx.blp).connect(fx.bpost).connect(this.music);

    // Two LEAD instruments, each with its own full guitar-style chain (drive → saturate →
    // hard-clip → fold → low-cut → tone → level), so they can be shaped like the rhythm/bass.
    this.leadBus = this._buildLeadChain('lead');
    this.lead2Bus = this._buildLeadChain('lead2');
  }

  // Build a lead instrument's signal chain from its `<prefix>*` params, store the nodes on
  // this._fx[prefix+...], and return the input bus.
  _buildLeadChain(prefix) {
    const ctx = this.ctx, fx = this._fx, P = this.params;
    const bus = ctx.createGain(); bus.gain.value = 1.0;
    fx[prefix + 'pre'] = ctx.createGain(); fx[prefix + 'pre'].gain.value = P[prefix + 'Drive'];
    fx[prefix + 'sat'] = ctx.createWaveShaper(); fx[prefix + 'sat'].curve = distortionCurve(P[prefix + 'Sat']); fx[prefix + 'sat'].oversample = '4x';
    fx[prefix + 'fizz'] = ctx.createWaveShaper(); fx[prefix + 'fizz'].curve = hardClipCurve(P[prefix + 'Clip']); fx[prefix + 'fizz'].oversample = '4x';
    fx[prefix + 'fold'] = ctx.createWaveShaper(); fx[prefix + 'fold'].curve = foldbackCurve(P[prefix + 'Fold']); fx[prefix + 'fold'].oversample = '4x';
    fx[prefix + 'hp'] = ctx.createBiquadFilter(); fx[prefix + 'hp'].type = 'highpass'; fx[prefix + 'hp'].frequency.value = P[prefix + 'LowCut'];
    fx[prefix + 'lp'] = ctx.createBiquadFilter(); fx[prefix + 'lp'].type = 'lowpass'; fx[prefix + 'lp'].frequency.value = P[prefix + 'Tone'];
    fx[prefix + 'post'] = ctx.createGain(); fx[prefix + 'post'].gain.value = P[prefix + 'Level'];
    bus.connect(fx[prefix + 'pre']).connect(fx[prefix + 'sat']).connect(fx[prefix + 'fizz']).connect(fx[prefix + 'fold'])
      .connect(fx[prefix + 'hp']).connect(fx[prefix + 'lp']).connect(fx[prefix + 'post']).connect(this.music);
    return bus;
  }

  // ── DAW-style solo/mute ────────────────────────────────────────────────────────────────
  // 0/1 audibility multiplier for a track: if anything is soloed, only soloed tracks sound;
  // otherwise everything sounds except muted tracks. Never reads/writes the level params.
  _mix(t) {
    if (this.soloSet.size) return this.soloSet.has(t) ? 1 : 0;
    return this.muteSet.has(t) ? 0 : 1;
  }
  isMuted(t) { return this.muteSet.has(t); }
  isSoloed(t) { return this.soloSet.has(t); }
  muteTrack(t) { this.muteSet.has(t) ? this.muteSet.delete(t) : this.muteSet.add(t); this._applyMix(); }
  soloTrack(t) { this.soloSet.has(t) ? this.soloSet.delete(t) : this.soloSet.add(t); this._applyMix(); }
  // Re-push the node-based track levels (guitar/bass/leads live in gain nodes, not read at
  // note time) so their audibility tracks the current solo/mute state. Drum tracks read the
  // multiplier live in their note functions, so they need no node update here.
  _applyMix() {
    const fx = this._fx, P = this.params;
    if (fx.post) fx.post.gain.value = P.guitarLevel * this._mix('guitar');
    if (fx.bpost) fx.bpost.gain.value = P.bassLevel * this._mix('bass');
    if (fx.leadpost) fx.leadpost.gain.value = P.leadLevel * this._mix('lead');
    if (fx.lead2post) fx.lead2post.gain.value = P.lead2Level * this._mix('lead2');
  }

  // Live-update a music parameter from the in-game panel; also persists into this.params so
  // "copy settings" can dump a paste-ready defaults block.
  setParam(k, v) {
    this.params[k] = v;
    const fx = this._fx;
    if (!this.ctx) return;
    // Lead 1 / Lead 2 chains share one shape; route by prefix. (Fifth/Oct/Pitch are read
    // live at note time, so they need no node update.)
    if (k.startsWith('lead')) {
      const p = k.startsWith('lead2') ? 'lead2' : 'lead', s = k.slice((k.startsWith('lead2') ? 5 : 4));
      if (s === 'Drive') fx[p + 'pre'].gain.value = v;
      else if (s === 'Sat') fx[p + 'sat'].curve = distortionCurve(v);
      else if (s === 'Clip') fx[p + 'fizz'].curve = hardClipCurve(v);
      else if (s === 'Fold') fx[p + 'fold'].curve = foldbackCurve(v);
      else if (s === 'LowCut') fx[p + 'hp'].frequency.value = v;
      else if (s === 'Tone') fx[p + 'lp'].frequency.value = v;
      else if (s === 'Level') fx[p + 'post'].gain.value = v * this._mix(p);
      return;
    }
    switch (k) {
      case 'master': if (!this.muted) this.master.gain.value = v; break;
      case 'music': this.music.gain.value = v; break;
      case 'drumLevel': this.drums.gain.value = v; break;
      case 'guitarDrive': fx.pre.gain.value = v; break;
      case 'guitarSat': fx.sat.curve = distortionCurve(v); break;
      case 'guitarClip': fx.fizz.curve = hardClipCurve(v); break;
      case 'guitarFold': fx.fold.curve = foldbackCurve(v); break;
      case 'guitarLowCut': fx.hp.frequency.value = v; break;
      case 'guitarTone': fx.cab.frequency.value = v; break;
      case 'guitarLevel': fx.post.gain.value = v * this._mix('guitar'); break;
      case 'bassDrive': fx.bdrive.gain.value = v; break;
      case 'bassGrit': fx.bshape.curve = distortionCurve(v); break;
      case 'bassTone': fx.blp.frequency.value = v; break;
      case 'bassLevel': fx.bpost.gain.value = v * this._mix('bass'); break;
      default: break;   // tempo + voicing/level params are read live at note time
    }
  }

  // Per-weapon SFX (Weapon Lab sound panel). `stage` is 'fire' | 'trajectory' | 'impact';
  // falls back to FALLBACK_SFX for a weapon with no entry so any future weapon stays safe.
  getSfxParams(weaponId) {
    return this.sfxParams[weaponId] ?? FALLBACK_SFX;
  }
  setSfxParam(weaponId, stage, layerIndex, field, value) {
    const w = (this.sfxParams[weaponId] ??= {});
    const layers = (w[stage] ??= []);
    const layer = (layers[layerIndex] ??= {});
    layer[field] = value;
    this._scheduleSfxSave();
  }
  resetSfxParams(weaponId) {
    this.sfxParams[weaponId] = JSON.parse(JSON.stringify(DEFAULT_SFX[weaponId] ?? FALLBACK_SFX));
    this._scheduleSfxSave();
  }
  // Debounced so a slider drag (many setSfxParam calls a second) doesn't hammer
  // localStorage — writes ~400ms after the last change.
  _scheduleSfxSave() {
    clearTimeout(this._sfxSaveTimer);
    this._sfxSaveTimer = setTimeout(() => saveSfxParams(this.sfxParams), 400);
  }

  // The riff's tonal low foundation: root + sub-octave + tunable FIFTH / octave overtones,
  // lightly driven + low-passed. The fifth/octave mixes let the bass carry overtones too.
  _bass(freq, at, dur, gain = 0.6) {
    if (gain <= 0) return;                          // silent — skip
    const ctx = this.ctx, P = this.params;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);                 // 0 ms attack — full volume instantly
    g.gain.setValueAtTime(gain, at + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    g.connect(this.bass);
    const v = (f, level, type = P.bassWave) => {
      if (level <= 0) return;
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      if (level === 1) o.connect(g);
      else { const vg = ctx.createGain(); vg.gain.value = level; o.connect(vg).connect(g); }
      o.start(at); o.stop(at + dur + 0.02);
    };
    v(freq, 1);                       // root
    v(freq * 0.5, P.bassSub, 'square'); // sub octave for body (always square for weight)
    v(freq * 1.5, P.bassFifth);       // the FIFTH overtone
    v(freq * 2, P.bassOctave);        // octave overtone
  }

  // A lead melody note into lead `prefix`'s bus: a detuned root pair plus tunable 5th/octave
  // overtone voices (like the bass). `type` picks the waveform so the leads differ in timbre.
  _leadNote(prefix, freq, at, dur, type = 'sawtooth', gain = 0.5) {
    if (gain <= 0) return;
    const ctx = this.ctx, P = this.params, bus = this[prefix + 'Bus'];
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);                 // 0 ms attack — full volume instantly
    g.gain.setValueAtTime(gain, at + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    g.connect(bus);
    const v = (f, level) => {
      if (level <= 0) return;
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      if (level === 1) o.connect(g);
      else { const vg = ctx.createGain(); vg.gain.value = level; o.connect(vg).connect(g); }
      o.start(at); o.stop(at + dur + 0.02);
    };
    v(freq * 0.997, 1); v(freq * 1.003, 1);     // detuned root pair
    v(freq * 0.5, P[prefix + 'Sub']);            // sub octave for body
    v(freq * 1.5, P[prefix + 'Fifth']);          // 5th overtone
    v(freq * 2, P[prefix + 'Oct']);              // octave overtone
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.params.master;
    return m;
  }
  toggleMute() { return this.setMuted(!this.muted); }

  get ready() { return !!this.ctx && this.ctx.state === 'running' && !this.muted; }
  _now() { return this.ctx.currentTime; }
  // Phaser usually resumes the context on input; nudge it just in case.
  _resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }

  // ── SFX latency instrumentation ─────────────────────────────────────────────────────────
  // Answers "is the perceived fire-delay our code, or a browser/OS/hardware floor?"
  //   baseLatencyMs   — the AudioContext's own buffering (set by latencyHint at creation;
  //                     'interactive' minimises it, typically ~3-6ms)
  //   outputLatencyMs — time from the context to the actual speakers: the OS audio stack +
  //                     hardware buffer. The big one, and mostly OUT of our control — wired
  //                     onboard audio is ~10-40ms; BLUETOOTH is 100-300ms (unfixable in JS).
  // If (base + output) is large, THAT is the floor and no code change removes it.
  latencyReport() {
    if (!this.ctx) return null;
    const base = (this.ctx.baseLatency || 0) * 1000;
    const output = (this.ctx.outputLatency || 0) * 1000;   // Chrome/Firefox; 0 if unsupported
    return {
      baseLatencyMs: +base.toFixed(1),
      outputLatencyMs: +output.toFixed(1),
      floorMs: +(base + output).toFixed(1),   // the platform minimum, button-press aside
      sampleRate: this.ctx.sampleRate,
      state: this.ctx.state,
    };
  }

  // Stamp the moment an input event decided to fire, so _logSfxTiming can measure the
  // input-read -> audio-node-start gap (our code-path cost). Called from the fire path.
  markTrigger() { this._triggerAt = (typeof performance !== 'undefined') ? performance.now() : 0; }

  // Enable with `window.__sfxDebug = true` in the console: logs, per sound, the code-path
  // delay since the last markTrigger() plus the platform latency floor. Off by default.
  _logSfxTiming(label) {
    if (typeof window === 'undefined' || !window.__sfxDebug || !this.ctx) return;
    const code = this._triggerAt ? (performance.now() - this._triggerAt).toFixed(1) : '?';
    const r = this.latencyReport();
    // eslint-disable-next-line no-console
    console.log(`[sfx ${label}] code-path ${code}ms · baseLatency ${r.baseLatencyMs}ms · outputLatency ${r.outputLatencyMs}ms · floor ≈ ${r.floorMs}ms`);
  }

  // 1s cached white-noise buffer (built lazily; reused by every noise voice).
  _noise() {
    if (this._noiseBuf) return this._noiseBuf;
    const n = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, n, n);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;
    return buf;
  }

  // ── Synth voices ── each schedules itself at `at` (default: now) and frees on stop. ──

  // A pitched oscillator with a fast attack + exponential decay; optional pitch glide.
  // (gain <= 0 is skipped — exponential ramps can't target 0, and a silent voice is a no-op.)
  tone(bus, { type = 'sine', freq = 440, freqEnd, dur = 0.15, gain = 0.4, attack = 0.004 }, at) {
    if (!this.ctx || gain <= 0) return;
    const t = at ?? this._now();
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, freq), t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus);
    o.start(t); o.stop(t + dur + 0.03);
  }

  // Filtered noise burst — the workhorse for gun cracks, whooshes, impacts, drums.
  // (gain <= 0 is skipped — exponential ramps can't target 0.)
  noise(bus, { dur = 0.2, gain = 0.4, type = 'lowpass', freq = 1200, freqEnd, q = 0.8, attack = 0.002 }, at) {
    if (!this.ctx || gain <= 0) return;
    const t = at ?? this._now();
    const src = this.ctx.createBufferSource(); src.buffer = this._noise();
    const f = this.ctx.createBiquadFilter(); f.type = type;
    f.frequency.setValueAtTime(Math.max(40, freq), t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(t); src.stop(t + dur + 0.03);
  }

  // ── SFX events ────────────────────────────────────────────────────────────────────

  // Weapon firing (#32) — per-weapon tunable layers (Weapon Lab sound panel, see
  // sfxParams.js). Gameplay SFX dispatch lives in ./sfx.js; these facade methods keep the
  // public API + the resume/ready guards and delegate.
  fire(weapon) {
    this._resume();
    if (!this.ready || !weapon) return;
    Sfx.fire(this, weapon);
    this._duckTrigger();
    this._logSfxTiming('fire');
  }

  // A brief in-flight flavor cue, fired a beat after launch — only weapons with a
  // noticeable flight time have one (see sfxParams.js); a no-op otherwise.
  trajectory(weaponId) {
    this._resume();
    if (!this.ready || !weaponId) return;
    Sfx.trajectory(this, weaponId);
  }

  // Weapon impact (#33) — per weapon (falls back to a generic clank for an unknown weaponId).
  impact(weaponId) {
    this._resume();
    if (!this.ready) return;
    Sfx.impact(this, weaponId);
    this._duckTrigger();
  }

  // ── Held/looping fire sound (#53) ──────────────────────────────────────────────────────
  // Start a continuous fire sound for a held weapon (flamethrower roar / beam laser hum) at
  // mount location `location`. Guards against double-starting the same location (a stray
  // repeated call finds one already playing there and no-ops) — callers should stopHeld()
  // first if that location's weapon has genuinely changed. No-ops if the engine isn't ready
  // or the weapon isn't a held/looping one (hasHeldSfx).
  startHeld(location, weaponId) {
    this._resume();
    if (!this.ready || this._heldSounds.has(location)) return;
    const stop = Sfx.startHeld(this, weaponId);
    if (stop) this._heldSounds.set(location, stop);
    this._logSfxTiming('held-start');
  }

  // Stop the held sound at `location`, if any (safe to call when nothing is playing there).
  stopHeld(location) {
    const stop = this._heldSounds.get(location);
    if (!stop) return;
    this._heldSounds.delete(location);
    stop();
  }

  // Cleanup — stop every currently-held sound (e.g. on scene shutdown/transition).
  stopAllHeld() {
    for (const stop of this._heldSounds.values()) stop();
    this._heldSounds.clear();
  }

  // ── Per-projectile in-flight loop (#56) ────────────────────────────────────────────────
  // Start a continuous trajectory sound for one in-flight round; returns a stop() closure to
  // stash on that projectile (or null if the weapon has no trajectory cue / engine not ready).
  startTrajectoryLoop(weaponId) {
    this._resume();
    if (!this.ready) return null;
    return Sfx.startTrajectory(this, weaponId) || null;
  }

  // Footfall (#34) — a heavy low thud; alternating feet shift pitch slightly (throttled).
  footstep(foot = 0) {
    this._resume();
    if (!this.ready) return;
    Sfx.footstep(this, foot);
  }

  // Ability (#35) — jump-jet dash vs. bubble-shield raise.
  ability(kind) {
    this._resume();
    if (!this.ready) return;
    Sfx.ability(this, kind);
  }

  // Explosion (#36) — a broken-off part / player MECH DOWN. `scale` 0.4..1.2 sizes the blast.
  // NOT used for enemy-kill explosions any more — see deathExplosion below (#107).
  explosion(scale = 1) {
    this._resume();
    if (!this.ready) return;
    Sfx.explosion(this, scale);
    this._duckTrigger();
  }

  // ── Combat music ducking (#108) ────────────────────────────────────────────────────────
  // Record a combat-SFX trigger (weapon fire, impact, explosion — the audible "action is
  // happening" cues; NOT footsteps/abilities/trajectory flavor, which are too frequent/subtle
  // to duck against). The music bus gain is reshaped toward duckGainAt()'s envelope on the
  // same 25ms tick that already drives the music clock (see _schedule/_updateDuck) — no extra
  // timer, and it's a no-op whenever music isn't actually playing.
  _duckTrigger() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._duckTriggers.push(t);
    // Bound the array: nothing further back than one full envelope cycle can still matter.
    const P = this.params;
    const horizon = t - (P.duckHold + P.duckRelease + P.duckAttack + 1);
    while (this._duckTriggers.length && this._duckTriggers[0] < horizon) this._duckTriggers.shift();
  }

  // Push the music bus gain toward the current duck envelope value for time `at`. Called every
  // music-clock tick (only while music is playing) — additive on top of the existing `music`
  // level param, never replacing the panel's own volume control.
  _updateDuck(at) {
    const P = this.params;
    const mult = duckGainAt(this._duckTriggers, at, {
      depth: P.duckDepth, attack: P.duckAttack, hold: P.duckHold, release: P.duckRelease,
    });
    this.music.gain.setValueAtTime(P.music * mult, at);
  }

  // Destruction explosion (#100, made tunable by size category in #107) — the per-kill boom
  // (not the player's own MECH DOWN / a part breaking off — those stay on `explosion` above).
  // `category` is one of EXPLOSION_CATEGORIES (small/medium/large/massive; see sfxParams.js +
  // scenes/arena/shared.js's explosionCategoryFor), each independently tunable via the Weapon
  // Lab panel (same getSfxParams/setSfxParam/resetSfxParams plumbing, keyed by
  // `explosionSfxId(category)`) instead of one continuous scale.
  deathExplosion(category = 'medium') {
    this._resume();
    if (!this.ready) return;
    Sfx.deathExplosionByCategory(this, category);
  }

  // ── Music (#38) ─────────────────────────────────────────────────────────────────────
  // A looping metal arrangement on a 25ms lookahead clock (sample-accurate regardless of frame
  // rate), driven by `this.track` — one of the generated (style × mode) tracks in TRACKS (default
  // 'gallop-aeolian'). The loop no-ops until the context is running, so it "starts" the moment
  // Phaser unlocks audio on first input. setTrack() swaps between tracks live.
  startMusic(track) {
    if (track) this.track = track;
    if (this._musicOn) return;
    this._resume();                  // a play click is a user gesture — unlock the context
    this._musicOn = true;
    this._step = 0;
    this._nextStepTime = 0;
    this._musicTimer = setInterval(() => this._schedule(), 25);
  }

  stopMusic() {
    this._musicOn = false;
    if (this._musicTimer) clearInterval(this._musicTimer);
    this._musicTimer = null;
  }

  // Is the soundtrack currently playing? (The music is OFF by default; the panel's play/pause
  // starts/stops it.) toggleMusic() flips it and returns the new state.
  get musicOn() { return this._musicOn; }
  toggleMusic() { this._musicOn ? this.stopMusic() : this.startMusic(); return this._musicOn; }

  // Switch the active track (live). Each track carries its own tempo, so adopt it (the panel
  // re-reads params.tempo when it rebuilds on a track switch). Unknown ids fall back to default.
  setTrack(name) {
    this._trackDef = TRACKS[name] || TRACKS[DEFAULT_TRACK];
    this.track = this._trackDef.id;
    this.params.tempo = this._trackDef.tempo;
    this._step = 0;
  }
  get trackIds() { return TRACK_IDS; }
  trackLabel(id) { return (TRACKS[id] || TRACKS[DEFAULT_TRACK]).label; }

  _schedule() {
    if (!this.ctx || this.ctx.state !== 'running' || this.muted) return;
    const tempo = Math.max(1, this.params.tempo);
    const stepDur = 60 / tempo / 4;   // sixteenth note
    const now = this.ctx.currentTime;
    if (this._nextStepTime < now) this._nextStepTime = now + 0.06;
    while (this._nextStepTime < now + 0.12) {
      this._playStep(this._step, this._nextStepTime);
      this._nextStepTime += stepDur;
      this._step = (this._step + 1) % 384;
    }
    this._updateDuck(now);
  }

  _playStep(step, at) {
    this._stepMetal(step, at);
  }

  // Aggressive thrash: a galloping riff of distorted power chords (root+5th+8ve through the
  // guitar chain), optional screaming leads, and a hard double-bass kit. All note content comes
  // from the active track (this._trackDef) so every mode in TRACKS plays through this one engine.
  _stepMetal(step, at) {
    const P = this.params, T = this._trackDef, D = T.drums;
    // 384-step / 24-bar arrangement = three 8-bar sections that layer the leads in:
    //   section 0 (bars 1-8):   bass + guitar only
    //   section 1 (bars 9-16):  + lead 1
    //   section 2 (bars 17-24): + lead 1 & lead 2
    // The guitar / bass / drum patterns each tile at their OWN length (step % len), so a track's
    // rhythmic FEEL (gallop, eighths, doom drone, tremolo, blast) lives entirely in its grids.
    // `stretch` slows the HARMONY without slowing the pulse: the pick still fires on every grid
    // onset, but the note it grabs advances at 1/stretch speed (the gallop's slow 8-bar harmony).
    // Lead 1 plays bars 1-2 & 5-6 of a section; lead 2 plays all bars (when present).
    const sd = 60 / Math.max(1, P.tempo) / 4;        // one sixteenth, in seconds
    const st = T.stretch;
    const block = Math.floor(step / 128);            // which 8-bar section (0,1,2)
    const bstep = step % 128;                        // position within the section
    const m = step % 32;                             // lead phrase position (32-step / 2 bars)
    const lead1Bars = bstep < 32 || (bstep >= 64 && bstep < 96);   // lead 1: bars 1-2 & 5-6

    // Rhythm guitar: pick on each onset of this track's grid. Either a tight palm-muted chug of
    // `chug` seconds, or — for doom/sustained tracks — a chord that RINGS to the next pick.
    const gi = step % T.gtr.len;                                 // pulse: which onset (raw)
    if (T.gtr.hit[gi]) {
      const hi = Math.floor((step % (T.gtr.len * st)) / st);    // harmony: the (slowed) note index
      const dur = T.ring ? T.gtr.gap[gi] * sd * 0.92 : T.chug;
      this._gtr(T.gtr.freq[hi], at, dur, 0.94, true);           // loudness via guitarLevel
    }
    // Bass follows its own rhythm grid (steady sixteenths, groovy syncopation, eighths, or a
    // sustained drone) — capped so a note never overruns the next onset.
    const bi = step % T.bass.len;
    if (T.bass.hit[bi]) {
      const bh = Math.floor((step % (T.bass.len * st)) / st);   // same slowed harmony for the bass
      const cap = T.bass.gap[bi] * sd * 0.95;
      this._bass(T.bass.freq[bh], at, Math.min(T.bassRing ? Infinity : P.bassLength, cap), 0.6);
    }
    // Lead melodies: lead 1 enters in section 1 (bars 1-2 & 5-6), lead 2 in section 2 (all bars).
    // New tracks leave these empty (open for the owner), so the loops simply add nothing.
    if (lead1Bars && block >= 1) {
      for (const [deg, atStep, dur] of T.leadMelody) {
        if (atStep === m) this._leadNote('lead', degHz(T.leadRoot, T.semis, deg) * P.leadPitch, at, dur * sd * P.leadLength, P.leadWave);
      }
    }
    if (block >= 2) {
      for (const [deg, atStep, dur] of T.lead2Melody) {
        if (atStep === m) this._leadNote('lead2', degHz(T.leadRoot, T.semis, deg) * P.lead2Pitch, at, dur * sd * P.lead2Length, P.lead2Wave);
      }
    }

    // Drums — each voice tiles its own grid; the hat reads its grid (open "ride" wash or closed tick).
    if (D.kick[step % D.kick.length] === 'x') this._kickMetal(at);
    if (D.snare[step % D.snare.length] === 'x') this._snareMetal(at);
    if (D.hat && D.hat[step % D.hat.length] === 'x') {
      this._hat(at, (D.ride ? 0.05 : 0.035) * P.hatLevel * this._mix('hat'), D.ride);
    }
    if (step % D.crash === 0) this._crash(at);
  }

  // A distorted power chord (root + fifth + octave, detuned for width, with a square voice
  // for extra grit) into the guitar/waveshaper chain. The envelope is a fast pick attack +
  // a short sustained body + quick release, so it reads as a palm-muted CHUG, not a blip.
  // `chord:false` plays a single note (lead/tremolo).
  _gtr(freq, at, dur, gain = 0.5, chord = true) {
    if (gain <= 0) return;                          // silent (level slider at 0) — skip
    const ctx = this.ctx, P = this.params;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);                          // 0 ms attack — full volume instantly
    g.gain.setValueAtTime(gain, at + dur * 0.7);              // hold the chug body
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);    // fast release (damped palm mute)
    g.connect(this.guitar);
    const voice = (f, level, type = P.guitarWave) => {
      if (level <= 0) return;
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      if (level === 1) o.connect(g);
      else { const vg = ctx.createGain(); vg.gain.value = level; o.connect(vg).connect(g); }
      o.start(at); o.stop(at + dur + 0.02);
    };
    voice(freq * 0.992, 1); voice(freq * 1.008, 1);  // detuned root pair (thickness)
    if (chord) {
      const d = P.guitarFifthDetune;
      voice(freq * (1.5 - d), P.guitarFifth); voice(freq * (1.5 + d), P.guitarFifth); // beating fifth pair (weird overtone)
      voice(freq * 2, P.guitarOctave);
      voice(freq * 3, P.guitarHigh); voice(freq * 4.5, P.guitarHigh);  // 8ve+5th, high screaming 5th
      voice(freq, P.guitarSquare, 'square'); voice(freq * 1.5, P.guitarSquare, 'square'); // square root + fifth grit
    }
  }

  _kickMetal(at) {
    const P = this.params, k = P.kickLevel * this._mix('kick');
    this.tone(this.drums, { type: 'sine', freq: P.kickPitch, freqEnd: 42, dur: P.kickDecay, gain: 0.26 * k, attack: 0.001 }, at);
    this.noise(this.drums, { dur: 0.02, gain: P.kickClick * k, type: 'highpass', freq: 3200 }, at);   // beater click
  }
  _snareMetal(at) {
    const P = this.params, s = P.snareLevel * this._mix('snare');
    this.noise(this.drums, { dur: P.snareDecay, gain: 0.17 * s, type: 'highpass', freq: P.snareTone }, at); // body/brightness
    this.noise(this.drums, { dur: 0.08, gain: 0.08 * s, type: 'bandpass', freq: P.snareSnap, q: 1 }, at);   // snap/crack
    this.tone(this.drums, { type: 'triangle', freq: 245, freqEnd: 170, dur: 0.09, gain: 0.05 * s }, at);    // tone body
  }
  _crash(at) {
    const P = this.params;
    this.noise(this.drums, { dur: P.crashDecay, gain: 0.1 * P.crashLevel * this._mix('crash'), type: 'highpass', freq: P.crashBright }, at);
  }
  _hat(at, gain, ride = false) {
    // `ride` = a longer, lower open-hat/ride wash (for slow doom grooves); else the usual closed tick.
    const dur = ride ? this.params.hatDecay * 3 : this.params.hatDecay;
    const freq = ride ? this.params.hatFreq * 0.7 : this.params.hatFreq;
    this.noise(this.drums, { dur, gain, type: 'highpass', freq }, at);
  }
}
