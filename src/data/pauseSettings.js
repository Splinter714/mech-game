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
  // #629: the gamepad aim-assist toggle (#620's turret pull). A real player-facing preference,
  // not a diagnostic readout — and the only flag here that defaults ON, so it doesn't go
  // through loadFlag (which defaults OFF); see loadAimAssist below.
  aimAssist: 'mech-game-aim-assist-v1',
  // #637: projectile LEADING — a non-tracking round is aimed where the target will be rather
  // than where it is. Deliberately its OWN toggle rather than riding on `aimAssist`: leading is
  // the gun aiming correctly, not a helper, so it applies to mouse and pad alike. Defaults ON
  // for the same reason, so it goes through loadProjectileLead (not loadFlag) below.
  projectileLead: 'mech-game-projectile-lead-v1',
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

// #629: gamepad aim assist (#620), default ON — matches the behaviour that shipped with #620, so
// nothing changes for a player who never opens the pause menu. Because the default is ON, the
// stored value is read as "anything but an explicit '0' means on" rather than loadFlag's
// "only '1' means on" — an absent key (never toggled, or localStorage blocked) reads as ON.
export function loadAimAssist() {
  try {
    return localStorage.getItem(KEYS.aimAssist) !== '0';
  } catch {
    return true;
  }
}
export function saveAimAssist(enabled) { saveFlag(KEYS.aimAssist, enabled); }

// #637: projectile leading, default ON — same "absent key reads as ON" treatment as aim assist
// above. Turning it OFF restores the pre-#637 behaviour (every non-tracking round fired straight
// at where the target IS, landing behind it by targetSpeed × flightTime).
export function loadProjectileLead() {
  try {
    return localStorage.getItem(KEYS.projectileLead) !== '0';
  } catch {
    return true;
  }
}
export function saveProjectileLead(enabled) { saveFlag(KEYS.projectileLead, enabled); }

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
