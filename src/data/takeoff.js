// #415 — docked flyers are hidden until they LAUNCH. A flying kind (drone/helicopter) sitting in a
// base dock shouldn't be visible at all while dormant; the moment its base wakes it MATERIALISES
// over the dock — alpha fades 0→1 — hovers there for a beat, and only then lifts off into its
// normal flight AI. This is the pure timing/fade state for that "takeoff" beat, kept out of the
// scene so the curve and the release point are unit-tested; scenes/arena/enemies.js is the adapter
// that reads `alpha`/`done` each frame and applies them to the live view + movement.
//
// The fade completes over the FIRST `TAKEOFF_FADE_MS`, then the flyer holds fully visible for the
// remainder of `TAKEOFF_HOVER_MS` before releasing — so it reads as "shimmer in, hang over the
// pad, then peel off" rather than a unit that is still fading as it flies away. Owner: tunable.
export const TAKEOFF_FADE_MS = 420;    // how long the alpha 0→1 fade-in takes
export const TAKEOFF_HOVER_MS = 700;   // total beat (fade-in + full-visible hover) before liftoff

export function makeTakeoff() {
  return { elapsed: 0 };
}

// Advance a takeoff by `delta` ms. Returns the current alpha (0→1 across the fade) and whether the
// whole beat is over (`done` — release the flyer to its normal behaviour). `done` clamps alpha to 1.
export function stepTakeoff(state, delta) {
  state.elapsed += Math.max(0, delta);
  const done = state.elapsed >= TAKEOFF_HOVER_MS;
  const alpha = done ? 1 : Math.min(1, state.elapsed / TAKEOFF_FADE_MS);
  return { alpha, done };
}
