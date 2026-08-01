// #529: a COSMETIC-ONLY chassis variant for the Mech Lab's new chassis-select tab. Originally
// revived only the old (removed, commit a164564) Assault/"Colossus" chassis' `bodyLen`/
// `bodyWid`/`accent` — `git show f8f3707:src/data/chassis/assault.js` — but that chassis never
// actually had distinct GEOMETRY (it only scaled the medium's proportions), and Jackson called
// that out after playing: "the new chassis you added are just bigger versions of the same
// geometry; a long time ago we had legitimately different geometry". The real per-chassis
// silhouette system that followed (#24, `art.shape` — see mechArt.js's `shapeOf`/`mechLayout`)
// postdates Striker/Colossus, so this is that system applied to Colossus for the first time: a
// bulkier, heavily-plated assault silhouette echoing the original's "immovable object... enormous
// armor... stand and bombard" flavor and the enemy heavy chassis' bruiser-silhouette vocabulary
// (bigger head sunk back, broad torso, thick low arms, a planted stance, shoulder pauldrons) —
// NOT a re-scaled Trooper. (That enemy chassis was called 'Bulwark' when this was written; #598
// collapsed the two competing name layers and it is now plainly 'Heavy Mech'.)
//
// 2026-07-31 live-chat: same change as strikerPlayer.js — see its header for the full reasoning.
// Jackson pointed at the ART PREVIEW's "PLAYER BUILD — heavy" cell and wanted THAT silhouette
// back; that cell renders the player theme on the `heavy` chassis, so it is enemy/heavy.js's
// geometry, not the approximation this file had been carrying (bodyLen 52 vs 46, and a stance
// widened to 1.2 where the heavy plants at 0.86). The `art` below was MATCHED to that preview
// cell, legs included ("match the preview exactly").
//
// It briefly did that by spreading `HEAVY_CONFIG.art` wholesale, so the two "could not drift".
// That is now INVERTED — live-chat ask (2026-07-31): "can we actually split out the enemy chassis
// as separate code to be tweaked separately from the player chassis code?" The art below is an
// independent COPY of what enemy/heavy.js held at the moment of the split, and the two are free
// to diverge from here: retuning the enemy heavy no longer moves the player's Colossus, and the
// art-preview's "PLAYER BUILD — heavy" cell (which still renders the enemy heavy chassis) is no
// longer a guarantee of what this looks like.
//
// STATS deliberately stay identical to mediumPlayer.js, per Jackson's own words: "same stats,
// just different art cosmetically." That coupling is INSIDE the player group and is the point of
// the chassis-select tab, so it stays a spread — only `id`/`name`/`art` differ. The heavy's own
// heavier/slower stat block is still deliberately NOT taken.
import { MEDIUM_PLAYER_CONFIG } from './mediumPlayer.js';

export const COLOSSUS_PLAYER_CONFIG = {
  ...MEDIUM_PLAYER_CONFIG,
  id: 'colossusPlayer',
  name: 'Colossus',
  // Blocky bruiser silhouette (#24): a small head sunk BACK between huge shoulder pauldrons, arms
  // hung low/forward in a siege stance, broad torso, thick stubby limbs, a narrow planted stance.
  // Copied off enemy/heavy.js at the 2026-07-31 split — the pauldrons ride the pivoting SHOULDER
  // textures (mechArt.js SHOULDER_DECOR), and the rear exhaust stacks that used to be the only
  // body-texture decor are gone (live-chat ask, same day: "remove decor from heavy torso"), so
  // the torso is clean.
  art: {
    bodyLen: 46, bodyWid: 38,
    shape: { head: 1.08, torso: 1.18, shoulder: 1.2, armW: 1.32, armH: 0.8, armSpread: 0.88, legW: 1.45, legH: 0.8, legSpread: 0.86, legDrop: 0.95, headDy: 0.04, armDy: 0.07 },
    decor: [{ kind: 'pauldron', side: -1 }, { kind: 'pauldron', side: 1 }],
  },
};
