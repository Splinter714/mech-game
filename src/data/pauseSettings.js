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
