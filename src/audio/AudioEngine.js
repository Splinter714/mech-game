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
  const a = Math.max(1, amount);                        // a=1 is identity (passthrough); <1 would silence
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (((i * 2) / n - 1) * a + 1) % 4;          // triangle-fold into [-1,1]
    const u = (t + 4) % 4;
    curve[i] = (u < 2 ? u : 4 - u) - 1;
  }
  return curve;
}

// A transparent soft-clip limiter curve for the master bus: linear below `th`, then a soft
// knee that rounds peaks toward (but never past) ~0.93 — so a hot mix stays loud without
// hard digital clipping (values never exceed 1.0).
function softClipCurve() {
  const n = 2048, c = new Float32Array(n), th = 0.7;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1, s = Math.sign(x), a = Math.abs(x);
    c[i] = a < th ? x : s * (th + (1 - th) * Math.tanh((a - th) / (1 - th)));
  }
  return c;
}

// ── Lead melody, in scale-degree notation over the track's key (E aeolian / natural minor) ─
// Degrees: 1=E 2=F# 3=G 4=A 5=B 6=C 7=D 8=E(8ve up), 9..= keep climbing. The lead line is a
// list of [degree, startStep, durationSteps] over the 32-sixteenth-step loop (2 bars). Edit
// LEAD_MELODY to change the tune; the Lead "Pitch" knob shifts the whole thing by octave.
const LEAD_SCALE = [329.63, 369.99, 392.0, 440.0, 493.88, 523.25, 587.33]; // E aeolian degrees 1-7 (E4..D5)
const leadFreq = (deg) => {
  const d = deg - 1, oct = Math.floor(d / 7);
  return LEAD_SCALE[((d % 7) + 7) % 7] * Math.pow(2, oct);
};
// Build the lead line from a DEGREE list + an x/o RHYTHM grid (1 char per sixteenth-step,
// 32 steps = the 2-bar loop): `x` = a note onset, `o` = hold/rest. Each x takes the next
// degree and the note sustains until the following x (so trailing o's = a held note).
function buildMelody(degrees, grid, len = 32) {
  let g = grid; while (g.length < len) g += grid;        // tile a short grid to fill the loop
  g = g.slice(0, len);
  const onsets = [];
  for (let i = 0; i < g.length; i++) if (g[i] === 'x' || g[i] === 'X') onsets.push(i);
  return onsets.map((start, k) => {
    const end = k + 1 < onsets.length ? onsets[k + 1] : g.length;
    return [degrees[k % degrees.length], start, end - start];
  });
}
// Lead 1 (full 2-bar phrase).
const LEAD_DEGREES = [1, 5, 3, 4, 3, 2, 3, 4, 5, 1];
const LEAD_RHYTHM  = 'xooxooxoxooxooxoxooxooxoxooooooo';   // x = onset, o = hold/rest
const LEAD_MELODY = buildMelody(LEAD_DEGREES, LEAD_RHYTHM);
// Lead 2 (1-bar pattern, repeats each bar).
const LEAD2_DEGREES = [1, 8, 1, 7, 1, 5, 6, 5, 4, 5];
const LEAD2_RHYTHM  = 'xxoxxoxxoxxoxoxo';
const LEAD2_MELODY = buildMelody(LEAD2_DEGREES, LEAD2_RHYTHM);

// Bass line — its own 64-step (4-bar) pattern, decoupled from the guitar riff, played on a
// steady repetitive sixteenth-note pulse (not the guitar's gallop). Written as a
// digit-per-sixteenth string so it reads like the line: each digit is an E-phrygian scale
// degree (1=E 2=F# 3=G 4=A 5=B 6=C 7=D) in the bass octave, and a `-` drops everything after
// it an octave. Here: 28 steps of E, an F–F / G–G turnaround, then an octave-down C pedal
// and D pedal (16 steps each).
const BASS_HZ = { E: 82.41, Fs: 92.50, G: 98.0, A: 110.0, B: 123.47, C: 130.81, D: 146.83 };
const BASS_DEG = { '1': 'E', '2': 'Fs', '3': 'G', '4': 'A', '5': 'B', '6': 'C', '7': 'D' };
function buildBass(spec) {
  const out = [];
  let oct = 1;
  for (const ch of spec) {
    if (ch === '-') { oct = 0.5; continue; }   // octave-down for the rest of the line
    out.push(BASS_HZ[BASS_DEG[ch]] * oct);
  }
  return out;
}
const BASS_LINE = buildBass('11111111111111111111111111112233-66666666666666667777777777777777');

// Drum grids — one char per sixteenth over the 32-step (2-bar) phrase; `x` = hit, anything
// else = rest. They repeat twice across the 64-step loop.
const KICK_GRID  = 'xxxxoxxxxxxxoxxxxxxxoxxxxxxxoxoo';
const SNARE_GRID = 'ooooxoooooooxoooooooxoooooooxoxx';

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
      drumLevel: 2, kickLevel: 1.09, snareLevel: 1.42, hatLevel: 0.88,
      // per-drum SOUND shaping
      kickPitch: 115, kickDecay: 0.2, kickClick: 0.095,
      snareTone: 1000, snareSnap: 1200, snareDecay: 0.3,
      hatFreq: 7500, hatDecay: 0.32,
      crashLevel: 0.93, crashBright: 4000, crashDecay: 1,
      // rhythm-guitar TONE (the distortion pedal + cab)
      guitarLevel: 0.38, guitarDrive: 40, guitarSat: 600, guitarClip: 1, guitarFold: 4,
      guitarTone: 7000, guitarLowCut: 40,
      // rhythm-guitar VOICING (which overtones make up each power chord)
      guitarFifth: 0, guitarFifthDetune: 0, guitarOctave: 2, guitarHigh: 0, guitarSquare: 0,
      chugLength: 0.1, pickLevel: 0,
      // LEAD 1 + LEAD 2 — two melodic leads, each with a full guitar-style chain + overtones
      leadLevel: 0.25, leadDrive: 40, leadSat: 600, leadClip: 1, leadFold: 4, leadLowCut: 400, leadTone: 7000,
      leadFifth: 0, leadOct: 1, leadPitch: 1,
      lead2Level: 0, lead2Drive: 40, lead2Sat: 600, lead2Clip: 8, lead2Fold: 0, lead2LowCut: 400, lead2Tone: 4200,
      lead2Fifth: 0, lead2Oct: 0, lead2Pitch: 1,
      // bass / low foundation (+ its own overtones)
      bassLevel: 0.7, bassDrive: 12, bassGrit: 200, bassTone: 3000,
      bassSub: 0.15, bassFifth: 0, bassOctave: 0.15,
    };
    this._fx = {};             // live node references the panel tweaks
  }

  // Adopt Phaser's AudioContext (scene.sound.context) and wire the bus graph once. Safe
  // to call repeatedly / with a missing context.
  init(ctx) {
    if (this.ctx || !ctx) return;
    this.ctx = ctx;
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

  // The riff's tonal low foundation: root + sub-octave + tunable FIFTH / octave overtones,
  // lightly driven + low-passed. The fifth/octave mixes let the bass carry overtones too.
  _bass(freq, at, dur, gain = 0.6) {
    if (gain <= 0) return;                          // silent — skip
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

  // A lead melody note into lead `prefix`'s bus: a detuned root pair plus tunable 5th/octave
  // overtone voices (like the bass). `type` picks the waveform so the leads differ in timbre.
  _leadNote(prefix, freq, at, dur, type = 'sawtooth', gain = 0.5) {
    if (gain <= 0) return;
    const ctx = this.ctx, P = this.params, bus = this[prefix + 'Bus'];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.006);
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
    const tempo = Math.max(1, this.track === 'synthwave' ? 104 : this.params.tempo);
    const stepDur = 60 / tempo / 4;   // sixteenth note
    const now = this.ctx.currentTime;
    if (this._nextStepTime < now) this._nextStepTime = now + 0.06;
    while (this._nextStepTime < now + 0.12) {
      this._playStep(this._step, this._nextStepTime);
      this._nextStepTime += stepDur;
      this._step = (this._step + 1) % (this.track === 'synthwave' ? 32 : 64);
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
    const E = 82.41, F = 87.31, G = 98.0, A = 110.0, B = 123.47, C = 130.81, D = 146.83;
    // 64-step root line (matches the bass's 4-bar pattern): an E-based first half, then power
    // chords on C and D under the bass's octave-down C / D pedals (the new implied chords).
    const riff = [E, E, E, E, E, E, E, E, E, E, E, E, G, G, F, F,
                  E, E, E, E, E, E, E, E, E, E, E, E, A, A, B, C,
                  C, C, C, C, C, C, C, C, C, C, C, C, C, C, C, C,
                  D, D, D, D, D, D, D, D, D, D, D, D, D, D, D, D];
    const P = this.params;
    const m = step % 32;                             // leads repeat their 32-step phrase
    const local = step % 16;
    const gallop = local % 4 !== 1;                  // hits on 0,2,3 of each beat (gallop)

    if (gallop) {
      this._gtr(riff[step], at, P.chugLength, 0.94, true);          // tight palm-muted chug (no overlap = no smear); loudness via guitarLevel
      this.noise(this.drums, { dur: 0.018, gain: P.pickLevel, type: 'bandpass', freq: 2600, q: 0.7 }, at); // pick attack "chk"
    }
    // Bass runs its own steady, repetitive sixteenth-note pulse (every step), independent of
    // the guitar's gallop, so the low end is a constant driving foundation.
    this._bass(BASS_LINE[step], at, P.chugLength + 0.02, 0.6);
    // Lead melodies (scale-degree notation): play any note starting this step. Two leads,
    // each with its own bus + timbre (lead 1 saw, lead 2 square).
    const sd = 60 / Math.max(1, P.tempo) / 4;
    for (const [deg, atStep, dur] of LEAD_MELODY) {
      if (atStep === m) this._leadNote('lead', leadFreq(deg) * P.leadPitch, at, dur * sd, 'sawtooth');
    }
    for (const [deg, atStep, dur] of LEAD2_MELODY) {
      if (atStep === m) this._leadNote('lead2', leadFreq(deg) * P.lead2Pitch, at, dur * sd, 'square');
    }

    if (KICK_GRID[m] === 'x') this._kickMetal(at);
    if (SNARE_GRID[m] === 'x') this._snareMetal(at);
    this._hat(at, (local % 2 === 0 ? 0.04 : 0.02) * P.hatLevel * this._mix('hat'));
    if (m === 0) this._crash(at);
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
    if (gain <= 0) return;                          // silent (level slider at 0) — skip
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
    const P = this.params, k = P.kickLevel * this._mix('kick');
    this.tone(this.drums, { type: 'sine', freq: P.kickPitch, freqEnd: 42, dur: P.kickDecay, gain: 0.26 * k, attack: 0.001 }, at);
    this.noise(this.drums, { dur: 0.02, gain: P.kickClick * k, type: 'highpass', freq: 3200 }, at);   // beater click
  }
  _snare(at) {
    this.noise(this.drums, { dur: 0.16, gain: 0.12, type: 'highpass', freq: 1400 }, at);
    this.tone(this.drums, { type: 'triangle', freq: 220, freqEnd: 160, dur: 0.1, gain: 0.05 }, at);
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
  _hat(at, gain) {
    this.noise(this.drums, { dur: this.params.hatDecay, gain, type: 'highpass', freq: this.params.hatFreq }, at);
  }
}
