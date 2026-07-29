// #523: persisted show/hide toggles for the pause menu's diagnostic readouts. Perf/control-
// method/AI-debug used to be gated entirely behind `import.meta.env.DEV` (absent from a
// production build); the version-number readout is brand new. All four now render in
// production too, opt-in via their own tiny localStorage flag — same "one key per toggle, try/
// catch, silently degrade to a default" pattern as `src/ui/weaponCardList.js`'s
// `loadAutoFireEnabled`/`saveAutoFireEnabled`. Deliberately NOT a centralized settings module —
// matches this codebase's existing ad hoc-per-toggle convention (see also
// `src/audio/sfxParams.js`'s `loadSfxParams`/`saveSfxParams`).
//
// All four default OFF. They were entirely invisible in production before this issue, and are
// diagnostic/debug tools most players have no reason to want on by default — Claude's call to
// make (flagged in the PR/report), trivial to flip if Jackson would rather they start on.

const KEYS = {
  version: 'mech-game-show-version-v1',
  perf: 'mech-game-show-perf-v1',
  controlMethod: 'mech-game-show-control-method-v1',
  aiDebug: 'mech-game-show-ai-debug-v1',
  // #555: the dev-menu toggle that replaces the old hardcoded shop.js UNLOCK_ALL flag — off by
  // default (real scrap-based progression), flippable per-device from the pause menu.
  unlockAll: 'mech-game-dev-unlock-all-v1',
  // #558: the player-facing master volume slider. Numeric (0..1), not a flag, so it gets its
  // own load/save pair below rather than going through loadFlag/saveFlag.
  volume: 'mech-game-volume-v1',
};

function loadFlag(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function saveFlag(key, enabled) {
  try {
    localStorage.setItem(key, enabled ? '1' : '0');
  } catch {
    // localStorage blocked/unavailable — the toggle still works this session.
  }
}

export function loadShowVersion() { return loadFlag(KEYS.version); }
export function saveShowVersion(enabled) { saveFlag(KEYS.version, enabled); }

export function loadShowPerf() { return loadFlag(KEYS.perf); }
export function saveShowPerf(enabled) { saveFlag(KEYS.perf, enabled); }

export function loadShowControlMethod() { return loadFlag(KEYS.controlMethod); }
export function saveShowControlMethod(enabled) { saveFlag(KEYS.controlMethod, enabled); }

export function loadShowAiDebug() { return loadFlag(KEYS.aiDebug); }
export function saveShowAiDebug(enabled) { saveFlag(KEYS.aiDebug, enabled); }

// #555: default OFF — real scrap-based unlock progression. Flipping this ON in the pause menu
// mirrors the old always-on shop.js UNLOCK_ALL flag, purely for dev/testing convenience.
export function loadDevUnlockAll() { return loadFlag(KEYS.unlockAll); }
export function saveDevUnlockAll(enabled) { saveFlag(KEYS.unlockAll, enabled); }

// #558: master volume, 0..1, defaults to 1 (unchanged from today's implicit full volume) so an
// existing player's experience doesn't change until they touch the new slider.
export function loadMasterVolume() {
  try {
    const raw = localStorage.getItem(KEYS.volume);
    const n = raw != null ? Number(raw) : 1;
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  } catch {
    return 1;
  }
}

export function saveMasterVolume(v) {
  try {
    localStorage.setItem(KEYS.volume, String(v));
  } catch {
    // localStorage blocked/unavailable — the slider still works this session.
  }
}
