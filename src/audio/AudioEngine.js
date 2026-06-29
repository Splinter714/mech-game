// Procedural audio — every sound is SYNTHESIZED from oscillators + filtered noise with
// envelopes, mirroring the art ethos: ZERO asset files (no .wav/.mp3). One singleton
// engine drives a small bus graph (master → sfx / music) on top of Phaser's WebAudio
// context, so it inherits Phaser's autoplay-unlock handling. Everything no-ops safely
// until the context exists and is running (e.g. before the first user gesture, or in the
// headless smoke run), so callers never need to guard.
//
//   SFX (#32 firing · #33 impacts · #34 footfalls · #35 abilities · #36 explosions)
//   Music (#38): a looping metal arrangement (guitar + bass + leads + drums) on a lookahead clock.

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

// ── Switchable metal tracks (#43) ───────────────────────────────────────────────────────
// Every track reuses the SAME instruments (the distorted-guitar chain, the bass path, the two
// leads, the drum voices) — only the NOTES differ, written in scale-degree notation so a track
// is pure data: a key (root Hz) + a mode (the 7 degrees' semitone offsets) + the riff/gallop
// patterns. Add a track = one entry in TRACKS; switch live with setTrack().
//
// Degrees are 1-based and may climb past 7 to go up octaves (8=root+8ve, etc). 1=root, then
// the mode's intervals. A track's bass + rhythm guitar share the low (root) octave; the leads
// sit two octaves up. The lead lines are intentionally left OPEN for new tracks (empty []) so
// the owner can drop a melody in later using the same notation — the arrangement still layers
// whatever leads exist across its three 8-bar sections.

// Mode = semitone offsets of the 7 scale degrees from the root.
const MODES = {
  aeolian:       [0, 2, 3, 5, 7, 8, 10],   // natural minor (dark, the classic metal default)
  dorian:        [0, 2, 3, 5, 7, 9, 10],   // minor with a bright raised 6th
  phrygian:      [0, 1, 3, 5, 7, 8, 10],   // ♭2 — that dark/Spanish metal flavor
  mixolydian:    [0, 2, 4, 5, 7, 9, 10],   // major-ish with a ♭7 — bright hard-rock gallop
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],   // raised 7th leading tone — neoclassical bite
};
// Degree (1-based, can exceed 7) → Hz over a root + mode.
function degHz(root, semis, deg) {
  const d = deg - 1, oct = Math.floor(d / 7), i = ((d % 7) + 7) % 7;
  return root * Math.pow(2, oct + semis[i] / 12);
}

// Build a lead line from a DEGREE list + an x/o RHYTHM grid (1 char per sixteenth-step, 32
// steps = the 2-bar loop): `x` = a note onset, `o` = hold/rest. Each x takes the next degree
// and sustains until the following x (so trailing o's = a held note). Returns [deg,start,dur].
function buildMelody(degrees, grid, len = 32) {
  if (!degrees.length) return [];
  let g = grid; while (g.length < len) g += grid;        // tile a short grid to fill the loop
  g = g.slice(0, len);
  const onsets = [];
  for (let i = 0; i < g.length; i++) if (g[i] === 'x' || g[i] === 'X') onsets.push(i);
  return onsets.map((start, k) => {
    const end = k + 1 < onsets.length ? onsets[k + 1] : g.length;
    return [degrees[k % degrees.length], start, end - start];
  });
}

// For a hit pattern, the gap (in steps, wrapping) from each onset to the next — so a "ringing"
// note can sustain exactly until the next pick.
function onsetGaps(hit, len) {
  const onsets = [];
  for (let i = 0; i < len; i++) if (hit[i]) onsets.push(i);
  const gap = new Array(len).fill(0);
  for (let k = 0; k < onsets.length; k++) {
    const cur = onsets[k], nxt = onsets[(k + 1) % onsets.length];
    let g = nxt - cur; if (g <= 0) g += len;            // wrap to the first onset of the next loop
    gap[cur] = g;
  }
  return gap;
}

// A melodic LINE played through the guitar/bass: a degree-per-ONSET list dropped on an x/o
// rhythm grid (x = pick/note, o = rest). The grid IS the track's rhythmic feel — gallop, straight
// chugs, eighth-note downpicks, whole-note doom drones, sixteenth-note tremolo, etc. Returns
// per-step arrays { freq, hit, gap } (gap = steps until the next onset, for ringing notes).
function buildLine(degrees, grid, root, semis) {
  const len = grid.length;
  const freq = new Array(len), hit = new Array(len).fill(false);
  let di = 0, last = degHz(root, semis, degrees.length ? degrees[0] : 1);
  for (let i = 0; i < len; i++) {
    if (grid[i] === 'x' || grid[i] === 'X') {
      last = degHz(root, semis, degrees[di % degrees.length]); hit[i] = true; di++;
    }
    freq[i] = last;                                      // non-onset steps repeat the held note
  }
  return { freq, hit, gap: onsetGaps(hit, len), len };
}

// A bass LINE that also supports octave drops: each char is a degree digit (an onset), `o`
// (rest), or `-` (toggle everything after it down/back an octave — the `-` consumes no step).
function buildBassLine(spec, root, semis) {
  const freq = [], hit = [];
  let oct = 1, last = degHz(root, semis, 1);
  for (const ch of spec) {
    if (ch === '-') { oct = oct === 1 ? 0.5 : 1; continue; }
    if (ch === 'o') { hit.push(false); freq.push(last); continue; }
    last = degHz(root, semis, +ch) * oct; hit.push(true); freq.push(last);
  }
  const len = freq.length;
  return { freq, hit, gap: onsetGaps(hit, len), len };
}

// Drum kit per track — a 32-step (2-bar) grid per voice (`x` = hit). `ride` swaps the hat's
// closed tick for a longer open wash; tracks pick whatever groove fits (gallop double-bass,
// groovy backbeat, half-time doom, four-on-the-floor, blast beat).
function makeDrums({ kick, snare, hat, crash = 32, ride = false }) {
  return { kick, snare, hat, crash, ride };
}

// A track is a compact config; makeTrack() expands it into the per-step arrays _stepMetal reads.
//   gtr/bass : [degrees, rhythmGrid]  — the grid is the FEEL; bass grid may use digits/o/- directly.
//   ring     : if true the guitar lets each chord RING to the next pick (doom drones / sustained
//              power chords); if false it's a tight palm-muted chug of `chug` seconds.
//   lead/lead2: [degrees, rhythm] — empty degrees leave the lead OPEN for the owner.
function makeTrack({ id, label, root, mode, tempo, gtr, bass, drums,
                     ring = false, bassRing = false, chug = 0.08, bassLen = 0.12,
                     lead = [[], ''], lead2 = [[], ''] }) {
  const semis = MODES[mode];
  return {
    id, label, mode, tempo, semis, ring, bassRing, chug, bassLen,
    leadRoot: root * 4,                                  // leads sit two octaves above the riff
    gtr: buildLine(gtr[0], gtr[1], root, semis),
    bass: buildBassLine(bass, root, semis),
    drums: makeDrums(drums),
    leadMelody: buildMelody(lead[0], lead[1]),
    lead2Melody: buildMelody(lead2[0], lead2[1]),
  };
}

// Reusable rhythm grids (1 char = a sixteenth; a bar = 16). Each track combines a guitar grid +
// a bass spec + a drum kit to get a DISTINCT style — not just a different scale over one gallop.
const GALLOP   = 'xoxxxoxxxoxxxoxxxoxxxoxxxoxxxoxx';   // dd-dd thrash gallop (2 bars)
const EIGHTHS  = 'xoxoxoxoxoxoxoxoxoxoxoxoxoxoxoxo';   // straight downpicked eighth notes
const TREMOLO  = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';   // every sixteenth — tremolo picking
const WHOLES   = 'xoooooooooooooooxooooooooooooooo';   // one ringing chord per bar (doom drone)

// ── Styles × modes ───────────────────────────────────────────────────────────────────────
// A STYLE is the mode-NEUTRAL identity of a track: its rhythmic feel (guitar grid, bass grid,
// drum kit), tempo, articulation, and any leads — all in scale-degree notation, so it can be
// rendered in ANY mode. We then generate one track per (style × mode) over a small set of metal
// modes, so the owner can audition every style in each mode and keep whichever fits. All styles
// share the same root (E) so switching is a pure mode comparison.
const STYLE_ROOT = 82.41;                                   // E2 — common key for every style
const PICK_MODES = ['aeolian', 'phrygian', 'harmonicMinor'];
const MODE_TAG = { aeolian: 'aeolian', phrygian: 'phrygian', harmonicMinor: 'harm.min' };

const STYLES = [
  // THRASH GALLOP — fast dd-dd palm-muted gallop, driving double-bass; the original, with leads.
  {
    key: 'gallop', name: 'gallop', tempo: 132, chug: 0.08,
    gtr: [[1, 1, 1, 1, 1, 1, 3, 2,  1, 1, 1, 1, 1, 1, 4, 5,
           6, 6, 6, 6, 6, 6, 5, 4,  7, 7, 7, 7, 7, 7, 5, 7], GALLOP + GALLOP],
    bass: '1111111111111111' + '1111111111112233' + '-6666666666666666' + '7777777777777777',
    drums: { kick: 'xxxxoxxxxxxxoxxxxxxxoxxxxxxxoxoo', snare: 'ooooxoooooooxoooooooxoooooooxoxx',
             hat: 'xoxoxoxoxoxoxoxoxoxoxoxoxoxoxoxo' },
    lead:  [[1, 5, 3, 4, 3, 2, 3, 4, 5, 1], 'xooxooxoxooxooxoxooxooxoxooooooo'],
    lead2: [[1, 8, 1, 7, 1, 5, 6, 5, 4, 5], 'xxoxxoxxoxxoxoxo'],
  },
  // GROOVE — mid-tempo syncopated palm-muted chugs (NOT a constant gallop) over a bouncy bass and
  // a backbeat kit. Leads open.
  {
    key: 'groove', name: 'groove', tempo: 120, chug: 0.11,
    gtr: [[1, 1, 4, 1, 6, 5, 1, 4,  1, 1, 4, 1, 6, 7, 6, 4],
          'xxoxooxxxoxooxoo' + 'xxoxooxxxoxooxoo'],
    bass: '1oo1oo1o4oo1o5o4' + '1oo1oo1o6oo5o4o5',
    drums: { kick: 'xooooxooxoooxoooxooooxooxoooxooo', snare: 'oooxoooooooxoooooooxoooooooxoooo',
             hat: 'xoxoxoxoxoxoxoxoxoxoxoxoxoxoxoxo' },
  },
  // DOOM — slow + crushing: huge RINGING power chords (one per bar, sustained), a half-time kit
  // (snare on beat 3), and a droning bass. Leads open.
  {
    key: 'doom', name: 'doom', tempo: 76, ring: true, bassRing: true, bassLen: 0.6,
    gtr: [[1, 2, 1, 6], WHOLES + WHOLES],            // root … 2 … root … 6 — four 1-bar drones
    bass: '1ooooooooooooooo' + '2ooooooooooooooo' + '-1ooooooooooooooo' + '6ooooooooooooooo',
    drums: { kick: 'xoooooooooooooooxooooooooooooooo', snare: 'ooooooooxoooooooooooooooxooooooo',
             hat: 'xoooooooxoooooooxoooooooxooooooo', ride: true, crash: 32 },
  },
  // DRIVE — up-tempo hard rock: relentless straight downpicked EIGHTH-note power chords (chug on
  // the beat), four-on-the-floor double kick + backbeat. Leads open.
  {
    key: 'drive', name: 'drive', tempo: 150, chug: 0.12,
    gtr: [[1, 1, 1, 3,  1, 1, 5, 4,  1, 1, 1, 3,  7, 7, 5, 1], EIGHTHS + EIGHTHS],
    bass: '1o1o1o1o1o1o1o1o' + '1o1o1o1o5o5o4o4o' + '1o1o1o1o1o1o1o1o' + '7o7o7o7o5o5o1o1o',
    drums: { kick: 'xoooxoooxoooxoooxoooxoooxoooxooo', snare: 'ooooxoooooooxoooooooxoooooooxooo',
             hat: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
  },
  // BLAST — extreme/fast: constant sixteenth-note TREMOLO picking over a blast beat (kick/snare
  // alternating every sixteenth). Leads open.
  {
    key: 'blast', name: 'blast', tempo: 160, chug: 0.045,
    gtr: [[1, 1, 7, 1,  3, 1, 7, 1,  5, 5, 7, 8,  7, 6, 5, 7], TREMOLO + TREMOLO],
    bass: '1111111177771111' + '3333111155557777' + '1111111166665555' + '7777555533331111',
    drums: { kick: 'xoxoxoxoxoxoxoxoxoxoxoxoxoxoxoxo', snare: 'oxoxoxoxoxoxoxoxoxoxoxoxoxoxoxox',
             hat: 'xoxoxoxoxoxoxoxoxoxoxoxoxoxoxoxo', crash: 64 },
  },
];

// Generate every (style × mode) track. Id = `<style>-<mode>`; label = `<style> · <mode>`.
const TRACKS = {};
for (const s of STYLES) {
  for (const mode of PICK_MODES) {
    const id = `${s.key}-${mode}`;
    TRACKS[id] = makeTrack({
      id, label: `${s.name} · ${MODE_TAG[mode]}`, root: STYLE_ROOT, mode, tempo: s.tempo,
      gtr: s.gtr, bass: s.bass, drums: s.drums,
      ring: s.ring, bassRing: s.bassRing, chug: s.chug, bassLen: s.bassLen,
      lead: s.lead, lead2: s.lead2,
    });
  }
}
const TRACK_IDS = Object.keys(TRACKS);
const DEFAULT_TRACK = 'gallop-aeolian';

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
  // A looping metal arrangement on a 25ms lookahead clock (sample-accurate regardless of frame
  // rate), driven by `this.track` — one of the generated (style × mode) tracks in TRACKS (default
  // 'gallop-aeolian'). The loop no-ops until the context is running, so it "starts" the moment
  // Phaser unlocks audio on first input. setTrack() swaps between tracks live.
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
    // Lead 1 plays bars 1-2 & 5-6 of a section; lead 2 plays all bars (when present).
    const sd = 60 / Math.max(1, P.tempo) / 4;        // one sixteenth, in seconds
    const block = Math.floor(step / 128);            // which 8-bar section (0,1,2)
    const bstep = step % 128;                        // position within the section
    const m = step % 32;                             // lead phrase position (32-step / 2 bars)
    const lead1Bars = bstep < 32 || (bstep >= 64 && bstep < 96);   // lead 1: bars 1-2 & 5-6

    // Rhythm guitar: pick on each onset of this track's grid. Either a tight palm-muted chug of
    // `chug` seconds, or — for doom/sustained tracks — a chord that RINGS to the next pick.
    const gi = step % T.gtr.len;
    if (T.gtr.hit[gi]) {
      const dur = T.ring ? T.gtr.gap[gi] * sd * 0.92 : T.chug;
      this._gtr(T.gtr.freq[gi], at, dur, 0.94, true);            // loudness via guitarLevel
    }
    // Bass follows its own rhythm grid (steady sixteenths, groovy syncopation, eighths, or a
    // sustained drone) — capped so a note never overruns the next onset.
    const bi = step % T.bass.len;
    if (T.bass.hit[bi]) {
      const cap = T.bass.gap[bi] * sd * 0.95;
      this._bass(T.bass.freq[bi], at, Math.min(T.bassRing ? Infinity : P.bassLength, cap), 0.6);
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
