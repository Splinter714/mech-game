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
import { MEDIUM_PLAYER_CONFIG } from './mediumPlayer.js';

export const COLOSSUS_PLAYER_CONFIG = {
  ...MEDIUM_PLAYER_CONFIG,
  id: 'colossusPlayer',
  name: 'Colossus',
  art: {
    ...MEDIUM_PLAYER_CONFIG.art,
    bodyLen: 52, bodyWid: 44, accent: 0x9a6ad6,
    // A bulkier, heavily-plated bruiser silhouette, not just a bigger Trooper: a broader
    // head/torso sunk back, thick low-slung arms, a wide planted stance. `legSpread`/
    // `legW`/`legH`/`legDrop` still build on the player's own #438 leg tuning (inherited
    // above) rather than reverting to DEFAULT_SHAPE.
    shape: {
      ...MEDIUM_PLAYER_CONFIG.art.shape,
      head: 1.15, torso: 1.22, shoulder: 1.25,
      armW: 1.4, armH: 0.75, armSpread: 0.85,
      legW: 1.35, legSpread: 1.2, legH: 1.15,
      headDy: 0.05, armDy: 0.08,
    },
    // Shoulder pauldrons + rear exhaust stacks, same bruiser vocabulary as heavy.js — a
    // Colossus reads as an immovable siege platform, not a re-skinned Trooper.
    decor: [{ kind: 'pauldron', side: -1 }, { kind: 'pauldron', side: 1 }, { kind: 'stack', side: -1 }, { kind: 'stack', side: 1 }],
  },
};
