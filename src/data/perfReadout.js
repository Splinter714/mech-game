// #334: the production performance readout. Jackson gets a great frame rate on macOS/Safari but
// a terrible one on a high-end Windows gaming rig in Edge, and FPS alone can't tell those apart —
// so the corner overlay reports the three things that plausibly explain the gap:
//
//   1. RENDERER — Phaser silently falls back to Canvas2D when a WebGL context can't be created.
//      #321/#333 measured ~8,000 Graphics commands per frame, a load WebGL absorbs and Canvas2D
//      cannot. This must be read LIVE off `game.renderer.type`, never inferred from the config.
//   2. GPU — on Windows hybrid-graphics machines the browser is often handed the integrated chip
//      rather than the discrete card, which would explain a "very nice gaming rig" losing to a Mac.
//   3. RESOLUTION + DPR — main.js renders at physical pixels (capped at MAX_DPR 2), so a 4K
//      Windows display can be pushing ~4x the fill rate of the Mac with no visible difference.
//
// Pure formatting/probing helpers live here (unit-tested, no Phaser); HudScene owns the Text object.
// This module deliberately does NOT diagnose or fix anything — it only reports.

// Phaser's renderer-type constants are plain ints (CANVAS 1, WEBGL 2, HEADLESS 3). Taking them as
// arguments keeps this file Phaser-free and makes the mapping trivially testable.
export function rendererLabel(type, WEBGL, CANVAS) {
  if (type === WEBGL) return 'WebGL';
  if (type === CANVAS) return 'Canvas';
  return 'unknown';
}

// The GPU string comes from the WEBGL_debug_renderer_info extension's UNMASKED_RENDERER_WEBGL.
// That extension is absent under several privacy configurations (Firefox's resistFingerprinting,
// some Safari/Brave settings, enterprise policy), and a Canvas-fallback game has no gl at all —
// so every failure mode collapses to the string 'unavailable'. NEVER throws: this ships to
// production and a broken overlay must not take the HUD down with it.
export function gpuRendererString(gl) {
  if (!gl) return 'unavailable';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return 'unavailable';
    const s = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    return (typeof s === 'string' && s.trim()) ? s.trim() : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// Best-effort WebGL context for the GPU probe. Prefers the live renderer's own context (that's the
// context actually drawing the game); falls back to a throwaway canvas so a Canvas2D-fallback build
// can still report which GPU the browser WOULD hand it — or confirm WebGL is unavailable entirely,
// which is itself the answer. Also never throws.
export function probeGl(rendererGl, makeCanvas) {
  if (rendererGl) return rendererGl;
  try {
    const c = makeCanvas?.();
    return c?.getContext?.('webgl') || c?.getContext?.('experimental-webgl') || null;
  } catch {
    return null;
  }
}

// Long GPU strings ("ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)") would
// span the screen, so they're clipped — the vendor/model prefix is the part that answers "integrated
// or discrete?", and it comes first.
export function clip(s, max = 54) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── #452 follow-up: WHERE the dev cluster sits ───────────────────────────────────────────────
//
// The FPS block and the control-scheme indicator are one cluster (Jackson wants them next to each
// other, not in opposite corners). #452 put them on the console's top edge; the follow-up moves
// them to the BOTTOM-RIGHT corner of the screen with a backing panel behind them, because the
// centred console no longer reaches the corners and bare monospace over terrain is unreadable.
//
// Laid out right-to-left from the corner off each object's MEASURED size, so a long GPU string
// grows the cluster leftward instead of running off the screen — and the backing is exactly the
// cluster's bounding box plus its padding, so it can never be the wrong size for what it backs.
// Pure: HudScene measures its Text objects and paints these numbers.
export const DEV_CLUSTER = { inset: 10, gap: 14, padX: 8, padY: 6 };

// `items` is `[{ w, h }]` in LEFT-TO-RIGHT order (the same order the cluster has always read in).
// Every item is BOTTOM-aligned, so the returned positions are for an origin of (0, 1).
export function devClusterLayout(W, H, items, opts = {}) {
  const { inset, gap, padX, padY } = { ...DEV_CLUSTER, ...opts };
  const live = items.filter(Boolean);
  if (!live.length) return { panel: null, positions: [] };
  const totalW = live.reduce((s, it) => s + (it.w || 0), 0) + gap * (live.length - 1);
  const maxH = live.reduce((m, it) => Math.max(m, it.h || 0), 0);
  const bottom = H - inset - padY;
  let x = W - inset - padX - totalW;
  const positions = live.map((it) => {
    const at = { x: Math.round(x), y: Math.round(bottom) };
    x += (it.w || 0) + gap;
    return at;
  });
  return {
    panel: {
      x: Math.round(W - inset - totalW - padX * 2),
      y: Math.round(bottom - maxH - padY),
      w: Math.round(totalW + padX * 2),
      h: Math.round(maxH + padY * 2),
    },
    positions,
  };
}

// Two compact lines. Line 1 is the per-frame number; line 2 is the static machine profile, so the
// overlay reads as "how fast / on what" at a glance without obstructing play.
export function perfLines({ fps, renderer, gpu, width, height, dpr }) {
  return [
    `FPS ${Math.round(fps)}  ·  ${renderer}  ·  ${Math.round(width)}x${Math.round(height)} @${(Math.round(dpr * 100) / 100)}x`,
    `GPU ${clip(gpu)}`,
  ];
}
