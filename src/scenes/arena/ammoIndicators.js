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

// Live-chat ask (2026-07-31): "I want a visual indicator for long cycle times that it's not ready
// to fire yet, similar to reload; maybe have the color go away between long cycle times in the
// same way it goes away during reload?" So the glow's meaning is now the single, uniform question
// "can this slot fire right now?" — dark covers BOTH causes of not-ready (mid-reload, and still
// cycling after a shot) instead of reload alone.
//
// Gated on the cycle being long enough to READ as a state rather than a flicker. Every discrete
// weapon in the game cycles at 1100-2400ms and every continuous one resolves to a small stream
// interval, so this threshold cleanly separates the two families with a wide margin either side —
// it is not tuned to a specific weapon and shouldn't need to move when one is added. Below it, a
// machine gun or flamethrower would strobe its own glow several times a second, which reads as a
// rendering fault rather than as information.
export const GLOW_COOLDOWN_MIN_MS = 500;

// Should a weapon-carrying slot's glow overlay be VISIBLE this frame? Pure function of the
// weapon's state plus this slot's live fire cooldown.
//   - no weapon / offline (destroyed part) → hidden (no floating glow).
//   - still cycling, and the cycle is long enough to see → hidden until it comes back up.
//   - unlimited-ammo (`ammo == null`, melee) → otherwise always on (never reloads).
//   - reloading → hidden for the whole reload.
//   - otherwise (loaded, idle, or mid-magazine) → on.
// The cooldown check sits ABOVE the unlimited-ammo early-out deliberately: "ready to fire" is the
// question being answered, and a melee weapon mid-swing isn't ready either — an unlimited magazine
// only means it never RELOADS.
export function glowOverlayVisible(weapon, cooldownMs = 0, intervalMs = 0) {
  if (!weapon || !weapon.online) return false;
  if (intervalMs >= GLOW_COOLDOWN_MIN_MS && cooldownMs > 0) return false;
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
        // The cycle cooldown is SCENE state (firing.js `player.fireCooldowns`, ticked down per
        // frame), not model state, which is why it's read here and passed in rather than living on
        // `mech.weapons()` alongside `reload`. `_fireInterval` resolves the same cadence the firing
        // path itself gates on — powerup cycle buffs included — so a weapon sped up by Overclock
        // stops going dark once its cycle drops under the readability threshold.
        const cd = player.fireCooldowns?.[loc] ?? 0;
        const interval = weapon?.weapon ? this._fireInterval(weapon.weapon) : 0;
        overlay.visible = glowOverlayVisible(weapon, cd, interval);
      }
    }
  },
};
