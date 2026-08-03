// Single source of truth for how far FORWARD of a mount's front edge each weapon's drawn
// muzzle art actually reaches (#233 — "projectiles should originate from the tip of the
// weapon muzzle art"). Every mount draw fn below computes a barrel/tube length `L` (design
// units, at reference chassis size) and draws its foremost feature (an emitter glowDot, a
// blade tip, a launch-box edge, …) at `frontY - L * frac` — i.e. `frac` of the way along that
// modeled length. Before this fix, the arena's muzzle math (`partMuzzle`, shared.js) spawned
// every shot at the mount's front edge (`frontY`) itself: the BASE of the barrel, not its tip
// — a visible "shots leave from inside the arm/shoulder" gap of `len * frac` design units (scaled
// up to several world px), worst on the longest barrels (Rail Lance, Beam Laser).
// `barrelLen()` is called both by the draw fns (so the rendered art never drifts from this
// table) and by `weaponMuzzleTip()` below (so the fired shot always matches whatever actually
// got drawn, cap-clamp included).
//
// #584 audit (2026-07-31), all 19 weapons / 13 bespoke mounts + 5 category fallbacks: every
// PROJECTING mount (a barrel/tube/blade that sticks out past the limb) was already correct at
// `frac: 1` — or at its own tuned fraction where the emitter sits short of the modeled tube
// (napalm 0.9). The FLUSH `weaponCollar()` mounts were not. Those sit ON the limb: the collar
// runs from `frontY` BACKWARD to `frontY + collarH` (collarH = 0.8L), so their emitters are all
// at a POSITIVE art-y offset — i.e. a NEGATIVE `frac`, since weaponMuzzleTip's return is a
// forward offset. They were left at the projecting-mount default of 1, which reported a muzzle
// tip a full modeled length AHEAD of a mount that never leaves the limb at all (shots spawning
// well in front of the gun). Now derived from each fn's own emitter placement, in units of L:
//   collarY = frontY + 0.4L (the collar's own centre)   y0 = frontY (its front edge)
// The reference point is the FOREMOST LIT feature — the emitter glow/launch cell, which is what
// reads as the muzzle. That's the same point every already-correct projecting entry uses (each
// one's `frac` lands exactly on its own glowDot), so it's one rule across the whole table.
export const BARREL_SPECS = {
  // category fallbacks (src/art/mounts/{energy,ballistic,missile,support,melee}.js)
  energy:        { len: 11,  frac: 1 },
  ballistic:     { len: 10,  frac: 1 },
  // flush collar mount: foremost launch cell at y0 + collarH*0.28 = frontY + 0.224L
  missile:       { len: 6.5, frac: -0.224 },
  support:       { len: 7,   frac: 1 },
  melee:         { len: 11,  frac: 1 },
  // bespoke energy (src/art/mounts/weapons.js)
  pulseLaser:    { len: 6,   frac: 1 },
  // #618: beamLaser's own bespoke mount fn was deleted — WEAPON_MOUNT_ART.beamLaser (weapons.js)
  // now draws with railLance's fn instead, which hardcodes its own `barrelLen('railLance', ...)`
  // call regardless of which catalog key invoked it. weaponMuzzleTip() below looks up this table
  // by the WEAPON's own id first, so this entry has to match railLance's spec exactly or the
  // reported muzzle tip drifts from where the (now-shared) art is actually drawn — the exact
  // mismatch bug #233 exists to prevent.
  beamLaser:     { len: 15,  frac: 1 },
  railLance:     { len: 15,  frac: 1 },
  // #627 Charge Beam — its own bespoke projecting mount (weapons.js `chargeBeam`), which sizes all
  // of its geometry off `barrelLen('chargeBeam', ...)`, i.e. this entry. Its foremost lit feature is
  // the lens glowDot at `frontY - L`, so `frac: 1` like every other projecting energy barrel. `len`
  // is deliberately a touch under Rail Lance's 15 so the two long energy rods aren't identical.
  chargeBeam:    { len: 14,  frac: 1 },
  plasmaCannon:  { len: 8,   frac: 1 },
  // 2026-07-31: the first mount to go flush (see weapons.js's plasmaCoater header for the full
  // round-by-round history), so it was also the first to need a NEGATIVE frac -- the front
  // (centre) tube sits BEHIND frontY (into the limb), not ahead of it. weaponMuzzleTip only
  // reports one point, and the frontmost tube is still the right one to spawn shots from.
  // #584: the recorded -0.494 didn't match the art. Its own comment claimed to track the draw
  // fn's front-tube position, but that arithmetic never reached 0.494 for any tube offset the
  // fn has used (and the fn now uses collarH*0.24, not the 0.32 the comment cited), so the shot
  // spawned ~0.29L deeper into the limb than the tube it is supposed to leave.
  // Front tube: collarY - collarH*0.24 = frontY + 0.208L.
  plasmaCoater:  { len: 6,   frac: -0.208 },
  flamethrower:  { len: 7,   frac: 1 },
  // bespoke ballistic
  autocannon:    { len: 12,  frac: 1 },
  machineGun:    { len: 10,  frac: 1 },
  shotgun:       { len: 8,   frac: 1 },
  napalm:        { len: 8,   frac: 0.9 },   // canister glow sits at 0.9L, not the full modeled tube
  // bespoke missile — all three went flush on the shared weaponCollar() the same day Plasma
  // Coater did, but kept the projecting-mount fracs their old free-floating tube shapes earned.
  swarmRack:     { len: 7.5, frac: -0.16 },    // foremost 2x3 cell: y0 + collarH*0.2 = frontY + 0.16L
  // 2026-08-02: newMissiles draws swarmRack's rack (WEAPON_MOUNT_ART), so it needs swarmRack's
  // spec too — without an entry here `weaponMuzzleTip` falls through to the `missile` CATEGORY
  // spec and spawns rounds off a tube that isn't on the model any more.
  newMissiles:   { len: 7.5, frac: -0.16 },
  streakPod:     { len: 9,   frac: -0.208 },   // seeker eye: collarY - collarH*0.24 = frontY + 0.208L
  clusterRocket: { len: 8,   frac: -0.128 },   // foremost warhead glint: collarY - collarH*0.34 = frontY + 0.128L
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
