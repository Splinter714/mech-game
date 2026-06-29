import Phaser from 'phaser';
import { buildBaseTextures } from '../art/index.js';
import { ROSTER_SPECIES } from '../data/save.js';
import { Audio } from '../audio/index.js';

// Boot: load the saved garage into the registry, build world/UI textures, then open
// the garage. Roster load is registry-driven (data/rosters.js) so adding a saved-build
// slot needs no edit here.
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  create() {
    for (const { registryKey, load } of ROSTER_SPECIES) {
      this.registry.set(registryKey, load());
    }
    buildBaseTextures(this);
    // Procedural audio: adopt Phaser's WebAudio context. The soundtrack starts OFF — the
    // player turns it on with the music panel's play/pause (or it stays silent).
    Audio.init(this.sound.context);
    this.scene.start('GarageScene');
  }
}
