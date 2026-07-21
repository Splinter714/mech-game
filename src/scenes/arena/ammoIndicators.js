// On-mech per-weapon ammo indicators (#402). Each mounted, online, LIMITED-ammo weapon wears a
// tiny readout drawn ON THE MECH — near its own mount location — so the player can read every
// gun's state without looking away to the HUD:
//   * a STATUS LIGHT — a small dot: green = ready, red = empty/dead, amber (blinking) = reloading;
//   * a HORIZONTAL AMMO BAR — rounds remaining, draining as the weapon fires and filling as it
//     reloads (during a reload the bar shows the reload's own progress, so it visibly refills).
// Unlimited-ammo weapons (melee, `ammoMax: null`) show nothing — they can never run dry or reload.
//
// This is a per-frame OVERLAY, not baked into the mech textures: the mech art (art/mechArt.js) is
// static per walk-frame and only re-skins on damage, so live ammo/reload state can't live there.
// The overlay draws in world space at each weapon's mount joint, using the SAME per-part transform
// the sprites themselves pivot with (art/mechArt.js `partSpriteTransform`), so a light rides its
// arm/side-torso as the turret slews. Purely visual — the state it reads is all from the pure
// model (Mech.weapons()), so there is nothing to unit-test here (the reload/ammo transitions are
// covered in Mech.test.js).
import { partSpriteTransform } from '../../art/index.js';
import { ARENA_MECH_SCALE, DEPTH } from './shared.js';
import { livePlayersOf } from './players.js';

// Geometry (world px). The mech renders at ARENA_MECH_SCALE (~0.34) on a hex grid of ~48px, so a
// ~20px bar reads as a compact tag on a ~50px mech without crowding it.
const BAR_W = 20;
const BAR_H = 3.5;
const LIGHT_R = 2.4;
const GAP = 3;            // vertical gap between the bar and the light above it
const DROP = 9;           // push the whole tag toward screen-bottom of the joint so it clears the turret plate

const COL = {
  track: 0x0c1116, trackEdge: 0x2a333f,
  ready: 0x7bd17b,     // green — has ammo, can fire
  low: 0xefc14a,       // amber — has ammo but the magazine is running low
  empty: 0xe2533a,     // red — dry (only briefly; empty auto-starts a reload)
  reload: 0x5e7ce0,    // blue-violet — reloading (matches the HUD tile's reload tint)
};

// A magazine at/under this fraction reads as "running low" (amber light) rather than plain ready.
const LOW_FRAC = 0.34;

export const AmmoIndicatorsMixin = {
  // #402: one shared Graphics layer for every player's weapon tags, cleared and redrawn each
  // frame. Sits at the projectile tier so it draws over the mech body (DEPTH.UNITS) rather than
  // under it. Created in ArenaScene.create() alongside the other per-frame FX layers.
  _initAmmoIndicators() {
    this.ammoFx = this.add.graphics().setDepth(DEPTH.PROJECTILES);
  },

  // Redraw every live player's on-mech weapon tags. Called once per frame from ArenaScene.update().
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
      for (const w of mech.weapons()) {
        if (!w.online || w.ammo == null) continue;   // offline or unlimited: no tag
        const t = partSpriteTransform(mech, w.location, player.turretAngle, ARENA_MECH_SCALE);
        this._drawWeaponTag(g, player.x + t.dx, player.y + t.dy + DROP, w, blink);
      }
    }
  },

  // One weapon's tag: an ammo bar with a status light centred above it, at (cx, cy).
  _drawWeaponTag(g, cx, cy, w, blink) {
    const bx = cx - BAR_W / 2, by = cy;
    const reloading = w.reloading;
    const frac = reloading
      ? 1 - Math.max(0, Math.min(1, w.reload / (w.reloadMax || 1)))   // reload progress: fills toward full
      : Math.max(0, Math.min(1, w.ammo / (w.weapon.ammoMax || 1)));   // rounds remaining
    const empty = !reloading && w.ammo < 1;

    // Bar track (dim full-width backing) so a spent bar still reads as "there".
    g.fillStyle(COL.track, 0.85);
    g.fillRect(bx, by, BAR_W, BAR_H);
    // Fill.
    const fillCol = reloading ? COL.reload : empty ? COL.empty : (frac <= LOW_FRAC ? COL.low : COL.ready);
    if (frac > 0) {
      g.fillStyle(fillCol, 0.95);
      g.fillRect(bx, by, BAR_W * frac, BAR_H);
    }
    g.lineStyle(1, COL.trackEdge, 0.9);
    g.strokeRect(bx, by, BAR_W, BAR_H);

    // Status light above the bar.
    const lightCol = reloading ? COL.reload : empty ? COL.empty : COL.ready;
    const lightAlpha = reloading ? blink : 1;
    g.fillStyle(lightCol, lightAlpha);
    g.fillCircle(cx, by - GAP - LIGHT_R, LIGHT_R);
    // A faint dark ring so the light stays legible over bright terrain.
    g.lineStyle(1, 0x000000, 0.4 * lightAlpha);
    g.strokeCircle(cx, by - GAP - LIGHT_R, LIGHT_R);
  },
};
