// #523: the pause menu's four persisted show/hide toggles. Same shape as
// ui/weaponCardList.test.js's autofire-toggle coverage — a fake localStorage, verifying the
// round-trip and the "blocked storage degrades to the default" fallback for each pair.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadShowVersion, saveShowVersion, loadShowPerf, saveShowPerf,
  loadShowControlMethod, saveShowControlMethod, loadShowAiDebug, saveShowAiDebug,
} from './pauseSettings.js';

function fakeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

const PAIRS = [
  ['version', loadShowVersion, saveShowVersion],
  ['perf', loadShowPerf, saveShowPerf],
  ['controlMethod', loadShowControlMethod, saveShowControlMethod],
  ['aiDebug', loadShowAiDebug, saveShowAiDebug],
];

describe('pauseSettings — persisted show/hide toggles', () => {
  const realLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    globalThis.localStorage = fakeStorage();
  });

  afterEach(() => {
    globalThis.localStorage = realLocalStorage;
  });

  it.each(PAIRS)('%s: defaults to false with nothing stored', (_name, load) => {
    expect(load()).toBe(false);
  });

  it.each(PAIRS)('%s: save then load round-trips true', (_name, load, save) => {
    save(true);
    expect(load()).toBe(true);
  });

  it.each(PAIRS)('%s: save then load round-trips false', (_name, load, save) => {
    save(true);
    save(false);
    expect(load()).toBe(false);
  });

  it.each(PAIRS)('%s: a blocked localStorage.getItem degrades load to false, never throws', (_name, load) => {
    globalThis.localStorage = { getItem() { throw new Error('blocked'); } };
    expect(() => load()).not.toThrow();
    expect(load()).toBe(false);
  });

  it.each(PAIRS)('%s: a blocked localStorage.setItem degrades save silently, never throws', (_name, _load, save) => {
    globalThis.localStorage = { setItem() { throw new Error('blocked'); } };
    expect(() => save(true)).not.toThrow();
  });

  it('the four toggles use distinct storage keys (one flip never bleeds into another)', () => {
    saveShowVersion(true);
    expect(loadShowPerf()).toBe(false);
    expect(loadShowControlMethod()).toBe(false);
    expect(loadShowAiDebug()).toBe(false);
  });
});
