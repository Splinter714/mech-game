// Bespoke per-weapon mount silhouettes — the on-mech hardware for each INDIVIDUAL weapon,
// so a loadout reads at a glance from the sprite alone (a stubby pulse emitter vs a long
// beam lens vs a heavy rail rod, a single-barrel autocannon vs a multi-barrel repeater vs
// a wide scatter muzzle, a stacked swarm rack vs a slim streak pod vs a fat cluster tube).
//
// All draw the same way as the category fallbacks: `(sg, T, bx, frontY, s, n, cap)`, pointing
// forward (-y) from `frontY`, glowing the weapon's CATEGORY neon `n` so type still reads.
// Sizes are in design px scaled by `s` (chassis size) and clamped to `cap` so the muzzle
// stays inside the canvas. Keyed by weapon id in WEAPON_MOUNT_ART at the bottom.
//
// A weapon WITHOUT an entry here falls back to its category shape (see ./index.js), so
// adding a weapon never requires art. **Add a bespoke mount = one entry in WEAPON_MOUNT_ART.**
import { barrel, rectC, roundC, ellipseC, poly, plateOutline, glowDot, glowBar, emissive } from '../mechPrims.js';
import { barrelLen } from './barrelSpec.js';

// ── ENERGY ──────────────────────────────────────────────────────────────────────────────

// Pulse Laser — a SHORT twin-emitter block: a compact housing with two stubby little barrels
// and two small glowing eyes, reading as a rapid-fire pulse array (not one long beam).
function pulseLaser(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('pulseLaser', s, cap), w = 5.4 * s, off = 1.2 * s;
  rectC(sg, bx, frontY - L * 0.5, w, L, T.deep);                     // squat housing
  for (const dx of [-1, 1]) {
    barrel(sg, T, bx + dx * off, frontY - L * 0.5, 1.5 * s, L * 0.9);
    glowDot(sg, bx + dx * off, frontY - L + 0.3, 1.4 * s, n);
  }
}

// Beam Laser — a LONG slim barrel with a big focusing LENS at the muzzle: reads as a
// continuous-beam projector. Bright edge light runs the whole length.
function beamLaser(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('beamLaser', s, cap), w = 2.2 * s;
  barrel(sg, T, bx, frontY - L / 2, w, L);
  emissive(sg, () => rectC(sg, bx - w * 0.42, frontY - L / 2, w * 0.22, L, n.edge, 0.7)); // edge light down the barrel
  ellipseC(sg, bx, frontY - L * 0.9, w * 1.8, w * 1.1, T.deep);        // lens collar
  glowDot(sg, bx, frontY - L, 3.4 * s, n);                            // big emitter lens
}

// Rail Lance — a HEAVY long rail rod: a thick barrel flanked by twin accelerator rails, a
// blocky breech at the base and a bright charge glow at the tip. The sniper of the set.
function railLance(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('railLance', s, cap), w = 2.8 * s, rail = 1.1 * s, off = 2.1 * s;
  rectC(sg, bx, frontY - L * 0.14, w * 2.8, 3 * s, T.deep);           // blocky breech
  for (const dx of [-1, 1]) {                                        // twin accelerator rails
    rectC(sg, bx + dx * off, frontY - L * 0.52, rail, L * 0.9, T.faceDk);
    emissive(sg, () => rectC(sg, bx + dx * off, frontY - L * 0.52, rail * 0.5, L * 0.9, n.core, 0.8)); // lit rail slit
  }
  barrel(sg, T, bx, frontY - L / 2, w, L);                           // heavy central rod
  glowBar(sg, bx, frontY - L * 0.9, w * 0.7, L * 0.5, n);            // charged rail slit
  glowDot(sg, bx, frontY - L, 2.2 * s, n);
}

// Plasma Arc — a wide-mouthed mortar-ish emitter that lobs a bolt: a flared cup on a short
// neck with a fat plasma ball glowing at the mouth.
function plasmaCannon(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('plasmaCannon', s, cap), w = 3.2 * s;
  rectC(sg, bx, frontY - L * 0.35, w, L * 0.7, T.deep);              // short neck
  poly(sg, [[bx - w * 1.1, frontY - L], [bx + w * 1.1, frontY - L],
            [bx + w * 0.5, frontY - L * 0.6], [bx - w * 0.5, frontY - L * 0.6]], T.faceDk);  // flared cup
  emissive(sg, () => ellipseC(sg, bx, frontY - L, w * 1.5, w * 0.8, n.halo, 0.4)); // plasma pool
  glowDot(sg, bx, frontY - L, 2.8 * s, n);                          // fat plasma ball
}

// Plasma Coater — new mount style for lobbed weapons (live-chat ask, 2026-07-31, iterated twice
// same day). Original ask: "mounted more on top of the mech arm or torso, instead of on the
// front of it." First draft was a single flat plate with one vent, positioned by hand outside
// the barrelLen()/BARREL_SPECS system (#233 — "projectiles should originate from the tip of the
// weapon muzzle art") — every OTHER mount here sizes its own geometry off `barrelLen(id, s,
// cap)` so the reported muzzle tip (barrelSpec.js `weaponMuzzleTip`) always matches whatever
// actually got drawn; skipping that meant this mount's own fired shots spawned from a point
// that had nothing to do with its new art. Rebuilt on `barrelLen()` like every sibling mount.
//
// Follow-up (same day, round 1): "move the mount further back on its mech section" — a SHORT
// modeled length (`BARREL_SPECS.plasmaCoater`, below). "Update to be like three tubes facing up
// (towards viewer) and forward (towards enemy) with slight light inside tip of each tube" —
// three launch tubes on a low mounting collar, each drawn as a foreshortened ellipse (an
// up-and-forward-angled tube mouth reads as an ellipse from top-down, not a flat circle) with a
// soft inner glow. Matches the weapon's own 3-blob volley.
//
// Follow-up (round 2): "cluster the barrels ... tips are a triangle" — round 1's depth gap
// between the front tube and the back pair was too shallow to read as a triangle at a glance
// (the same "reads as a line, not a triangle" lesson from the projectile-landing-pattern
// iteration earlier this session — a shallow arc/line needs a real depth gap, not a subtle one).
// Widened it substantially. "Pull the whole muzzle thing back onto the mech section, not on
// front of it" — round 1 still had the entire assembly, collar included, sitting ahead of
// `frontY` (the limb's own front edge). Every position below is now AT or BEHIND frontY (zero
// or positive offset) instead of a negative one, so the whole launcher reads as sitting on/in
// the limb's own body rather than floating in front of it. Unverified live (this session's
// environment can't render WebGL) — iterate from here.
function plasmaCoater(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('plasmaCoater', s, cap);
  const w = 6.6 * s, tubeR = 1.05 * s, off = 2.2 * s;
  // Low mounting collar, centred just behind the front edge — on the limb, not ahead of it.
  rectC(sg, bx, frontY + L * 0.18, w, L * 0.85, T.deep);
  // Triangle cluster: the back pair sit well behind the front edge; the front tube's tip barely
  // reaches the edge itself (never past it) — a real depth gap between the two, so 3 clearly
  // non-collinear points instead of a shallow arc.
  const tubes = [[-off, frontY + L * 0.32], [0, frontY - L * 0.02], [off, frontY + L * 0.32]];
  for (const [dx, ty] of tubes) {
    const tx = bx + dx;
    ellipseC(sg, tx, ty, tubeR * 2.1, tubeR * 1.15, T.faceDk);   // outer rim, foreshortened
    ellipseC(sg, tx, ty, tubeR * 1.5, tubeR * 0.8, T.deep);      // bore
    emissive(sg, () => glowDot(sg, tx, ty - tubeR * 0.08, tubeR * 0.55, n));   // slight light inside the tip
  }
}

// Flamethrower — a stubby fuel-tank body with a flared FLAME NOZZLE at the tip and a pilot
// glow. Squat and wide, reading as a close-range gout gun.
function flamethrower(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('flamethrower', s, cap), w = 3.4 * s;
  ellipseC(sg, bx, frontY - L * 0.28, w * 1.3, L * 0.6, T.deep);     // rounded fuel body
  rectC(sg, bx, frontY - L * 0.62, w * 0.5, L * 0.5, T.faceDk);      // neck
  poly(sg, [[bx - w * 0.75, frontY - L], [bx + w * 0.75, frontY - L],
            [bx + w * 0.28, frontY - L * 0.78], [bx - w * 0.28, frontY - L * 0.78]], T.faceMid);  // flared nozzle
  glowDot(sg, bx, frontY - L, 1.8 * s, n);                          // pilot flame
}

// ── BALLISTIC ───────────────────────────────────────────────────────────────────────────

// Autocannon — one BIG single barrel with a chunky muzzle brake and a base housing: a heavy
// direct-fire shell gun (contrasts the repeater's many small barrels).
function autocannon(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('autocannon', s, cap), w = 3.2 * s;
  rectC(sg, bx, frontY - L * 0.16, w * 1.9, 3 * s, T.deep);          // base housing
  barrel(sg, T, bx, frontY - L / 2, w, L);                          // fat barrel
  rectC(sg, bx, frontY - L * 0.82, w * 1.5, L * 0.18, T.faceDk);     // muzzle brake
  glowDot(sg, bx, frontY - L, 1.7 * s, n);
}

// Repeater — a MULTI-barrel gatling: two thin barrels in a row over a wide housing, each
// with its own small muzzle glow (matches its two stream lanes). Reads as a rapid tracer stream.
function machineGun(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('machineGun', s, cap), w = 1.2 * s, off = 1.7 * s;
  rectC(sg, bx, frontY - L * 0.4, (off * 2 + w) * 1.5, L * 0.8, T.deep);  // gatling housing
  for (const dx of [-0.5, 0.5]) {
    barrel(sg, T, bx + dx * off, frontY - L / 2, w, L);
    glowDot(sg, bx + dx * off, frontY - L + 0.4, 1.0 * s, n);
  }
}

// Scatter Gun — a WIDE flared shotgun muzzle: a short barrel opening into a broad cone with
// pellet glints across the mouth. Reads as a spread weapon.
function shotgun(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('shotgun', s, cap), w = 2.2 * s, mouth = 5.6 * s;
  rectC(sg, bx, frontY - L * 0.35, w, L * 0.7, T.deep);             // stubby barrel
  poly(sg, [[bx - mouth / 2, frontY - L], [bx + mouth / 2, frontY - L],
            [bx + w * 0.6, frontY - L * 0.55], [bx - w * 0.6, frontY - L * 0.55]], T.faceDk);  // wide funnel
  for (const dx of [-1, 0, 1]) glowDot(sg, bx + dx * mouth * 0.3, frontY - L + 0.4, 1.0 * s, n);  // pellet glints
}

// Napalm Lobber — a fat upward-angled MORTAR tube: a short stout barrel with a thick collar
// and a canister glow in the mouth. Reads as a lobbed incendiary.
function napalm(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('napalm', s, cap), w = 4 * s;
  rectC(sg, bx, frontY - L * 0.4, w * 0.5, L * 0.8, T.deep);        // base
  barrel(sg, T, bx, frontY - L * 0.55, w, L * 0.7);                // stout tube
  ellipseC(sg, bx, frontY - L * 0.9, w * 0.9, w * 0.55, T.faceDk);  // thick rim collar
  glowDot(sg, bx, frontY - L * 0.9, 2.4 * s, n);                   // canister in the mouth
}

// ── MISSILE ─────────────────────────────────────────────────────────────────────────────

// Swarm Rack — a TALL stacked launch rack: a 2×3 grid of glowing tubes in a boxy frame,
// reading as a big all-at-once salvo.
function swarmRack(sg, T, bx, frontY, s, n, cap) {
  const w = 5.6 * s, h = barrelLen('swarmRack', s, cap), cy = frontY - h / 2;
  boxFrame(sg, T, bx, cy, w, h);
  for (const dx of [-1, 1]) for (const dy of [0, 1, 2]) {           // 2×3 launch cells
    const cxx = bx + dx * w * 0.22, cyy = frontY - h * (0.2 + dy * 0.28);
    emissive(sg, () => {
      rectC(sg, cxx, cyy, w * 0.24, h * 0.13, n.halo, 0.5);
      rectC(sg, cxx, cyy, w * 0.16, h * 0.09, n.core, 1);
    });
  }
}

// Streak Pod — a SLIM twin-tube pod: two long narrow tubes side by side, each with a bright
// seeker glow at the tip. Reads as a precise pair of seekers, not a box.
function streakPod(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('streakPod', s, cap), w = 1.9 * s, off = 1.7 * s;
  for (const dx of [-1, 1]) {
    roundC(sg, bx + dx * off, frontY - L / 2, w, L, T.faceDk, w * 0.5);   // #446: no bubbly variant
    glowDot(sg, bx + dx * off, frontY - L + 0.4, 1.5 * s, n);       // seeker eye
  }
  rectC(sg, bx, frontY - L * 0.2, (off * 2 + w), 2 * s, T.deep);    // yoke tying the tubes
}

// Cluster Salvo — a single FAT dumbfire tube: one wide short launch barrel with a cluster of
// small warhead glints packed in the mouth. Reads as a tight clump, not a rack.
function clusterRocket(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('clusterRocket', s, cap), w = 5 * s;
  roundC(sg, bx, frontY - L / 2, w, L, T.faceDk, w * 0.3);          // fat tube (#446: one variant)
  rectC(sg, bx, frontY - L * 0.85, w * 0.86, L * 0.14, T.deep);     // muzzle lip
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) {             // packed cluster of warheads
    glowDot(sg, bx + dx * w * 0.2, frontY - L * (0.86 + dy * 0.06), 0.9 * s, n);
  }
  glowDot(sg, bx, frontY - L * 0.86, 1.0 * s, n);
}

// A theme-aware boxy launcher frame (shared by the rack). Chamfered for the player, faceted for
// the enemy — mirrors the generic missile box. (#446 dropped the bubbly ellipse, then pass 2
// dropped the rounded-rect fallback.)
function boxFrame(sg, T, bx, cy, w, h) {
  poly(sg, plateOutline(T, bx, cy, w + 1, h + 1, 1), T.outline);
  poly(sg, plateOutline(T, bx, cy, w, h, 1), T.faceDk);
}

export const WEAPON_MOUNT_ART = {
  // energy
  pulseLaser, beamLaser, railLance, plasmaCannon, plasmaCoater, flamethrower,
  // ballistic
  autocannon, machineGun, shotgun, napalm,
  // missile
  swarmRack, streakPod, clusterRocket,
};
