// Single shared audio engine for the whole game. Scenes import { Audio } and call event
// methods (Audio.fire(weapon), Audio.impact(kind), Audio.footstep(), Audio.ui(id),
// Audio.explosion(), Audio.startMusic()/stopMusic(), Audio.toggleMute()). All of it
// no-ops safely until Audio.init(scene.sound.context) has run and the context is live.
import { AudioEngine } from './AudioEngine.js';

export const Audio = new AudioEngine();
