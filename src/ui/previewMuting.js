// Pure DAW-style mute/solo logic for the Weapon Lab sound panel's live preview (#131, #171),
// factored out of weaponSfxPanel.js so it can be unit-tested without a Phaser scene. No Phaser,
// no Audio — just the audibility rule and the transient gain-zeroing that the panel wraps a
// single preview cue in.

// Whether a component (`${stage}:${li}` key) should actually sound in the live preview right
// now: soloing anything silences every non-soloed component regardless of its own mute state;
// otherwise it's just "not muted."
export function isAudible(key, mutedSet, soloedSet) {
  if (soloedSet.size) return soloedSet.has(key);
  return !mutedSet.has(key);
}

// Temporarily zero the real `gain` of every inaudible component among `stages` (the stage(s)
// about to play), synchronously, then return a closure that restores every saved value. This
// MUST bracket a single Audio.fire/trajectory/impact call: the cue reads each layer's `gain`
// synchronously at schedule time (sfxLayers.playLayers → AudioEngine.tone/noise bake it into the
// node graph via setValueAtTime, and skip the voice entirely when gain <= 0), so a value put
// back right after the call has already been "consumed" by the sound now playing asynchronously.
//
// Crucially it mutates the SAME layer objects the playback path reads (the caller passes the
// live `getSfxParams(weaponId)[stage]` layers) and never routes through Audio.setSfxParam, so the
// STORED params — and therefore copy/reset/persist/IndexedDB — never observe the muted 0 as long
// as the returned restore() runs. `components` is a flat list of `{ stage, li, layer }`.
export function applyPreviewMuting(components, stages, mutedSet, soloedSet) {
  const overrides = [];
  for (const { stage, li, layer } of components) {
    if (!stages.includes(stage)) continue;
    const key = `${stage}:${li}`;
    if (!isAudible(key, mutedSet, soloedSet)) {
      overrides.push({ layer, gain: layer.gain });
      layer.gain = 0;
    }
  }
  return () => { for (const o of overrides) o.layer.gain = o.gain; };
}
