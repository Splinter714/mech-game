// Base scene locomotion mixin — a TRIMMED copy of the arena's twin-stick drive + stompy gait
// (arena/locomotion.js `_drive`/`_stepGait`), with only the COMBAT dependencies dropped: no
// enemy-crush checks (the base has no enemies) and no weapon-convergence part-tilt (nothing
// mounted fires here). The CONTROL FEEL is otherwise identical to a live run on purpose — same
// twin-stick mapping (left stick/WASD drives, right stick/mouse aims the turret independently
// of travel), same weight-inertia-free instant movement/turning (matching the arena's own
// INSTANT_TURNING/INSTANT_VELOCITY), same terrain speed scaling, same swept wall/edge
// collision, and the full footfall gait (frame stepping, footstep FX + camera shake, body
// bob) — reusing `_makeMechView`/`_syncTilts`/`_syncPivots`/`_footImpactFx`/`_footShake` from
// LocomotionMixin directly (see BaseScene.js), since none of those five have any combat
// coupling of their own. No sprint/dash yet (#509 Stage 1 scope — those are player abilities,
// not core locomotion).
import Phaser from 'phaser';
import { PLAYER_HULL_FRAMES } from '../../art/index.js';
import { Audio } from '../../audio/index.js';
import { ARENA_MECH_SCALE, PLAYER_WALL_COLLIDE_RADIUS, approach } from '../arena/shared.js';
import { STICK_DEADZONE } from '../../input/Controls.js';
import { HEX_SIZE } from '../../data/hexgrid.js';

const COLLISION_SUBSTEP_PX = HEX_SIZE / 6;   // mirrors arena/locomotion.js's own tunneling fix
const CYCLE_BEATS = 4;
const BOB_EASE_POWER = 1.15;

export const BaseLocomotionMixin = {
  _driveBase(intent, dt) {
    const p = this.player;
    const mv = p.mech.movement;
    const legF = p.mech.legFactor();
    const terrainScale = this._speedFactorAt(p.x, p.y);
    const maxSp = mv.maxSpeed * legF * terrainScale;
    p.vx = intent.move.x * maxSp;
    p.vy = intent.move.y * maxSp;

    const totalDist = Math.hypot(p.vx * dt, p.vy * dt);
    const steps = Math.max(1, Math.ceil(totalDist / COLLISION_SUBSTEP_PX));
    const stepDt = dt / steps;
    for (let s = 0; s < steps; s++) {
      const ox = p.x, oy = p.y;
      let nx = p.x + p.vx * stepDt, ny = p.y + p.vy * stepDt;
      const groundBlocked = (x, y) => this._blockedAlongSegment(ox, oy, x, y, PLAYER_WALL_COLLIDE_RADIUS);
      if (groundBlocked(nx, ny)) {
        if (!groundBlocked(ox, ny)) { nx = ox; p.vx = 0; }
        else if (!groundBlocked(nx, oy)) { ny = oy; p.vy = 0; }
        else { nx = ox; ny = oy; p.vx = 0; p.vy = 0; }
      }
      p.x = nx; p.y = ny;
    }
    p.speed = Math.hypot(p.vx, p.vy);

    const inputMag = Math.hypot(intent.move.x, intent.move.y);
    if (inputMag > STICK_DEADZONE) p.angle = Math.atan2(intent.move.y, intent.move.x);

    // Turret aim: identical twin-stick mapping to the arena's own `_drive` (right stick/mouse
    // aims independently of travel direction) — even with nothing to shoot at yet, the CONTROL
    // FEEL should be the same machine, not a different one that happens to look alike.
    if (intent.aim.mode === 'pointer') {
      p.aimX = intent.aim.x; p.aimY = intent.aim.y;
    } else {
      p.aimX = p.x + Math.cos(intent.aim.angle) * 800;
      p.aimY = p.y + Math.sin(intent.aim.angle) * 800;
    }
    p.turretAngle = Math.atan2(p.aimY - p.y, p.aimX - p.x);
  },

  _stepGaitBase(dt) {
    const p = this.player;
    const mv = p.mech.movement;
    const legF = p.mech.legFactor();
    let bob = 0;
    if (Math.abs(p.speed) > 5 && legF > 0) {
      const cycleMs = mv.stepInterval * CYCLE_BEATS;
      p.stepMs = (p.stepMs + dt * 1000 * (Math.abs(p.speed) / mv.maxSpeed)) % cycleMs;
      const phase = p.stepMs / cycleMs;
      p.hullFrame = Math.min(PLAYER_HULL_FRAMES - 1, Math.floor(phase * PLAYER_HULL_FRAMES));

      const beat = phase < 0.5 ? 0 : 1;
      if (beat !== p._gaitBeat) {
        p._gaitBeat = beat;
        this._footImpactFx(beat, mv.stepBob, p);
        this._footShake(mv.footShake, mv.maxSpeed, p);
        Audio.footstep(beat);
      }

      const speedScale = Phaser.Math.Clamp(Math.abs(p.speed) / mv.maxSpeed, 0, 1);
      const lift = Math.abs(Math.sin(phase * Math.PI * 2));
      bob = Math.pow(lift, BOB_EASE_POWER) * mv.stepBob * speedScale;
    } else {
      p._gaitBeat = undefined;
      const cycleMs = mv.stepInterval * CYCLE_BEATS;
      if (dt > 0 && cycleMs > 0) {
        const half = cycleMs / 2;
        const target = Math.round(p.stepMs / half) * half;
        p.stepMs = approach(p.stepMs, target, cycleMs * 3 * dt) % cycleMs;
        p.hullFrame = Math.min(PLAYER_HULL_FRAMES - 1, Math.floor((p.stepMs / cycleMs) * PLAYER_HULL_FRAMES));
      }
    }
    p.view.hull.setTexture(`${p.textureKey}_hull_${p.hullFrame}`);
    p.view.hull.rotation = p.angle + Math.PI / 2;
    p.view.turret.rotation = p.turretAngle + Math.PI / 2;
    // No weapons to converge — every pivoting part eases back to its neutral (0) tilt.
    this._syncTilts(p.view, p.mech, p.turretAngle, ARENA_MECH_SCALE, 0, 0, {}, dt);
    p.view.setPosition(p.x, p.y - bob);
  },
};
