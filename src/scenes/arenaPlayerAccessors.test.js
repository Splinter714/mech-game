// #347 — the delegating accessors on ArenaScene.prototype.
//
// This is the single riskiest mechanism in the phase-1 refactor: `this.px`, `this.mech`,
// `this._playerDead` and friends are no longer plain properties, they are getter/setter pairs
// onto `this.players[0]`. If that delegation were wrong in either direction, EVERY remaining
// singleton-style read in the arena would silently break — and a large refactor with no visible
// payoff is exactly the kind that a playtest cannot distinguish from "fine".
//
// So this pins the contract directly: one storage location, no second copy that can drift.
import { describe, it, expect, vi } from 'vitest';

// ArenaScene extends Phaser.Scene and touches Phaser.Math at module scope, so the mock needs
// slightly more than the usual `{ default: {} }` stub the mixin tests use.
vi.mock('phaser', () => ({
  default: {
    Scene: class { constructor(key) { this.sceneKey = key; } },
    Math: { Clamp: (v, a, b) => Math.min(b, Math.max(a, v)), Angle: { Wrap: (v) => v, RotateTo: (a) => a } },
    Scenes: { Events: { SHUTDOWN: 'shutdown' } },
  },
}));

const { default: ArenaScene } = await import('./ArenaScene.js');
const { makePlayer } = await import('../data/players.js');

// A bare object on the prototype — enough to exercise the accessors without booting Phaser.
function sceneWithPlayers(players) {
  return Object.assign(Object.create(ArenaScene.prototype), { players });
}

const FIELDS = [
  ['px', 'x'], ['py', 'y'],
  ['angle', 'angle'], ['turretAngle', 'turretAngle'],
  ['aimX', 'aimX'], ['aimY', 'aimY'],
  ['vx', 'vx'], ['vy', 'vy'], ['speed', 'speed'],
  ['stepMs', 'stepMs'], ['hullFrame', 'hullFrame'],
  ['playerView', 'view'], ['_playerDead', 'dead'],
];

describe('ArenaScene player-field accessors delegate to players[0] (#347)', () => {
  it('every alias READS the primary player\'s own field', () => {
    const p = makePlayer({ id: 0 });
    const scene = sceneWithPlayers([p]);
    let n = 1;
    for (const [sceneField, playerField] of FIELDS) {
      const v = n++;
      p[playerField] = v;
      expect(scene[sceneField], `${sceneField} should read players[0].${playerField}`).toBe(v);
    }
  });

  it('every alias WRITES through to the primary player — no shadow copy', () => {
    const p = makePlayer({ id: 0 });
    const scene = sceneWithPlayers([p]);
    let n = 100;
    for (const [sceneField, playerField] of FIELDS) {
      const v = n++;
      scene[sceneField] = v;
      expect(p[playerField], `${sceneField} should write players[0].${playerField}`).toBe(v);
      // And reading it back must come from that same storage, not from an own property.
      expect(Object.hasOwn(scene, sceneField)).toBe(false);
      expect(scene[sceneField]).toBe(v);
    }
  });

  it('`mech` delegates too — the most-read alias of all', () => {
    const mech = { id: 'the-mech' };
    const scene = sceneWithPlayers([makePlayer({ id: 0 })]);
    scene.mech = mech;
    expect(scene.players[0].mech).toBe(mech);
    expect(scene.mech).toBe(mech);
  });

  it('a write followed by a read round-trips exactly, including falsy values', () => {
    const scene = sceneWithPlayers([makePlayer({ id: 0 })]);
    for (const v of [0, false, null, -0.5, NaN]) {
      scene.vx = v;
      if (Number.isNaN(v)) expect(Number.isNaN(scene.vx)).toBe(true);
      else expect(scene.vx).toBe(v);
    }
  });

  it('adding a second player does not disturb the aliases, which stay on the primary', () => {
    const a = makePlayer({ id: 0, x: 1, y: 2 });
    const b = makePlayer({ id: 1, x: 900, y: 900 });
    const scene = sceneWithPlayers([a, b]);
    expect(scene.px).toBe(1);
    expect(scene.py).toBe(2);
    scene.px = 50;
    expect(a.x).toBe(50);
    expect(b.x).toBe(900);   // untouched
  });

  it('reading before the collection exists yields undefined rather than throwing', () => {
    const scene = Object.create(ArenaScene.prototype);
    expect(scene.px).toBeUndefined();
    expect(scene.mech).toBeUndefined();
  });

  it('WRITING before the collection exists throws loudly instead of silently vanishing', () => {
    const scene = Object.create(ArenaScene.prototype);
    expect(() => { scene.px = 5; }).toThrow(/before this\.players existed/);
  });
});
