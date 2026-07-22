// On-mech per-weapon RELOAD BLINK (#402, re-implemented as a texture swap in #433). Each mounted,
// online, LIMITED-ammo weapon flashes its RELOADING state ON THE MECH by extinguishing its own
// baked muzzle glow in a fast on/off pulse: on the blink's OFF phase the weapon-carrying part
// sprite is swapped to a pre-baked "muzzle-off" VARIANT of its texture (art/mechArt.js —
// identical plating, but the weapon's muzzle glow drawn in dark tones), and on the ON phase (and
// whenever the weapon isn't reloading) it shows the normal part texture. Unlimited-ammo weapons
// (melee, `ammoMax: null`) never reload, so they never blink.
//
// Why a texture swap and not a live overlay (the #433 rewrite): the muzzle colour is BAKED STATIC
// into each part texture at bake time (drawWeaponsAt → the mount art's glowDot/glowBar), so it
// can't be recoloured per-frame. Two earlier passes drew a live glow near the assumed muzzle tip;
// both read as a foreign blob sitting on the gun rather than the gun's own light pulsing. Baking a
// dark-muzzle twin of the part and toggling between the two makes the weapon's ACTUAL baked glow
// blink off — the only thing that changes on screen is the muzzle light.
//
// Composing with damage reskins: the muzzle-off variant is rebuilt in place alongside the normal
// part texture on every reskin (armor break, destruction, status-spot recolour — buildMechTextures
// rebuilds the whole set under fixed keys). So BOTH keys always carry the CURRENT damage state, and
// toggling between them can never clobber a reskin — the swap only ever picks which of the two
// current-state textures the sprite points at. Weapon-carrying parts are arms + side torsos (the
// four skill slots), which are the pivoting part sprites — none of them animate walk frames (only
// the hull does), so texture ownership here doesn't fight the gait swap either.
//
// The blink STATE is read live from the pure model (Mech.weapons()); the "which texture this frame"
// decision is a pure function (`partTextureKey`), unit-tested in ammoIndicators.test.js.
import { PIVOT_LOCATIONS, MUZZLE_OFF_SUFFIX } from '../../art/index.js';
import { livePlayersOf } from './players.js';

// Which container child holds each weapon-carrying location's sprite (see _makeMechView).
const PIVOT_SPRITE = { leftTorso: 'torL', rightTorso: 'torR', leftArm: 'armL', rightArm: 'armR' };

// True when a weapon should show its EXTINGUISHED muzzle this frame: it's online, has a real
// magazine (`ammo != null`), is mid-reload, and we're on the blink's OFF phase. Pure.
export function reloadBlinkOff(weapon, blinkOn) {
  return !!(weapon && weapon.online && weapon.ammo != null && weapon.reloading && !blinkOn);
}

// The texture key a weapon-carrying part sprite should show this frame: the muzzle-off variant
// while its weapon is mid-reload on the blink's off phase, otherwise the normal part texture.
// `baseKey` is the mech's texture key (e.g. 'playerMech'); `loc` a pivot location. Pure — the one
// place the key shape is derived, shared by every part so a regression can't sneak in per-part.
export function partTextureKey(baseKey, loc, weapon, blinkOn) {
  return reloadBlinkOff(weapon, blinkOn)
    ? `${baseKey}_${loc}${MUZZLE_OFF_SUFFIX}`
    : `${baseKey}_${loc}`;
}

export const AmmoIndicatorsMixin = {
  // Toggle every live player's weapon-carrying part sprites between their normal and
  // muzzle-off textures for this frame's reload blink. Called once per frame from
  // ArenaScene.update(), after locomotion/gait so the swap runs on settled poses.
  _drawAmmoIndicators() {
    const now = this.time?.now ?? 0;
    // A fast (~4.8Hz) hard on/off blink — an urgent "reloading" pulse. `now * 0.03` ≈ 4.8Hz.
    const blinkOn = Math.sin(now * 0.03) > 0;
    for (const player of livePlayersOf(this)) {
      const mech = player?.mech;
      const view = player?.view;
      if (!mech || !view) continue;
      const baseKey = player.textureKey ?? 'playerMech';
      for (const loc of PIVOT_LOCATIONS) {
        const sprite = view[PIVOT_SPRITE[loc]];
        if (!sprite) continue;
        // At most one weapon per skill slot (one item per location), so `find` is exact.
        const weapon = mech.weapons().find((w) => w.location === loc);
        const key = partTextureKey(baseKey, loc, weapon, blinkOn);
        if (sprite.texture?.key !== key) sprite.setTexture(key);
      }
    }
  },
};
