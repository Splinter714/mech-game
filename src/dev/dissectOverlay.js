// Dev-only live dissect overlay: interactive part breakdown in-browser (#545, ported from the
// horse game's src/dev/dissectOverlay.js — see that file for the original, which also has an
// animation/pose picker this port drops; see the note above `show()` below for why).
// - globalThis.__dissect.show(key) opens the overlay for one texture key
// - globalThis.__dissect.show({ label: target, ... }) opens it for a subject whose art is baked
//   across SEVERAL textures (a mech; a weapon's mount icon + projectile fx). #585 turned that from
//   a row of picker buttons into a real VIRTUAL ROOT LEVEL: every label is a normal, clickable
//   drill-down panel like any other, and the usual `= overlaid` panel at that level is therefore
//   the whole assembled subject (for a mech: the entire mech, standing).
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

// The two synthetic panels every level ends with. `◆ colour-coded` is deliberately NOT just
// "colour": #585 gave the weapon mounts a `color` LAYER tag (every lit glowDot/glowBar/emissive
// layer), and a real layer panel named `color` sitting next to a synthetic one named `colour`
// would read as a typo rather than as two different things.
const OVERLAID = '= overlaid';
const CODED = '◆ colour-coded';

// State. Unlike the horse game's version there is no pose/animation state — #545 deliberately
// dropped the pose picker (see `show()`'s note below), so a "frame" is just whichever texture key
// was shown.
//
// #585 collapsed what used to be three overlapping fields (`key`, `targets`, `activeLabel`) into
// TWO ideas:
//   `source` — whatever `show()` was handed, kept verbatim so a hot-reload can re-assemble.
//   `ops`    — ONE flat op list assembled from it (`assemble()` below). For a multi-texture
//              subject every op's layer is REWRITTEN to sit under its segment name, which is what
//              lets the virtual root be an ordinary crumb level: the target is just `crumb[0]`,
//              navigated and displayed exactly like `weapons` or `plate` at any deeper level.
// `crumb` is therefore the whole navigation state (empty = the root level), and the old
// `selectTarget()` + target-button row are gone: a target is picked by clicking its panel.
const state = { source: null, root: null, ops: [], sharedSpace: true, crumb: [] };
let wrap, breadcrumbEl, panelsEl;
let MAX_SCALE = 3;    // upper bound on panel scale (overridable with ?scale=)

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
    state.source = null; state.root = null; state.ops = []; state.crumb = []; idle();
  });
  headerRow.appendChild(closeBtn);

  wrap.append(headerRow);

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

  // Re-render on texture rebuild. The ops have to be RE-ASSEMBLED, not just redrawn: a reskin
  // replaces the registry entries `state.ops` was built from.
  window.addEventListener('artLayersUpdated', () => { if (state.source) { reassemble(); render(); } });

  globalThis.__dissect = {
    // #545: the horse game's `show()` also took a discovered `poses` list and drove a little
    // live-preview canvas + play/pause via `setPoses()`, so an owner could pick which
    // idle/walk/etc. frame set to dissect. That's species pose discovery (ArtPreviewScene's
    // `_posesFor`) with no equivalent concept in mech's art, so it was dropped rather than adapted.
    //
    // `keyOrMap` is either a bare texture key (unchanged since #545 — straight into that texture's
    // top-level parts, no virtual root) or a `{ label: target }` map, where each target is either
    // a texture key or `{ key, tags, z }` (see `assemble()`). #546 rendered a map as a row of
    // picker buttons and auto-opened one of them, remembering the last-picked label across calls;
    // #585 replaced all of that with the virtual root, so there is nothing to remember — every
    // `show()` lands on the ASSEMBLED subject, which is the whole point of the level ("show the
    // full mech, then click parts to drill down"). `root` names the breadcrumb's first segment.
    show(keyOrMap, part = null, root = null) {
      state.source = keyOrMap;
      state.root = root ?? (typeof keyOrMap === 'string' ? keyOrMap : rootNameFor(keyOrMap));
      state.crumb = part == null ? [] : [part];
      reassemble();
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
  panelsEl.innerHTML = '';
  fireDock(0); // tell the gallery to reclaim the reserved space
}

// A readable breadcrumb root when the caller didn't name one: the longest common prefix of the
// source texture keys (a mech's `mech1_turret`/`mech1_hull_0`/… → `mech1`). Falls back to a
// neutral word when the keys have no meaningful shared stem — e.g. a weapon's `wmount_x`/`wfx_x`.
function rootNameFor(map) {
  const keys = Object.values(map || {}).map((t) => (typeof t === 'string' ? t : t?.key)).filter(Boolean);
  if (!keys.length) return 'all';
  let p = keys[0];
  for (const k of keys) { while (p && !k.startsWith(p)) p = p.slice(0, -1); }
  p = p.replace(/[^A-Za-z0-9]+$/, '');
  return p.length >= 2 ? p : 'all';
}

// ── Assembling one flat op list ─────────────────────────────────────────────
// A single texture contributes its ops verbatim. A MULTI-TEXTURE subject contributes each source's
// ops with the layer path rewritten to sit under that source's segment name, so:
//   - names can't collide (each arm and each shoulder tags its own `plate`/`weapons`, and merged
//     naively they would fold into one panel showing both arms' plating at once), and
//   - the segment becomes an ordinary crumb level with no special-casing anywhere below.
// A target is either a texture key or `{ key, tags, z }`:
//   `tags`  — `{ sourceTag: pathUnderSegment }`. Only ops in those tag subtrees are taken, and
//             `''` ABSORBS the source tag into the segment name. That's what lets the dissect UI
//             show anatomy instead of texture layout: the mech's `turret` texture is split into a
//             `head` segment (its `head` tag, absorbed → `head.plate.body`) and a `torso` segment
//             (`centerTorso` absorbed + `decor` kept → `torso.spine`, `torso.decor.mast.tip`).
//             `turret`/`hull` are how the sprite is SPLIT FOR AIMING, not body parts, so they never
//             surface here.
//   `z`     — paint order for the assembled composite, independent of the panel order (which
//             follows the map's own key order, top-to-bottom anatomy). Without it the `= overlaid`
//             panel would stack the mech in whatever order reads best as a LIST — legs over body.
// `sharedSpace` records whether every source bakes on the same canvas size. Mech part textures all
// do (`DESIGN * ART_SCALE` square, same CENTER origin — see buildMechTextures), so their ops are
// directly comparable and composite into the standing mech. A weapon cell's `{mount, fx}` pair does
// NOT (different canvas sizes, unrelated subjects); `render()` falls back to per-panel bounding
// boxes and drops the composite panels there rather than overlaying two unrelated drawings.
function reassemble() {
  const reg = globalThis.__artLayers || {};
  const src = state.source;
  if (typeof src === 'string') {
    state.ops = reg[src]?.ops ?? [];
    state.sharedSpace = true;
    return;
  }
  const entries = Object.entries(src || {})
    .map(([label, t], i) => [label, typeof t === 'string' ? { key: t } : t, i])
    .filter(([, spec]) => reg[spec?.key])
    .sort((a, b) => (a[1].z ?? a[2]) - (b[1].z ?? b[2]));
  const ops = [];
  const sizes = new Set();
  for (const [label, spec] of entries) {
    const d = reg[spec.key];
    sizes.add(`${d.w}x${d.h}`);
    if (!spec.tags) {
      for (const o of d.ops) ops.push({ ...o, layer: `${label}.${o.layer}` });
      continue;
    }
    for (const [tag, under] of Object.entries(spec.tags)) {
      for (const o of d.ops) {
        if (o.layer !== tag && !o.layer.startsWith(`${tag}.`)) continue;
        const rest = o.layer === tag ? '' : o.layer.slice(tag.length + 1);
        ops.push({ ...o, layer: [label, under, rest].filter(Boolean).join('.') });
      }
    }
  }
  state.ops = ops;
  state.sharedSpace = sizes.size <= 1;
}

// ── Panel geometry ──────────────────────────────────────────────────────────
// The bbox a set of ops is drawn in, plus the scale that fits it to the dock. Auto-fit is
// essential rather than cosmetic: ops are super-sampled (ART_SCALE×), so a fixed scale would
// overflow the column — and the root level's bbox is the WHOLE mech, several times wider than any
// single part, which the same division handles by simply resolving to a smaller scale (capped at
// MAX_SCALE so a small drilled-in piece doesn't blow up instead).
function panelBox(ops) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of ops) { const b = bbox(o); x0=Math.min(x0,b[0]); y0=Math.min(y0,b[1]); x1=Math.max(x1,b[2]); y1=Math.max(y1,b[3]); }
  if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
  const scale = Math.min(MAX_SCALE, (DOCK_W - 30) / Math.max(1, (x1 - x0) + 10));
  const pad = Math.round(5 * scale), lh = 18;
  return {
    x0, y0, scale, pad, lh,
    cw: Math.ceil((x1 - x0) * scale) + pad * 2,
    ch: Math.ceil((y1 - y0) * scale) + pad * 2 + lh,
  };
}

function drawOp(ctx, o, box, override, alpha) {
  const { x0, y0, scale: S, pad } = box;
  const mx = (x) => pad + (x-x0)*S, my = (y) => pad + (y-y0)*S;
  ctx.fillStyle   = override || hex(o.color);
  ctx.globalAlpha = alpha ?? o.alpha;
  if      (o.t==='rect')    ctx.fillRect(mx(o.x), my(o.y), Math.max(1,o.w*S), Math.max(1,o.h*S));
  else if (o.t==='circle')  { ctx.beginPath(); ctx.arc(mx(o.x),my(o.y),o.r*S,0,Math.PI*2); ctx.fill(); }
  else if (o.t==='ellipse') { ctx.beginPath(); ctx.ellipse(mx(o.x),my(o.y),o.w/2*S,o.h/2*S,0,0,Math.PI*2); ctx.fill(); }
  else if (o.t==='tri')     { ctx.beginPath(); ctx.moveTo(mx(o.pts[0]),my(o.pts[1])); ctx.lineTo(mx(o.pts[2]),my(o.pts[3])); ctx.lineTo(mx(o.pts[4]),my(o.pts[5])); ctx.fill(); }
  else { ctx.beginPath(); o.points.forEach((p,i)=>i?ctx.lineTo(mx(p.x),my(p.y)):ctx.moveTo(mx(p.x),my(p.y))); ctx.fill(); }
  ctx.globalAlpha = 1;
}

// ── Main render ─────────────────────────────────────────────────────────────
function render() {
  wrap.style.display = 'flex';
  fireDock(DOCK_W); // gallery reserves matching left space so the dock doesn't cover cards

  if (!state.ops.length) {
    breadcrumbEl.textContent = `no layers for "${state.root ?? '(nothing)'}"`;
    panelsEl.innerHTML = '';
    return;
  }

  const part   = state.crumb.length ? state.crumb[state.crumb.length - 1] : null;
  const scoped = part ? state.ops.filter((o) => o.layer === part || o.layer.startsWith(`${part}.`)) : state.ops;
  // One panel per layer path exactly ONE segment deeper than where we're standing. (#585: this used
  // to be the op's WHOLE layer once drilled in, which was only ever right because every tag happened
  // to be exactly one level deep. With the mech body and the weapon mounts now tagged several levels
  // deep, taking the full path would flatten the tree and skip the intermediate levels entirely.)
  const depth   = part ? part.split('.').length : 0;
  const labelOf = (o) => o.layer.split('.').slice(0, depth + 1).join('.');
  const found   = new Set(scoped.map(labelOf));
  // At the virtual root, panel order follows the SOURCE MAP's own key order — the caller's
  // top-to-bottom anatomy — rather than the paint order the ops were assembled in.
  const groups = (!part && state.source && typeof state.source === 'object')
    ? Object.keys(state.source).filter((l) => found.has(l))
    : [...found];
  const colorOf = (g) => CODE[groups.indexOf(g) % CODE.length];
  const hasSubs = (g) => state.ops.some((o) => o.layer.startsWith(`${g}.`));

  // ── breadcrumb ────────────────────────────────────────────────────────────
  // `<root> › <segment> › … › <current>`; every non-last segment navigates back to that depth.
  // The virtual root's target (e.g. `leftArm`) is just crumb[0], so it appears here as an ordinary
  // clickable segment — which is what "the breadcrumb carries the target" means in practice.
  breadcrumbEl.innerHTML = '';
  const segments = [{ text: state.root, depth: 0 },
    ...state.crumb.map((seg, i) => ({ text: seg.split('.').pop(), depth: i + 1 }))];
  segments.forEach((seg, i) => {
    if (i > 0) breadcrumbEl.append(Object.assign(document.createElement('span'), { textContent: ' › ', style: 'opacity:0.4' }));
    if (i === segments.length - 1) {
      breadcrumbEl.append(Object.assign(document.createElement('span'), { textContent: seg.text, style: 'color:#cfd3da' }));
      return;
    }
    const btn = Object.assign(document.createElement('span'), { textContent: seg.text });
    Object.assign(btn.style, { cursor: 'pointer', opacity: '0.6', textDecoration: 'underline' });
    btn.addEventListener('click', () => { state.crumb = state.crumb.slice(0, seg.depth); render(); });
    breadcrumbEl.appendChild(btn);
  });

  // ── panel geometry ────────────────────────────────────────────────────────
  // Normally every panel shares ONE bbox so each piece renders in its true position within the
  // whole (an arm panel shows the arm off to the side, ghosted against the mech silhouette). The
  // exception is a root level whose sources don't share a coordinate space (a weapon's mount icon
  // vs. its projectile fx): there each panel is fitted to its own bounds and the composites are
  // dropped, since overlaying two unrelated drawings would be meaningless rather than useful.
  const perPanel  = !part && !state.sharedSpace;
  const sharedBox = perPanel ? null : panelBox(scoped);
  const opsOf     = (g) => scoped.filter((o) => labelOf(o) === g);
  const boxCache  = new Map();
  const boxFor    = (g) => {
    if (sharedBox) return sharedBox;
    if (!boxCache.has(g)) boxCache.set(g, panelBox(opsOf(g)));
    return boxCache.get(g);
  };

  // ── panels ────────────────────────────────────────────────────────────────
  panelsEl.innerHTML = '';
  const allPanels = perPanel ? groups : [...groups, OVERLAID, CODED];

  for (const name of allPanels) {
    const isAll   = name === OVERLAID;
    const isCoded = name === CODED;
    const drillable = !isAll && !isCoded && hasSubs(name);
    const box = isAll || isCoded ? sharedBox : boxFor(name);

    const cv  = document.createElement('canvas');
    cv.width  = box.cw; cv.height = box.ch;
    Object.assign(cv.style, { display: 'block', imageRendering: 'pixelated', flexShrink: '0' });
    if (drillable) { cv.style.cursor = 'pointer'; cv.title = `drill into ${name}`; }

    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#1e2026'; ctx.fillRect(0, 0, box.cw, box.ch);

    // Ghost of the whole scope behind the piece — only meaningful when the panel shares the
    // scope's bbox (otherwise the "ghost" would just be the piece itself, at its own fit).
    if (!isAll && !isCoded && sharedBox) for (const o of scoped) drawOp(ctx, o, box, '#8a8f98', 0.12);

    // content
    for (const o of scoped) {
      const g = labelOf(o);
      if      (isAll)   drawOp(ctx, o, box);
      else if (isCoded) drawOp(ctx, o, box, colorOf(g), Math.max(0.55, o.alpha));
      else if (g===name) drawOp(ctx, o, box);
    }

    // label + border — trim to the segment past the current drill depth so a deeply-nested tag
    // (e.g. 'leftArm.weapons.plasmaCoater.collar') reads as just 'collar' once you've drilled in,
    // instead of repeating the whole dotted path on every panel.
    const shortName = !isAll && !isCoded ? name.split('.').pop() : name;
    ctx.fillStyle  = isCoded || isAll ? '#cfd3da' : colorOf(name);
    ctx.font       = '11px monospace';
    ctx.fillText(drillable ? shortName + ' ▸' : shortName, 5, box.ch - box.lh/2 + 4);
    ctx.strokeStyle = drillable ? colorOf(name) : '#3a3d45';
    ctx.lineWidth   = drillable ? 1.5 : 1;
    ctx.strokeRect(0.5, 0.5, box.cw-1, box.ch-1);

    if (drillable) {
      cv.addEventListener('click', () => { state.crumb = [...state.crumb, name]; render(); });
    }

    panelsEl.appendChild(cv);
  }
}
