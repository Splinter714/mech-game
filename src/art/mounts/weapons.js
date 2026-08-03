// Bespoke per-weapon mount silhouettes — the on-mech hardware for each INDIVIDUAL weapon,
// so a loadout reads at a glance from the sprite alone (a stubby pulse emitter vs a long
// beam lens vs a heavy rail rod, a single-barrel autocannon vs a multi-barrel repeater vs
// a wide scatter muzzle, a stacked swarm rack vs a slim streak pod vs a fat cluster tube).
//
// All draw the same way as the category fallbacks: `(sg, T, bx, frontY, s, n, cap, partW, partH,
// tag)`, pointing forward (-y) from `frontY`, glowing the weapon's CATEGORY neon `n` so type still
// reads. Sizes are in design px scaled by `s` (chassis size) and clamped to `cap` so the muzzle
// stays inside the canvas. Keyed by weapon id in WEAPON_MOUNT_ART at the bottom.
//
// #585: `tag(name)` sub-tags the shapes for the dev art-dissect tool, using the ONE standardized
// vocabulary every mount shares — `collar` (structure bolted to the mech) / `barrel` (the emitting
// body) / `muzzle` (the solid flared/belled/capped piece at the barrel's tip, where a mount has
// one) / `color` (every lit layer: glowDot/glowBar/`emissive()`) / `detail` (the flat residual
// bucket). See drawWeaponMount in ./index.js for the full rationale. A fn tags only what it
// actually draws, and re-tags inside a loop where grouping the draws by tag would reorder
// overlapping shapes and change the bake.
//
// A weapon WITHOUT an entry here falls back to its category shape (see ./index.js), so
// adding a weapon never requires art. **Add a bespoke mount = one entry in WEAPON_MOUNT_ART.**
import { barrel, rectC, roundC, ellipseC, poly, weaponCollar, glowDot, glowBar, emissive } from '../mechPrims.js';
import { barrelLen } from './barrelSpec.js';

// ── ENERGY ──────────────────────────────────────────────────────────────────────────────

// Pulse Laser — a SHORT twin-emitter block: a compact housing with two stubby little barrels
// and two small glowing eyes, reading as a rapid-fire pulse array (not one long beam).
function pulseLaser(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('pulseLaser', s, cap), w = 5.4 * s, off = 1.2 * s;
  tag('collar');
  rectC(sg, bx, frontY - L * 0.5, w, L, T.deep);                     // squat housing
  for (const dx of [-1, 1]) {                                        // bare tubes: no tip piece
    tag('barrel');
    barrel(sg, T, bx + dx * off, frontY - L * 0.5, 1.5 * s, L * 0.9);
    tag('color');
    glowDot(sg, bx + dx * off, frontY - L + 0.3, 1.4 * s, n);
  }
}

// Rail Lance — a HEAVY long rail rod: a thick barrel flanked by twin accelerator rails, a
// blocky breech at the base and a bright charge glow at the tip. The sniper of the set.
// The accelerator rails are `detail`, not `barrel`: they flank the tube rather than emit, and
// nothing leaves the mount through them.
// #618: Rail Lance the weapon is shelved (SHELVED_WEAPON_IDS, weapons.js) — its own bespoke
// mount only still renders for the wall-turret enemy kind, which mounts `railLance` directly
// and bypasses the catalog entirely. This same fn is now ALSO used for Beam Laser
// (WEAPON_MOUNT_ART.beamLaser below adopts it per the owner's ask — "keep its weapon mount art
// and use that art for the beam laser"), which is why Beam Laser's own old bespoke mount fn
// (a slim barrel + focusing lens) was deleted rather than left dead. The `barrelLen('railLance',
// ...)` call below stays hardcoded to this fn's own id regardless of which catalog key invokes
// it, so BARREL_SPECS.beamLaser (barrelSpec.js) was updated to match this fn's own spec — see
// its comment there.
function railLance(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('railLance', s, cap), w = 2.8 * s, rail = 1.1 * s, off = 2.1 * s;
  tag('collar');
  rectC(sg, bx, frontY - L * 0.14, w * 2.8, 3 * s, T.deep);           // blocky breech
  for (const dx of [-1, 1]) {                                        // twin accelerator rails
    tag('detail');
    rectC(sg, bx + dx * off, frontY - L * 0.52, rail, L * 0.9, T.faceDk);
    tag('color');
    emissive(sg, () => rectC(sg, bx + dx * off, frontY - L * 0.52, rail * 0.5, L * 0.9, n.core, 0.8)); // lit rail slit
  }
  tag('barrel');
  barrel(sg, T, bx, frontY - L / 2, w, L);                           // heavy central rod
  tag('color');
  glowBar(sg, bx, frontY - L * 0.9, w * 0.7, L * 0.5, n);            // charged rail slit
  glowDot(sg, bx, frontY - L, 2.2 * s, n);
}

// Plasma Arc — a wide-mouthed mortar-ish emitter that lobs a bolt: a flared cup on a short
// neck with a fat plasma ball glowing at the mouth.
function plasmaCannon(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('plasmaCannon', s, cap), w = 3.2 * s;
  tag('barrel');
  rectC(sg, bx, frontY - L * 0.35, w, L * 0.7, T.deep);              // short neck
  tag('muzzle');
  poly(sg, [[bx - w * 1.1, frontY - L], [bx + w * 1.1, frontY - L],
            [bx + w * 0.5, frontY - L * 0.6], [bx - w * 0.5, frontY - L * 0.6]], T.faceDk);  // flared cup
  tag('color');
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
// Live-chat ask: "plasma coater lights should match the purple projectile" — the mount would
// otherwise glow the shared 'energy' category cyan, visibly mismatched from the weapon's own
// purple bolt (weapons.js `projectileColor: 0xa04dff`). That was first fixed here, as a local
// NEON-shaped const hardcoding the purple ramp. #583 replaced it with the general rule: any
// weapon that declares a `projectileColor` has its mount neon derived from that one number
// (`neonForWeapon`/`neonRamp` in ./index.js), so this fn now just glows the `n` it is handed
// like every other mount, and the purple can't drift from the round again. The derived ramp
// reproduces the hand-picked one within ~6/255 on a single channel — no visible change.

// Live-chat ask, round 1: "the weapons position for a lobbed/mounted weapon like plasma coater
// should sit within the outline of the plate on the body segment" — shrunk to avoid overhanging
// an arm's own plate width. Round 2, after a screenshot (the mount sat right at the arm's very
// top edge, its own square corners floating past the arm's chamfer into the background): "it
// can be wider, it just needs scooted down, and also allow the corners to be cut off by the arm
// outline" — widened it, moved it well down the arm, and switched the collar to the SAME
// chamfered-plate shape (`plateOutline`) the arm's own plate uses so its corners taper the same
// way instead of reading as a separate floating box. Round 3, after ANOTHER screenshot (now
// dead-centered on the arm and spanning nearly its full width): "too big / dominates the arm"
// + "wrong vertical spot" — pulled the size back down and moved it to roughly a quarter of the
// way down the arm (nearer the front/firing end) instead of the exact middle. Round 4: "the arm
// plate body has an outline; we want the weapon mount spot to be just flush with that plate body
// outline" — first pass inset the collar 1.2 units inside the plate's own face width (meant to
// clear the plate's outline STROKE, but that read as "still not flush" + "wrong proportions").
// Fixed properly: the collar now spans the plate's full face width with ZERO inset (its edges
// land exactly on the plate's own edge, since the plate's thin outline stroke is drawn just
// outside its face anyway — see mechPrims.js `plate()`), and its chamfer is computed with the
// arm plate's own `plateCut()` formula instead of an ad hoc fraction, so the corner cut matches
// the plate's proportions instead of looking like a mismatched shape dropped on top of it.
// Round 5: "position towards front of arm is still wrong" — the width fix (round 4) made the
// collar visibly wider without changing its vertical placement, and a quarter of the way down
// still reads as too far from the front/firing edge now that it spans the full plate width.
// Pulled it in closer to frontY -- too close, it turned out (round 6 below).
// Round 6: "corner clip is now an ugly black box, and also doesn't even clip at the right point;
// can we instead have the body outline do the clipping itself?" — a "paint the corners over"
// hack was the wrong fix; tried dropping the collar down far enough to clear the plate's chamfer
// zone entirely instead, which just moved the problem ("weapon plate is in the wrong spot") —
// dropping the WHOLE collar down to clear the corners loses the "flush with the plate body
// outline" placement from round 4.
// Round 7: "scoot it to be flush with the plate body outline" — fixed at the actual root this
// time: the collar's TOP edge now sits exactly AT frontY (touching the plate's own front edge,
// zero gap) and its top-left/top-right corners are cut with the arm plate's OWN chamfer amount
// (`plateChamfer`, not an independently-computed one) — i.e. the collar's top corner points
// coincide exactly with the plate's own front-corner chamfer points. That's what makes it
// genuinely flush AND non-overhanging at the same time: same edge, same corner cut, literally
// inscribed in the plate's own silhouette at the top. Only the bottom corners (deep inside the
// plate, no overhang risk) get their own more pronounced taper for visual distinction.
function plasmaCoater(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('plasmaCoater', s, cap);
  const w = partW ?? 5.4 * s, tubeR = 1.15 * s, off = w * 0.22;   // live-chat ask: bigger tubes/purple glow
  const collarH = L * 0.8;
  // Live-chat ask: sub-tag the collar plate vs. the tube cluster so the art-dissect tool can
  // drill into each piece separately when giving placement/sizing feedback from a screenshot.
  // #585 generalized that one-off pair into the vocabulary every mount now shares — this fn used
  // to hardcode its own weapon id into the tag string ('weapons.plasmaCoater.collar'), which is
  // exactly the pattern `tag` replaces, and its 'tubes' is the standard `barrel`.
  tag('collar');
  const collarY = weaponCollar(sg, T, bx, frontY, w, collarH, partW, partH);
  // Triangle cluster, anchored to the new collarY: the back pair sit further down still, the
  // front tube noticeably closer to the collar's own leading edge — a real depth gap so the 3
  // tips read as a triangle, not a shallow arc. Live-chat asks: back pair scooted closer to the
  // front tube (shrunk the depth gap), then the front tube pulled closer to the back pair too.
  const tubes = [
    [-off, collarY + collarH * 0.16], [0, collarY - collarH * 0.24], [off, collarY + collarH * 0.16],
  ];
  for (const [dx, ty] of tubes) {
    const tx = bx + dx;
    // Rim + bore are both the tube itself seen end-on, not a separate flared tip piece, so both
    // are `barrel` — no `muzzle` on this mount.
    tag('barrel');
    ellipseC(sg, tx, ty, tubeR * 2.1, tubeR * 1.15, T.faceDk);   // outer rim, foreshortened
    ellipseC(sg, tx, ty, tubeR * 1.5, tubeR * 0.8, T.deep);      // bore
    // Live-chat ask: "the streak pod and cluster salvo have some nice glow, add that glow to the
    // plasma coater" — those two size their glowDot to fill/dominate their own tube instead of a
    // small light tucked inside the bore; matched that here (radius up from tubeR*0.55 to *1.0).
    tag('color');
    glowDot(sg, tx, ty, tubeR, n);
  }
}

// Flamethrower — a stubby fuel-tank body with a flared FLAME NOZZLE at the tip and a pilot
// glow. Squat and wide, reading as a close-range gout gun.
function flamethrower(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('flamethrower', s, cap), w = 3.4 * s;
  tag('collar');
  ellipseC(sg, bx, frontY - L * 0.28, w * 1.3, L * 0.6, T.deep);     // rounded fuel body
  tag('barrel');
  rectC(sg, bx, frontY - L * 0.62, w * 0.5, L * 0.5, T.faceDk);      // neck
  tag('muzzle');
  poly(sg, [[bx - w * 0.75, frontY - L], [bx + w * 0.75, frontY - L],
            [bx + w * 0.28, frontY - L * 0.78], [bx - w * 0.28, frontY - L * 0.78]], T.faceMid);  // flared nozzle
  tag('color');
  glowDot(sg, bx, frontY - L, 1.8 * s, n);                          // pilot flame
}

// ── BALLISTIC ───────────────────────────────────────────────────────────────────────────

// Autocannon — one BIG single barrel with a chunky muzzle brake and a base housing: a heavy
// direct-fire shell gun (contrasts the repeater's many small barrels).
function autocannon(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('autocannon', s, cap), w = 3.2 * s;
  tag('collar');
  rectC(sg, bx, frontY - L * 0.16, w * 1.9, 3 * s, T.deep);          // base housing
  tag('barrel');
  barrel(sg, T, bx, frontY - L / 2, w, L);                          // fat barrel
  tag('muzzle');
  rectC(sg, bx, frontY - L * 0.82, w * 1.5, L * 0.18, T.faceDk);     // muzzle brake
  tag('color');
  glowDot(sg, bx, frontY - L, 1.7 * s, n);
}

// Repeater — a MULTI-barrel gatling: two thin barrels in a row over a wide housing, each
// with its own small muzzle glow (matches its two stream lanes). Reads as a rapid tracer stream.
function machineGun(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('machineGun', s, cap), w = 1.2 * s, off = 1.7 * s;
  tag('collar');
  rectC(sg, bx, frontY - L * 0.4, (off * 2 + w) * 1.5, L * 0.8, T.deep);  // gatling housing
  for (const dx of [-0.5, 0.5]) {                                   // bare tubes: no tip piece
    tag('barrel');
    barrel(sg, T, bx + dx * off, frontY - L / 2, w, L);
    tag('color');
    glowDot(sg, bx + dx * off, frontY - L + 0.4, 1.0 * s, n);
  }
}

// Scatter Gun — a WIDE flared shotgun muzzle: a short barrel opening into a broad cone with
// pellet glints across the mouth. Reads as a spread weapon.
function shotgun(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('shotgun', s, cap), w = 2.2 * s, mouth = 5.6 * s;
  tag('barrel');
  rectC(sg, bx, frontY - L * 0.35, w, L * 0.7, T.deep);             // stubby barrel
  tag('muzzle');
  poly(sg, [[bx - mouth / 2, frontY - L], [bx + mouth / 2, frontY - L],
            [bx + w * 0.6, frontY - L * 0.55], [bx - w * 0.6, frontY - L * 0.55]], T.faceDk);  // wide funnel
  tag('color');
  for (const dx of [-1, 0, 1]) glowDot(sg, bx + dx * mouth * 0.3, frontY - L + 0.4, 1.0 * s, n);  // pellet glints
}

// Napalm Lobber — a fat upward-angled MORTAR tube: a short stout barrel with a thick collar
// and a canister glow in the mouth. Reads as a lobbed incendiary.
function napalm(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('napalm', s, cap), w = 4 * s;
  tag('collar');
  rectC(sg, bx, frontY - L * 0.4, w * 0.5, L * 0.8, T.deep);        // base
  tag('barrel');
  barrel(sg, T, bx, frontY - L * 0.55, w, L * 0.7);                // stout tube
  tag('muzzle');
  ellipseC(sg, bx, frontY - L * 0.9, w * 0.9, w * 0.55, T.faceDk);  // thick rim collar (belled tip)
  tag('color');
  glowDot(sg, bx, frontY - L * 0.9, 2.4 * s, n);                   // canister in the mouth
}

// ── MISSILE ─────────────────────────────────────────────────────────────────────────────

// Live-chat ask: reuse Plasma Coater's flush mounting collar (`weaponCollar`, mechPrims.js) for
// the missile category too, instead of each launcher projecting forward past the arm's own edge
// (the old `boxFrame`/free-floating tube shapes) — same "mounted on the plate, not in front of
// it" treatment, and it fixes the swarm rack's own previously-flagged bad placement for free
// (it's now geometrically flush/non-overhanging by construction, like Plasma Coater).

// Swarm Rack — a TALL stacked launch rack: a 2×3 grid of glowing tubes on the flush collar,
// reading as a big all-at-once salvo.
// #585 tags: like the generic missile fallback, every launch cell here is drawn purely as
// `emissive()` colour with no dark tube under it — so this mount is `collar` + `color` and has
// neither a `barrel` nor a `muzzle` piece.
function swarmRack(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const w = partW ?? 5.6 * s, collarH = barrelLen('swarmRack', s, cap) * 0.8;
  tag('collar');
  const collarY = weaponCollar(sg, T, bx, frontY, w, collarH, partW, partH);
  const y0 = collarY - collarH / 2;
  tag('color');
  for (const dx of [-1, 1]) for (const dy of [0, 1, 2]) {           // 2×3 launch cells
    const cxx = bx + dx * w * 0.22, cyy = y0 + collarH * (0.2 + dy * 0.28);
    emissive(sg, () => {
      rectC(sg, cxx, cyy, w * 0.24, collarH * 0.13, n.halo, 0.5);
      rectC(sg, cxx, cyy, w * 0.16, collarH * 0.09, n.core, 1);
    });
    // Live-chat ask: same prominent glowDot treatment as Streak Pod / Cluster Salvo / Plasma
    // Coater, layered on top of each cell instead of just the flat halo/core rects.
    glowDot(sg, cxx, cyy, collarH * 0.08, n);
  }
}

// Streak Pod — a SLIM twin-tube pod on the flush collar: two tubes side by side, each with a
// bright seeker glow at the tip. Reads as a precise pair of seekers, not a box.
function streakPod(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const w = partW ?? 5.4 * s, collarH = barrelLen('streakPod', s, cap) * 0.8;
  tag('collar');
  const collarY = weaponCollar(sg, T, bx, frontY, w, collarH, partW, partH);
  const off = w * 0.22;
  for (const dx of [-1, 1]) {
    tag('barrel');
    roundC(sg, bx + dx * off, collarY, w * 0.24, collarH * 0.7, T.faceDk, w * 0.12);   // #446: no bubbly variant
    tag('color');
    glowDot(sg, bx + dx * off, collarY - collarH * 0.24, 1.5 * s, n);       // seeker eye
  }
  tag('detail');   // a tie-bar between the tubes, not structure/body/tip — the residual bucket
  rectC(sg, bx, collarY + collarH * 0.16, (off * 2 + w * 0.24), collarH * 0.14, T.deep);   // yoke tying the tubes
}

// Cluster Salvo — a single FAT dumbfire tube on the flush collar: one wide short launch barrel
// with a cluster of small warhead glints packed in the mouth. Reads as a tight clump, not a rack.
function clusterRocket(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const w = partW ?? 5.4 * s, collarH = barrelLen('clusterRocket', s, cap) * 0.8;
  tag('collar');
  const collarY = weaponCollar(sg, T, bx, frontY, w, collarH, partW, partH);
  tag('barrel');
  roundC(sg, bx, collarY, w * 0.7, collarH * 0.7, T.faceDk, w * 0.2);   // fat tube (#446: one variant)
  tag('muzzle');
  rectC(sg, bx, collarY - collarH * 0.28, w * 0.6, collarH * 0.14, T.deep);     // muzzle lip
  tag('color');
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) {             // packed cluster of warheads
    glowDot(sg, bx + dx * w * 0.14, collarY - collarH * (0.28 + dy * 0.06), 0.9 * s, n);
  }
  glowDot(sg, bx, collarY - collarH * 0.28, 1.0 * s, n);
}

// ── LIGHTNING (#622) ────────────────────────────────────────────────────────────────────

// Chain Bolt — a bare charged conductor rod wrapped in coil windings, sparking at the tip: a
// bolt caster, not a lens/beam emitter. Keeps the codebase's "compact procedural shape, not a
// detailed model" rule (issue #622) — just a rod, a few coil bands, and a spark glow.
function chainBolt(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('chainBolt', s, cap), w = 2.2 * s;
  tag('collar');
  rectC(sg, bx, frontY - L * 0.14, w * 2.2, 3 * s, T.deep);            // small breech block
  tag('barrel');
  barrel(sg, T, bx, frontY - L / 2, w, L);                             // bare conductor rod
  tag('detail');
  for (const t of [0.32, 0.52, 0.72]) {                                // coil windings
    rectC(sg, bx, frontY - L * t, w * 1.7, 0.8 * s, T.faceDk);
  }
  tag('color');
  glowDot(sg, bx, frontY - L, 2 * s, n);                               // sparking tip
}

// Tesla Pylons — a stubby forked launcher stake: a squat base with two short prongs, each
// glowing at its own tip, reading as "throws a pair of things" rather than a single barrel.
function linkPylons(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('linkPylons', s, cap), w = 3.6 * s;
  tag('collar');
  rectC(sg, bx, frontY - L * 0.2, w * 1.3, L * 0.42, T.deep);          // squat base
  for (const dx of [-1, 1]) {                                          // two short throw prongs
    tag('barrel');
    barrel(sg, T, bx + dx * w * 0.34, frontY - L * 0.62, w * 0.3, L * 0.5);
    tag('color');
    glowDot(sg, bx + dx * w * 0.34, frontY - L * 0.86, 1.3 * s, n);
  }
}

export const WEAPON_MOUNT_ART = {
  // energy
  // #618: beamLaser adopts railLance's own bespoke fn (Beam Laser's old fn was deleted). The
  // railLance key is kept too, still pointing at the same fn, so the wall-turret enemy kind
  // (which mounts the shelved railLance weapon directly, bypassing the catalog) keeps its own
  // heavy-sniper mount silhouette instead of falling back to the generic energy category shape.
  pulseLaser, beamLaser: railLance, railLance, plasmaCannon, plasmaCoater, flamethrower,
  // ballistic
  autocannon, machineGun, shotgun, napalm,
  // missile
  swarmRack, streakPod, clusterRocket,
  // lightning
  chainBolt, linkPylons,
};
