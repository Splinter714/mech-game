// In-game music tuning panel — a DOM overlay (toggle with the `P` key) of sliders grouped
// per instrument, wired straight to the live AudioEngine via Audio.setParam, so you tune the
// REAL soundtrack as it plays. "Copy settings" dumps a paste-ready defaults block (matching
// AudioEngine's this.params) to the clipboard + console so the chosen values can be baked in.
import { Audio } from '../audio/index.js';

// [paramKey, label, min, max, step]
const GROUPS = [
  ['Master + levels (mixer)', [
    ['master', 'Master', 0, 2, 0.01],
    ['music', 'Music level', 0, 2, 0.01],
    ['tempo', 'Tempo (BPM)', 60, 240, 1],
    ['kickLevel', 'Kick level', 0, 2, 0.01],
    ['snareLevel', 'Snare level', 0, 2, 0.01],
    ['hatLevel', 'Hat level', 0, 2, 0.01],
    ['crashLevel', 'Crash level', 0, 2, 0.01],
    ['guitarLevel', 'Rhythm guitar', 0, 2, 0.01],
    ['leadLevel', 'Lead 1 level', 0, 2, 0.01],
    ['lead2Level', 'Lead 2 level', 0, 2, 0.01],
    ['bassLevel', 'Bass level', 0, 2, 0.01],
  ]],
  ['Drums (sound)', [
    ['kickPitch', 'Kick pitch (Hz)', 60, 320, 5],
    ['kickDecay', 'Kick decay', 0.04, 0.4, 0.01],
    ['kickClick', 'Kick click', 0, 0.2, 0.005],
    ['snareTone', 'Snare bright (Hz)', 600, 4000, 50],
    ['snareSnap', 'Snare snap (Hz)', 150, 1200, 10],
    ['snareDecay', 'Snare decay', 0.05, 0.5, 0.01],
    ['hatFreq', 'Hat bright (Hz)', 3000, 12000, 100],
    ['hatDecay', 'Hat decay', 0.01, 0.6, 0.005],
    ['crashBright', 'Crash bright (Hz)', 2000, 10000, 100],
    ['crashDecay', 'Crash decay', 0.2, 3, 0.05],
  ]],
  ['Rhythm guitar (the chug)', [
    ['guitarDrive', 'Drive (amount)', 1, 40, 1],
    ['guitarSat', 'Saturation', 50, 600, 5],
    ['guitarClip', 'Hard clip', 1, 15, 0.5],
    ['guitarFold', 'Foldback', 0, 4, 0.05],
    ['guitarTone', 'Cab tone (Hz)', 1500, 9000, 50],
    ['guitarLowCut', 'Low cut (Hz)', 40, 400, 5],
    ['guitarFifth', '5th overtone', 0, 2, 0.05],
    ['guitarFifthDetune', '5th detune', 0, 0.05, 0.001],
    ['guitarOctave', 'Octave', 0, 2, 0.05],
    ['guitarHigh', 'High bite', 0, 2, 0.05],
    ['guitarSquare', 'Square grit', 0, 2, 0.05],
    ['chugLength', 'Chug length', 0.03, 0.2, 0.005],
    ['pickLevel', 'Pick attack', 0, 0.2, 0.005],
  ]],
  ['Lead 1 (saw)', [
    ['leadDrive', 'Drive (amount)', 1, 40, 1],
    ['leadSat', 'Saturation', 50, 600, 5],
    ['leadClip', 'Hard clip', 1, 15, 0.5],
    ['leadFold', 'Foldback', 0, 4, 0.05],
    ['leadTone', 'Tone (Hz)', 400, 16000, 50],
    ['leadLowCut', 'Low cut (Hz)', 40, 400, 5],
    ['leadFifth', '5th', 0, 1.5, 0.05],
    ['leadOct', 'Octave', 0, 1.5, 0.05],
    ['leadSub', 'Sub octave', 0, 1.5, 0.05],
    ['leadPitch', 'Pitch', 0.25, 2, 0.25],
  ]],
  ['Lead 2 (square)', [
    ['lead2Drive', 'Drive (amount)', 1, 40, 1],
    ['lead2Sat', 'Saturation', 50, 600, 5],
    ['lead2Clip', 'Hard clip', 1, 15, 0.5],
    ['lead2Fold', 'Foldback', 0, 4, 0.05],
    ['lead2Tone', 'Tone (Hz)', 400, 16000, 50],
    ['lead2LowCut', 'Low cut (Hz)', 40, 400, 5],
    ['lead2Fifth', '5th', 0, 1.5, 0.05],
    ['lead2Oct', 'Octave', 0, 1.5, 0.05],
    ['lead2Sub', 'Sub octave', 0, 1.5, 0.05],
    ['lead2Pitch', 'Pitch', 0.25, 2, 0.25],
  ]],
  ['Bass (low foundation)', [
    ['bassDrive', 'Drive (amount)', 0, 12, 0.5],
    ['bassGrit', 'Grit (distortion)', 1, 200, 1],
    ['bassTone', 'Tone (Hz)', 200, 3000, 20],
    ['bassSub', 'Sub octave', 0, 1.5, 0.05],
    ['bassFifth', '5th', 0, 1.5, 0.05],
    ['bassOctave', 'Octave', 0, 1.5, 0.05],
  ]],
];

const decimals = (step) => (step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3);
const fmt = (v, step) => Number(v).toFixed(decimals(step));

// Level-slider keys that map to a mixer track, so we can hang DAW-style Solo/Mute buttons off
// them. Solo/mute change audibility only — they never touch the slider value.
const TRACK_OF = {
  kickLevel: 'kick', snareLevel: 'snare', hatLevel: 'hat', crashLevel: 'crash',
  guitarLevel: 'guitar', leadLevel: 'lead', lead2Level: 'lead2', bassLevel: 'bass',
};

// Base-oscillator waveform selector per instrument group: which param it sets + the options.
const WAVE_PARAM = {
  'Rhythm guitar (the chug)': 'guitarWave',
  'Lead 1 (saw)': 'leadWave',
  'Lead 2 (square)': 'lead2Wave',
  'Bass (low foundation)': 'bassWave',
};
const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
const WAVE_ABBR = { sine: 'sin', triangle: 'tri', sawtooth: 'saw', square: 'sqr' };

export function mountAudioPanel() {
  if (typeof document === 'undefined') return;
  let el = null;

  // The app sets `* { touch-action: none }` (to stop the game from scrolling/zooming on
  // touch), which also kills scrolling INSIDE the panel. Re-enable vertical pan + momentum
  // scrolling for the panel and its contents so it can scroll when it spills off-screen.
  const style = document.createElement('style');
  style.textContent = '.mtuner,.mtuner *{touch-action:pan-y}.mtuner{overscroll-behavior:contain;-webkit-overflow-scrolling:touch}';
  document.head.appendChild(style);

  const open = () => {
    el = document.createElement('div');
    el.className = 'mtuner';
    el.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'width:336px', 'max-width:calc(100vw - 16px)',
      'max-height:92vh', 'max-height:92dvh', 'overflow-y:auto',
      'background:rgba(13,16,20,0.94)', 'border:1px solid #2a333f', 'border-radius:8px', 'padding:10px 12px',
      'font-family:monospace', 'font-size:11px', 'color:#c8d2dd', 'z-index:99999', 'box-shadow:0 6px 24px rgba(0,0,0,0.5)',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
    const title = document.createElement('span');
    title.textContent = 'MUSIC TUNER'; title.style.cssText = 'color:#5ec8e0;font-size:13px';
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '✕ close  [P]'; closeBtn.style.cssText = 'color:#7c8794;cursor:pointer';
    closeBtn.onclick = close;
    head.append(title, closeBtn);
    el.appendChild(head);

    // Track switch.
    const trackRow = document.createElement('div');
    trackRow.style.cssText = 'display:flex;gap:6px;margin-bottom:10px';
    for (const t of ['metal', 'synthwave']) {
      const b = document.createElement('button');
      b.textContent = t;
      b.style.cssText = `flex:1;padding:4px;background:${Audio.track === t ? '#1b2430' : '#161b22'};color:#c8d2dd;border:1px solid ${Audio.track === t ? '#efc14a' : '#2a333f'};border-radius:4px;cursor:pointer;font-family:monospace`;
      b.onclick = () => { Audio.setTrack(t); close(); open(); };
      trackRow.appendChild(b);
    }
    el.appendChild(trackRow);

    // Collected so toggling any Solo/Mute can repaint every track's button state.
    const mixRefreshers = [];
    const refreshAllMix = () => mixRefreshers.forEach((fn) => fn());

    for (const [groupName, rows] of GROUPS) {
      const h = document.createElement('div');
      h.textContent = groupName;
      h.style.cssText = 'color:#7c8794;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px';
      el.appendChild(h);

      // Waveform selector for this instrument (sets its base oscillator type live).
      const waveKey = WAVE_PARAM[groupName];
      if (waveKey) {
        const wrow = document.createElement('div');
        wrow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0 6px';
        const wlab = document.createElement('span');
        wlab.textContent = 'Waveform'; wlab.style.cssText = 'flex:0 0 116px';
        wrow.appendChild(wlab);
        const wbtns = [];
        const paintWaves = () => {
          const cur = Audio.params[waveKey];
          wbtns.forEach(({ b, w }) => {
            const on = w === cur;
            b.style.background = on ? '#5ec8e0' : '#161b22';
            b.style.color = on ? '#0d1014' : '#7c8794';
            b.style.border = `1px solid ${on ? '#5ec8e0' : '#2a333f'}`;
          });
        };
        for (const w of WAVES) {
          const b = document.createElement('button');
          b.textContent = WAVE_ABBR[w];
          b.title = w;
          b.style.cssText = 'flex:1;padding:3px 0;border-radius:3px;cursor:pointer;font-family:monospace;font-size:10px';
          b.onclick = () => { Audio.setParam(waveKey, w); paintWaves(); };
          wbtns.push({ b, w });
          wrow.appendChild(b);
        }
        paintWaves();
        el.appendChild(wrow);
      }

      for (const [key, label, min, max, step] of rows) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:3px 0';
        const lab = document.createElement('span');
        lab.textContent = label; lab.style.cssText = 'flex:0 0 116px';
        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step;
        inp.value = Audio.params[key]; inp.style.cssText = 'flex:1;min-width:0';
        const out = document.createElement('span');
        out.textContent = fmt(Audio.params[key], step);
        out.style.cssText = 'flex:0 0 44px;text-align:right;color:#efc14a';
        inp.addEventListener('input', () => {
          const v = parseFloat(inp.value);
          Audio.setParam(key, v);
          out.textContent = fmt(v, step);
        });
        row.append(lab, inp, out);
        // DAW-style Solo / Mute for tracks that have a mixer level. These toggle audibility
        // in the engine without changing the slider, so you can isolate a part while tuning.
        const track = TRACK_OF[key];
        if (track) {
          const mkBtn = (txt, onColor) => {
            const b = document.createElement('button');
            b.textContent = txt;
            b.style.cssText = `flex:0 0 18px;padding:2px 0;margin-left:4px;border-radius:3px;cursor:pointer;font-family:monospace;font-size:10px;font-weight:bold`;
            const paint = (on) => {
              b.style.background = on ? onColor : '#161b22';
              b.style.color = on ? '#0d1014' : '#7c8794';
              b.style.border = `1px solid ${on ? onColor : '#2a333f'}`;
            };
            return { b, paint };
          };
          const solo = mkBtn('S', '#efc14a');
          const mute = mkBtn('M', '#e06c6c');
          const refresh = () => { solo.paint(Audio.isSoloed(track)); mute.paint(Audio.isMuted(track)); };
          solo.b.onclick = () => { Audio.soloTrack(track); refreshAllMix(); };
          mute.b.onclick = () => { Audio.muteTrack(track); refreshAllMix(); };
          refresh();
          mixRefreshers.push(refresh);
          row.append(solo.b, mute.b);
        }
        el.appendChild(row);
      }
    }

    const copy = document.createElement('button');
    copy.textContent = 'copy settings';
    copy.style.cssText = 'width:100%;margin-top:12px;padding:6px;background:#161b22;color:#7bd17b;border:1px solid #2a333f;border-radius:4px;cursor:pointer;font-family:monospace';
    copy.onclick = () => {
      const lines = Object.entries(Audio.params)
        .map(([k, v]) => `      ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v},`).join('\n');
      const text = `params = {\n${lines}\n    };`;
      navigator.clipboard?.writeText(text).catch(() => {});
      console.log('[MUSIC TUNER] settings:\n' + text);
      copy.textContent = 'copied! (also in console)';
      setTimeout(() => { copy.textContent = 'copy settings'; }, 1500);
    };
    el.appendChild(copy);

    document.body.appendChild(el);
  };

  const close = () => { el?.remove(); el = null; };
  const toggle = () => (el ? close() : open());

  // Floating toggle button (so it's discoverable without the keyboard). Sits top-right;
  // when the panel opens it covers the button, and the panel's own ✕ / P closes it.
  const btn = document.createElement('button');
  btn.textContent = '♪ music';
  btn.setAttribute('aria-label', 'Open the music tuner');
  btn.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:99998',
    'background:rgba(13,16,20,0.92)', 'color:#5ec8e0', 'border:1px solid #2a333f', 'border-radius:6px',
    'padding:7px 12px', 'font-family:monospace', 'font-size:12px', 'cursor:pointer', 'box-shadow:0 2px 10px rgba(0,0,0,0.45)',
  ].join(';');
  btn.onmouseenter = () => { btn.style.borderColor = '#5ec8e0'; };
  btn.onmouseleave = () => { btn.style.borderColor = '#2a333f'; };
  btn.onclick = toggle;
  document.body.appendChild(btn);

  window.addEventListener('keydown', (e) => {
    if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      toggle();
    }
  });
}
