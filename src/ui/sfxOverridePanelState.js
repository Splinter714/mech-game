// #177: the panel's per-stage "file override" display/edit state, factored out of
// weaponSfxPanel.js's _buildOverrideRow so it's plain data logic — no Phaser scene required —
// and so it works for ANY `(id, stage)` pair, not just a weapon pulled from the weapons
// catalog. WeaponSfxPanel calls this SAME function to compute what its sliders show; a unit
// test can call it directly against a synthetic non-weapon id (see sfxOverridePanelState.test.js)
// to prove the generalized (id, stage) plumbing works all the way up through the panel's own
// display logic, not just the raw storage layer (sfxOverrides.js), which was already generic.
import {
  hasOverride, getOverrideMeta, getOverride, getStartMs, getTrimMs, getFadeOutMs, getProcessing, getVolume,
  getLoopStartMs,
} from '../audio/sfxOverrides.js';
import { hasBaked } from '../audio/bakedSfx.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// #181: whether this (id, stage)'s procedural synthesis-layer editors (the tone/noise layer
// sliders that author the ORIGINAL procedural def) are meaningful to show at all. Once a real
// file — a dev-tool override OR a shipped bake — is what actually plays for this stage, the
// procedural layer settings are dead weight (they don't affect what's heard), so the panel
// hides them. This is deliberately independent of `active` (file-override-loaded) above: a
// stage can have NO runtime override yet still have a shipped bake (e.g. plasmaLance/fire,
// #175), in which case the procedural controls should still hide even though `active` is false.
function proceduralControlsVisibleFor(id, stage) {
  return !hasOverride(id, stage) && !hasBaked(id, stage);
}

// Returns `{ active: false, statusText }` when no file override is loaded for this (id, stage)
// — nothing else to show. Once a file IS loaded, returns everything a start/end/fade-out/
// volume/processing UI needs to render its current values: `fullSec` (the loaded file's real
// duration), `startSec`/`endSec` (the non-destructive trim window, #166), `fadeMs`/`fadeMax`
// (the fade-out duration and its cap, #174), `volume` (the overall gain multiplier, #182 —
// always a number, defaults to 1/unity), and `proc` (the sparse pitch/filter/reverb processing
// object, #172 — never null, defaults to `{}` so callers can read fields directly). `loopStartSec`
// (#185) is the held-loop-only loop-start position, clamped to `[startSec, endSec]` — defaults to
// `startSec` (today's pre-#185 behavior: the loop region is the whole played window) when unset,
// since getLoopStartMs() itself falls back to getStartMs().
// `proceduralControlsVisible` (#181) is always present regardless of `active`: false whenever
// EITHER a file override or a baked sound is active for this stage, true otherwise.
export function getOverrideRowState(id, stage) {
  const active = hasOverride(id, stage);
  const meta = active ? getOverrideMeta(id, stage) : null;
  const statusText = active ? `file override: ${meta?.name || '(loaded)'}` : 'file override: none (procedural)';
  const proceduralControlsVisible = proceduralControlsVisibleFor(id, stage);
  if (!active) return { active, statusText, meta: null, proceduralControlsVisible };

  const buffer = getOverride(id, stage);
  const fullSec = Math.max(buffer?.duration ?? 0, 0.01);
  const startMs = getStartMs(id, stage);
  const trimMs = getTrimMs(id, stage);
  const startSec = clamp(startMs != null ? startMs / 1000 : 0, 0, fullSec);
  const endSec = clamp(trimMs != null ? startSec + trimMs / 1000 : fullSec, startSec, fullSec);
  const playedMs = Math.max(0, Math.round((endSec - startSec) * 1000));
  const fadeMax = Math.max(10, playedMs);
  const fadeMs = clamp(getFadeOutMs(id, stage) ?? 0, 0, fadeMax);
  const volume = clamp(getVolume(id, stage), 0, 2);
  const proc = getProcessing(id, stage) || {};
  const loopStartMs = getLoopStartMs(id, stage);
  const loopStartSec = clamp(loopStartMs != null ? loopStartMs / 1000 : startSec, startSec, endSec);
  return {
    active, statusText, meta, fullSec, startSec, endSec, fadeMs, fadeMax, volume, proc, loopStartSec, proceduralControlsVisible,
  };
}
