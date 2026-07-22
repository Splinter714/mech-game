// On-mech per-weapon RELOAD BLINK (#402, re-anchored #433). Each mounted, online, LIMITED-ammo
// weapon flashes a tiny status blink drawn ON THE MECH while it is RELOADING. The blink has exactly
// ONE state: a fast on/off pulse in the weapon's CATEGORY neon colour while `reloading`, and is OFF
// (not drawn) at all other times. It's a pure "reloading now" pulse — no ready/empty/steady states.
// Unlimited-ammo weapons (melee, `ammoMax: null`) show nothing — they can never run dry or reload.
//
// #433: the blink moved from a baked readout socket at the part JOINT to the weapon's MUZZLE TIP,
// coloured by the weapon's CATEGORY neon instead of a single red. There's no baked socket anymore —
// the muzzle-tip anchor is computed live from the same helpers the projectile system fires from
// (`partMuzzle` fed by `mechMuzzleTipOffset`, shared.js), so the blink sits exactly where the gun's
// barrel points, accounting for the part's live convergence tilt.
//
// This is a per-frame OVERLAY, not baked into the mech textures, because it reads LIVE state
// (art/mechArt.js is static per walk-frame and only re-skins on damage). The anchor is measured off
// the mech's RENDERED VIEW CONTAINER (`player.view`), NOT its logical `player.x/y`: the view is
// offset each frame by the gait bob (`_stepGait` sets `view.setPosition(x, y - bob)`), so anchoring
// to the logical position let the blink float against the bobbing body. `partMuzzle` is linear in
// its origin, so calling it at origin (0,0) yields the muzzle-tip offset relative to the mech centre,
// which we add to the view container — locking the blink to the rendered barrel tip.
// Purely visual — the state it reads is all from the pure model (Mech.weapons()), so there is
// nothing to unit-test here (reload/ammo transitions are covered in Mech.test.js).
import { mechLayout, ART_SCALE, PART_PIVOT } from '../../art/index.js';
import { neonFor } from '../../art/mechPrims.js';
import { ARENA_MECH_SCALE, DEPTH, mechMuzzleTipOffset, partMuzzle } from './shared.js';
import { livePlayersOf } from './players.js';

// Blink radius in world px. In DESIGN units the dot is ~1.6 (the old baked socket's inner radius),
// scaled by the TRUE design-unit→screen factor (ARENA_MECH_SCALE × ART_SCALE — the same factor the
// muzzle geometry folds in), so the tip flash reads at a legible on-mech size.
const BLINK_DESIGN_R = 1.6;
const LIGHT_R = BLINK_DESIGN_R * ARENA_MECH_SCALE * ART_SCALE;

export const AmmoIndicatorsMixin = {
  // #402: one shared Graphics layer for every player's reload blinks, cleared and redrawn each
  // frame. Sits at the projectile tier so it draws over the mech body (DEPTH.UNITS) rather than
  // under it. Created in ArenaScene.create() alongside the other per-frame FX layers.
  _initAmmoIndicators() {
    this.ammoFx = this.add.graphics().setDepth(DEPTH.PROJECTILES);
  },

  // Redraw every live player's on-mech reload blinks. Called once per frame from
  // ArenaScene.update().
  _drawAmmoIndicators() {
    const g = this.ammoFx;
    if (!g) return;
    g.clear();
    const now = this.time?.now ?? 0;
    // A fast (~5Hz) hard on/off blink — an urgent "reloading" pulse. `now * 0.03` ≈ 4.8Hz.
    const blinkOn = Math.sin(now * 0.03) > 0;
    if (!blinkOn) return;
    const disp = ARENA_MECH_SCALE * ART_SCALE;
    for (const player of livePlayersOf(this)) {
      const mech = player?.mech;
      if (!mech) continue;
      // Anchor off the RENDERED view container (includes the gait bob), not the logical position.
      const baseX = player.view?.x ?? player.x;
      const baseY = player.view?.y ?? player.y;
      const layout = mechLayout(mech);
      for (const w of mech.weapons()) {
        if (!w.online || w.ammo == null || !w.reloading) continue;   // offline, unlimited, or idle
        // Anchor = the weapon's MUZZLE TIP (#433) — the same tip the projectile system fires from.
        // Computed at origin (0,0) so partMuzzle returns the tip's offset from the mech centre, in
        // the same view space (bob-corrected) the overlay draws in; add it to the view container.
        const loc = w.location;
        const part = layout[loc];
        const tipOffset = mechMuzzleTipOffset(mech, loc, part);
        const tilt = player.view?._tilt?.[loc] || 0;
        const pivotFrac = PART_PIVOT[loc] ?? 0;
        const m = partMuzzle(part, 0, 0, player.turretAngle, disp, tipOffset, tilt, pivotFrac);
        this._drawWeaponLight(g, baseX + m.x, baseY + m.y, w);
      }
    }
  },

  // One weapon's reload blink at its muzzle tip (cx, cy), in the weapon's CATEGORY neon colour.
  // Only ever called on the blink's ON phase for a weapon that is actively reloading.
  // #433 revision: the first pass drew a small flat-filled circle with a black outline stroke —
  // a completely different look from the weapon's actual BAKED muzzle glow (art/mechPrims.js
  // `glowDot`, a soft layered bloom: halo -> mid-halo -> core -> hot spot, out to r*2.2), so it
  // read as a foreign black-ringed blob sitting near the gun rather than the muzzle light itself.
  // Mirroring `glowDot`'s own layering (same radii, no outline) makes the blink read as that
  // glow visually intensifying/pulsing, not a new object appearing on top of it.
  _drawWeaponLight(g, cx, cy, w) {
    const n = neonFor(w.weapon?.category);
    g.fillStyle(n.halo, 0.3);  g.fillCircle(cx, cy, LIGHT_R * 2.2);
    g.fillStyle(n.halo, 0.6);  g.fillCircle(cx, cy, LIGHT_R * 1.35);
    g.fillStyle(n.core, 1);    g.fillCircle(cx, cy, LIGHT_R);
    g.fillStyle(n.hot, 1);     g.fillCircle(cx, cy, LIGHT_R * 0.42);
  },
};
