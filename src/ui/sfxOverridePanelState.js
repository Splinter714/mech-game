// #177: the panel's per-stage "file override" display/edit state, factored out of
// weaponSfxPanel.js's _buildOverrideRow so it's plain data logic — no Phaser scene required —
// and so it works for ANY `(id, stage)` pair, not just a weapon pulled from the weapons
// catalog. WeaponSfxPanel calls this SAME function to compute what its sliders show; a unit
// test can call it directly against a synthetic non-weapon id (see sfxOverridePanelState.test.js)
// to prove the generalized (id, stage) plumbing works all the way up through the panel's own
// display logic, not just the raw storage layer (sfxOverrides.js), which was already generic.
import {
  hasOverride, getOverrideMeta, getOverride, getStartMs, getTrimMs, getFadeOutMs, getProcessing,
} from '../audio/sfxOverrides.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Returns `{ active: false, statusText }` when no file override is loaded for this (id, stage)
// — nothing else to show. Once a file IS loaded, returns everything a start/end/fade-out/
// processing UI needs to render its current values: `fullSec` (the loaded file's real
// duration), `startSec`/`endSec` (the non-destructive trim window, #166), `fadeMs`/`fadeMax`
// (the fade-out duration and its cap, #174), and `proc` (the sparse pitch/filter/reverb
// processing object, #172 — never null, defaults to `{}` so callers can read fields directly).
export function getOverrideRowState(id, stage) {
  const active = hasOverride(id, stage);
  const meta = active ? getOverrideMeta(id, stage) : null;
  const statusText = active ? `file override: ${meta?.name || '(loaded)'}` : 'file override: none (procedural)';
  if (!active) return { active, statusText, meta: null };

  const buffer = getOverride(id, stage);
  const fullSec = Math.max(buffer?.duration ?? 0, 0.01);
  const startMs = getStartMs(id, stage);
  const trimMs = getTrimMs(id, stage);
  const startSec = clamp(startMs != null ? startMs / 1000 : 0, 0, fullSec);
  const endSec = clamp(trimMs != null ? startSec + trimMs / 1000 : fullSec, startSec, fullSec);
  const playedMs = Math.max(0, Math.round((endSec - startSec) * 1000));
  const fadeMax = Math.max(10, playedMs);
  const fadeMs = clamp(getFadeOutMs(id, stage) ?? 0, 0, fadeMax);
  const proc = getProcessing(id, stage) || {};
  return { active, statusText, meta, fullSec, startSec, endSec, fadeMs, fadeMax, proc };
}
