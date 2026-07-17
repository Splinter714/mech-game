// Single source of truth for how far FORWARD of a mount's front edge each weapon's drawn
// muzzle art actually reaches (#233 — "projectiles should originate from the tip of the
// weapon muzzle art"). Every mount draw fn below computes a barrel/tube length `L` (design
// units, at reference chassis size) and draws its foremost feature (an emitter glowDot, a
// blade tip, a launch-box edge, …) at `frontY - L * frac` — i.e. `frac` of the way along that
// modeled length. Before this fix, the arena's muzzle math (`partMuzzle`, shared.js) spawned
// every shot at the mount's front edge (`frontY`) itself: the BASE of the barrel, not its tip
// — a visible "shots leave from inside the arm/torso" gap of `len * frac` design units (scaled
// up to several world px), worst on the longest barrels (Rail Lance, Beam Laser).
// `barrelLen()` is called both by the draw fns (so the rendered art never drifts from this
// table) and by `weaponMuzzleTip()` below (so the fired shot always matches whatever actually
// got drawn, cap-clamp included).
export const BARREL_SPECS = {
  // category fallbacks (src/art/mounts/{energy,ballistic,missile,support,melee}.js)
  energy:        { len: 11,  frac: 1 },
  ballistic:     { len: 10,  frac: 1 },
  missile:       { len: 6.5, frac: 1 },
  support:       { len: 7,   frac: 1 },
  melee:         { len: 11,  frac: 1 },
  // bespoke energy (src/art/mounts/weapons.js)
  pulseLaser:    { len: 6,   frac: 1 },
  beamLaser:     { len: 13,  frac: 1 },
  railLance:     { len: 15,  frac: 1 },
  plasmaCannon:  { len: 8,   frac: 1 },
  flamethrower:  { len: 7,   frac: 1 },
  // bespoke ballistic
  autocannon:    { len: 12,  frac: 1 },
  machineGun:    { len: 10,  frac: 1 },
  shotgun:       { len: 8,   frac: 1 },
  napalm:        { len: 8,   frac: 0.9 },   // canister glow sits at 0.9L, not the full modeled tube
  // bespoke missile
  swarmRack:     { len: 7.5, frac: 1 },
  streakPod:     { len: 9,   frac: 1 },
  clusterRocket: { len: 8,   frac: 0.86 },  // packed warhead cluster sits at 0.86L
};

// The barrel/tube length (design units) for one mount, at chassis scale `s`, clamped so it
// never draws (or spawns a shot) past the texture canvas edge — mirrors the `cap` every draw
// fn already receives from drawWeaponMount. `id` may be a bespoke weapon id or a category id;
// unrecognised ids fall back to the energy category, same as drawWeaponMount's own fallback.
export function barrelLen(id, s, cap) {
  const spec = BARREL_SPECS[id] ?? BARREL_SPECS.energy;
  return Math.min(spec.len * s, cap);
}

// How far forward of a mounted weapon's front edge (`part.y - part.h/2`, design units) the
// weapon's ACTUAL drawn muzzle tip sits. `bodyLen` is the chassis's `chassis.art.bodyLen`
// (mechArt.js's `s = bodyLen / 38` — the same normalisation the draw fns use), so this returns
// the same design-unit length the art was actually drawn with, tip-fraction included.
export function weaponMuzzleTip(weaponId, catId, part, bodyLen, CENTER) {
  const s = bodyLen / 38;
  const frontY = part.y - part.h / 2;
  const cap = frontY + CENTER - 2;
  const id = BARREL_SPECS[weaponId] ? weaponId : catId;
  const spec = BARREL_SPECS[id] ?? BARREL_SPECS.energy;
  return barrelLen(id, s, cap) * spec.frac;
  // (barrelLen already applies spec.len; multiplying by spec.frac here, not inside barrelLen,
  // keeps barrelLen's return value equal to the exact modeled tube length the housings/rects
  // are drawn at — the frac only matters for where the tip GLOW sits within that tube.)
}
