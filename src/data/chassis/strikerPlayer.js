// #529: a COSMETIC-ONLY chassis variant for the Mech Lab's new chassis-select tab. Revives the
// ART shape parameters from the old (removed, commit a164564) Striker chassis — `git show
// f8f3707:src/data/chassis/striker.js` — but deliberately keeps every STAT identical to
// mediumPlayer.js (movement, totalArmor, totalHp, leg shape). Jackson's own words: "same stats,
// just different art cosmetically." Only `id`/`name`/the three art fields differ from
// MEDIUM_PLAYER_CONFIG; everything else is spread through so the two can never drift on the
// things meant to match.
import { MEDIUM_PLAYER_CONFIG } from './mediumPlayer.js';

export const STRIKER_PLAYER_CONFIG = {
  ...MEDIUM_PLAYER_CONFIG,
  id: 'strikerPlayer',
  name: 'Striker',
  art: { ...MEDIUM_PLAYER_CONFIG.art, bodyLen: 34, bodyWid: 26, accent: 0x49e88f },
};
