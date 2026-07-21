// On-mech per-weapon RELOAD LIGHT (#402). Each mounted, online, LIMITED-ammo weapon wears a tiny
// status light drawn ON THE MECH — bolted to its own mount segment — so the player can read every
// gun's state without looking away to the HUD:
//   * GREEN  = ready (has ammo, can fire);
//   * RED    = empty/dead (dry — only briefly, since empty auto-starts a reload);
//   * BLUE   = reloading, BLINKING (bright/dim so the dot never fully vanishes).
// Unlimited-ammo weapons (melee, `ammoMax: null`) show nothing — they can never run dry or reload.
//
// #402 follow-up: the horizontal ammo/reload BAR was dropped entirely (owner: "just a reload light
// and no bar"), so this overlay is now a single dot per weapon and the baked socket (mechPrims.js
// `readoutMount`) is just a small round bezel that hosts it.
//
// This is a per-frame OVERLAY, not baked into the mech textures, because it reads LIVE state
// (art/mechArt.js is static per walk-frame and only re-skins on damage). The mech art bakes a
// PERSISTENT light socket (drawn on each weapon-carrying arm/side-torso texture regardless of
// armor state), and this overlay paints the live lit dot onto that exact socket. The anchor is the
// part's JOINT — the same point the part sprite pivots around (art/mechArt.js `partSpriteTransform`
// returns its offset in `dx/dy`) — measured off the mech's RENDERED VIEW CONTAINER (`player.view`),
// NOT its logical `player.x/y`: the view is offset each frame by the gait bob (`_stepGait` sets
// `view.setPosition(x, y - bob)`), so anchoring to the logical position let the light float against
// the bobbing body. Anchoring to the container locks the dot to the part — and because the socket
// sits ON the joint (the pivot), the dot needs no rotation and never swings as the limb cants.
// Purely visual — the state it reads is all from the pure model (Mech.weapons()), so there is
// nothing to unit-test here (reload/ammo transitions are covered in Mech.test.js).
import { partSpriteTransform } from '../../art/index.js';
import { ARENA_MECH_SCALE, DEPTH } from './shared.js';
import { livePlayersOf } from './players.js';

const COL = {
  ready: 0x7bd17b,     // green — has ammo, can fire
  empty: 0xe2533a,     // red — dry (only briefly; empty auto-starts a reload)
  reload: 0x5e7ce0,    // blue-violet — reloading (matches the HUD tile's reload tint)
};
// Status-light radius in world px. The baked socket's radius is READOUT.lightR * display scale;
// this draws the lit dot a hair smaller so it sits inside the socket's dark rim.
const LIGHT_R = 1.7 * ARENA_MECH_SCALE;

export const AmmoIndicatorsMixin = {
  // #402: one shared Graphics layer for every player's reload lights, cleared and redrawn each
  // frame. Sits at the projectile tier so it draws over the mech body (DEPTH.UNITS) rather than
  // under it. Created in ArenaScene.create() alongside the other per-frame FX layers.
  _initAmmoIndicators() {
    this.ammoFx = this.add.graphics().setDepth(DEPTH.PROJECTILES);
  },

  // Redraw every live player's on-mech reload lights. Called once per frame from
  // ArenaScene.update().
  _drawAmmoIndicators() {
    const g = this.ammoFx;
    if (!g) return;
    g.clear();
    const now = this.time?.now ?? 0;
    // A ~5Hz blink for reloading lights — bright/dim rather than fully off, so the dot never
    // vanishes (which would read as "gone", not "busy").
    const blink = 0.45 + 0.55 * (Math.sin(now * 0.012) > 0 ? 1 : 0);
    for (const player of livePlayersOf(this)) {
      const mech = player?.mech;
      if (!mech) continue;
      // Anchor off the RENDERED view container (includes the gait bob), not the logical position.
      const baseX = player.view?.x ?? player.x;
      const baseY = player.view?.y ?? player.y;
      for (const w of mech.weapons()) {
        if (!w.online || w.ammo == null) continue;   // offline or unlimited: no light
        // Anchor = the part's joint (dx/dy from partSpriteTransform) — the same point the baked
        // socket sits on and the sprite pivots around. On the pivot, so no orientation needed.
        const t = partSpriteTransform(mech, w.location, player.turretAngle, ARENA_MECH_SCALE);
        this._drawWeaponLight(g, baseX + t.dx, baseY + t.dy, w, blink);
      }
    }
  },

  // One weapon's status light at its socket (cx, cy): green ready / red empty / blinking reload.
  _drawWeaponLight(g, cx, cy, w, blink) {
    const reloading = w.reloading;
    const empty = !reloading && w.ammo < 1;
    const col = reloading ? COL.reload : empty ? COL.empty : COL.ready;
    const alpha = reloading ? blink : 1;
    g.fillStyle(col, alpha);
    g.fillCircle(cx, cy, LIGHT_R);
    // A faint dark ring so the light stays legible over bright terrain.
    g.lineStyle(1, 0x000000, 0.4 * alpha);
    g.strokeCircle(cx, cy, LIGHT_R);
  },
};
