// Posing a unit OUT of the arena — the shared "show this thing in isolation" helpers.
//
// A mech is six sprites (hull frame + two side torsos + two arms + turret), assembled at run time
// rather than baked as one image, so anything that wants to display one standing still — the
// garage preview, the #461 art gallery, #452's HUD target readout — has to reproduce that stack.
// This is the one copy of it: pose at a fixed facing, with each part pivoted at its joint by the
// same `partSpriteTransform` the arena uses, so a preview and the live unit can never disagree
// about where an arm sits.
//
// Deliberately NOT a scene mixin: it takes the scene it should build into, so a HUD overlay scene
// and a gallery scene can both call it, and it returns the sprites rather than tracking them.

import { PIVOT_LOCATIONS, partSpriteTransform, MUZZLE_GLOW_SUFFIX, HULL_FRAMES } from './mechArt.js';

// The facing every isolated pose uses. At -π/2 `partSpriteTransform` reproduces each part's
// baked-in placement exactly, so the whole assembled mech lives in the parts' shared texture
// frame — which is what makes the union of their inked bounds the mech's real silhouette box.
export const PREVIEW_ANGLE = -Math.PI / 2;

// Every texture key one mech's pose is assembled from, filtered to those that actually exist (a
// destroyed part bakes blank and may be absent entirely). Feed this to `InkCache.union` to get the
// mech's silhouette box.
export function mechPreviewKeys(textures, key, frames = HULL_FRAMES) {
  const keys = [];
  for (let f = 0; f < frames; f++) keys.push(`${key}_hull_${f}`);
  keys.push(`${key}_turret`, ...PIVOT_LOCATIONS.map((loc) => `${key}_${loc}`));
  return keys.filter((k) => textures.exists(k));
}

// Build one mech's pose into `holder` at `scale`, offset by `ox`/`oy` (the re-centring the ink fit
// asks for). Draw order matches the arena's: hull, then the pivoting parts, then the player-only
// muzzle-glow overlays (#433) sharing each part's transform, then the turret on top.
// Returns the sprites so the caller can animate the hull or retint the lot.
export function poseMechInto(scene, holder, key, mech, scale, frame, ox, oy) {
  const hull = scene.add.sprite(ox, oy, `${key}_hull_${frame}`).setScale(scale);
  holder.add(hull);

  const parts = [];
  const glows = [];
  for (const loc of PIVOT_LOCATIONS) {
    if (!scene.textures.exists(`${key}_${loc}`)) continue;
    const t = partSpriteTransform(mech, loc, PREVIEW_ANGLE, scale);
    const s = scene.add.sprite(0, 0, `${key}_${loc}`).setScale(scale)
      .setOrigin(t.ox, t.oy).setPosition(ox + t.dx, oy + t.dy);
    s.rotation = t.rot;
    holder.add(s);
    parts.push(s);
    const gk = `${key}_${loc}${MUZZLE_GLOW_SUFFIX}`;
    if (scene.textures.exists(gk)) {
      const g = scene.add.sprite(0, 0, gk).setScale(scale)
        .setOrigin(t.ox, t.oy).setPosition(ox + t.dx, oy + t.dy);
      g.rotation = t.rot;
      glows.push(g);
    }
  }
  for (const g of glows) holder.add(g);
  const turret = scene.add.sprite(ox, oy, `${key}_turret`).setScale(scale);
  holder.add(turret);
  return { hull, parts, glows, turret };
}

// The two texture keys a non-mech VEHICLE is stacked from, honouring the multi-frame conventions
// (`legFrames` ⇒ `_hull_0..N`, `turretFrames` ⇒ `_turret_0..N`) that enemies.js renders by.
export function vehiclePreviewKeys(texKey, { legFrames = 0, turretFrames = 0 } = {}) {
  return {
    hull: legFrames ? `${texKey}_hull_0` : `${texKey}_hull`,
    turret: turretFrames ? `${texKey}_turret_0` : `${texKey}_turret`,
  };
}
