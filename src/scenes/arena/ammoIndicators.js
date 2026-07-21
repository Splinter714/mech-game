// On-mech per-weapon ammo indicators (#402, re-attached in the #402 follow-up). Each mounted,
// online, LIMITED-ammo weapon wears a tiny readout drawn ON THE MECH — bolted to its own mount
// segment — so the player can read every gun's state without looking away to the HUD:
//   * a STATUS LIGHT — a small dot: green = ready, red = empty/dead, amber = reloading (blinking);
//   * a HORIZONTAL AMMO BAR — rounds remaining, draining as the weapon fires and filling as it
//     reloads (during a reload the bar shows the reload's own progress, so it visibly refills).
// Unlimited-ammo weapons (melee, `ammoMax: null`) show nothing — they can never run dry or reload.
//
// This is a per-frame OVERLAY, not baked into the mech textures, because it reads LIVE state
// (art/mechArt.js is static per walk-frame and only re-skins on damage). But it is NOT free-
// floating: the mech art bakes a PERSISTENT readout socket (mechPrims.js `readoutMount`, drawn on
// each weapon-carrying arm/side-torso texture regardless of armor state), and this overlay paints
// the live bar + light onto that exact socket. The anchor is the part's JOINT — the same point the
// part sprite pivots around (art/mechArt.js `partSpriteTransform` returns its offset in `dx/dy`) —
// and the tag is oriented along the part's LIVE facing (turret angle + the part's convergence
// tilt, the same `view._tilt[loc]` the sprite and muzzle use). So the readout rides its arm/side-
// torso as the turret slews and the limb cants, and it survives the armor being stripped off (the
// socket underneath is always drawn). Purely visual — the state it reads is all from the pure model
// (Mech.weapons()), so there is nothing to unit-test here (reload/ammo transitions are covered in
// Mech.test.js).
import { partSpriteTransform, mechLayout, ART_SCALE, READOUT } from '../../art/index.js';
import { ARENA_MECH_SCALE, DEPTH } from './shared.js';
import { livePlayersOf } from './players.js';

const COL = {
  track: 0x0c1116, trackEdge: 0x2a333f,
  ready: 0x7bd17b,     // green — has ammo, can fire
  low: 0xefc14a,       // amber — has ammo but the magazine is running low
  empty: 0xe2533a,     // red — dry (only briefly; empty auto-starts a reload)
  reload: 0x5e7ce0,    // blue-violet — reloading (matches the HUD tile's reload tint)
};

// A magazine at/under this fraction reads as "running low" (amber light) rather than plain ready.
const LOW_FRAC = 0.34;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

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
    const disp = ARENA_MECH_SCALE * ART_SCALE;
    for (const player of livePlayersOf(this)) {
      const mech = player?.mech;
      if (!mech) continue;
      const lay = mechLayout(mech);
      for (const w of mech.weapons()) {
        if (!w.online || w.ammo == null) continue;   // offline or unlimited: no tag
        const loc = w.location;
        const part = lay[loc];
        if (!part) continue;
        // Anchor = the part's joint (dx/dy from partSpriteTransform) — the same point the baked
        // socket sits on and the sprite pivots around. Orientation = the part's LIVE facing: turret
        // angle plus its convergence tilt, so the tag cants with the limb.
        const t = partSpriteTransform(mech, loc, player.turretAngle, ARENA_MECH_SCALE);
        const tilt = player.view?._tilt?.[loc] || 0;
        const theta = player.turretAngle + tilt;
        const barLen = Math.max(READOUT.barMin, part.w * READOUT.barSpan) * disp;
        this._drawWeaponTag(g, player.x + t.dx, player.y + t.dy, theta, barLen, w, blink);
      }
    }
  },

  // One weapon's tag centred on its socket at (cx, cy), oriented along the part's forward axis
  // `theta` (the barrel direction): the ammo bar runs ACROSS the part, the status light sits just
  // forward of it (toward the muzzle). `barLen` is the bar's world length.
  _drawWeaponTag(g, cx, cy, theta, barLen, w, blink) {
    const disp = ARENA_MECH_SCALE * ART_SCALE;
    const thick = READOUT.barThick * disp;
    const lr = READOUT.lightR * disp;
    const gap = READOUT.lightGap * disp;
    const fx = Math.cos(theta), fy = Math.sin(theta);     // forward (barrel) unit
    const ax = -Math.sin(theta), ay = Math.cos(theta);    // across-the-part unit

    const reloading = w.reloading;
    const frac = reloading
      ? 1 - clamp01(w.reload / (w.reloadMax || 1))         // reload progress: fills toward full
      : clamp01(w.ammo / (w.weapon.ammoMax || 1));         // rounds remaining
    const empty = !reloading && w.ammo < 1;

    // Bar track (dim full-width backing) so a spent bar still reads as "there".
    this._rotRect(g, cx, cy, barLen, thick, ax, ay, fx, fy, COL.track, 0.85);
    // Fill, growing from one end.
    const fillCol = reloading ? COL.reload : empty ? COL.empty : (frac <= LOW_FRAC ? COL.low : COL.ready);
    if (frac > 0) {
      const fl = barLen * frac;
      const fcx = cx - (barLen / 2) * ax + (fl / 2) * ax;
      const fcy = cy - (barLen / 2) * ay + (fl / 2) * ay;
      this._rotRect(g, fcx, fcy, fl, thick, ax, ay, fx, fy, fillCol, 0.95);
    }
    this._rotRectStroke(g, cx, cy, barLen, thick, ax, ay, fx, fy, COL.trackEdge, 0.9);

    // Status light, forward of the bar (toward the muzzle).
    const off = thick / 2 + gap + lr;
    const lcx = cx + off * fx, lcy = cy + off * fy;
    const lightCol = reloading ? COL.reload : empty ? COL.empty : COL.ready;
    const lightAlpha = reloading ? blink : 1;
    g.fillStyle(lightCol, lightAlpha);
    g.fillCircle(lcx, lcy, lr);
    // A faint dark ring so the light stays legible over bright terrain.
    g.lineStyle(1, 0x000000, 0.4 * lightAlpha);
    g.strokeCircle(lcx, lcy, lr);
  },

  // A filled rectangle centred at (cx,cy), `len` along the across-axis (ax,ay) and `thick` along
  // the forward-axis (fx,fy) — a rotated quad, since Phaser's fillRect is axis-aligned.
  _rotRect(g, cx, cy, len, thick, ax, ay, fx, fy, col, alpha) {
    const hax = (len / 2) * ax, hay = (len / 2) * ay;
    const hfx = (thick / 2) * fx, hfy = (thick / 2) * fy;
    const pts = [
      { x: cx - hax - hfx, y: cy - hay - hfy },
      { x: cx + hax - hfx, y: cy + hay - hfy },
      { x: cx + hax + hfx, y: cy + hay + hfy },
      { x: cx - hax + hfx, y: cy - hay + hfy },
    ];
    g.fillStyle(col, alpha);
    g.fillPoints(pts, true);
  },

  _rotRectStroke(g, cx, cy, len, thick, ax, ay, fx, fy, col, alpha) {
    const hax = (len / 2) * ax, hay = (len / 2) * ay;
    const hfx = (thick / 2) * fx, hfy = (thick / 2) * fy;
    const pts = [
      { x: cx - hax - hfx, y: cy - hay - hfy },
      { x: cx + hax - hfx, y: cy + hay - hfy },
      { x: cx + hax + hfx, y: cy + hay + hfy },
      { x: cx - hax + hfx, y: cy - hay + hfy },
    ];
    g.lineStyle(1, col, alpha);
    g.strokePoints(pts, true);
  },
};
