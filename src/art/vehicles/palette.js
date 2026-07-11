// Shared palette + tiny helpers for the non-mech VEHICLE art (turret / tank / drone /
// helicopter). These units now read as the SAME sleek WHITE faction as the player + enemy
// mechs (mirrors the `enemy` mech theme in mechPrims.js: dark outline, pale ceramic panels,
// a bright rim) rather than a separate dark industrial one. Each kind still passes its own
// `accent` colour (from ENEMY_KINDS.themeColor) so they differ from ONE ANOTHER on the
// "danger" bits (gun glow, sensor eye, rotor hub) — just on a light body now.
//
// Contrast: the biomes include arctic/snow (light terrain). A white body could vanish on
// snow, so the SILHOUETTE is carried by the dark `outline` (drawn around every plate) plus a
// darker `deep` used for the ground/drop shadow — both read against snow AND dark volcanic
// terrain. `tread` stays a mid-dark grey so tracks/barrels/guns pop off the pale panels.
// Design coords match mechPrims (origin = centre, −y = forward), so builders can reuse
// rectC/roundC/ellipseC/poly.

export const VEHICLE = {
  outline: 0x2b3441,      // dark blue-grey edge — carries the silhouette on snow + volcanic
  // #129: an extra near-white ring drawn OUTSIDE `outline` on every exterior silhouette shape.
  // `outline` alone reads fine against LIGHT terrain (snow, sand) but nearly matches DARK
  // terrain (volcanic ash, night grass/urban) in tone, so the silhouette vanished there — see
  // the long comment on mechPrims.js's `HALO` for the full reasoning. `halo` mirrors that same
  // fixed colour so vehicles and mechs use one consistent legibility treatment.
  halo: 0xfbfdff,
  deep: 0x39424f,         // shadow / underside / ground-drop shadow (kept dark so it reads on snow)
  bodyDk: 0xb6c2cf,       // lower body panel (subtle grey shading)
  body: 0xd3dae2,         // main body panel (pale)
  bodyHi: 0xeef2f6,       // upper body panel (near-white highlight)
  rim: 0xf6f9fb,          // top highlight rim (overhead light)
  rimHi: 0xffffff,        // brightest edge
  tread: 0x5a6675,        // tank track / barrel / dark mechanical (mid-dark, pops off white)
  treadHi: 0x8b97a6,      // track lug / barrel highlight
  glass: 0x51616f,        // cockpit glass (cool tint, darker so the canopy reads)
};

// A warm-accent glow ramp derived from a kind's accent colour, for the "hot" bits.
export function accentGlow(accent) {
  return { core: accent, hot: 0xffe6c0, halo: accent };
}
