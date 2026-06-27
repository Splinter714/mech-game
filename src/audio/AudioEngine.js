// Procedural audio — every sound is SYNTHESIZED from oscillators + filtered noise with
// envelopes, mirroring the art ethos: ZERO asset files (no .wav/.mp3). One singleton
// engine drives a small bus graph (master → sfx / music) on top of Phaser's WebAudio
// context, so it inherits Phaser's autoplay-unlock handling. Everything no-ops safely
// until the context exists and is running (e.g. before the first user gesture, or in the
// headless smoke run), so callers never need to guard.
//
//   SFX (#32 firing · #33 impacts · #34 footfalls · #35 abilities · #36 explosions)
//   Music (#38): a looping synthwave sequence (bass + arp + drums) on a lookahead clock.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A WaveShaper transfer curve for guitar-style distortion (higher `k` = more crunch).
function distortionCurve(k) {
  const n = 1024, curve = new Float32Array(n), deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

// A hard-clip transfer curve — squares the wave off flat (`drive` = how hard), which
// generates the high-order harmonics that read as harsh fizz/buzz. Cascaded after the
// soft saturation for a much more aggressive metal tone.
function hardClipCurve(drive) {
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.max(-1, Math.min(1, x * drive));
  }
  return curve;
}

// A foldback (wave-folding) transfer curve — instead of clipping flat, the signal FOLDS
// back on itself (`amount` = how many folds), generating wild, slightly inharmonic upper
// overtones: the gnarly metallic harshness on top of the clip.
function foldbackCurve(amount) {
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (((i * 2) / n - 1) * amount + 1) % 4;     // triangle-fold into [-1,1]
    const u = (t + 4) % 4;
    curve[i] = (u < 2 ? u : 4 - u) - 1;
  }
  return curve;
}

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
    this.track = 'metal';      // active soundtrack: 'metal' (default) | 'synthwave'
    // Live-tunable music parameters (driven by the in-game audio panel; see setParam).
    // These are the defaults baked into the build — the panel's "copy settings" prints a
    // params object you can paste back here.
    this.params = {
      // master + drums
      master: 1, music: 0.35, tempo: 120,
      drumLevel: 1.5, kickLevel: 1.4, snareLevel: 1.45, hatLevel: 1.7,
      // rhythm-guitar TONE (the distortion pedal + cab)
      guitarLevel: 0.17, guitarDrive: 40, guitarSat: 600, guitarClip: 1, guitarFold: 4,
      guitarTone: 9000, guitarLowCut: 400,
      // rhythm-guitar VOICING (which overtones make up each power chord)
      guitarFifth: 0, guitarFifthDetune: 0, guitarOctave: 0.95, guitarHigh: 0.55, guitarSquare: 0,
      chugLength: 0.1, chugLevel: 1, pickLevel: 0.01, leadLevel: 0.05,
      // bass / low foundation (+ its own overtones)
      bassLevel: 0.45, bassDrive: 12, bassGrit: 200, bassTone: 3000,
      bassSub: 0.45, bassFifth: 0, bassOctave: 1.5,
    };
    this._fx = {};             // live node references the panel tweaks
  }

  // Adopt Phaser's AudioContext (scene.sound.context) and wire the bus graph once. Safe
  // to call repeatedly / with a missing context.
  init(ctx) {
    if (this.ctx || !ctx) return;
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    // A gentle limiter so layered explosions/volleys don't clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);
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
  }

  // Live-update a music parameter from the in-game panel; also persists into this.params so
  // "copy settings" can dump a paste-ready defaults block.
  setParam(k, v) {
    this.params[k] = v;
    const fx = this._fx;
    if (!this.ctx) return;
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
      case 'guitarLevel': fx.post.gain.value = v; break;
      case 'bassDrive': fx.bdrive.gain.value = v; break;
      case 'bassGrit': fx.bshape.curve = distortionCurve(v); break;
      case 'bassTone': fx.blp.frequency.value = v; break;
      case 'bassLevel': fx.bpost.gain.value = v; break;
      default: break;   // tempo + voicing/level params are read live at note time
    }
  }

  // The riff's tonal low foundation: root + sub-octave + tunable FIFTH / octave overtones,
  // lightly driven + low-passed. The fifth/octave mixes let the bass carry overtones too.
  _bass(freq, at, dur, gain = 0.6) {
    const ctx = this.ctx, P = this.params;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    g.gain.setValueAtTime(gain, at + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    g.connect(this.bass);
    const v = (f, level, type = 'sawtooth') => {
      if (level <= 0) return;
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      if (level === 1) o.connect(g);
      else { const vg = ctx.createGain(); vg.gain.value = level; o.connect(vg).connect(g); }
      o.start(at); o.stop(at + dur + 0.02);
    };
    v(freq, 1);                       // root
    v(freq * 0.5, P.bassSub, 'square'); // sub octave for body
    v(freq * 1.5, P.bassFifth);       // the FIFTH overtone
    v(freq * 2, P.bassOctave);        // octave overtone
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
  tone(bus, { type = 'sine', freq = 440, freqEnd, dur = 0.15, gain = 0.4, attack = 0.004 }, at) {
    if (!this.ctx) return;
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
  noise(bus, { dur = 0.2, gain = 0.4, type = 'lowpass', freq = 1200, freqEnd, q = 0.8, attack = 0.002 }, at) {
    if (!this.ctx) return;
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

  // Weapon firing (#32) — distinct timbre per category, pitched by the weapon's weight
  // (more damage = lower/beefier), with overrides for flame/incendiary kinds.
  fire(weapon) {
    this._resume();
    if (!this.ready || !weapon) return;
    const d = weapon.delivery || {};
    const cat = weapon.category;
    const stream = d.pattern === 'stream';

    if (d.kind === 'flame') { // flamethrower hiss
      this.noise(this.sfx, { dur: 0.16, gain: 0.10, type: 'bandpass', freq: 1100, freqEnd: 600, q: 0.6 });
      return;
    }
    if (cat === 'energy') { // laser zap: bright saw sweeping down + a square sub
      const base = clamp(1000 - weapon.damage * 11, 180, 1300);
      this.tone(this.sfx, { type: 'sawtooth', freq: base * 2.4, freqEnd: base, dur: stream ? 0.07 : 0.15, gain: 0.13, attack: 0.001 });
      this.tone(this.sfx, { type: 'square', freq: base * 1.0, freqEnd: base * 0.6, dur: stream ? 0.06 : 0.10, gain: 0.06 });
      return;
    }
    if (cat === 'ballistic') {
      if (d.kind === 'fire') { // napalm canister thunk
        this.tone(this.sfx, { type: 'triangle', freq: 130, freqEnd: 60, dur: 0.16, gain: 0.22 });
        this.noise(this.sfx, { dur: 0.10, gain: 0.12, type: 'lowpass', freq: 700 });
        return;
      }
      // gun crack: a sharp noise transient over a low thump (lighter+faster for streams)
      this.noise(this.sfx, { dur: stream ? 0.045 : 0.11, gain: stream ? 0.10 : 0.26, type: 'highpass', freq: 1600, freqEnd: 700, attack: 0.0008 });
      this.tone(this.sfx, { type: 'triangle', freq: stream ? 220 : 170, freqEnd: 55, dur: stream ? 0.05 : 0.13, gain: stream ? 0.07 : 0.20 });
      return;
    }
    if (cat === 'missile') { // ignition + rising whoosh
      this.noise(this.sfx, { dur: 0.34, gain: 0.16, type: 'bandpass', freq: 480, freqEnd: 1700, q: 0.7, attack: 0.02 });
      this.tone(this.sfx, { type: 'sawtooth', freq: 200, freqEnd: 440, dur: 0.22, gain: 0.05 });
      return;
    }
    if (cat === 'melee') { // servo wind-up (the clang lands on impact)
      this.noise(this.sfx, { dur: 0.16, gain: 0.10, type: 'bandpass', freq: 700, freqEnd: 1500, q: 1.2 });
    }
  }

  // Weapon impact (#33) — per ordnance type. Big ordnance routes to an explosion.
  impact(kind) {
    this._resume();
    if (!this.ready) return;
    switch (kind) {
      case 'missile': case 'fire':
        this.explosion(0.55); return;
      case 'plasma': // electric sizzle + low splat
        this.noise(this.sfx, { dur: 0.18, gain: 0.14, type: 'bandpass', freq: 2200, freqEnd: 900, q: 1.4 });
        this.tone(this.sfx, { type: 'square', freq: 240, freqEnd: 80, dur: 0.12, gain: 0.10 }); return;
      case 'beam': // brief scorch tick
        this.noise(this.sfx, { dur: 0.06, gain: 0.10, type: 'highpass', freq: 2600, freqEnd: 1400 }); return;
      case 'flame':
        this.noise(this.sfx, { dur: 0.12, gain: 0.07, type: 'lowpass', freq: 900 }); return;
      default: // ballistic slug: a metallic clank
        this.noise(this.sfx, { dur: 0.05, gain: 0.18, type: 'highpass', freq: 2000, freqEnd: 800 });
        this.tone(this.sfx, { type: 'triangle', freq: 320, freqEnd: 120, dur: 0.06, gain: 0.10 });
    }
  }

  // Footfall (#34) — a heavy low thud; alternating feet shift pitch slightly. Throttled
  // so a fast gait can't machine-gun the sound.
  footstep(foot = 0) {
    this._resume();
    if (!this.ready) return;
    const t = this._now();
    if (t - this._lastStepSound < 0.07) return;
    this._lastStepSound = t;
    this.tone(this.sfx, { type: 'sine', freq: foot ? 78 : 66, freqEnd: 38, dur: 0.16, gain: 0.30, attack: 0.002 });
    this.noise(this.sfx, { dur: 0.09, gain: 0.08, type: 'lowpass', freq: 320 }); // dirt/servo crunch
  }

  // Ability (#35) — jump-jet dash vs. bubble-shield raise.
  ability(kind) {
    this._resume();
    if (!this.ready) return;
    if (kind === 'dash') { // thruster burst: rising filtered noise + pitch lift
      this.noise(this.sfx, { dur: 0.3, gain: 0.18, type: 'bandpass', freq: 400, freqEnd: 1800, q: 0.6, attack: 0.01 });
      this.tone(this.sfx, { type: 'sawtooth', freq: 180, freqEnd: 520, dur: 0.26, gain: 0.07 });
    } else if (kind === 'shield') { // shimmering power-up: two detuned bell tones
      this.tone(this.sfx, { type: 'sine', freq: 520, freqEnd: 780, dur: 0.5, gain: 0.10, attack: 0.02 });
      this.tone(this.sfx, { type: 'sine', freq: 523, freqEnd: 784, dur: 0.5, gain: 0.08, attack: 0.02 });
    }
  }

  // Explosion (#36) — death / part break-off. `scale` 0.4..1.2 sizes the blast.
  explosion(scale = 1) {
    this._resume();
    if (!this.ready) return;
    const s = clamp(scale, 0.3, 1.4);
    // Sub-bass drop = the punch.
    this.tone(this.sfx, { type: 'sine', freq: 140 * s, freqEnd: 30, dur: 0.5 * s, gain: 0.34, attack: 0.003 });
    // Wide noise body, decaying long.
    this.noise(this.sfx, { dur: 0.6 * s, gain: 0.28, type: 'lowpass', freq: 1400, freqEnd: 180, attack: 0.002 });
    // High crack on top.
    this.noise(this.sfx, { dur: 0.08, gain: 0.14, type: 'highpass', freq: 2200 });
  }

  // ── Music (#38) ─────────────────────────────────────────────────────────────────────
  // Two interchangeable 32-step (two-bar) loops on a 25ms lookahead clock (sample-accurate
  // regardless of frame rate). The active one is `this.track`:
  //   'metal'     (default) — aggressive thrash: galloping distorted power chords in E, a
  //                screaming lead, and a double-bass kit at ~184 BPM.
  //   'synthwave' (kept)    — the original driving synth in A-minor at ~104 BPM.
  // Both no-op until the context is running, so they "start" the moment Phaser unlocks
  // audio on first input. setTrack() swaps between them live.
  startMusic(track) {
    if (track) this.track = track;
    if (this._musicOn) return;
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

  setTrack(name) { this.track = name; this._step = 0; }

  _schedule() {
    if (!this.ctx || this.ctx.state !== 'running' || this.muted) return;
    const tempo = this.track === 'synthwave' ? 104 : this.params.tempo;
    const stepDur = 60 / tempo / 4;   // sixteenth note
    const now = this.ctx.currentTime;
    if (this._nextStepTime < now) this._nextStepTime = now + 0.06;
    while (this._nextStepTime < now + 0.12) {
      this._playStep(this._step, this._nextStepTime);
      this._nextStepTime += stepDur;
      this._step = (this._step + 1) % 32;
    }
  }

  _playStep(step, at) {
    if (this.track === 'synthwave') this._stepSynthwave(step, at);
    else this._stepMetal(step, at);
  }

  // Aggressive thrash: a galloping E-phrygian riff of distorted power chords (root+5th+8ve
  // through the guitar chain), a screaming high lead at phrase starts + a climbing tremolo,
  // and a hard double-bass kit.
  _stepMetal(step, at) {
    const E = 82.41, F = 87.31, G = 98.0, A = 110.0, B = 123.47, C = 130.81;
    // 32-step root line: mostly chugging E with a G–F turnaround and an A–B–C climb.
    const riff = [E, E, E, E, E, E, E, E, E, E, E, E, G, G, F, F,
                  E, E, E, E, E, E, E, E, E, E, E, E, A, A, B, C];
    const P = this.params;
    const local = step % 16;
    const gallop = local % 4 !== 1;                  // hits on 0,2,3 of each beat (gallop)

    if (gallop) {
      this._gtr(riff[step], at, P.chugLength, P.chugLevel, true);   // tight palm-muted chug (no overlap = no smear)
      this._bass(riff[step], at, P.chugLength + 0.02, 0.6);         // tonal low foundation under the fizz
      this.noise(this.drums, { dur: 0.018, gain: P.pickLevel, type: 'bandpass', freq: 2600, q: 0.7 }, at); // pick attack "chk"
    }
    if (step === 0 || step === 16) this._gtr(riff[step] * 4, at, 0.28, 0.06 * P.leadLevel, false); // scream
    if (step >= 28) this._gtr(riff[step] * 2, at, 0.07, 0.1 * P.leadLevel, false);                 // climb tremolo

    if (local % 2 === 0) this._kickMetal(at);        // double-bass eighths
    if (local === 4 || local === 12) this._snareMetal(at);          // backbeat
    this._hat(at, (local % 2 === 0 ? 0.04 : 0.02) * P.hatLevel);
    if (step === 0) this._crash(at);
  }

  // The original synthwave loop (kept as a selectable track).
  _stepSynthwave(step, at) {
    const m = this.music;
    const N = { A2: 110.0, C3: 130.8, E3: 164.8, F2: 87.3, G2: 98.0, A3: 220.0, C4: 261.6, E4: 329.6, F3: 174.6, G3: 196.0 };
    const bar = Math.floor(step / 8);                 // 0..3
    const roots = [N.A2, N.F2, N.C3, N.G2];
    const arps = [[N.A3, N.C4, N.E4], [N.F3, N.A3, N.C4], [N.C4, N.E4, N.G3], [N.G3, N.C4, N.E4]];
    const root = roots[bar];
    const arp = arps[bar];

    if (step % 4 === 0) this.tone(m, { type: 'sawtooth', freq: root, freqEnd: root, dur: 0.26, gain: 0.16, attack: 0.006 }, at);
    if (step % 8 === 6) this.tone(m, { type: 'square', freq: root * 2, dur: 0.12, gain: 0.07 }, at);
    if (step % 2 === 1) {
      const note = arp[(step >> 1) % arp.length] * 2;
      this.tone(m, { type: 'triangle', freq: note, dur: 0.18, gain: 0.06, attack: 0.003 }, at);
    }
    if (step % 4 === 0) this._kick(at);
    if (step === 8 || step === 24) this._snare(at);
    if (step % 2 === 0) this._hat(at, step % 4 === 2 ? 0.05 : 0.03);
  }

  // A distorted power chord (root + fifth + octave, detuned for width, with a square voice
  // for extra grit) into the guitar/waveshaper chain. The envelope is a fast pick attack +
  // a short sustained body + quick release, so it reads as a palm-muted CHUG, not a blip.
  // `chord:false` plays a single note (lead/tremolo).
  _gtr(freq, at, dur, gain = 0.5, chord = true) {
    const ctx = this.ctx, P = this.params;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.003);     // near-instant pick attack
    g.gain.setValueAtTime(gain, at + dur * 0.7);               // hold the chug body
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);     // fast release (damped palm mute)
    g.connect(this.guitar);
    const voice = (f, level, type = 'sawtooth') => {
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

  _kick(at) {
    this.tone(this.drums, { type: 'sine', freq: 130, freqEnd: 45, dur: 0.18, gain: 0.22, attack: 0.002 }, at);
  }
  _kickMetal(at) {
    const k = this.params.kickLevel;
    this.tone(this.drums, { type: 'sine', freq: 155, freqEnd: 42, dur: 0.12, gain: 0.26 * k, attack: 0.001 }, at);
    this.noise(this.drums, { dur: 0.02, gain: 0.06 * k, type: 'highpass', freq: 3200 }, at);   // beater click
  }
  _snare(at) {
    this.noise(this.drums, { dur: 0.16, gain: 0.12, type: 'highpass', freq: 1400 }, at);
    this.tone(this.drums, { type: 'triangle', freq: 220, freqEnd: 160, dur: 0.1, gain: 0.05 }, at);
  }
  _snareMetal(at) {
    const s = this.params.snareLevel;
    this.noise(this.drums, { dur: 0.18, gain: 0.17 * s, type: 'highpass', freq: 1800 }, at);
    this.noise(this.drums, { dur: 0.08, gain: 0.08 * s, type: 'bandpass', freq: 420, q: 1 }, at);
    this.tone(this.drums, { type: 'triangle', freq: 245, freqEnd: 170, dur: 0.09, gain: 0.05 * s }, at);
  }
  _crash(at) {
    this.noise(this.drums, { dur: 0.6, gain: 0.1 * this.params.hatLevel, type: 'highpass', freq: 5200 }, at);
  }
  _hat(at, gain) {
    this.noise(this.drums, { dur: 0.04, gain, type: 'highpass', freq: 7000 }, at);
  }
}
