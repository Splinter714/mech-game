import Phaser from 'phaser';
import { buildBaseTextures, buildImageHexTexture } from '../art/index.js';
import { ROSTER_SPECIES } from '../data/save.js';
import { Audio } from '../audio/index.js';
import grassTileUrl from '../assets/tiles/grass.jpg';

// Boot: load image tiles, load the saved garage into the registry, build world/UI textures,
// then open the garage. Roster load is registry-driven (data/rosters.js) so adding a saved-
// build slot needs no edit here.
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload() {
    // Real (AI-generated) hex art tiles — masked into hex textures in create (#41).
    this.load.image('grass_src', grassTileUrl);
  }

  create() {
    for (const { registryKey, load } of ROSTER_SPECIES) {
      this.registry.set(registryKey, load());
    }
    buildBaseTextures(this);
    // Override the procedural grass with the loaded image tile (masked to the hex).
    buildImageHexTexture(this, 'hex_grass', 'grass_src');
    buildImageHexTexture(this, 'hex_grassB', 'grass_src');
    // Procedural audio: adopt Phaser's WebAudio context and start the soundtrack. Both
    // no-op until Phaser unlocks audio on the first user gesture.
    Audio.init(this.sound.context);
    Audio.startMusic();
    this.scene.start('GarageScene');
  }
}
