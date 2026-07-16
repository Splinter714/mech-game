// #177: the panel's per-stage "file override" display/edit state, factored out of
// weaponSfxPanel.js's _buildOverrideRow so it's plain data logic — no Phaser scene required —
// and so it works for ANY `(id, stage)` pair, not just a weapon pulled from the weapons
// catalog. WeaponSfxPanel calls this SAME function to compute what its sliders show; a unit
// test can call it directly against a synthetic non-weapon id (see sfxOverridePanelState.test.js)
// to prove the generalized (id, stage) plumbing works all the way up through the panel's own
// display logic, not just the raw storage layer (sfxOverrides.js), which was already generic.
import {
  hasOverride, getOverrideMeta, getOverride, getStartMs, getTrimMs, getFadeOutMs, getProcessing, getVolume,
  getLoopStartMs, getOverrideVariantCount, variantStage, MAX_VARIANTS,
} from '../audio/sfxOverrides.js';
import { hasBaked, getBaked, getBakedVariantCount } from '../audio/bakedSfx.js';

// Re-exported so weaponSfxPanel.js has one import source for both the variant-pool state helpers
// below and the cap they're built against.
export { MAX_VARIANTS };

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

// Returns `{ active: false, source: 'none', statusText }` when this (id, stage) has NEITHER a
// live runtime override NOR a shipped bake — nothing else to show. Otherwise returns everything
// a start/end/fade-out/volume/processing UI needs to render its current values: `fullSec` (the
// loaded file's real duration), `startSec`/`endSec` (the non-destructive trim window, #166),
// `fadeMs`/`fadeMax` (the fade-out duration and its cap, #174), `volume` (the overall gain
// multiplier, #182 — always a number, defaults to 1/unity), and `proc` (the sparse pitch/filter/
// reverb processing object, #172 — never null, defaults to `{}` so callers can read fields
// directly). `loopStartSec` (#185) is the held-loop-only loop-start position, clamped to
// `[startSec, endSec]`.
//
// #186: `source` distinguishes WHERE those values came from — `'override'` (a live runtime
// override is loaded, same as before this issue), `'baked'` (no live override yet, but a
// shipped bake exists for this stage — the values below are the bake's own recipe, read straight
// out of bakedSfx.js's getBaked/hasBaked rather than the sfxOverrides.js getters), or `'none'`
// (neither — the original "nothing to show" case, byte-for-byte unchanged from before #186).
// `active` means "there's something to show/edit" and is now true for BOTH 'override' and
// 'baked' (previously only true for a live override) — callers that only care about "is there
// anything real playing here" (e.g. proceduralControlsVisibleFor, already independent of this
// flag) are unaffected; callers that used `active` to mean "there's a LIVE override" should
// switch to checking `source === 'override'` instead.
//
// `proceduralControlsVisible` (#181) is always present regardless of `active`/`source`: false
// whenever EITHER a file override or a baked sound is active for this stage, true otherwise.
export function getOverrideRowState(id, stage) {
  const overrideActive = hasOverride(id, stage);
  const proceduralControlsVisible = proceduralControlsVisibleFor(id, stage);

  if (overrideActive) {
    const meta = getOverrideMeta(id, stage);
    const statusText = `file override: ${meta?.name || '(loaded)'}`;
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
      active: true, source: 'override', statusText, meta, fullSec, startSec, endSec, fadeMs, fadeMax,
      volume, proc, loopStartSec, proceduralControlsVisible,
    };
  }

  const baked = hasBaked(id, stage) ? getBaked(id, stage) : null;
  if (baked) {
    // #186: same shape as the 'override' branch above, but every value is read straight off the
    // bake's own recipe (getBaked) instead of the sfxOverrides.js getters, since no live override
    // record exists yet to read from. Editing any control seeds a real live override from this
    // SAME bake (see sfxOverrides.js's seedOverrideFromBaked, wired up in weaponSfxPanel.js) —
    // until then, this is a read-only preview of what's actually shipping.
    const statusText = 'file override: (baked) shipped sound — edit any control to customize';
    const fullSec = Math.max(baked.buffer?.duration ?? 0, 0.01);
    const startSec = clamp(baked.startMs != null ? baked.startMs / 1000 : 0, 0, fullSec);
    const endSec = clamp(baked.trimMs != null ? startSec + baked.trimMs / 1000 : fullSec, startSec, fullSec);
    const playedMs = Math.max(0, Math.round((endSec - startSec) * 1000));
    const fadeMax = Math.max(10, playedMs);
    const fadeMs = clamp(baked.fadeOutMs ?? 0, 0, fadeMax);
    const volume = clamp(baked.volume ?? 1, 0, 2);
    const proc = baked.processing || {};
    const loopStartMs = baked.loopStartMs ?? baked.startMs;
    const loopStartSec = clamp(loopStartMs != null ? loopStartMs / 1000 : startSec, startSec, endSec);
    return {
      active: true, source: 'baked', statusText, meta: null, fullSec, startSec, endSec, fadeMs, fadeMax,
      volume, proc, loopStartSec, proceduralControlsVisible,
    };
  }

  return {
    active: false, source: 'none', statusText: 'file override: none (procedural)', meta: null, proceduralControlsVisible,
  };
}

// #195: how many variant SLOTS the tuner panel should render for this (id, stage) — at least 1
// (the base slot, whether or not anything is loaded into it yet), up to however many are
// actually loaded across the live-override pool AND the shipped-bake pool (whichever has more —
// a stage with no live override at all but a shipped multi-variant bake still gets one row per
// baked variant so the owner can see/audition each), capped at MAX_VARIANTS. Every existing
// single-variant (id, stage) — which is the entire game before #195 — returns exactly 1, so a
// caller that only ever renders slot 0 sees no change in behavior.
export function getVariantSlotCount(id, stage) {
  const overrideN = getOverrideVariantCount(id, stage);
  const bakedN = getBakedVariantCount(id, stage);
  return Math.max(1, overrideN, bakedN);
}

// #195: getOverrideRowState's shape, once per variant slot (index 0 is byte-identical to
// getOverrideRowState(id, stage) — today's single-variant call, unchanged). Each further index
// reads the `#v${i}` pseudo-stage key the variant pool machinery uses internally (see
// sfxOverrides.js's variantStage) — WeaponSfxPanel renders one of these per row instead of a
// single getOverrideRowState call once a stage's pool holds more than one variant.
export function getVariantRowStates(id, stage) {
  const n = getVariantSlotCount(id, stage);
  const states = [];
  for (let i = 0; i < n; i++) states.push(getOverrideRowState(id, variantStage(stage, i)));
  return states;
}
