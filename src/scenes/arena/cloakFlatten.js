// #500 (fifth pass — the real fix). Owner playtest, TWICE now, confirmed the leg/torso
// occlusion bleed-through survives raising each part's own baked fill alpha
// (art/mechArt.js CLOAK_FILL_ALPHA_MULT, 0.55→0.92): "I'm not seeing cloak occlusion whatever
// fix on the legs like I asked for."
//
// ROOT CAUSE (why a per-part alpha number can never fix this): a mech view is a Phaser
// CONTAINER holding SIX-PLUS SIBLING sprites (hull, leftTorso, rightTorso, leftArm, rightArm,
// turret, plus a muzzle-glow overlay per weapon-carrying slot — see mechView.js
// `makeMechParts`). Phaser renders a container by drawing each child independently into the
// shared render target, MULTIPLYING the CONTAINER's own alpha into every child as it draws
// (abilities.js sets that container alpha to CLOAK_ALPHA=0.45 while cloaked). That container
// alpha is a SECOND, independent source of transparency layered on top of whatever alpha each
// part's own texture already carries — no choice of per-part texture alpha can prevent a
// translucent container from letting whatever's drawn BEHIND a sibling still blend through it.
// Raising the per-part fill alpha towards opaque only shrinks the residual bleed; it can't
// remove it, because the container-level multiply still applies uniformly afterward.
//
// THE FIX: pre-composite the cloaked parts into ONE flattened raster FIRST, with NORMAL (fully
// opaque, non-cloak) internal occlusion — so a torso drawn over a hull in the SAME image
// completely covers it, exactly like an uncloaked mech — and apply the translucency reduction
// ONCE, to that single flattened result, instead of to each sibling independently. A Phaser
// RenderTexture is exactly this: an off-screen canvas other game objects can be `.draw()`n into,
// whose own content is then shown like a normal texture with its own single alpha.
//
// Each live player gets one RenderTexture + the RenderTexture itself doubles as the displayed
// game object (`setOrigin`/`setAlpha`/`setPosition` all work directly on it — no separate Image
// needed). It is created lazily on that player's first cloak activation and reused/redrawn every
// frame cloak stays active; see `_updateCloakFlatten` below for exactly when in the frame this
// runs and why.
import { CLOAK_ALPHA, hasActiveEffect } from './abilities.js';
import { livePlayersOf } from './players.js';
import { DESIGN, ART_SCALE } from '../../art/mechArt.js';
import { ARENA_MECH_SCALE } from './shared.js';

// Pure (no Phaser): the flatten canvas's side length in px, given the part-texture design
// constants. Every mech part is baked into a DESIGN×DESIGN (super-sampled by ART_SCALE) square
// and displayed at ARENA_MECH_SCALE, so one part's own on-screen footprint is
// `designPx * artScale * mechScale` px — but a PIVOTING part (side torso/arm) also carries a
// joint offset that walks it away from dead-centre (mechArt.js `partSpriteTransform`), so the
// canvas needs headroom beyond a single part's own footprint to avoid clipping a wide chassis'
// spread arms at the flatten's edge. `margin` is that headroom as a multiple of one part's
// footprint — 2.5x is generous or the width by measurement) at negligible extra canvas-alloc
// cost (one small canvas per player, built once on first cloak).
export function flattenCanvasSize(designPx, artScale, mechScale, margin = 2.5) {
  return Math.ceil(designPx * artScale * mechScale * margin);
}

// Pure (no Phaser): which of a mech view's children get drawn into this frame's flatten pass —
// every container child that's CURRENTLY VISIBLE. A hidden child must stay hidden in the
// flattened result too (a muzzle-glow overlay mid-reload-blink, or a shield-outline sprite while
// the shield pool is empty) — the flatten is a literal snapshot of what would already be
// showing, not "every child unconditionally". Order is preserved (a container's child order IS
// its back-to-front draw order), which is what gives the flatten correct internal occlusion.
export function cloakFlattenTargets(view) {
  const list = view?.list;
  if (!Array.isArray(list)) return [];
  return list.filter((child) => child && child.visible !== false);
}

const FLATTEN_SIZE = flattenCanvasSize(DESIGN, ART_SCALE, ARENA_MECH_SCALE);
const FLATTEN_HALF = FLATTEN_SIZE / 2;

export const CloakFlattenMixin = {
  // Redraw (while cloaked) or tear down (once cloak drops) each live player's flatten
  // RenderTexture. Called ONCE PER FRAME from ArenaScene.update(), as the LAST statement in that
  // method — strictly after every other per-frame mutation of a player's view: `_stepGait`
  // (gait pose, walk-frame texture, turret rotation, convergence tilts), `_updatePowerups` →
  // `updateShieldOutline` (shield-shell sprite texture/position/alpha), `_updateStatusSpots` →
  // a possible mid-run reskin, and `_drawAmmoIndicators` (the muzzle-glow reload-blink
  // visibility toggle). Placing this any earlier risks flattening a stale pose or a
  // about-to-change glow visibility that a later step in the SAME frame is still going to touch;
  // placing it here guarantees the bake matches exactly what would have rendered this frame.
  _updateCloakFlatten() {
    for (const player of livePlayersOf(this)) {
      const view = player.view;
      if (!view) continue;
      if (hasActiveEffect(player, 'cloak')) this._flattenCloakedView(view);
      else this._teardownCloakFlatten(view);
    }
  },

  // Bake this frame's cloaked pose into `view`'s flatten RenderTexture, then swap the display:
  // hide the real (multi-sibling) container and show the single flattened result in its place,
  // with CLOAK_ALPHA applied to THAT ONE IMAGE — never to the individual siblings.
  _flattenCloakedView(view) {
    if (!view._cloakRT) {
      // Lazy per-player allocation: only a mech that actually mounts + activates Cloak ever
      // pays for this canvas. `setOrigin(0.5, 0.5)` so positioning it at the mech's own (x, y)
      // centres it exactly like the container it's standing in for.
      view._cloakRT = this.add.renderTexture(0, 0, FLATTEN_SIZE, FLATTEN_SIZE).setOrigin(0.5, 0.5);
    }
    const rt = view._cloakRT;
    const kids = cloakFlattenTargets(view);
    rt.clear();
    // Draw every visible part at ITS OWN current alpha/rotation/origin/texture (no override) —
    // by design, no sprite here carries a translucency value that CAUSED the original bug: a
    // part sprite's own `.alpha` is always 1 (untouched), and the container-level CLOAK_ALPHA
    // that DID cause it is deliberately never applied here (see `abilities.js`'s
    // `setCloakVisual`, which no longer touches the container's alpha at all). What made a part
    // fully occlude whatever's behind it used to depend on how close its BAKED FILL alpha
    // (mechArt.js `desaturateTexture`) got to fully opaque; that texture now bakes the fill at
    // full opacity too (the CLOAK_FILL_ALPHA_MULT hack is retired — see that file's comment),
    // so drawing straight into the RenderTexture composites parts with NORMAL opaque-over-opaque
    // occlusion, same as an uncloaked mech. A muzzle-glow overlay's own small CLOAK_GLOW_ALPHA
    // dim (abilities.js) and a shield-outline sprite's own strength-alpha are both genuine,
    // independent effects unrelated to this bug, so they're deliberately left alone here too.
    // `FLATTEN_HALF + child.x/y` re-centres each child's container-local offset onto the
    // RenderTexture's own centre (the RT's internal draw space is top-left-origin regardless of
    // the RT's own `setOrigin` used for DISPLAYING it).
    for (const child of kids) rt.draw(child, FLATTEN_HALF + child.x, FLATTEN_HALF + child.y);

    // Hide the real multi-sibling container and show the flattened stand-in in its place,
    // mirroring the container's own live transform (position + the footstep squash/rebound
    // scale tween in locomotion.js `_footImpactFx`, which targets the container directly) so
    // nothing about the mech's silhouette or motion reads differently while cloaked.
    view.setVisible(false);
    rt.setPosition(view.x, view.y);
    rt.setScale(view.scaleX, view.scaleY);
    rt.setDepth(view.depth);
    rt.setAlpha(CLOAK_ALPHA);
    rt.setVisible(true);
  },

  // Cloak just dropped (or never activated this player): show the real parts again, hide the
  // flatten stand-in. Nothing to un-bake — the next activation redraws the RenderTexture fresh.
  _teardownCloakFlatten(view) {
    view.setVisible(true);
    if (view._cloakRT) view._cloakRT.setVisible(false);
  },
};
