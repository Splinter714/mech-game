// The PLAYER's medium chassis (#299).
//
// Why this exists: #248 locks the player to the medium weight class, and the Warden (the enemy
// sniper, data/enemies.js) also rides medium — but the #299 balance pass gives them deliberately
// DIFFERENT stat blocks (player 200 structure / 300 armor / 100 shield = 600; enemy medium
// 150/150/50 = 350). One shared config can't express both, so the two had to separate.
//
// Why a chassis variant rather than an override at the point the player mech is built: the
// player's Mech is constructed in several places that all have to agree — the garage preview,
// the saved-roster round-trip (data/rosters.js / save.js), and the arena — and the HUD reads
// per-location max armor/HP straight off the built mech. Patching stats after construction in
// ArenaScene would make the garage show one mech and the arena field a tougher one. Putting it in
// the registry keeps the codebase's standing rule intact ("adding a chassis is one config + one
// entry, no model changes") and every consumer sees one consistent mech.
//
// Everything except the stat totals is MEDIUM_CONFIG verbatim (movement feel, art, name, weight
// class), spread in so the two can never drift apart on the things that are meant to match. Only
// `id` and the totals differ. The player's shield is configured separately at deploy time
// (PLAYER_SHIELD in scenes/ArenaScene.js) — that's the 100 in 200/300/100.
import { MEDIUM_CONFIG } from './medium.js';

export const MEDIUM_PLAYER_CONFIG = {
  ...MEDIUM_CONFIG,
  id: 'mediumPlayer',
  // #299 balance pass (owner-set totals): 200 structure / 300 armor / 100 shield = 600 total —
  // making the player the single toughest unit in the game, above the heavy artillery mech's 500.
  // Confirmed by the owner with that consequence explicitly flagged.
  totalArmor: 300,
  totalHp: 200,
};
