// #529: a COSMETIC-ONLY chassis variant for the Mech Lab's new chassis-select tab. Originally
// revived only the old (removed, commit a164564) Striker chassis' `bodyLen`/`bodyWid`/`accent` —
// `git show f8f3707:src/data/chassis/striker.js` — but that chassis never actually had distinct
// GEOMETRY (it only scaled the medium's proportions), and Jackson called that out after playing:
// "the new chassis you added are just bigger versions of the same geometry; a long time ago we
// had legitimately different geometry". The real per-chassis silhouette system that followed
// (#24, `art.shape` — see light.js/medium.js/heavy.js and mechArt.js's `shapeOf`/`mechLayout`)
// postdates Striker/Colossus, so this is that system applied to Striker for the first time: a
// lean, forward-leaning recon-harasser silhouette echoing the Striker's original "fast, lightly-
// armored harasser... quicker and twitchier than the medium Trooper" flavor and light.js's own
// scout-silhouette vocabulary (smaller head thrust forward, slim torso, long reaching arms, wide
// light stance, sensor mast + swept vanes) — NOT a re-scaled Trooper.
//
// Deliberately keeps every STAT identical to mediumPlayer.js (movement, totalArmor, totalHp) per
// Jackson's own words: "same stats, just different art cosmetically." Only `id`/`name`/`art`
// differ from MEDIUM_PLAYER_CONFIG; everything else is spread through so the two can never drift
// on the things meant to match.
// 2026-07-31 live-chat: Jackson pointed at the ART PREVIEW's "PLAYER BUILD — light" cell and said
// he wanted THAT silhouette back. That cell renders the player theme on the `light` chassis, so
// what he was looking at is light.js's own geometry — not the approximation of it that this file
// had been carrying. The dials above were derived by hand and, layered over mediumPlayer's shape,
// came out a size larger with the arms splayed wide and a very wide stance (bodyLen 34 vs 30,
// armSpread 1.15 vs 0.8, legSpread 1.55 vs 1.02), which is exactly why it read as a milder Trooper
// rather than the distinct recon silhouette. So this now takes `LIGHT_CONFIG.art` WHOLESALE
// instead of re-deriving it: same body size, same proportions, same decor — the preview cell and
// the player's Striker are now the same geometry by construction and cannot drift.
//
// Asked whether to keep the player's own #438 leg tuning or take light's legs, Jackson chose
// light's ("match the preview exactly"), which is what the wholesale spread gives — the narrow
// light-footed stance rather than mediumPlayer's planted one.
//
// STATS still come from MEDIUM_PLAYER_CONFIG and are untouched (movement, totalArmor, totalHp).
// Jackson confirmed again here that this stays cosmetic-only — light.js's own lighter/faster stat
// block is deliberately NOT taken, only its art.
import { MEDIUM_PLAYER_CONFIG } from './mediumPlayer.js';
import { LIGHT_CONFIG } from './light.js';

export const STRIKER_PLAYER_CONFIG = {
  ...MEDIUM_PLAYER_CONFIG,
  id: 'strikerPlayer',
  name: 'Striker',
  art: { ...LIGHT_CONFIG.art },
};
