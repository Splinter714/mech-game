// #529: a COSMETIC-ONLY chassis variant for the Mech Lab's new chassis-select tab. Revives the
// ART shape parameters from the old (removed, commit a164564) Assault/"Colossus" chassis —
// `git show f8f3707:src/data/chassis/assault.js` — but deliberately keeps every STAT identical to
// mediumPlayer.js (movement, totalArmor, totalHp, leg shape). Same reasoning as strikerPlayer.js:
// same stats, different art only.
import { MEDIUM_PLAYER_CONFIG } from './mediumPlayer.js';

export const COLOSSUS_PLAYER_CONFIG = {
  ...MEDIUM_PLAYER_CONFIG,
  id: 'colossusPlayer',
  name: 'Colossus',
  art: { ...MEDIUM_PLAYER_CONFIG.art, bodyLen: 52, bodyWid: 44, accent: 0x9a6ad6 },
};
