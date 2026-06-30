// Generic multi-layer SFX player — a "layer" is the data for one e.tone()/e.noise() call.
// Turning each cue into an array of layers (mirroring how music.js turned synth code into a
// tunable data table) is what makes a weapon's sound editable: tune a layer's fields instead
// of hand-editing a hardcoded function. Add/change a sound = edit its layer array.

export function playLayers(e, bus, layers) {
  for (const l of layers || []) {
    if (!l) continue;
    if (l.kind === 'noise') e.noise(bus, l);
    else e.tone(bus, l);
  }
}
