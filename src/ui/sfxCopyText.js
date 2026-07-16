// #170: the paste-to-Claude payload built by the SFX tuner's "copy" button. Split out of
// weaponSfxPanel.js (which imports Phaser and so can't be unit-tested in the node env) into
// this pure, Phaser-free module — it only reads the #150/#166 override accessors, which have
// no Phaser dependency, so `buildSfxCopyText` is directly testable.
//
// Per-stage awareness: a weapon (or #107 destruction-explosion category) has up to three
// independently-overridable stages (fire / trajectory / impact). Each stage is EITHER a real
// loaded audio file (a #150 override, possibly #166-trimmed) OR procedural synthesis. The
// copy output now reflects that per stage:
//   - A stage WITH an active file override emits a clearly-labeled FILE block — the weapon/
//     category id, the stage, the verbatim filename (so Claude can locate it in the source
//     sound folder by name), and the start/end trim in MILLISECONDS — so the owner can paste
//     it to Claude to bake that trimmed file into the repo as the weapon's real shipped sound.
//   - A stage still PROCEDURAL keeps emitting its synthesis JSON, exactly as before.
// A weapon with NO overrides at all emits the historical whole-params JSON block byte-for-byte
// (see below), so pasting a fully-tuned procedural weapon back into DEFAULT_SFX is unchanged.

import {
  hasOverride, getOverrideMeta, getStartMs, getTrimMs, getOverride, getProcessing, getFadeOutMs, getVolume,
  getOverrideVariantCount, variantStage,
} from '../audio/sfxOverrides.js';
import { WEAPON_STAGES } from './weaponSfxStages.js';

// The FILE block for one overridden stage — or one VARIANT of a stage's pool (#195). `keyStage`
// is the actual (weaponId, stage) key to read the override's params from — either the plain
// `stage` (variant 0 / today's single-variant case) or a `#v${n}` pseudo-stage for variant n>0
// (see sfxOverrides.js's variantStage). `label` is what's printed in the header/bake instruction
// (the real stage name, plus a "variant N of M" suffix when the stage has more than one loaded).
// `startMs`/`trimMs` come from #166 (null = "start at 0" / "play to end"); we surface an explicit
// start and end in ms so the trim window is unambiguous when pasted into chat. End = start +
// trim; when trim is null we fall back to the decoded buffer's real length (if known) and label
// it "end of file".
function overrideBlock(weaponId, keyStage, stage, label = stage) {
  const meta = getOverrideMeta(weaponId, keyStage);
  const name = meta?.name || '(unnamed file)';
  const startMs = getStartMs(weaponId, keyStage) ?? 0;
  const trimMs = getTrimMs(weaponId, keyStage);
  const buffer = getOverride(weaponId, keyStage);
  const fullMs = buffer?.duration ? Math.round(buffer.duration * 1000) : null;
  const endMs = trimMs != null ? startMs + trimMs : fullMs;

  const endLine = trimMs != null
    ? `    end:             ${endMs} ms   (plays ${trimMs} ms from start)`
    : (fullMs != null
        ? `    end:             ${fullMs} ms   (end of file)`
        : '    end:             end of file');

  const bake = endMs != null
    ? `trimmed ${startMs}ms → ${endMs}ms`
    : `trimmed from ${startMs}ms to end of file`;

  const lines = [
    `[${label}] FILE OVERRIDE  (real audio file — NOT procedural)`,
    `    weapon/category: ${weaponId}`,
    `    stage:           ${stage}`,
    `    file:            ${name}`,
    `    start:           ${startMs} ms`,
    endLine,
  ];
  if (fullMs != null) lines.push(`    full file length: ${fullMs} ms`);

  // #172: the non-destructive playback processing chain (pitch/filter/reverb), when any of it is
  // set — so the copied recipe carries the full processing the owner tuned, not just the trim.
  // Each line is emitted only for a non-neutral param (a clean/unprocessed override adds none),
  // and the processing is summarised into the bake instruction too.
  const proc = getProcessing(weaponId, keyStage);
  const procNotes = [];
  if (proc?.detune) {
    lines.push(`    pitch:           ${proc.detune > 0 ? '+' : ''}${proc.detune} cents  (pitch+speed coupled)`);
    procNotes.push(`pitch ${proc.detune > 0 ? '+' : ''}${proc.detune} cents`);
  }
  if (proc?.filterType) {
    const fq = proc.filterFreq != null ? `${proc.filterFreq} Hz` : '(default freq)';
    const q = proc.filterQ != null ? `, Q ${proc.filterQ}` : '';
    lines.push(`    filter:          ${proc.filterType} @ ${fq}${q}`);
    procNotes.push(`${proc.filterType} filter @ ${fq}${q}`);
  }
  if (proc?.reverbMix > 0) {
    const size = proc.reverbSize != null ? `${proc.reverbSize}s` : '(default size)';
    lines.push(`    reverb:          mix ${proc.reverbMix}, size ${size}`);
    procNotes.push(`reverb mix ${proc.reverbMix} / size ${size}`);
  }

  // #174: the fade-out duration, when set — so the copied recipe carries the fade the owner
  // tuned (fade to silence over the last N ms before the trim/end point). Emitted only when a
  // real fade is active (0/absent adds no line), and summarised into the bake instruction too.
  const fadeOutMs = getFadeOutMs(weaponId, keyStage);
  if (fadeOutMs > 0) {
    lines.push(`    fade-out:        ${fadeOutMs} ms  (ramp to silence before the end)`);
    procNotes.push(`fade-out ${fadeOutMs} ms`);
  }

  // #182: the overall volume multiplier, when non-default — so the copied recipe carries the
  // gain the owner tuned. Emitted only when it differs from unity (1.0/absent adds no line).
  const volume = getVolume(weaponId, keyStage);
  if (volume !== 1) {
    lines.push(`    volume:          ${volume.toFixed(2)}x  (${Math.round(volume * 100)}%)`);
    procNotes.push(`volume ${volume.toFixed(2)}x`);
  }

  const procBake = procNotes.length ? `, then apply ${procNotes.join(', ')}` : '';
  lines.push(`    → bake "${name}" into the repo as ${weaponId}'s ${label} sound, ${bake}${procBake}.`);
  return lines.join('\n');
}

// #195: emit one FILE block per loaded variant of `stage`'s pool — a pool of exactly 1 (every
// stage before this feature, and any stage the owner hasn't added a second variant to) emits a
// SINGLE block with no "variant" suffix at all, byte-identical to the pre-#195 output. A pool of
// 2+ emits one block per variant, each labeled "stage (variant N of M)" so the export unambiguously
// distinguishes them (and can be pasted to bake all N files in as the shipped variant pool).
function overrideBlocksForStage(weaponId, stage) {
  const n = getOverrideVariantCount(weaponId, stage);
  if (n <= 1) return [overrideBlock(weaponId, stage, stage)];
  const blocks = [];
  for (let i = 0; i < n; i++) {
    blocks.push(overrideBlock(weaponId, variantStage(stage, i), stage, `${stage} (variant ${i + 1} of ${n})`));
  }
  return blocks;
}

// The procedural block for one un-overridden stage — its synthesis-layer JSON, indented to sit
// under the stage header. Keeps the historical `"stage": [...]` shape so it's still hand-
// editable / paste-able as before, just scoped to the one stage.
function proceduralBlock(stage, layers) {
  const json = JSON.stringify(layers, null, 2).replace(/\n/g, '\n    ');
  return `[${stage}] PROCEDURAL synthesis (unchanged)\n    "${stage}": ${json}`;
}

// Build the full copy payload for `weaponId` given its live `params` (Audio.getSfxParams).
// `stageList` is the target's REAL registered stage list — the same `[[key, label], ...]`
// shape the panel renders controls from (`this.stages`, set via setTarget/setWeapon —
// WEAPON_STAGES for a weapon/explosion category, or a single `[['play', 'PLAY']]` for a #178
// UI/pickup cue). Defaults to WEAPON_STAGES for back-compat with older call sites.
//
// #183 fix: this used to hardcode the 3-stage weapon shape (fire/trajectory/impact)
// regardless of what was actually being copied, so a single-stage UI sound (which has no
// `fire`/`impact` of its own — `Audio.getSfxParams` falls back to the unrelated weapon-shaped
// FALLBACK_SFX for any id with no DEFAULT_SFX entry) copied out fabricated fire/impact data
// and silently dropped any real file override tuned on its actual `play` stage. Now every
// stage considered — for both the override-detection pass and the plain-procedural fallback —
// comes from `stageList`, so the export can only ever contain the target's real stage(s).
// Returns a single string destined for both the clipboard and console.log.
export function buildSfxCopyText(weaponId, params, stageList = WEAPON_STAGES) {
  const stageKeys = stageList.map(([key]) => key);
  const overridden = stageKeys.filter((s) => hasOverride(weaponId, s));

  // No file overrides on any of this target's real stages → reproduce the pre-#170 output
  // verbatim, but scoped to just those stages (picked from `params` in stage order) rather
  // than the whole `params` object — for a weapon that's every key params has anyway (byte-
  // identical to before); for a single-stage UI sound with no procedural entry, this yields an
  // honestly-empty `{}` rather than fabricated fire/impact keys borrowed from the fallback.
  if (overridden.length === 0) {
    const picked = {};
    for (const s of stageKeys) if (params?.[s]?.length) picked[s] = params[s];
    return `  ${weaponId}: ${JSON.stringify(picked, null, 2).replace(/\n/g, '\n  ')},`;
  }

  // At least one real stage is a file override — emit a per-stage labeled payload mixing FILE
  // blocks and procedural blocks, each clearly marked so the two kinds can't be confused. Only
  // stages that either are overridden or have real procedural layers get a block.
  const stagesWithData = stageKeys.filter((s) => overridden.includes(s) || params?.[s]?.length);
  const blocks = stagesWithData.flatMap((stage) => (
    hasOverride(weaponId, stage) ? overrideBlocksForStage(weaponId, stage) : [proceduralBlock(stage, params[stage])]
  ));
  const header = `${weaponId} — SFX export (file override + procedural mix)`;
  return `${header}\n\n${blocks.join('\n\n')}`;
}
