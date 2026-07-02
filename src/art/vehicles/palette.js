// Shared palette + tiny helpers for the non-mech VEHICLE art (turret / tank / drone /
// helicopter). These units read as a distinct HOSTILE faction from the sleek white enemy
// mechs: darker, industrial, warm-accented armour. Each kind passes its own `accent` colour
// (from ENEMY_KINDS.themeColor) so they still differ from one another while sharing the family.
//
// Colours are chosen so the silhouette reads at arena scale (~0.34): a dark outline, a couple
// of body greys, a light rim catching overhead light, and the kind's warm accent for the
// "danger" bits (gun glow, sensor eye, rotor hub). Design coords match mechPrims (origin =
// centre, −y = forward), so builders can reuse rectC/roundC/ellipseC/poly.

export const VEHICLE = {
  outline: 0x14171d,      // dark edge
  deep: 0x232a33,         // ambient-occlusion shadow / underside
  bodyDk: 0x3a434f,       // lower body panel
  body: 0x4a5563,         // main body panel
  bodyHi: 0x5c6a7a,       // upper body panel
  rim: 0x7a8798,          // top highlight rim (overhead light)
  rimHi: 0x9fb0c2,        // brightest edge
  tread: 0x20262e,        // tank track / dark mechanical
  treadHi: 0x39424d,      // track lug highlight
  glass: 0x2b3a4a,        // cockpit glass
};

// A warm-accent glow ramp derived from a kind's accent colour, for the "hot" bits.
export function accentGlow(accent) {
  return { core: accent, hot: 0xffe6c0, halo: accent };
}
