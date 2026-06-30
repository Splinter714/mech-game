// The music tuner's control spec — which AudioEngine params each instrument group exposes, as
// [paramKey, label, min, max, step]. Data only (no UI), shared by the Music tab so the scene
// stays a thin renderer. Add a knob = one row here.

export const GROUPS = [
  ['Master + levels', [
    ['master', 'Master', 0, 2, 0.01],
    ['music', 'Music level', 0, 2, 0.01],
    ['tempo', 'Tempo (BPM)', 60, 240, 1],
    ['kickLevel', 'Kick', 0, 2, 0.01],
    ['snareLevel', 'Snare', 0, 2, 0.01],
    ['hatLevel', 'Hat', 0, 2, 0.01],
    ['crashLevel', 'Crash', 0, 2, 0.01],
    ['guitarLevel', 'Rhythm gtr', 0, 2, 0.01],
    ['leadLevel', 'Lead 1', 0, 2, 0.01],
    ['lead2Level', 'Lead 2', 0, 2, 0.01],
    ['bassLevel', 'Bass', 0, 2, 0.01],
  ]],
  ['Drums', [
    ['kickPitch', 'Kick pitch', 60, 320, 5],
    ['kickDecay', 'Kick decay', 0.04, 0.4, 0.01],
    ['kickClick', 'Kick click', 0, 0.2, 0.005],
    ['snareTone', 'Snr bright', 600, 4000, 50],
    ['snareSnap', 'Snr snap', 150, 1200, 10],
    ['snareDecay', 'Snr decay', 0.05, 0.5, 0.01],
    ['hatFreq', 'Hat bright', 3000, 12000, 100],
    ['hatDecay', 'Hat decay', 0.01, 0.6, 0.005],
    ['crashBright', 'Crash brt', 2000, 10000, 100],
    ['crashDecay', 'Crash dcy', 0.2, 3, 0.05],
  ]],
  ['Rhythm guitar', [
    ['guitarDrive', 'Drive', 1, 40, 1],
    ['guitarSat', 'Saturation', 50, 600, 5],
    ['guitarClip', 'Hard clip', 1, 15, 0.5],
    ['guitarFold', 'Foldback', 0, 4, 0.05],
    ['guitarTone', 'Low-pass', 1500, 9000, 50],
    ['guitarLowCut', 'High-pass', 40, 400, 5],
    ['guitarFifth', '5th', 0, 2, 0.05],
    ['guitarFifthDetune', '5th detune', 0, 0.05, 0.001],
    ['guitarOctave', 'Octave', 0, 2, 0.05],
    ['guitarHigh', 'High bite', 0, 2, 0.05],
    ['guitarSquare', 'Sqr grit', 0, 2, 0.05],
    ['chugLength', 'Note len', 0.03, 0.2, 0.005],
  ]],
  ['Lead 1 (saw)', [
    ['leadDrive', 'Drive', 1, 40, 1],
    ['leadSat', 'Saturation', 50, 600, 5],
    ['leadClip', 'Hard clip', 1, 15, 0.5],
    ['leadFold', 'Foldback', 0, 4, 0.05],
    ['leadTone', 'Low-pass', 400, 16000, 50],
    ['leadLowCut', 'High-pass', 40, 400, 5],
    ['leadFifth', '5th', 0, 1.5, 0.05],
    ['leadOct', 'Octave', 0, 1.5, 0.05],
    ['leadSub', 'Sub oct', 0, 1.5, 0.05],
    ['leadLength', 'Note len', 0.1, 2, 0.05],
    ['leadPitch', 'Pitch', 0.25, 2, 0.25],
  ]],
  ['Lead 2 (square)', [
    ['lead2Drive', 'Drive', 1, 40, 1],
    ['lead2Sat', 'Saturation', 50, 600, 5],
    ['lead2Clip', 'Hard clip', 1, 15, 0.5],
    ['lead2Fold', 'Foldback', 0, 4, 0.05],
    ['lead2Tone', 'Low-pass', 400, 16000, 50],
    ['lead2LowCut', 'High-pass', 40, 400, 5],
    ['lead2Fifth', '5th', 0, 1.5, 0.05],
    ['lead2Oct', 'Octave', 0, 1.5, 0.05],
    ['lead2Sub', 'Sub oct', 0, 1.5, 0.05],
    ['lead2Length', 'Note len', 0.1, 2, 0.05],
    ['lead2Pitch', 'Pitch', 0.25, 2, 0.25],
  ]],
  ['Bass', [
    ['bassDrive', 'Drive', 0, 12, 0.5],
    ['bassGrit', 'Grit', 1, 200, 1],
    ['bassTone', 'Low-pass', 200, 3000, 20],
    ['bassSub', 'Sub oct', 0, 1.5, 0.05],
    ['bassFifth', '5th', 0, 1.5, 0.05],
    ['bassOctave', 'Octave', 0, 1.5, 0.05],
    ['bassLength', 'Note len', 0.03, 0.3, 0.005],
  ]],
];

// Level keys that map to a mixer track → Solo/Mute affordances.
export const TRACK_OF = {
  kickLevel: 'kick', snareLevel: 'snare', hatLevel: 'hat', crashLevel: 'crash',
  guitarLevel: 'guitar', leadLevel: 'lead', lead2Level: 'lead2', bassLevel: 'bass',
};

// Base-oscillator waveform selector per group: which param it sets.
export const WAVE_PARAM = {
  'Rhythm guitar': 'guitarWave', 'Lead 1 (saw)': 'leadWave',
  'Lead 2 (square)': 'lead2Wave', 'Bass': 'bassWave',
};
export const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
export const WAVE_ABBR = { sine: 'sin', triangle: 'tri', sawtooth: 'saw', square: 'sqr' };
