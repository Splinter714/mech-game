// In-game music tuning panel — a DOM overlay (toggle with the `P` key) of sliders grouped
// per instrument, wired straight to the live AudioEngine via Audio.setParam, so you tune the
// REAL soundtrack as it plays. "Copy settings" dumps a paste-ready defaults block (matching
// AudioEngine's this.params) to the clipboard + console so the chosen values can be baked in.
import { Audio } from '../audio/index.js';

// [paramKey, label, min, max, step]
const GROUPS = [
  ['Master', [
    ['master', 'Master', 0, 1, 0.01],
    ['music', 'Music level', 0, 0.6, 0.01],
    ['drumLevel', 'Drums', 0, 1.5, 0.01],
    ['tempo', 'Tempo (BPM)', 120, 240, 1],
  ]],
  ['Rhythm guitar', [
    ['guitarLevel', 'Level', 0, 0.4, 0.005],
    ['guitarDrive', 'Drive', 1, 40, 1],
    ['guitarSat', 'Saturation', 50, 600, 5],
    ['guitarClip', 'Hard clip', 1, 15, 0.5],
    ['guitarFold', 'Foldback', 0, 4, 0.05],
    ['guitarTone', 'Cab tone (Hz)', 1500, 9000, 50],
    ['guitarLowCut', 'Low cut (Hz)', 40, 400, 5],
  ]],
  ['Low foundation (bass)', [
    ['bassLevel', 'Level', 0, 1.2, 0.01],
    ['bassDrive', 'Drive', 0, 12, 0.5],
    ['bassTone', 'Tone (Hz)', 200, 3000, 20],
  ]],
];

const decimals = (step) => (step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3);
const fmt = (v, step) => Number(v).toFixed(decimals(step));

export function mountAudioPanel() {
  if (typeof document === 'undefined') return;
  let el = null;

  const open = () => {
    el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'top:10px', 'right:10px', 'width:300px', 'max-height:92vh', 'overflow:auto',
      'background:rgba(13,16,20,0.94)', 'border:1px solid #2a333f', 'border-radius:8px', 'padding:10px 12px',
      'font-family:monospace', 'font-size:11px', 'color:#c8d2dd', 'z-index:99999', 'box-shadow:0 6px 24px rgba(0,0,0,0.5)',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
    head.innerHTML = '<span style="color:#5ec8e0;font-size:13px">MUSIC TUNER</span>'
      + '<span style="color:#7c8794">[P] close</span>';
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

    for (const [groupName, rows] of GROUPS) {
      const h = document.createElement('div');
      h.textContent = groupName;
      h.style.cssText = 'color:#7c8794;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.5px';
      el.appendChild(h);
      for (const [key, label, min, max, step] of rows) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:3px 0';
        const lab = document.createElement('span');
        lab.textContent = label; lab.style.cssText = 'flex:0 0 96px';
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
        el.appendChild(row);
      }
    }

    const copy = document.createElement('button');
    copy.textContent = 'copy settings';
    copy.style.cssText = 'width:100%;margin-top:12px;padding:6px;background:#161b22;color:#7bd17b;border:1px solid #2a333f;border-radius:4px;cursor:pointer;font-family:monospace';
    copy.onclick = () => {
      const lines = Object.entries(Audio.params).map(([k, v]) => `      ${k}: ${v},`).join('\n');
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

  window.addEventListener('keydown', (e) => {
    if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      el ? close() : open();
    }
  });
}
