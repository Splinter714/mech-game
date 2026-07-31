// #529: a COSMETIC-ONLY chassis variant for the Mech Lab's new chassis-select tab. Originally
// revived only the old (removed, commit a164564) Assault/"Colossus" chassis' `bodyLen`/
// `bodyWid`/`accent` — `git show f8f3707:src/data/chassis/assault.js` — but that chassis never
// actually had distinct GEOMETRY (it only scaled the medium's proportions), and Jackson called
// that out after playing: "the new chassis you added are just bigger versions of the same
// geometry; a long time ago we had legitimately different geometry". The real per-chassis
// silhouette system that followed (#24, `art.shape` — see light.js/medium.js/heavy.js and
// mechArt.js's `shapeOf`/`mechLayout`) postdates Striker/Colossus, so this is that system applied
// to Colossus for the first time: a bulkier, heavily-plated assault silhouette echoing the
// original's "immovable object... enormous armor... stand and bombard" flavor and heavy.js's own
// bruiser-silhouette vocabulary (bigger head sunk back, broad torso, thick low arms, a wide
// planted stance, shoulder pauldrons + rear exhaust stacks) — NOT a re-scaled Trooper.
//
// Deliberately keeps every STAT identical to mediumPlayer.js (movement, totalArmor, totalHp) per
// Jackson's own words: "same stats, just different art cosmetically." Only `id`/`name`/`art`
// differ from MEDIUM_PLAYER_CONFIG; everything else is spread through so the two can never drift
// on the things meant to match.
// 2026-07-31 live-chat: same change as strikerPlayer.js — see its header for the full reasoning.
// Jackson pointed at the ART PREVIEW's "PLAYER BUILD — heavy" cell and wanted THAT silhouette
// back; that cell renders the player theme on the `heavy` chassis, so it is heavy.js's own
// geometry, not the approximation this file had been carrying (bodyLen 52 vs 46, and a stance
// widened to 1.2 where heavy plants at 0.86). Now takes `HEAVY_CONFIG.art` wholesale, legs
// included ("match the preview exactly"), so the preview cell and the player's Colossus are the
// same geometry by construction.
//
// STATS still come from MEDIUM_PLAYER_CONFIG and are untouched — heavy.js's own heavier/slower
// stat block is deliberately NOT taken. Cosmetic-only, as confirmed again here.
import { MEDIUM_PLAYER_CONFIG } from './mediumPlayer.js';
import { HEAVY_CONFIG } from './heavy.js';

export const COLOSSUS_PLAYER_CONFIG = {
  ...MEDIUM_PLAYER_CONFIG,
  id: 'colossusPlayer',
  name: 'Colossus',
  art: { ...HEAVY_CONFIG.art },
};
