// Procedural top-down mech art. A mech is drawn as two stacked sprites so the turret
// can aim independently of the legs (tank feel):
//   <key>_hull_0..N — legs (feet) + pelvis + skirts. The baked walk cycle (N = HULL_FRAMES
//                     for enemies/garage, PLAYER_HULL_FRAMES for a player mech); this
//                     sprite rotates to face the movement direction.
//   <key>_turret    — side/center torsos + arms + head + weapon hardware. Rotates to
//                     face the aim (within the chassis' turret arc).
// Both are drawn pointing "up" (north / -y) and centred. Because the turret is stacked
// ON TOP of the hull, the torso naturally occludes the leg tops — that overhead
// occlusion is what sells the top-down read. Parts are drawn from the live Mech: a
// destroyed location draws nothing (#419 — no leftover stump) and its weapons vanish.
//
// Two visual THEMES distinguish the factions:
//   player — "gritty cyberpunk": dark weathered ANGULAR gunmetal plates (hard chamfers).
//   enemy  — "sleek": light/white ROUNDED panels.
// Both share the glow language, which is theme-independent:
//   purple — the mech's OWN power: reactor spine, cockpit optic, leg thrusters.
//   neon   — each weapon glows its CATEGORY colour (energy cyan, ballistic amber,
//            missile pink, melee white, support green), so loadout reads at a glance.

import { gen, scaledGraphics, drawDilated, ART_SCALE } from './_frames.js';
import { MOUNT_LOCATIONS } from '../data/anatomy.js';
import { isWeapon } from '../data/items.js';
import { getWeapon } from '../data/weapons.js';
import {
  DESIGN, themeFor, REACTOR, HALO, poly, rectC, roundC, ellipseC, chamfer, plate, glowBar,
  exposedInternals, statusSpotBar,
} from './mechPrims.js';
import { drawWeaponMount } from './mounts/index.js';
import { drawDecor, DECOR_ART } from './decor/index.js';

// The low-level primitives + palettes live in ./mechPrims.js; the per-category weapon-mount
// art in ./mounts/ and the per-kind chassis decor in ./decor/ (registries). This file keeps
// the layout + orchestration: mechLayout, drawTurret/drawHull, and the texture builders.
export { ART_SCALE, DESIGN };

// Per-chassis SHAPE — proportion/stance multipliers on the baseline layout so each weight
// class reads as a structurally different build (not one shape scaled), #24. All default
// to 1 (the medium baseline); a chassis overrides via `art.shape`. `armSpread` widens BOTH
// the shoulders (side torsos) and the arms; `legSpread`/`legDrop` set the stance.
const DEFAULT_SHAPE = {
  head: 1, torso: 1, sideTorso: 1,
  armW: 1, armH: 1, armSpread: 1,
  legW: 1, legH: 1, legSpread: 1, legDrop: 1,
  // Positional offsets (fraction of bodyLen, -y = forward) that rearrange the layout, not
  // just its thickness: a scout's head/arms ride forward, a bruiser's sit back/low.
  headDy: 0, armDy: 0,
};
const shapeOf = (mech) => ({ ...DEFAULT_SHAPE, ...(mech.chassis.art.shape || {}) });

// Off-centre weapon mounts (arms + side torsos) are drawn into their OWN textures (not baked
// into the static turret) so the scene can pivot each one at its joint toward the weapon-
// convergence point (#: shots from off-centre mounts angle inward; the art now angles with
// them). The PIVOT is the joint as a fraction of the part's height BEHIND the part centre
// (−y is forward, so the rear is +y) — the part swings its muzzle (front) inward around it.
// Arms are articulated limbs, so a big shoulder pivot reads naturally; side torsos are RIGID
// shoulder armour, so they cant only SLIGHTLY (their weapons are less off-centre, so their
// convergence angle is smaller anyway) and pivot nearer their own centre so the small rotation
// doesn't slide the plate out from under the centre torso.
export const ARM_LOCATIONS = ['leftArm', 'rightArm'];
export const SIDE_TORSO_LOCATIONS = ['leftTorso', 'rightTorso'];

// ── Walk-cycle sampling (#435) ────────────────────────────────────────────────────────────
// The gait is BAKED: the legs' fore/aft swing is drawn into N hull textures and the scene
// swaps between them. N is therefore the animation's frame rate — the whole cycle plays in
// `4 × stepInterval` ms no matter what N is, so raising N buys smoothness, not speed.
//
// `HULL_FRAMES` (4) is the historical default and stays the default for ENEMY mechs and the
// garage preview, neither of which actually cycles (an enemy mech sits on `hull_0`, the garage
// preview on `garageMech_hull_0`) — so spending textures on them would buy nothing.
//
// `PLAYER_HULL_FRAMES` is the PLAYER's count. At 4 the cycle had only THREE distinct poses
// (frames 0 and 2 are both legs-neutral), so the legs teleported between full stride and
// neutral roughly four times a second — the "needs more frames / too steppy" read. 16 samples
// the same swing finely enough that it flows. Cost is linear: one 256×256 texture per frame
// per player mech (see buildMechTextures' note on the reskin path, which no longer redraws
// them at all).
export const HULL_FRAMES = 4;
export const PLAYER_HULL_FRAMES = 16;

// The LEFT leg's stride offset for one walk frame, in [-1, 1] (+1 = forward, -1 = back; the
// right leg is always the exact opposite). A continuous sine of the cycle phase rather than a
// hand-written {-1, 0, +1} table, so any frame count samples the same smooth swing. Chosen so
// the legacy 4-frame set is reproduced EXACTLY — frame 0 neutral, 1 = left back, 2 neutral,
// 3 = left forward — which keeps enemy/garage hull art byte-identical to before.
export function strideDir(frame, frames = HULL_FRAMES) {
  return -Math.sin((frame / frames) * Math.PI * 2);
}
// Every location that gets its own pivoting texture (drawn in this back-to-front order).
export const PIVOT_LOCATIONS = [...SIDE_TORSO_LOCATIONS, ...ARM_LOCATIONS];
// Exported (not just a local const) so shared.js's muzzle geometry (`partMuzzle`'s `pivotFrac`)
// can share the SAME joint fraction the sprite itself pivots around (#233 follow-up) — if this
// ever gets retuned for visual reasons, the muzzle math moves with it instead of drifting.
export const PART_PIVOT = { leftArm: 0.42, rightArm: 0.42, leftTorso: 0.30, rightTorso: 0.30 };

// #433 (re-architecture): texture-key suffix for a weapon-carrying part's GLOW-ONLY overlay — the
// weapon's muzzle glow ALONE (glowDot/glowBar colour layers), on an otherwise-transparent canvas of
// the SAME size + origin as the part, so it layers over the part sprite with perfect registration
// and no muzzle-tip position math. The base part is now baked muzzle-OFF (dark) as its sole state;
// this overlay carries the colour. The reload blink toggles the overlay sprite's VISIBILITY
// (arena/ammoIndicators.js) — the part texture never changes, so the shield outline never re-derives
// its shell. Player-only (enemy mechs bake their glow straight into the part). One place the suffix
// is defined so the baker and the mech-view wiring can't drift apart.
export const MUZZLE_GLOW_SUFFIX = '_muzzleGlow';

// #422/#456: the player's shield SHELL is baked as its own raster — the body-only art DILATED
// outward by this many DESIGN units — and then drawn at the mech's EXACT display scale (see
// arena/shieldOutline.js). That is what makes the shell sit a consistent distance outside the
// silhouette: a dilation moves every edge by the same distance, whereas the old percentage scale
// moved each edge in proportion to its own distance from the mech centre, so the wide arm-to-arm
// axis got a fatter rim than the shallow nose-to-tail axis ("wider than it is deep").
// In display px the margin is `SHIELD_SHELL_PAD × ART_SCALE × ARENA_MECH_SCALE` = 1.8 × 4 × 0.34
// ≈ 2.4px, i.e. the same overall thickness the tuned #397/#422 shell had on its FRONT face — now
// on every face. Tunable; it is the ONLY dial for shell size, and nothing at runtime changes it
// (#456: strength drives opacity, never size).
export const SHIELD_SHELL_PAD = 1.8;

// #422: texture-key suffix for a part's baked shield shell (body-only art, dilated by
// SHIELD_SHELL_PAD). The hull gets one PER WALK FRAME so the shell's feet stride with the real
// legs. Shared with arena/shieldOutline.js so the baker and the consumer can't drift.
export const SHIELD_SHELL_SUFFIX = '_shield';

// Where a `${key}_<part>` sprite must sit and how it pivots, for a mech aimed along `angle`
// at display `scale`. `ox/oy` is the joint as an origin fraction (so setOrigin makes the
// sprite rotate around the joint); `dx/dy` is the joint's offset from the mech centre
// (add it to the mech's screen position); `rot` is the base rotation (caller adds the
// convergence tilt). At tilt 0 this reproduces the part's old baked-into-the-turret placement
// exactly. Mirrors the muzzle convention in locomotion._muzzle (forward = −y, right = +x).
export function partSpriteTransform(mech, loc, angle, scale) {
  const p = mechLayout(mech)[loc];
  const pivot = PART_PIVOT[loc] ?? 0.42;
  const sx = p.x, sy = p.y + p.h * pivot;             // joint in design coords
  const disp = scale * ART_SCALE;
  const f = -sy * disp, r = sx * disp;                // forward / right offset (world px)
  return {
    ox: 0.5 + sx / DESIGN, oy: 0.5 + sy / DESIGN,
    dx: f * Math.cos(angle) - r * Math.sin(angle),
    dy: f * Math.sin(angle) + r * Math.cos(angle),
    rot: angle + Math.PI / 2,
  };
}

// Back-compat alias — the arm-only name that existing call sites import.
export const armSpriteTransform = partSpriteTransform;

// Per-location anchors + box sizes in mech-local design coords (origin = centre, -y =
// forward). Scenes also read this to place per-part hit-areas + damage labels, so the
// keys and rough boxes are stable. Derived from chassis body dims AND its shape so a light
// reads spindly and a heavy reads broad/blocky.
export function mechLayout(mech) {
  const a = mech.chassis.art;
  const L = a.bodyLen, W = a.bodyWid;
  const sh = shapeOf(mech);
  const shoulder = W * 0.42 * sh.armSpread;   // side-torso x; arms sit just outboard
  return {
    head:        { x: 0,                       y: -L * 0.24 + L * sh.headDy, w: W * 0.34 * sh.head,      h: L * 0.22 * sh.head },
    cockpit:     { x: 0,                       y: -L * 0.27 + L * sh.headDy, w: W * 0.18 * sh.head,      h: L * 0.10 * sh.head },
    centerTorso: { x: 0,                       y: -L * 0.05,           w: W * 0.50 * sh.torso,     h: L * 0.44 },
    leftTorso:   { x: -shoulder,               y: -L * 0.03,           w: W * 0.30 * sh.sideTorso, h: L * 0.38 },
    rightTorso:  { x:  shoulder,               y: -L * 0.03,           w: W * 0.30 * sh.sideTorso, h: L * 0.38 },
    leftArm:     { x: -W * 0.72 * sh.armSpread, y: -L * 0.08 + L * sh.armDy, w: W * 0.22 * sh.armW,   h: L * 0.46 * sh.armH },
    rightArm:    { x:  W * 0.72 * sh.armSpread, y: -L * 0.08 + L * sh.armDy, w: W * 0.22 * sh.armW,   h: L * 0.46 * sh.armH },
    leftLeg:     { x: -W * 0.17 * sh.legSpread, y:  L * 0.15 * sh.legDrop, w: W * 0.24 * sh.legW,  h: L * 0.32 * sh.legH },
    rightLeg:    { x:  W * 0.17 * sh.legSpread, y:  L * 0.15 * sh.legDrop, w: W * 0.24 * sh.legW,  h: L * 0.32 * sh.legH },
  };
}

// One mount location's weapon hardware: a shape per mounted weapon, spread across the part,
// by category. Shared by the turret (torso/head mounts) and the arm textures (arm mounts).
function drawWeaponsAt(sg, mech, lay, loc, T, s, muzzleOff = false) {
  if (mech.isPartDestroyed(loc)) return;
  const p = lay[loc];
  const weaponIds = mech.mounts[loc].filter(isWeapon);
  const n = weaponIds.length;
  const front = p.y - p.h / 2;
  // #433: the player's base part OMITS the muzzle glow ENTIRELY — `glowSkip` suppresses EVERY
  // emissive layer (every glowDot/glowBar plus every `emissive()`-wrapped coloured layer — edge
  // lights, rail slits, plasma pools, launch cells, blade edges) so that area bakes TRANSPARENT (bare
  // gun hardware), not a dark blob. The muzzle colour lives solely in the separate glow-only overlay
  // (drawPartGlow), which keeps EXACTLY those same layers — so base + overlay recombine to the
  // original inline look per weapon, and the reload blink's off phase reads as the colour vanishing.
  const prevSkip = sg.glowSkip;
  if (muzzleOff) sg.glowSkip = true;
  weaponIds.forEach((id, i) => {
    const wpn = getWeapon(id);
    const bx = p.x + (i - (n - 1) / 2) * (p.w / Math.max(1, n));
    drawWeaponMount(sg, T, id, wpn?.category ?? 'energy', bx, front, s);
  });
  sg.glowSkip = prevSkip;
}

// One arm (the weapon mount) — chunky plate + its weapons — in its OWN texture so the scene
// can pivot it toward convergence. Drawn at the same design coords as when it lived in the
// turret, so a straight (tilt-0) arm renders identically. `stump` if the arm is destroyed.
// #401: the clean base plate IS the fully-armored look — full armor draws NOTHING extra.
// Once the location's armor pool hits 0 (but the arm still has structure/hp), a jagged panel
// is TORN OFF to bare the internals (`exposedInternals`, mechPrims.js): wires/struts/sparks in
// a dark cavity, so armor loss reads as the shell being ripped open rather than plating
// vanishing. Full destruction still falls through to `stump`.
// `noWeapons` (#397 follow-up): draw the arm's PLATING only, skipping its mounted guns +
// muzzle glow — the body-only raster the player's shield shell hugs (buildMechTextures builds
// a `_shield` variant with it set; see arena/shieldOutline.js). A destroyed arm is still a
// stump either way.
// `muzzleOff` (#433): draw the arm's weapons with their muzzle glow OMITTED — `glowSkip`
// (drawWeaponsAt) suppresses the glowDot/glowBar layers so that area bakes TRANSPARENT (bare gun
// hardware), not a dark blob. For the player this is now the arm's SOLE baked state — the muzzle
// colour lives in a separate glow-only overlay sprite (MUZZLE_GLOW_SUFFIX, drawPartGlow) that the
// reload blink toggles on/off, leaving this part texture constant; the off phase reads as the colour
// vanishing to nothing. Enemies bake muzzleOff=false (glow straight in the part, no overlay).
function drawArm(sg, mech, loc, T, noWeapons = false, muzzleOff = false) {
  const lay = mechLayout(mech);
  const s = mech.chassis.art.bodyLen / 38;
  const p = lay[loc];
  // #419: a fully-destroyed location draws NOTHING — no charred stump, no leftover piece. The
  // hull/attachment logic is unaffected (this part texture is simply blank when the location is gone).
  if (mech.isPartDestroyed(loc)) return;
  plate(sg, T, p.x, p.y, p.w, p.h, { fill: T.faceMid });
  if (!mech.hasArmor(loc)) exposedInternals(sg, T, p.x, p.y, p.w, p.h);
  if (!noWeapons) drawWeaponsAt(sg, mech, lay, loc, T, s, muzzleOff);
}

// One side torso (a weapon mount) — plate + recessed vent + its weapons — in its OWN texture
// so the scene can cant it slightly toward convergence. Drawn at the same design coords as
// when it lived in the turret, so a straight (tilt-0) side torso renders identically. The
// shoulder PAULDRON (heavy chassis) is drawn HERE too, so it stays glued to the side torso as
// it cants; other decor (mast/vane/stack/spine) stays on the body. `stump` if destroyed.
// #401: same treatment as drawArm above — clean plate = armored, and once this torso's armor
// is stripped (even though it's still alive) a jagged panel tears off to bare its internals
// via `exposedInternals`, instead of the old brackets-on-top overlay.
// `noWeapons` (#397 follow-up): plating + pauldron only, no mounted guns/muzzle glow — the
// body-only raster for the player's shield shell (see drawArm's note).
// `muzzleOff` (#433): see drawArm — the muzzle-glow-OMITTED bake (transparent where the glow would
// be; the player's sole part state; the colour lives in the separate glow overlay).
function drawSideTorso(sg, mech, loc, T, noWeapons = false, muzzleOff = false) {
  const lay = mechLayout(mech);
  const s = mech.chassis.art.bodyLen / 38;
  const p = lay[loc];
  // #419: a fully-destroyed location draws NOTHING — no charred stump, no leftover piece.
  if (mech.isPartDestroyed(loc)) return;
  plate(sg, T, p.x, p.y, p.w, p.h, { fill: T.face });
  if (!T.bubbly) rectC(sg, p.x, p.y + p.h * 0.16, p.w * 0.6, p.h * 0.12, T.recess);
  if (!mech.hasArmor(loc)) exposedInternals(sg, T, p.x, p.y, p.w, p.h);
  drawPauldronFor(sg, mech, lay, loc, T);
  if (!noWeapons) drawWeaponsAt(sg, mech, lay, loc, T, s, muzzleOff);
}

// #433 (re-architecture): the GLOW-ONLY overlay raster for one weapon-carrying part — the mounted
// weapons' muzzle glow ALONE, in the live CATEGORY neon, on an otherwise-transparent canvas the same
// size + origin as the part. Runs the exact same `drawWeaponsAt` the part uses, but under the
// scaledGraphics glow-gate (`sg.glowOnly`), so only the glowDot/glowBar layers reach the canvas and
// all the gun hardware is suppressed. Layered over the (muzzle-off) part sprite it reproduces the lit
// look; the reload blink toggles this overlay's visibility. A destroyed location draws nothing
// (drawWeaponsAt early-returns), and a slot with no weapon draws nothing — so the overlay is
// transparent there. Damage-INDEPENDENT: the muzzle colour doesn't change with armour, so this is one
// texture per location regardless of damage state (rebuilt in place on reskin, always identical).
function drawPartGlow(sg, mech, loc, T) {
  sg.glowOnly = true;
  const lay = mechLayout(mech);
  const s = mech.chassis.art.bodyLen / 38;
  drawWeaponsAt(sg, mech, lay, loc, T, s, false);   // muzzleOff=false → the CATEGORY neon glow
  sg.glowOnly = false;
}

// Draw the shoulder pauldron(s) that belong to `loc` (side < 0 → leftTorso, > 0 → rightTorso),
// so it rides on the same pivoting texture as its side torso. The other decor kinds stay on
// the body (see drawDecor's `skip`).
function drawPauldronFor(sg, mech, lay, loc, T) {
  const side = loc === 'leftTorso' ? -1 : 1;
  for (const d of mech.chassis.art.decor || []) {
    if (d.kind === 'pauldron' && d.side === side) DECOR_ART.pauldron(sg, d, lay, T);
  }
}

// The body: centre torso + head + spine decor + centre/head weapons. NOT the arms or side
// torsos — those are separate pivoting textures (drawArm / drawSideTorso), drawn under this
// body sprite so it occludes their inner edges (the top-down read). Drawn facing up; weapons
// point forward (-y).
// `noWeapons` (#397 follow-up): the body — centre torso, head, spine decor, reactor glow — WITHOUT
// the centre/head weapon hardware or its muzzle glow. The body-only raster the player's shield
// shell hugs (see drawArm's note).
function drawTurret(sg, mech, T, statusSpot, noWeapons = false) {
  const lay = mechLayout(mech);
  const s = mech.chassis.art.bodyLen / 38;     // size relative to the medium baseline

  // Center torso: armour slab → core inset → dark reactor housing → purple reactor.
  // #128: no longer damage-tracked (no armor/structure of its own — it's still the
  // ability mount, just untied from destructibility) — always draws intact, never a
  // stump.
  const ct = lay.centerTorso;
  plate(sg, T, ct.x, ct.y, ct.w, ct.h, { fill: T.face, chamfer: Math.min(ct.w, ct.h) * 0.26, seam: false });
  if (T.bubbly) ellipseC(sg, ct.x, ct.y, ct.w * 0.6, ct.h * 0.78, T.faceMid);
  else if (T.rounded) roundC(sg, ct.x, ct.y, ct.w * 0.64, ct.h * 0.78, T.faceMid, Math.min(ct.w, ct.h) * 0.2);
  else poly(sg, chamfer(ct.x, ct.y, ct.w * 0.64, ct.h * 0.78, Math.min(ct.w, ct.h) * 0.2), T.faceMid);
  if (T.bubbly) ellipseC(sg, ct.x, ct.y, ct.w * 0.4, ct.h * 0.7, T.housing);            // reactor housing
  else rectC(sg, ct.x, ct.y, ct.w * 0.36, ct.h * 0.84, T.housing);
  // #400/#404: the reactor spine doubles as the POWERUP SPOT for player mechs. When the caller
  // hands in a `statusSpot` colour list (arena players only) it renders that instead of the fixed
  // purple: the active-powerup colours, sectioned when several and a dark core when none — the
  // same in single-player and co-op (#404 reserved this spot for powerups; player identity moved
  // entirely onto the rim accent + ground ring). Enemies & the garage preview pass nothing and
  // keep the original reactor purple.
  if (statusSpot) statusSpotBar(sg, ct.x, ct.y, ct.w * 0.14, ct.h * 0.74, statusSpot);
  else glowBar(sg, ct.x, ct.y, ct.w * 0.14, ct.h * 0.74, REACTOR);                      // reactor spine
  // The two vents flanking the spine complete the reactor cluster. #400 follow-up: for player mechs
  // (statusSpot supplied) they no longer follow the status colour — as small horizontal glowBars they
  // read as a stray horizontal line of colour. Instead they draw a NEUTRAL DARK tone so ONLY the
  // reactor spine carries the powerup/player status colour. Enemies & garage preview keep the fixed
  // reactor purple.
  const ventCol = statusSpot ? { halo: T.housing, core: T.housing, hot: T.housing } : REACTOR;
  glowBar(sg, ct.x, ct.y - ct.h * 0.22, ct.w * 0.32, ct.h * 0.07, ventCol);             // vent
  glowBar(sg, ct.x, ct.y + ct.h * 0.18, ct.w * 0.32, ct.h * 0.07, ventCol);             // vent

  // Head + cockpit optic + antenna. #128: neither is damage-tracked any more — always
  // draws intact, never a stump/charred cockpit.
  const hd = lay.head;
  plate(sg, T, hd.x, hd.y, hd.w, hd.h, { fill: T.faceMid, seam: false });
  rectC(sg, hd.x + hd.w * 0.42, hd.y - hd.h * 0.9, Math.max(0.7, 0.5 * s), hd.h * 0.7, T.rimHi); // antenna
  // #400 follow-up: the head cockpit optic no longer glows purple on PLAYER mechs — Jackson wanted
  // no purple head light. Players (statusSpot supplied) get no optic glow; enemies & garage preview
  // keep the fixed reactor-purple optic.
  const cp = lay.cockpit;
  if (!statusSpot) glowBar(sg, cp.x, cp.y, cp.w, cp.h * 0.7, REACTOR);

  // Structural decor (mast / vane / exhaust stacks) under the weapons. The shoulder PAULDRONS
  // are drawn on the side-torso textures instead (so they cant with the side torso), so skip
  // them here.
  drawDecor(sg, mech, lay, T, { skip: ['pauldron'] });

  // Weapon hardware for the centre/head mounts only — the ARM and SIDE-TORSO mounts are drawn
  // in their own pivoting textures (drawArm / drawSideTorso), so skip them here.
  if (!noWeapons) {
    for (const loc of MOUNT_LOCATIONS) {
      if (PIVOT_LOCATIONS.includes(loc)) continue;
      drawWeaponsAt(sg, mech, lay, loc, T, s);
    }
  }
}

// Legs (feet) + pelvis + skirts. `frame` is one sample of the walk cycle (0..`frames`-1);
// the legs alternate forward/back. Body bob is applied in the scene, not here.
function drawHull(sg, mech, frame, T, frames = HULL_FRAMES) {
  const lay = mechLayout(mech);
  const a = mech.chassis.art;
  const s = a.bodyLen / 38;
  const shift = a.bodyLen * 0.09;     // stride: legs swing less so feet don't jut out far
  const lDir = strideDir(frame, frames);
  const rDir = -lDir;

  // Pelvis block ties the legs together (sits under the torso, tucked up so it's mostly
  // occluded from the top-down view).
  plate(sg, T, 0, a.bodyLen * 0.10, a.bodyWid * 0.5, a.bodyLen * 0.13, { fill: T.deep, seam: false });

  for (const [loc, dir] of [['leftLeg', lDir], ['rightLeg', rDir]]) {
    const p = lay[loc];   // legs are animation-only now — never destroyed
    const fy = p.y + dir * shift;
    ellipseC(sg, p.x, fy + p.h * 0.4, p.w * 1.1, p.h * 0.3, REACTOR.halo, 0.4);   // thruster wash
    ellipseC(sg, p.x, fy + p.h * 0.42, p.w * 0.5, p.h * 0.16, REACTOR.core, 0.8); // thruster core
    plate(sg, T, p.x, fy, p.w, p.h, { fill: T.lower, rim: T.rim, seam: false });
    if (!T.bubbly) {
      rectC(sg, p.x, fy - p.h * 0.4, p.w * 0.86, p.h * 0.16, T.faceMid);          // toe cap (forward)
      rectC(sg, p.x, fy - p.h * 0.46, p.w * 0.5, p.h * 0.1, T.joint);             // ankle actuator
      rectC(sg, p.x + p.w * 0.38, fy + p.h * 0.05, Math.max(0.8, 0.6 * s), p.h * 0.5, T.grime, 0.7);
    }
  }

  // Hip skirts over the inner-top of each leg (read as "legs tuck under the body").
  const legSpread = a.shape?.legSpread ?? 1;
  for (const dx of [-1, 1]) {
    const sx = dx * a.bodyWid * 0.24 * legSpread;
    if (T.bubbly) {
      if (T.legibilityHalo) ellipseC(sg, sx, a.bodyLen * 0.11, a.bodyWid * 0.34 + 1.4, a.bodyLen * 0.13 + 1.4, HALO);
      ellipseC(sg, sx, a.bodyLen * 0.11, a.bodyWid * 0.34, a.bodyLen * 0.13, T.outline);
      ellipseC(sg, sx, a.bodyLen * 0.11, a.bodyWid * 0.3, a.bodyLen * 0.11, T.faceMid);
      ellipseC(sg, sx - a.bodyWid * 0.05, a.bodyLen * 0.08, a.bodyWid * 0.12, a.bodyLen * 0.04, T.rim, 0.9);
      continue;
    }
    // A tucked hip plate that sits OVER the top of the leg — mirrored per side and kept
    // inside the leg's own outer edge, so it reads as "leg tucks under the body" rather than
    // a slab winging out past the leg. Local x-magnitudes ×dx so left/right are true mirrors
    // (the old poly reused one un-mirrored point set, which flared asymmetrically). Only the
    // OUTER-bottom corner draws in (the tuck), giving the slope without the sideways jut.
    // W = a.bodyWid, L = a.bodyLen. `g` insets/expands the outer edge for each shade layer.
    const skirt = (g) => [
      [dx * a.bodyWid * (0.02 - g),  a.bodyLen * (0.055 - g)],   // inner-top (over pelvis)
      [dx * a.bodyWid * (0.27 + g),  a.bodyLen * (0.055 - g)],   // outer-top (≈ leg outer edge)
      [dx * a.bodyWid * (0.215 + g), a.bodyLen * (0.17 + g)],    // outer-bottom (tucked in)
      [dx * a.bodyWid * (0.02 - g),  a.bodyLen * (0.17 + g)],    // inner-bottom
    ];
    if (T.legibilityHalo) poly(sg, skirt(0.02), HALO);
    poly(sg, skirt(0.01), T.outline);
    poly(sg, skirt(0), T.faceMid);
    rectC(sg, dx * a.bodyWid * 0.145, a.bodyLen * 0.08, a.bodyWid * 0.22, Math.max(0.8, 0.6 * s), T.rim);
  }
}

// Build (or re-skin in place) all textures for one mech under `key`. `opts.theme`
// ('player' | 'enemy') picks the faction palette/shape.
export function buildMechTextures(scene, key, mech, opts) {
  const T = themeFor(opts);
  const isPlayer = (opts?.theme ?? 'player') === 'player';
  // #435: `opts.hullFrames` picks how finely the walk cycle is sampled — the player asks for
  // PLAYER_HULL_FRAMES, everything else keeps the historical 4 (see the constants above).
  //
  // `opts.skipHull` is the RESKIN path (reskinMech). The hull is the one texture that is
  // completely damage-independent — it draws pelvis + legs + skirts, and legs are animation-only
  // (never destroyed, no armour state, no weapons, no status spot) — so a re-raster after damage
  // would redraw pixel-identical frames. Skipping them makes a reskin CHEAPER than it was at 4
  // frames, which is what keeps the 16-frame player set free at runtime: the extra frames are
  // paid for exactly once, when the mech is first built.
  const hullFrames = opts?.hullFrames ?? HULL_FRAMES;
  if (!opts?.skipHull || !scene.textures.exists(`${key}_hull_0`)) {
    for (let f = 0; f < hullFrames; f++) {
      gen(scene, `${key}_hull_${f}`, DESIGN * ART_SCALE, DESIGN * ART_SCALE,
        (g) => drawHull(scaledGraphics(g), mech, f, T, hullFrames));
    }
  }
  gen(scene, `${key}_turret`, DESIGN * ART_SCALE, DESIGN * ART_SCALE,
    (g) => drawTurret(scaledGraphics(g), mech, T, opts?.statusSpot));
  // One texture per side torso + arm — the scene pivots each toward the weapon-convergence
  // point (side torsos subtly, arms more; see partSpriteTransform).
  // #433 (re-architecture): the PLAYER bakes each weapon-carrying part MUZZLE-OFF (dark glow) as its
  // SOLE state — the coloured muzzle glow now lives in a separate glow-only overlay (below) that the
  // reload blink toggles, so this base texture NEVER swaps (the shield outline can't re-derive a wrong
  // shell mid-blink). Enemies bake muzzleOff=false: glow straight into the part, no overlay, no blink.
  for (const loc of SIDE_TORSO_LOCATIONS) {
    gen(scene, `${key}_${loc}`, DESIGN * ART_SCALE, DESIGN * ART_SCALE,
      (g) => drawSideTorso(scaledGraphics(g), mech, loc, T, false, isPlayer));
  }
  for (const loc of ARM_LOCATIONS) {
    gen(scene, `${key}_${loc}`, DESIGN * ART_SCALE, DESIGN * ART_SCALE,
      (g) => drawArm(scaledGraphics(g), mech, loc, T, false, isPlayer));
  }
  // #397 follow-up: the PLAYER's shield shell must hug the BODY ARMOR only — not the mounted guns
  // and not their baked-in muzzle glow. Weapons live INSIDE each part texture (drawWeaponsAt), so
  // the only clean way to keep the shell off them is a parallel BODY-ONLY raster of every
  // weapon-carrying part. The hull carries no weapons, so it needs no variant — the shield outline
  // just reuses the live hull frame. Only the player theme builds these (arena/shieldOutline.js
  // `bodyOnly` points the player's outline duplicates at them); enemies keep their full-part shell.
  //
  // #422: each shell raster is the body-only art DILATED by SHIELD_SHELL_PAD (drawDilated) instead
  // of the plain body art. The outline sprite then draws it at the mech's EXACT display scale, so
  // the shell's margin is a constant number of pixels on every side of the silhouette rather than a
  // percentage of each edge's distance from the mech centre. The HULL now needs shells too (one per
  // walk frame): at equal scale the un-dilated hull would be perfectly covered by the real legs and
  // no rim would show at all. They carry no damage state (legs are animation-only), so they follow
  // the same build-once `skipHull` gate as the real hull frames.
  const shell = (name, drawFn) => gen(scene, name, DESIGN * ART_SCALE, DESIGN * ART_SCALE, (g) => {
    const sg = scaledGraphics(g);
    drawDilated(sg, SHIELD_SHELL_PAD, () => drawFn(sg));
  });
  if (isPlayer) {
    if (!opts?.skipHull || !scene.textures.exists(`${key}_hull_0${SHIELD_SHELL_SUFFIX}`)) {
      for (let f = 0; f < hullFrames; f++) {
        shell(`${key}_hull_${f}${SHIELD_SHELL_SUFFIX}`, (sg) => drawHull(sg, mech, f, T, hullFrames));
      }
    }
    shell(`${key}_turret${SHIELD_SHELL_SUFFIX}`, (sg) => drawTurret(sg, mech, T, opts?.statusSpot, true));
    for (const loc of SIDE_TORSO_LOCATIONS) {
      shell(`${key}_${loc}${SHIELD_SHELL_SUFFIX}`, (sg) => drawSideTorso(sg, mech, loc, T, true));
    }
    for (const loc of ARM_LOCATIONS) {
      shell(`${key}_${loc}${SHIELD_SHELL_SUFFIX}`, (sg) => drawArm(sg, mech, loc, T, true));
    }
    // #433 (re-architecture): the GLOW-ONLY overlay for every weapon-carrying part (the four skill
    // slots). Same canvas size + origin as the part, containing ONLY the muzzle glow in the CATEGORY
    // neon (drawPartGlow, via the scaledGraphics glow-gate). The mech view (locomotion.js) mounts one
    // overlay sprite per slot ABOVE its part, sharing its transform; it's VISIBLE by default (so the
    // glow shows normally) and the reload blink toggles its visibility (arena/ammoIndicators.js). The
    // part texture itself never changes, so nothing downstream (the shield outline) re-derives its
    // shape. Rebuilt in place on every reskin like the rest — always identical, since muzzle colour is
    // damage-independent — so a reskin can never leave a stale glow. Player-only.
    for (const loc of PIVOT_LOCATIONS) {
      gen(scene, `${key}_${loc}${MUZZLE_GLOW_SUFFIX}`, DESIGN * ART_SCALE, DESIGN * ART_SCALE,
        (g) => drawPartGlow(scaledGraphics(g), mech, loc, T));
    }
  }
}

// Re-draw after damage so destroyed parts become stumps / weapons vanish. `skipHull` (#435):
// the walk-cycle hull frames carry no damage state at all, so they're left standing rather than
// redrawn identically — see buildMechTextures.
export function reskinMech(scene, key, mech, opts) {
  buildMechTextures(scene, key, mech, { ...opts, skipHull: true });
}
