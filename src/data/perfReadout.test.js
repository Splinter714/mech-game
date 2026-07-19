// #334: the production performance readout's pure helpers. The behaviour that actually matters
// here is the FAILURE path — the GPU-string extension is unavailable under several privacy
// configurations, and this overlay ships to production, so it must degrade to 'unavailable' and
// never throw no matter how the WebGL API misbehaves.
import { describe, it, expect } from 'vitest';
import { rendererLabel, gpuRendererString, probeGl, clip, perfLines } from './perfReadout.js';

// Phaser's real constants: CANVAS 1, WEBGL 2, HEADLESS 3.
const WEBGL = 2, CANVAS = 1;

describe('rendererLabel', () => {
  it('names the two renderers Phaser can actually pick', () => {
    expect(rendererLabel(WEBGL, WEBGL, CANVAS)).toBe('WebGL');
    expect(rendererLabel(CANVAS, WEBGL, CANVAS)).toBe('Canvas');
  });

  it("falls back to 'unknown' for HEADLESS/undefined rather than lying about the renderer", () => {
    expect(rendererLabel(3, WEBGL, CANVAS)).toBe('unknown');
    expect(rendererLabel(undefined, WEBGL, CANVAS)).toBe('unknown');
  });
});

describe('gpuRendererString', () => {
  const fakeGl = (renderer) => ({
    getExtension: (name) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37446 } : null),
    getParameter: (p) => (p === 37446 ? renderer : null),
  });

  it('reports UNMASKED_RENDERER_WEBGL when the debug extension is available', () => {
    expect(gpuRendererString(fakeGl('  ANGLE (NVIDIA GeForce RTX 4090)  '))).toBe('ANGLE (NVIDIA GeForce RTX 4090)');
  });

  it("degrades to 'unavailable' with no gl at all (Canvas fallback, or WebGL blocked)", () => {
    expect(gpuRendererString(null)).toBe('unavailable');
    expect(gpuRendererString(undefined)).toBe('unavailable');
  });

  it("degrades to 'unavailable' when privacy settings hide the extension", () => {
    expect(gpuRendererString({ getExtension: () => null, getParameter: () => 'nope' })).toBe('unavailable');
  });

  it("degrades to 'unavailable' when the extension exists but returns nothing usable", () => {
    expect(gpuRendererString(fakeGl(null))).toBe('unavailable');
    expect(gpuRendererString(fakeGl('   '))).toBe('unavailable');
  });

  it('never throws even if the WebGL API itself throws', () => {
    const hostile = { getExtension: () => { throw new Error('blocked'); } };
    expect(() => gpuRendererString(hostile)).not.toThrow();
    expect(gpuRendererString(hostile)).toBe('unavailable');
    const hostileParam = {
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 1 }),
      getParameter: () => { throw new Error('blocked'); },
    };
    expect(gpuRendererString(hostileParam)).toBe('unavailable');
  });
});

describe('probeGl', () => {
  it("prefers the live renderer's own context — that's the one drawing the game", () => {
    const gl = { tag: 'live' };
    expect(probeGl(gl, () => { throw new Error('should not be called'); })).toBe(gl);
  });

  it('falls back to a throwaway canvas so a Canvas2D build can still name the GPU', () => {
    const gl = { tag: 'probe' };
    expect(probeGl(null, () => ({ getContext: (t) => (t === 'webgl' ? gl : null) }))).toBe(gl);
  });

  it('returns null (never throws) when no context can be made at all', () => {
    expect(probeGl(null, () => ({ getContext: () => null }))).toBe(null);
    expect(probeGl(null, () => { throw new Error('no canvas'); })).toBe(null);
    expect(probeGl(null, undefined)).toBe(null);
  });
});

describe('clip', () => {
  it('leaves short strings alone', () => {
    expect(clip('Apple M3 Max')).toBe('Apple M3 Max');
  });

  it('keeps the vendor/model prefix — the part that answers integrated-vs-discrete', () => {
    const long = 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const out = clip(long);
    expect(out.length).toBe(54);
    expect(out.startsWith('ANGLE (Intel, Intel(R) UHD Graphics 770')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('perfLines', () => {
  it('packs fps/renderer/resolution on one line and the GPU on a second', () => {
    const [a, b] = perfLines({
      fps: 59.6, renderer: 'WebGL', gpu: 'Apple M3 Max', width: 2560, height: 1440, dpr: 2,
    });
    expect(a).toBe('FPS 60  ·  WebGL  ·  2560x1440 @2x');
    expect(b).toBe('GPU Apple M3 Max');
  });

  it('shows a fractional DPR (a 4K Windows display) without a wall of decimals', () => {
    expect(perfLines({ fps: 24.2, renderer: 'Canvas', gpu: 'unavailable', width: 3840, height: 2160, dpr: 1.5 })[0])
      .toBe('FPS 24  ·  Canvas  ·  3840x2160 @1.5x');
  });
});
