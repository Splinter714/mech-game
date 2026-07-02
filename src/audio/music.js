// Music data + synth transfer curves (#38, #43). The looping metal soundtrack is pure data:
// each track is a key (root Hz) + a mode (scale-degree offsets) + riff/gallop/drum grids in
// scale-degree notation, expanded by makeTrack() into the per-step arrays the engine's
// sequencer (_stepMetal) reads. Every track reuses the SAME instruments — only the notes
// differ — so **adding a track = one entry in STYLES** (rendered across the picked modes).
// The WaveShaper distortion curves (the guitar chain + the master soft-clip limiter) live
// here too, since they're the static DSP the engine wires into its bus graph at init.
//
// AudioEngine owns the live synthesis (the `this`-bound voices + lookahead sequencer); this
// module is the side-effect-free data/DSP layer it draws from.
// A WaveShaper transfer curve for guitar-style distortion (higher `k` = more crunch).
export function distortionCurve(k) {
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
export function hardClipCurve(drive) {
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
export function foldbackCurve(amount) {
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
export function softClipCurve() {
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
export function degHz(root, semis, deg) {
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
function makeTrack({ id, label, root, mode, tempo, gtr, bass, drums, stretch = 1,
                     ring = false, bassRing = false, chug = 0.08, bassLen = 0.12,
                     lead = [[], ''], lead2 = [[], ''] }) {
  const semis = MODES[mode];
  return {
    id, label, mode, tempo, semis, ring, bassRing, chug, bassLen,
    stretch,
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
const MODE_TAG = { aeolian: 'aeolian', phrygian: 'phrygian', harmonicMinor: 'harm.min',
                   dorian: 'dorian', mixolydian: 'mixolydian' };

const STYLES = [
  // THRASH GALLOP — the original: fast dd-dd palm-muted gallop, driving double-bass, slow 8-bar
  // harmony (stretch ×2) at 120 BPM, with the screaming leads. Restored to its first form.
  {
    // Rendered in aeolian (dark thrash) and mixolydian — the raised 3rd + ♭7 give the gallop a
    // brighter, major-tinged hard-rock swagger over the same dd-dd feel.
    key: 'gallop', name: 'gallop', tempo: 120, chug: 0.08, stretch: 2, modes: ['aeolian', 'mixolydian'],
    gtr: [[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 2,   // bar 1: E pedal, tail G-F#
           1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4, 5,   // bar 2: E pedal, tail A-B (climbs into C)
           6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 5, 4,   // bar 3: C pedal, tail B-A
           7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 5, 7],  // bar 4: D pedal, tail B-D
          GALLOP + GALLOP],
    bass: '1111111111111111' + '1111111111112233' + '-6666666666666666' + '7777777777777777',
    drums: { kick: 'xxxxoxxxxxxxoxxxxxxxoxxxxxxxoxoo', snare: 'ooooxoooooooxoooooooxoooooooxoxx',
             hat: 'xoxoxoxoxoxoxoxoxoxoxoxoxoxoxoxo' },
    lead:  [[1, 5, 3, 4, 3, 2, 3, 4, 5, 1], 'xooxooxoxooxooxoxooxooxoxooooooo'],
    lead2: [[1, 8, 1, 7, 1, 5, 6, 5, 4, 5], 'xxoxxoxxoxxoxoxo'],
  },
  // DOOM — slow + crushing: huge RINGING power chords (one per bar, sustained), a half-time kit
  // (snare on beat 3), and a droning bass. Leads open.
  {
    key: 'doom', name: 'doom', tempo: 76, ring: true, bassRing: true, bassLen: 0.6, modes: ['phrygian'],
    gtr: [[1, 2, 1, 6], WHOLES + WHOLES],            // root … 2 … root … 6 — four 1-bar drones
    bass: '1ooooooooooooooo' + '2ooooooooooooooo' + '-1ooooooooooooooo' + '6ooooooooooooooo',
    drums: { kick: 'xoooooooooooooooxooooooooooooooo', snare: 'ooooooooxoooooooooooooooxooooooo',
             hat: 'xoooooooxoooooooxoooooooxooooooo', ride: true, crash: 32 },
  },
  // DRIVE — up-tempo hard rock: relentless straight downpicked EIGHTH-note power chords (chug on
  // the beat), four-on-the-floor double kick + backbeat. Leads open.
  {
    // Rendered in aeolian (dark hard rock) and dorian — the raised 6th lifts the up-tempo
    // downpicked chug into a bright-minor drive without losing the minor tonic.
    key: 'drive', name: 'drive', tempo: 150, chug: 0.12, modes: ['aeolian', 'dorian'],
    gtr: [[1, 1, 1, 3,  1, 1, 5, 4,  1, 1, 1, 3,  7, 7, 5, 1], EIGHTHS + EIGHTHS],
    // Bass tracks the guitar's 2-bar riff: pedals the root under the quick passing 3, then
    // follows the structural tail moves (5-4 in bar 1, 7-7-5-1 in bar 2) so it locks instead of
    // clashing. Two bars, tiled under the guitar's repeat.
    bass: '1o1o1o1o1o1o5o4o' + '1o1o1o1o7o7o5o1o',
    drums: { kick: 'xoooxoooxoooxoooxoooxoooxoooxooo', snare: 'ooooxoooooooxoooooooxoooooooxooo',
             hat: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
  },
  // BLAST — extreme/fast: constant sixteenth-note TREMOLO picking over a blast beat (kick/snare
  // alternating every sixteenth). Leads open.
  {
    // Rendered in phrygian (dark ♭2 blast) and harmonicMinor — the raised-7th leading tone gives
    // the tremolo blast a neoclassical bite.
    key: 'blast', name: 'blast', tempo: 140, chug: 0.045, modes: ['phrygian', 'harmonicMinor'],
    gtr: [[1, 1, 7, 1,  3, 1, 7, 1,  5, 5, 7, 8,  7, 6, 5, 7], TREMOLO + TREMOLO],
    bass: '1111111177771111' + '3333111155557777' + '1111111166665555' + '7777555533331111',
    drums: { kick: 'xoxoxoxoxoxoxoxoxoxoxoxoxoxoxoxo', snare: 'oxoxoxoxoxoxoxoxoxoxoxoxoxoxoxox',
             hat: 'xoxoxoxoxoxoxoxoxoxoxoxoxoxoxoxo', crash: 64 },
  },
];

// Generate one track per (style × mode). A style may pin a subset of modes (e.g. a decided
// keeper renders in just that one mode); otherwise it's auditioned across all PICK_MODES.
// Id = `<style>-<mode>`; label = `<style> · <mode>`.
export const TRACKS = {};
for (const s of STYLES) {
  for (const mode of (s.modes || PICK_MODES)) {
    const id = `${s.key}-${mode}`;
    TRACKS[id] = makeTrack({
      id, label: `${s.name} · ${MODE_TAG[mode]}`, root: STYLE_ROOT, mode, tempo: s.tempo,
      gtr: s.gtr, bass: s.bass, drums: s.drums, stretch: s.stretch,
      ring: s.ring, bassRing: s.bassRing, chug: s.chug, bassLen: s.bassLen,
      lead: s.lead, lead2: s.lead2,
    });
  }
}
export const TRACK_IDS = Object.keys(TRACKS);
export const DEFAULT_TRACK = 'gallop-aeolian';
