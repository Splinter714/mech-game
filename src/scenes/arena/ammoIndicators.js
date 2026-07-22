// On-mech per-weapon RELOAD INDICATOR (#402; re-architected in #433 as a glow-overlay VISIBILITY
// toggle, then simplified from a blink to a steady on/off). Each weapon-carrying skill slot on a
// player mech has a separate GLOW-ONLY overlay sprite carrying the muzzle's coloured glow
// (art/mechArt.js `MUZZLE_GLOW_SUFFIX` / drawPartGlow; wired into the mech view in
// locomotion._makeMechView). The base part texture is baked muzzle-OFF, so this overlay is the
// ONLY place the lit glow lives — it's VISIBLE by default (normal play shows the glow) and this
// mixin sets its `.visible` per frame: HIDDEN for the whole duration the slot's LIMITED-ammo
// weapon is RELOADING, VISIBLE again the instant it's ready to fire. A blown-off/offline/empty
// slot hides the overlay so there's no floating glow. Unlimited-ammo weapons (melee,
// `ammoMax: null`) never reload, so their glow just stays on.
//
// Why an overlay toggle and not a texture swap (the #433 re-architecture): the previous impl swapped
// the whole part sprite between a normal and a baked "_muzzleOff" twin. The shield outline
// (shieldOutline.js) follows the part sprite's live texture key each frame and its body-only `_shield`
// lookup only knows the NORMAL key — so a swap to `_muzzleOff` missed the lookup and the shell fell
// back to the full (gun-bearing) texture, changing the SHIELD SHAPE mid-reload. Pulling the glow into
// its own sprite and toggling THAT leaves the part texture CONSTANT, so the outline never re-derives.
//
// The reload STATE is read live from the pure model (Mech.weapons()); the "is the overlay shown this
// frame" decision is a pure function (`glowOverlayVisible`), unit-tested in ammoIndicators.test.js.
import { PIVOT_LOCATIONS } from '../../art/index.js';
import { livePlayersOf } from './players.js';

// Should a weapon-carrying slot's glow overlay be VISIBLE this frame? Pure function of the
// weapon's own state — no time/cadence input.
//   - no weapon / offline (destroyed part) → hidden (no floating glow).
//   - unlimited-ammo (`ammo == null`, melee) → always on (never reloads).
//   - reloading → hidden for the whole reload.
//   - otherwise (loaded, idle, or mid-magazine) → on.
export function glowOverlayVisible(weapon) {
  if (!weapon || !weapon.online) return false;
  if (weapon.ammo == null) return true;
  return !weapon.reloading;
}

export const AmmoIndicatorsMixin = {
  // Set every live player's per-slot muzzle-glow overlay visibility for this frame. Called once
  // per frame from ArenaScene.update(), after locomotion/gait so the overlays are already posed
  // onto their (settled) parts (locomotion._syncPivots) before we decide show/hide.
  _drawAmmoIndicators() {
    for (const player of livePlayersOf(this)) {
      const mech = player?.mech;
      const view = player?.view;
      if (!mech || !view?.glow) continue;
      for (const loc of PIVOT_LOCATIONS) {
        const overlay = view.glow[loc];
        if (!overlay) continue;
        // At most one weapon per skill slot (one item per location), so `find` is exact.
        const weapon = mech.weapons().find((w) => w.location === loc);
        overlay.visible = glowOverlayVisible(weapon);
      }
    }
  },
};
