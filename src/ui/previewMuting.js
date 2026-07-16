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

// #171 (re-fix): whether a whole STAGE should play at all, given the current mute/solo state.
// applyPreviewMuting only zeroes the `gain` of PROCEDURAL layers — but fire()/trajectory()/
// impact()/uiCue()/startHeld() all check for a file override or a shipped bake FIRST (sfx.js's
// playOverride / resolveBufferSource) and, when one exists, play that buffer (for startHeld, just
// the one-time intro — see sfx.js's startIntroThenSustain) and return WITHOUT ever touching the
// procedural layers' gain. That's why mute/solo looked broken again after the
// original #171 fix: once a weapon's stage has a live override or a baked sound (increasingly
// the common case — plasmaLance/pulseLaser/clusterRocket/deathExplosionMassive already ship
// baked fire cues), toggling Mute/Solo on that stage's mixer row rebuilt the panel and replayed
// the stage, but the replayed sound was the untouched buffer — gain-zeroing a procedural layer
// nobody was reading had zero audible effect.
//
// The fix: before playing a stage at all, check whether ANY of its components are audible under
// the current mute/solo state. If none are (every component muted, or something in a DIFFERENT
// stage is soloed), skip the Audio.* call entirely — silencing the stage outright works
// regardless of whether what would have played was procedural, a live override, or a baked file,
// since it never depends on being able to reach into the buffer's own gain node.
//
// A stage with no components at all (e.g. a non-weapon domain's stage with no procedural layers
// defined) is always treated as audible — there's nothing to mute in the mixer strip for it, so
// nothing should suppress it either.
export function isStageAudible(stage, components, mutedSet, soloedSet) {
  const stageComponents = components.filter((c) => c.stage === stage);
  if (!stageComponents.length) return true;
  return stageComponents.some(({ stage: s, li }) => isAudible(`${s}:${li}`, mutedSet, soloedSet));
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
