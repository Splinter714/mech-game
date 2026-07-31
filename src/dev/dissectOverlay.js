// Dev-only live dissect overlay: interactive part breakdown in-browser (#545, ported from the
// horse game's src/dev/dissectOverlay.js — see that file for the original, which also has an
// animation/pose picker this port drops; see the note above `show()` below for why).
// - globalThis.__dissect.show(key) opens the overlay for one texture key
// - globalThis.__dissect.show({ label: key, ... }) opens it with a target-picker row (#546) —
//   for a gallery cell whose art is baked as more than one texture (a mech's six parts; a
//   weapon's mount icon + projectile fx), so every one of them is reachable without leaving
//   the overlay.
// - Click a panel to drill into its sub-parts (▸ suffix = drillable)
// - Click the key/part segments in the header to navigate back up
// - Docked as a fixed RIGHT sidebar; panels stack vertically and scroll; × to close
// - Re-renders automatically on every 'artLayersUpdated' event (hot-reload)
// Activated from ArtPreviewScene gallery-cell clicks, or with ?dissect=<key>&part=<name>.

import { swallowDomInput } from './swallowDomInput.js';

// Docked as a fixed right sidebar. It fires a `dissectDockChanged` window event with its width
// on open and 0 on close; ArtPreviewScene listens to reserve matching gallery space so the dock
// never covers the cards. (Outside the gallery — e.g. ?dissect= on the real game — nothing
// listens and it just docks over the right edge.)
const DOCK_W = 300;
const fireDock = (width) => window.dispatchEvent(new CustomEvent('dissectDockChanged', { detail: { width } }));

const CODE = ['#e0907a', '#7fb5e8', '#86c98e', '#e8c66b', '#b79be0', '#e69bbf', '#8fd3c4', '#d99a6c'];
const hex  = (n) => '#' + (n >>> 0 & 0xffffff).toString(16).padStart(6, '0');
const bbox = (o) => o.t === 'rect'    ? [o.x, o.y, o.x+o.w, o.y+o.h]
  : o.t === 'circle'  ? [o.x-o.r, o.y-o.r, o.x+o.r, o.y+o.r]
  : o.t === 'ellipse' ? [o.x-o.w/2, o.y-o.h/2, o.x+o.w/2, o.y+o.h/2]
  : o.t === 'tri'     ? [Math.min(o.pts[0],o.pts[2],o.pts[4]), Math.min(o.pts[1],o.pts[3],o.pts[5]),
                         Math.max(o.pts[0],o.pts[2],o.pts[4]), Math.max(o.pts[1],o.pts[3],o.pts[5])]
  : [Math.min(...o.points.map(p=>p.x)), Math.min(...o.points.map(p=>p.y)),
     Math.max(...o.points.map(p=>p.x)), Math.max(...o.points.map(p=>p.y))];

// State: key = texture base key, crumb = stack of parent parts (null = top level). Unlike the
// horse game's version, there is no pose/animation state here — #545 deliberately dropped the
// pose picker (see `show()`'s note below), so a "frame" is just whichever texture key was shown.
//
// #546: `targets`/`activeLabel` are the multi-texture follow-up. A gallery cell whose art is
// baked as more than one texture (a mech's six parts; a weapon's mount icon + projectile fx)
// now passes a `{ label: textureKey }` map to `show()` instead of one bare key — `targets`
// holds that map, `activeLabel` which of its entries is currently open, and `key` (unchanged)
// is always just `targets[activeLabel]` in that case. A single-key `show(key)` call still
// works exactly as before: `targets` stays null and the picker row renders nothing.
const state = { key: null, crumb: [], targets: null, activeLabel: null };
let wrap, breadcrumbEl, targetsEl, panelsEl;
let SCALE = 3;        // working scale, recomputed per render to fit the dock width
let MAX_SCALE = 3;    // upper bound (overridable with ?scale=)

export function setupDissectOverlay() {
  const params = new URLSearchParams(location.search);
  MAX_SCALE = Number(params.get('scale') || 3);

  // ── outer wrapper: docked RIGHT sidebar, full height ──────────────────────
  wrap = document.createElement('div');
  Object.assign(wrap.style, {
    position: 'fixed', top: '0', right: '0', bottom: '0', width: DOCK_W + 'px', zIndex: '9999',
    fontFamily: 'monospace', fontSize: '12px', background: '#1e2026',
    boxShadow: '-2px 0 16px rgba(0,0,0,0.5)',
    display: 'flex', flexDirection: 'column',
  });

  // ── header row (pinned; panels scroll below it) ───────────────────────────
  const headerRow = document.createElement('div');
  Object.assign(headerRow.style, {
    background: '#1e2026', color: '#9ba3b0', padding: '7px 8px',
    userSelect: 'none', display: 'flex', alignItems: 'center', gap: '6px', flexShrink: '0',
  });

  breadcrumbEl = document.createElement('span');
  breadcrumbEl.style.flex = '1';
  headerRow.appendChild(breadcrumbEl);

  // × at the top-right of the dock. A wide hit target so it's easy to land on.
  const closeBtn = document.createElement('span');
  closeBtn.textContent = '×';
  Object.assign(closeBtn.style, { cursor: 'pointer', opacity: '0.6', padding: '0 7px', fontSize: '16px', flexShrink: '0' });
  closeBtn.addEventListener('click', () => {
    state.key = null; state.crumb = []; state.targets = null; state.activeLabel = null; idle();
  });
  headerRow.appendChild(closeBtn);

  wrap.append(headerRow);

  // ── target picker row (which of a multi-texture cell's baked textures is open) ────────────
  // #546: reuses the UI real estate #545 dropped the horse game's pose/animation picker from
  // (see the note on `show()` below) — a mech or weapon cell now has several candidate
  // textures instead of one animation to choose between, but it's the same "which one am I
  // looking at" slot. Empty/hidden whenever `state.targets` has 0 or 1 entries (nothing to
  // pick between), so a plain single-texture `show(key)` call looks exactly as before.
  targetsEl = document.createElement('div');
  Object.assign(targetsEl.style, {
    display: 'none', flexWrap: 'wrap', gap: '4px', padding: '0 8px 7px',
    flexShrink: '0', background: '#1e2026',
  });
  wrap.append(targetsEl);

  // ── panels column (stack vertically, scroll vertically) ───────────────────
  panelsEl = document.createElement('div');
  Object.assign(panelsEl.style, {
    display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px',
    overflow: 'auto', background: '#1e2026',
    flex: '1', minHeight: '0',
  });

  wrap.append(panelsEl);
  document.body.appendChild(wrap);

  // Block clicks/drags from reaching Phaser's input (which fires on window for events not
  // targeting the canvas) — otherwise interacting with the overlay dissects/re-clicks whatever
  // gallery cell sits behind it. Phaser uses mouse/touch, not pointer, events; see swallowDomInput.
  swallowDomInput(wrap);

  // re-render on texture rebuild
  window.addEventListener('artLayersUpdated', () => { if (state.key) render(); });

  globalThis.__dissect = {
    // crumb stores the navigation stack; last element = current part (null = top level)
    //
    // #545: the horse game's `show()` also took a discovered `poses` list and drove a little
    // live-preview canvas + play/pause via `setPoses()`, so an owner could pick which
    // idle/walk/etc. frame set to dissect. That's species pose discovery (ArtPreviewScene's
    // `_posesFor`) with no equivalent concept in mech's art, so it was dropped rather than
    // adapted. #546 gave that same UI slot a real, still-non-animation job instead (see
    // `targetsEl` above): `keyOrMap` may now be either a bare string (unchanged — single
    // texture, no picker) or a `{ label: textureKey }` map (a picker row opens, defaulting to
    // its first entry, or whichever label was last active if this map has that label too — so
    // re-clicking a different mech cell with the SAME part open, e.g. 'turret', stays on
    // 'turret' rather than resetting to the map's first key every time).
    show(keyOrMap, part = null) {
      if (keyOrMap && typeof keyOrMap === 'object') {
        state.targets = keyOrMap;
        const labels = Object.keys(keyOrMap);
        if (!labels.includes(state.activeLabel)) state.activeLabel = labels[0];
        state.key = keyOrMap[state.activeLabel];
      } else {
        state.targets = null;
        state.activeLabel = null;
        state.key = keyOrMap;
      }
      state.crumb = part == null ? [] : [part];
      render();
    },
  };

  // URL param initial state
  const initKey = params.get('dissect');
  if (initKey) globalThis.__dissect.show(initKey, params.get('part') || null);
  else idle();
}

function idle() {
  wrap.style.display = 'none';
  breadcrumbEl.innerHTML = '<span style="opacity:0.4">click a gallery cell to dissect</span>';
  targetsEl.style.display = 'none';
  targetsEl.innerHTML = '';
  panelsEl.innerHTML = '';
  fireDock(0); // tell the gallery to reclaim the reserved space
}

// Switch which of `state.targets`' textures is open, without leaving the overlay. Resets the
// drill-down crumb — a part name from one texture (e.g. turret's 'head') has no meaning against
// another (e.g. the left arm), so carrying it over would either silently show nothing or, worse,
// coincidentally match an unrelated same-named part on the new texture.
function selectTarget(label) {
  if (!state.targets || !(label in state.targets) || label === state.activeLabel) return;
  state.activeLabel = label;
  state.key = state.targets[label];
  state.crumb = [];
  render();
}

// ── Main render ─────────────────────────────────────────────────────────────
function render() {
  wrap.style.display = 'flex';
  fireDock(DOCK_W); // gallery reserves matching left space so the dock doesn't cover cards
  const rawKey = state.key;
  const part   = state.crumb.length ? state.crumb[state.crumb.length - 1] : null;

  // ── target picker (only when this cell offered more than one texture) ─────────────────────
  targetsEl.innerHTML = '';
  const labels = state.targets ? Object.keys(state.targets) : [];
  targetsEl.style.display = labels.length > 1 ? 'flex' : 'none';
  for (const label of labels) {
    const active = label === state.activeLabel;
    const btn = Object.assign(document.createElement('span'), { textContent: label });
    Object.assign(btn.style, {
      cursor: 'pointer', padding: '2px 7px', borderRadius: '3px', fontSize: '11px',
      background: active ? '#2c3542' : 'transparent',
      color: active ? '#efc14a' : '#7c8794',
      border: `1px solid ${active ? '#efc14a' : '#3a3d45'}`,
    });
    btn.addEventListener('click', () => selectTarget(label));
    targetsEl.appendChild(btn);
  }

  const reg = globalThis.__artLayers || {};
  const key = reg[rawKey] ? rawKey : null;
  if (!key) { breadcrumbEl.textContent = `no layers for "${rawKey}"`; panelsEl.innerHTML = ''; return; }

  const data = reg[key];
  const topOf   = (l) => l.split('.')[0];
  const scoped  = part ? data.ops.filter((o) => o.layer === part || o.layer.startsWith(`${part}.`)) : data.ops;
  const labelOf = part ? ((o) => o.layer) : ((o) => topOf(o.layer));
  const groups  = [...new Set(scoped.map(labelOf))];
  const colorOf = (g) => CODE[groups.indexOf(g) % CODE.length];
  const hasSubs = (g) => data.ops.some((o) => o.layer.startsWith(g + '.'));

  // ── breadcrumb ────────────────────────────────────────────────────────────
  breadcrumbEl.innerHTML = '';
  // Each segment in state.crumb is a part value (null = top level).
  // We display: key [> part0 [> part1 …]] and every non-last segment is clickable.
  const segments = [null, ...state.crumb]; // null = key root
  segments.forEach((seg, i) => {
    if (i > 0) breadcrumbEl.append(Object.assign(document.createElement('span'), { textContent: ' › ', style: 'opacity:0.4' }));
    const label = seg === null ? rawKey : seg;
    const isLast = i === segments.length - 1;
    if (isLast) {
      breadcrumbEl.append(Object.assign(document.createElement('span'), { textContent: label, style: 'color:#cfd3da' }));
    } else {
      const btn = Object.assign(document.createElement('span'), { textContent: label });
      Object.assign(btn.style, { cursor: 'pointer', opacity: '0.6', textDecoration: 'underline' });
      const targetDepth = i; // clicking segment i navigates to that depth
      btn.addEventListener('click', () => { state.crumb = state.crumb.slice(0, targetDepth); render(); });
      breadcrumbEl.appendChild(btn);
    }
  });

  // ── bounding box ─────────────────────────────────────────────────────────
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of scoped) { const b = bbox(o); x0=Math.min(x0,b[0]); y0=Math.min(y0,b[1]); x1=Math.max(x1,b[2]); y1=Math.max(y1,b[3]); }
  // Auto-fit each panel to the dock width (ops are super-sampled, so a fixed scale would
  // overflow the column). Cap at MAX_SCALE so small/drilled-in parts don't blow up.
  SCALE = Math.min(MAX_SCALE, (DOCK_W - 30) / Math.max(1, (x1 - x0) + 10));
  const pad = Math.round(5 * SCALE), lh = 18;
  const cw  = Math.ceil((x1-x0)*SCALE) + pad*2;
  const ch  = Math.ceil((y1-y0)*SCALE) + pad*2 + lh;

  // ── panels ────────────────────────────────────────────────────────────────
  panelsEl.innerHTML = '';

  function drawOp(ctx, o, override, alpha) {
    const mx = (x) => pad + (x-x0)*SCALE, my = (y) => pad + (y-y0)*SCALE;
    ctx.fillStyle   = override || hex(o.color);
    ctx.globalAlpha = alpha ?? o.alpha;
    if      (o.t==='rect')    ctx.fillRect(mx(o.x), my(o.y), Math.max(1,o.w*SCALE), Math.max(1,o.h*SCALE));
    else if (o.t==='circle')  { ctx.beginPath(); ctx.arc(mx(o.x),my(o.y),o.r*SCALE,0,Math.PI*2); ctx.fill(); }
    else if (o.t==='ellipse') { ctx.beginPath(); ctx.ellipse(mx(o.x),my(o.y),o.w/2*SCALE,o.h/2*SCALE,0,0,Math.PI*2); ctx.fill(); }
    else if (o.t==='tri')     { ctx.beginPath(); ctx.moveTo(mx(o.pts[0]),my(o.pts[1])); ctx.lineTo(mx(o.pts[2]),my(o.pts[3])); ctx.lineTo(mx(o.pts[4]),my(o.pts[5])); ctx.fill(); }
    else { ctx.beginPath(); o.points.forEach((p,i)=>i?ctx.lineTo(mx(p.x),my(p.y)):ctx.moveTo(mx(p.x),my(p.y))); ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  const allPanels = [...groups, '= overlaid', '◆ colour'];

  for (const name of allPanels) {
    const isAll   = name === '= overlaid';
    const isCoded = name === '◆ colour';
    const drillable = !isAll && !isCoded && hasSubs(name);

    const cv  = document.createElement('canvas');
    cv.width  = cw; cv.height = ch;
    Object.assign(cv.style, { display: 'block', imageRendering: 'pixelated', flexShrink: '0' });
    if (drillable) { cv.style.cursor = 'pointer'; cv.title = `drill into ${name}`; }

    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#1e2026'; ctx.fillRect(0, 0, cw, ch);

    // ghost of the whole scope
    if (!isAll && !isCoded) for (const o of scoped) drawOp(ctx, o, '#8a8f98', 0.12);

    // content
    for (const o of scoped) {
      const g = labelOf(o);
      if      (isAll)   drawOp(ctx, o);
      else if (isCoded) drawOp(ctx, o, colorOf(g), Math.max(0.55, o.alpha));
      else if (g===name) drawOp(ctx, o);
    }

    // label + border — trim to the segment past the current drill depth so a deeply-nested tag
    // (e.g. 'weapons.plasmaCoater.collar') reads as just 'collar' once you've drilled in, instead
    // of repeating the whole dotted path on every panel.
    const shortName = !isAll && !isCoded && part && name.startsWith(part + '.') ? name.slice(part.length + 1) : name;
    ctx.fillStyle  = isCoded || isAll ? '#cfd3da' : colorOf(name);
    ctx.font       = '11px monospace';
    ctx.fillText(drillable ? shortName + ' ▸' : shortName, 5, ch - lh/2 + 4);
    ctx.strokeStyle = drillable ? colorOf(name) : '#3a3d45';
    ctx.lineWidth   = drillable ? 1.5 : 1;
    ctx.strokeRect(0.5, 0.5, cw-1, ch-1);

    if (drillable) {
      cv.addEventListener('click', () => { state.crumb = [...state.crumb, name]; render(); });
    }

    panelsEl.appendChild(cv);
  }
}
