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
    this.sfx = ctx.createGain(); this.sfx.gain.value = 0.85; this.sfx.connect(this.master);
    this.music = ctx.createGain(); this.music.gain.value = 0.30; this.music.connect(this.master);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.9;
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

  // ── Music (#38): looping synthwave ─────────────────────────────────────────────────
  // A 32-step (two-bar) loop over a minor i–VI–III–VII progression: a driving bass, an
  // offbeat arpeggio, and a four-on-the-floor-ish drum kit. Scheduled on a 25ms lookahead
  // clock so timing is sample-accurate regardless of frame rate. No-ops until the context
  // is running, so it "starts" the moment Phaser unlocks audio on first input.
  startMusic() {
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

  _schedule() {
    if (!this.ctx || this.ctx.state !== 'running' || this.muted) return;
    const tempo = 104;
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
    const m = this.music;
    // A minor scale frequencies (two octaves of the chord roots we need).
    const N = { A2: 110.0, C3: 130.8, E3: 164.8, F2: 87.3, G2: 98.0, A3: 220.0, C4: 261.6, E4: 329.6, F3: 174.6, G3: 196.0 };
    // Which chord this half-bar is on (i Am, VI F, III C, VII G).
    const bar = Math.floor(step / 8);                 // 0..3
    const roots = [N.A2, N.F2, N.C3, N.G2];
    const arps = [[N.A3, N.C4, N.E4], [N.F3, N.A3, N.C4], [N.C4, N.E4, N.G3], [N.G3, N.C4, N.E4]];
    const root = roots[bar];
    const arp = arps[bar];

    // Bass: root on the beat + a syncopated octave pulse (steps 0,3,6 of each beat group).
    if (step % 4 === 0) this.tone(m, { type: 'sawtooth', freq: root, freqEnd: root, dur: 0.26, gain: 0.16, attack: 0.006 }, at);
    if (step % 8 === 6) this.tone(m, { type: 'square', freq: root * 2, dur: 0.12, gain: 0.07 }, at);

    // Arp: an offbeat plucky lead climbing the chord.
    if (step % 2 === 1) {
      const note = arp[(step >> 1) % arp.length] * 2;
      this.tone(m, { type: 'triangle', freq: note, dur: 0.18, gain: 0.06, attack: 0.003 }, at);
    }

    // Drums.
    if (step % 4 === 0) this._kick(at);                       // four on the floor
    if (step === 8 || step === 24) this._snare(at);           // backbeat
    if (step % 2 === 0) this._hat(at, step % 4 === 2 ? 0.05 : 0.03);
  }

  _kick(at) {
    this.tone(this.music, { type: 'sine', freq: 130, freqEnd: 45, dur: 0.18, gain: 0.22, attack: 0.002 }, at);
  }
  _snare(at) {
    this.noise(this.music, { dur: 0.16, gain: 0.12, type: 'highpass', freq: 1400 }, at);
    this.tone(this.music, { type: 'triangle', freq: 220, freqEnd: 160, dur: 0.1, gain: 0.05 }, at);
  }
  _hat(at, gain) {
    this.noise(this.music, { dur: 0.04, gain, type: 'highpass', freq: 7000 }, at);
  }
}
