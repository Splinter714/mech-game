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

import { hasOverride, getOverrideMeta, getStartMs, getTrimMs, getOverride } from '../audio/sfxOverrides.js';

// Fire before trajectory before impact — matches the panel's STAGES ordering. Explosion
// categories only have `fire`; stages absent from `params` are simply skipped.
const STAGE_ORDER = ['fire', 'trajectory', 'impact'];

// The FILE block for one overridden stage. `startMs`/`trimMs` come from #166 (null = "start at
// 0" / "play to end"); we surface an explicit start and end in ms so the trim window is
// unambiguous when pasted into chat. End = start + trim; when trim is null we fall back to the
// decoded buffer's real length (if known) and label it "end of file".
function overrideBlock(weaponId, stage) {
  const meta = getOverrideMeta(weaponId, stage);
  const name = meta?.name || '(unnamed file)';
  const startMs = getStartMs(weaponId, stage) ?? 0;
  const trimMs = getTrimMs(weaponId, stage);
  const buffer = getOverride(weaponId, stage);
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
    `[${stage}] FILE OVERRIDE  (real audio file — NOT procedural)`,
    `    weapon/category: ${weaponId}`,
    `    stage:           ${stage}`,
    `    file:            ${name}`,
    `    start:           ${startMs} ms`,
    endLine,
  ];
  if (fullMs != null) lines.push(`    full file length: ${fullMs} ms`);
  lines.push(`    → bake "${name}" into the repo as ${weaponId}'s ${stage} sound, ${bake}.`);
  return lines.join('\n');
}

// The procedural block for one un-overridden stage — its synthesis-layer JSON, indented to sit
// under the stage header. Keeps the historical `"stage": [...]` shape so it's still hand-
// editable / paste-able as before, just scoped to the one stage.
function proceduralBlock(stage, layers) {
  const json = JSON.stringify(layers, null, 2).replace(/\n/g, '\n    ');
  return `[${stage}] PROCEDURAL synthesis (unchanged)\n    "${stage}": ${json}`;
}

// Build the full copy payload for `weaponId` given its live `params` (Audio.getSfxParams).
// Returns a single string destined for both the clipboard and console.log.
export function buildSfxCopyText(weaponId, params) {
  const stages = STAGE_ORDER.filter((s) => params?.[s]?.length);
  const overridden = stages.filter((s) => hasOverride(weaponId, s));

  // No file overrides anywhere → reproduce the pre-#170 output verbatim: the whole params
  // object as a ready-to-paste DEFAULT_SFX entry (two-space indent + trailing comma). Keeping
  // this byte-for-byte means a fully-procedural weapon copies exactly as it always has.
  if (overridden.length === 0) {
    return `  ${weaponId}: ${JSON.stringify(params, null, 2).replace(/\n/g, '\n  ')},`;
  }

  // At least one stage is a real file — emit a per-stage labeled payload mixing FILE blocks and
  // procedural blocks, each clearly marked so the two kinds can't be confused.
  const blocks = stages.map((stage) => (
    hasOverride(weaponId, stage) ? overrideBlock(weaponId, stage) : proceduralBlock(stage, params[stage])
  ));
  const header = `${weaponId} — SFX export (file override + procedural mix)`;
  return `${header}\n\n${blocks.join('\n\n')}`;
}
