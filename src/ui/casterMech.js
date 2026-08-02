// #612 — the CASTER on an ability catalog card is the player's OWN LIVE MECH.
//
// Every ability preview (ui/abilityPreview.js) needs something standing where the ability goes
// off. That used to be `_drawChip`: a ~9x12px accent-coloured block with a white dot, justified in
// that module's header on the grounds that "there is no mech on a catalog card to desaturate, and
// building one per card is far out of proportion". #611 retired that premise — the CHASSIS cards
// draw real posed mechs on cards through `art/mechView.js`'s `makeMechParts`/`poseMechParts`, and
// the Garage catalog is now one grid where a card showing a mech is ordinary. Jackson: "for ability
// previews, it seems there's a generic green box or something to represent the 'mech'; can we
// instead actually show the mech?"
//
// WHAT IS SHOWN, and what it costs:
//
//   * It is the COLUMN'S OWN LIVE BUILD — that player's chassis, that player's mounted weapons,
//     that player's colour — not a neutral stand-in. Which means it is PER COLUMN in co-op, and it
//     has to follow every mount, chassis swap and colour change.
//   * It costs ZERO extra texture bakes. A caster is a `makeMechParts` sprite stack pointed at the
//     column's ALREADY-BAKED `col.textureKey` — the very textures the lab's big preview panel and
//     the arena's own mech view read from. GarageScene re-bakes that key IN PLACE on every build
//     change (`buildMechTextures`/`reskinMech` both re-`gen()` under the same keys), so every
//     caster on every card picks the new pixels up for free; only the POSE has to be re-applied,
//     because a chassis swap moves the shoulder/arm joints (`refresh` below). That is the whole
//     answer to "don't do a dozen near-identical bakes of the same build".
//   * The one thing that IS baked here is Cloak's greyscale, and it is baked once per column for
//     the same reason: `desaturateTexture` writes to `${partKey}_grey`, and every column's cards
//     share one `textureKey`, so the six `_grey` part textures exist once no matter how many cards
//     ask for them.
//
// SIZE. A caster is scaled by the card's own world→px factor against `CASTER_WORLD_PX` (the mech's
// real arena footprint), so the mech standing on a card is the same size relative to the blast
// radius / envelope / travel drawn around it that it is when the ability actually goes off. The
// caller floors and caps that against its stage — see `abilityPreview.js`'s `setStage`.
import { makeMechParts, poseMechParts } from '../art/mechView.js';
import { DESIGN, ART_SCALE, PIVOT_LOCATIONS, desaturateTexture } from '../art/mechArt.js';
import { ARENA_MECH_SCALE } from '../scenes/arena/shared.js';
import { CLOAK_ALPHA, CLOAK_GLOW_ALPHA, CLOAK_GLOW_TINT } from '../scenes/arena/abilities.js';

export { CLOAK_ALPHA };

// A mech part's baked raster square (every part is a DESIGN×DESIGN design grid, super-sampled by
// ART_SCALE), and the on-screen footprint that square occupies IN THE ARENA. The second number is
// what makes a card's mech proportional to everything else on the card.
export const CASTER_PART_PX = DESIGN * ART_SCALE;
export const CASTER_WORLD_PX = CASTER_PART_PX * ARENA_MECH_SCALE;

// How much of that square the mech's own silhouette actually fills, top to bottom — the part
// canvas carries headroom for the arms' pivot swing, so the visible mech is meaningfully smaller
// than its texture. Measured off the drawn art, and used only to turn a footprint into a "how big
// is the thing standing there" radius for the card's own FX sizing. Approximate by design.
export const CASTER_BODY_FRAC = 0.75;

// Cloak's flatten canvas, as a multiple of the caster's footprint. Same headroom argument (and the
// same generous number) as `cloakFlatten.js`'s `flattenCanvasSize`: a pivoting shoulder/arm walks
// away from dead centre, so the canvas needs room beyond one part's own footprint or a wide
// chassis' spread arms clip at the edge.
const CLOAK_RT_MARGIN = 2.5;

// The six part sprites `makeMechParts` returns, by the field it stores each under. Mirrors
// `arena/abilities.js`'s own `MECH_PART_KEYS`.
const MECH_PART_FIELDS = ['hull', 'shldL', 'shldR', 'armL', 'armR', 'turret'];

// One mech standing on one card. A thin wrapper over the shared sprite assembly — it exists to own
// the "place it at (x, y) this big" math and the invalidate-on-build-change hook, so the ability
// preview never has to know how a mech is put together.
export class CasterMech {
  // `source` is the caller's LIVE handle on the build — `{ mech, textureKey }`, read on every pose
  // rather than snapshotted, because GarageScene mutates the same Mech instance in place.
  constructor(scene, source) {
    this.scene = scene;
    this.source = source;
    this.parts = makeMechParts(scene, source.textureKey, { x: 0, y: 0, scale: 1, isPlayer: true });
    this.children = this.parts.children;
    this.x = null; this.y = null; this.footprintPx = null;
  }

  addTo(container) {
    container.add(this.children);
    return this;
  }

  // Centre the mech at (x, y) with its part square drawn `footprintPx` across. A no-op when
  // nothing moved (most cards' casters are dead still — only Dash and Jump Blast travel), so the
  // per-frame cost of a static caster is a single comparison.
  place(x, y, footprintPx, force = false) {
    if (!force && x === this.x && y === this.y && footprintPx === this.footprintPx) return;
    this.x = x; this.y = y; this.footprintPx = footprintPx;
    const scale = footprintPx / CASTER_PART_PX;
    this.scale = scale;
    for (const s of this.children) s.setScale(scale);
    // makeMechParts positions hull/turret directly; poseMechParts owns the four pivoting parts and
    // their muzzle-glow overlays — the same two-step the lab preview and the chassis cards use.
    this.parts.hull.setPosition(x, y);
    this.parts.turret.setPosition(x, y);
    poseMechParts(this.parts, this.source.mech, -Math.PI / 2, scale, x, y, {});
  }

  // The build changed (a mount, a chassis swap, a colour). The TEXTURES re-bake themselves in place
  // under the same keys, so nothing here needs re-pointing — but a chassis swap moves the joints,
  // and `setTexture` resets a sprite's origin, so the pose is re-applied unconditionally.
  refresh() {
    if (this.footprintPx == null) return;
    this.place(this.x, this.y, this.footprintPx, true);
  }

  // Both guarded on the last value they were given: a caster is ten sprites, most cards' casters
  // sit at full alpha and never move, and this runs once per card per frame.
  setVisible(v) {
    if (v === this._visible) return;
    this._visible = v;
    for (const s of this.children) s.setVisible(v);
  }

  setAlpha(a) {
    if (a === this._alpha) return;
    this._alpha = a;
    for (const s of this.children) s.setAlpha(a);
  }

  destroy() {
    for (const s of this.children) s.destroy();
    this.children = [];
    this.parts = null;
  }
}

// Cloak's REAL look on a card (#612), replacing the outline-only "lit wireframe" chip stand-in the
// #500 fourth pass settled on. Both halves of the arena's effect are the genuine article here:
//
//   1. The per-pixel greyscale re-bake — `desaturateTexture` (art/mechArt.js), the same call
//      `arena/abilities.js`'s `setCloakVisual` makes, with the same per-slot muzzle-glow dim/tint
//      alongside it. Not a tint and not a redrawn silhouette: the actual `_grey` textures.
//   2. The FLATTEN — `arena/cloakFlatten.js`'s whole reason for existing. A mech is six-plus
//      sibling sprites in one container, and dimming the container multiplies its alpha into each
//      child independently, so a leg shows through the torso in front of it. Pre-compositing the
//      greyed parts into ONE RenderTexture at full opacity gives normal occlusion, and CLOAK_ALPHA
//      then applies exactly once, to that single image.
//
// The one thing this does NOT copy is the arena's per-frame re-bake: an arena mech is walking, a
// card's is standing still, so the flatten is baked lazily on first use and only re-baked when the
// build or the layout actually changes. What animates per frame is the RenderTexture's alpha,
// which is free.
export class CasterCloak {
  constructor(scene, caster) {
    this.scene = scene;
    this.caster = caster;
    this.rt = null;
    this.size = 0;
    this._dirty = true;
  }

  invalidate() { this._dirty = true; }

  // Returns the flatten image, allocating/rebaking as needed. `container` is where the RenderTexture
  // is parented on first use — the caster's own layer, so it scrolls, masks and z-orders with the
  // mech it stands in for.
  ensure(container) {
    const c = this.caster;
    const size = Math.max(8, Math.ceil(c.footprintPx * CLOAK_RT_MARGIN));
    if (this.rt && this.size !== size) { this.rt.destroy(); this.rt = null; }
    if (!this.rt) {
      this.size = size;
      this.rt = this.scene.add.renderTexture(0, 0, size, size).setOrigin(0.5, 0.5).setVisible(false);
      container.add(this.rt);
      this._dirty = true;
    }
    this.rt.setPosition(c.x, c.y);
    if (this._dirty) { this._bake(); this._dirty = false; }
    return this.rt;
  }

  hide() { this.rt?.setVisible(false); }

  _bake() {
    const { parts, children, x, y } = this.caster;
    const half = this.size / 2;
    // Swap every part to its genuine greyscale variant and mute the muzzle glows, exactly as
    // `setCloakVisual` does. The HULL is swapped here too — the arena deliberately leaves it to
    // `_stepGait` because a walking mech re-picks its hull frame every tick and would stomp the
    // swap; a card's mech never walks, so there is nothing to stomp it.
    const restore = [];
    for (const field of MECH_PART_FIELDS) {
      const s = parts[field];
      if (!s?.setTexture) continue;
      const key = s.texture.key;
      restore.push([s, key]);
      s.setTexture(desaturateTexture(this.scene, key));
    }
    for (const loc of PIVOT_LOCATIONS) {
      const glow = parts.glow?.[loc];
      if (!glow) continue;
      glow.setAlpha(CLOAK_GLOW_ALPHA);
      glow.setTint(CLOAK_GLOW_TINT);
    }
    // `setTexture` resets a sprite's origin to centre, which would drop every pivoting part off its
    // joint — re-pose before drawing, and again after restoring.
    this.caster.refresh();

    // A bake can land on any frame, including one where the cross-dissolve has already faded the
    // real parts to alpha 0 and hidden them (a card that scrolled away mid-cloak and came back to
    // a re-baked build does exactly that) — so the flatten is taken from a forced fully-opaque,
    // fully-visible pose and the live state is put back afterwards. This is also what makes the
    // flatten OCCLUDE properly: partial alpha on a part would let its sibling show through inside
    // the composite, which is the very bug cloakFlatten.js exists to kill.
    const was = children.map((s) => ({ visible: s.visible, alpha: s.alpha }));
    for (const s of children) { s.setVisible(true); s.setAlpha(1); }
    // The glows keep their own deliberate cloak dim, applied just above.
    for (const loc of PIVOT_LOCATIONS) parts.glow?.[loc]?.setAlpha(CLOAK_GLOW_ALPHA);
    this.rt.clear();
    // Child order IS back-to-front draw order, and every part goes in at its own full opacity, so
    // the flattened result occludes internally exactly like an uncloaked mech.
    for (const s of children) this.rt.draw(s, half + (s.x - x), half + (s.y - y));
    children.forEach((s, i) => { s.setVisible(was[i].visible); s.setAlpha(was[i].alpha); });

    for (const [s, key] of restore) s.setTexture(key);
    for (const loc of PIVOT_LOCATIONS) {
      const glow = parts.glow?.[loc];
      if (!glow) continue;
      glow.setAlpha(1);
      glow.clearTint();
    }
    this.caster.refresh();
  }

  destroy() {
    this.rt?.destroy();
    this.rt = null;
  }
}
