// #404 (third pass) — the shared SPRITE ASSEMBLY for a mech.
//
// A mech is not one sprite: it's a hull, two side torsos, two arms, a per-slot muzzle-glow overlay
// above each of those four, and the body/turret on top — in that exact back-to-front order, each
// posed at its own joint. The arena (`arena/locomotion.js`) and the garage lab preview
// (`GarageScene`) both build that stack, and they used to build it from two hand-kept-in-sync
// copies of the list. Layer order, which parts exist, and how a part is pivoted onto its joint are
// therefore defined ONCE here; both callers use these two functions.
//
// What stays with the caller is only what genuinely differs: the arena parents the sprites to a
// moving container at world depth and eases per-part convergence tilts every frame; the lab places
// them at fixed screen coordinates, at its own preview scale, in a still pose (tilt 0, facing up,
// hull frame 0). Those are arguments here, not forks of the code.
import { partSpriteTransform, PIVOT_LOCATIONS, MUZZLE_GLOW_SUFFIX } from './mechArt.js';

// The four off-centre parts that pivot on a joint, paired with the field each is stored under.
// (`PIVOT_LOCATIONS` order is side torsos then arms — the same back-to-front order they draw in.)
const PIVOT_FIELDS = { leftTorso: 'torL', rightTorso: 'torR', leftArm: 'armL', rightArm: 'armR' };

// Build one mech's sprite stack under texture `key`, at `scale`, positioned at (x, y).
// Returns `{ hull, torL, torR, armL, armR, turret, glow, children }` where `children` is the
// stack in BACK-TO-FRONT draw order (hull → side torsos → arms, each followed by its muzzle-glow
// overlay → turret) — the arena hands that array straight to a container, the lab adds them in
// order. `isPlayer` gates the muzzle-glow overlays, which are baked for the player theme only.
export function makeMechParts(scene, key, { x = 0, y = 0, scale = 1, isPlayer = false } = {}) {
  const spr = (tex) => scene.add.sprite(x, y, tex).setScale(scale);
  const parts = {
    hull: spr(`${key}_hull_0`),
    torL: spr(`${key}_leftTorso`),
    torR: spr(`${key}_rightTorso`),
    armL: spr(`${key}_leftArm`),
    armR: spr(`${key}_rightArm`),
    turret: spr(`${key}_turret`),
    glow: {},
  };
  const children = [parts.hull];
  for (const loc of PIVOT_LOCATIONS) {
    const part = parts[PIVOT_FIELDS[loc]];
    children.push(part);
    // #433: the muzzle glow is a glow-ONLY overlay on its own texture, sitting directly above its
    // (muzzle-off) part and sharing that part's transform. Visible by default; the arena's reload
    // blink toggles it, the lab leaves it lit — so the preview reads as the lit mech does in play.
    if (isPlayer) {
      const o = spr(`${key}_${loc}${MUZZLE_GLOW_SUFFIX}`);
      parts.glow[loc] = o;
      children.push(o);
    }
  }
  children.push(parts.turret);
  parts.children = children;
  return parts;
}

// Place + pivot the four off-centre parts (and each one's glow overlay) onto their joints.
// `angle` is the turret facing (the lab passes -π/2 so the mech faces up with rotation 0);
// `baseX`/`baseY` is the origin the offsets are measured from (0,0 inside the arena's container,
// the preview centre in the lab); `tilts` maps a loc → extra convergence tilt (the lab passes {}).
export function poseMechParts(parts, mech, angle, scale, baseX, baseY, tilts = {}) {
  for (const loc of PIVOT_LOCATIONS) {
    const sprite = parts[PIVOT_FIELDS[loc]];
    if (!sprite) continue;
    const t = partSpriteTransform(mech, loc, angle, scale);
    const rot = t.rot + (tilts[loc] || 0);
    for (const s of [sprite, parts.glow?.[loc]]) {
      if (!s) continue;
      s.setOrigin(t.ox, t.oy);
      s.setPosition(baseX + t.dx, baseY + t.dy);
      s.rotation = rot;
    }
  }
}
