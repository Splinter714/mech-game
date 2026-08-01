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
// The reload STATE is read live from the pure model (Mech.weapons()); the cycle cooldown is scene
// state (firing.js). How bright the overlay is this frame is a pure function of the two,
// `glowOverlayAlpha` below. (That test file is long gone with the rest of the suite.)
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

// How dim the glow gets at the START of a cycle. Follow-up ask, same day: the first pass made the
// cooldown a BINARY hide, which looked fine tapping single shots but broke down holding the
// trigger — the weapon re-fires the instant the cooldown expires, so the "ready" window is about
// one frame and the glow sat dark essentially always ("if I hold down most weapons, they basically
// just stay dark all the time which looks dumb"). A binary switch simply can't show readiness on a
// weapon that is continuously re-arming.
//
// So the cooldown drives a RAMP, not a switch: brightness tracks how close the slot is to ready,
// dimmest right after a shot and full at ready. Holding the trigger now reads as a rhythmic pulse
// in time with the weapon's actual cadence — which is more information than the binary version
// ever conveyed — and the floor keeps it from ever bottoming out to black, so "dark" stays
// exclusively the RELOAD state and the two remain instantly distinguishable.
export const GLOW_COOLDOWN_FLOOR = 0.22;

// RELOAD gets the same treatment on a DEEPER band (live-chat ask: "for the reload visual, let's do
// the dim thing like you're doing with the cycle time, but make it even more dim during reload").
// So reload is no longer a flat blackout — it ramps as the reload completes, exactly like a cycle,
// just much darker throughout.
//
// The ceiling here sits BELOW `GLOW_COOLDOWN_FLOOR` on purpose, and that gap is what carries the
// meaning: the brightest a reloading weapon ever gets is still dimmer than the dimmest a merely-
// cycling one gets. So the two states can never be confused at a glance no matter where each
// happens to be in its own ramp — "dimmer than anything a cycle does" reads as reload without
// needing a separate visual language for it.
export const GLOW_RELOAD_FLOOR = 0.05;
export const GLOW_RELOAD_CEIL = 0.16;

// A weapon-carrying slot's glow-overlay ALPHA this frame, 0–1. Pure function of the weapon's state
// plus this slot's live fire cooldown.
//   - no weapon / offline (destroyed part) → 0 (no floating glow).
//   - reloading → 0. The one fully-dark state, so it stays visually distinct from cycling.
//   - still cycling, and the cycle is long enough to see → ramps FLOOR→1 as it re-arms.
//   - otherwise (loaded, idle, mid-magazine, or cycling too fast to read) → 1.
// The cycle ramp applies to unlimited-ammo weapons too: "ready to fire" is the question being
// answered, and a melee weapon mid-swing isn't ready either — an unlimited magazine only means it
// never RELOADS.
export function glowOverlayAlpha(weapon, cooldownMs = 0, intervalMs = 0) {
  if (!weapon || !weapon.online) return 0;
  if (weapon.ammo != null && weapon.reloading) {
    // `reload` counts DOWN to 0, so this runs 0 (just emptied) → 1 (about to come back).
    const done = 1 - Math.min(1, Math.max(0, weapon.reload) / (weapon.reloadMax || 1));
    return GLOW_RELOAD_FLOOR + (GLOW_RELOAD_CEIL - GLOW_RELOAD_FLOOR) * done;
  }
  if (intervalMs >= GLOW_COOLDOWN_MIN_MS && cooldownMs > 0) {
    const ready = 1 - Math.min(1, Math.max(0, cooldownMs) / intervalMs);   // 0 just-fired → 1 ready
    return GLOW_COOLDOWN_FLOOR + (1 - GLOW_COOLDOWN_FLOOR) * ready;
  }
  return 1;
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
        const a = glowOverlayAlpha(weapon, cd, interval);
        overlay.visible = a > 0;
        overlay.alpha = a;
      }
    }
  },
};
