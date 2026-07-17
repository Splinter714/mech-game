// #225 (playtest: "when my mech is destroyed, it needs to really be destroyed in a big
// explosion, not just have parts missing and still be able to walk around as a husk").
// Two gaps, two tests:
//   1. `_damagePlayerAt` (combat.js) used to only flip `_playerDead`, float 'MECH DOWN' and
//      play the mechDestroyed cue — no visual destruction at all. It must now also fire the
//      same catastrophic `_deathFx` an enemy death gets (biggest scale/category, since this is
//      the single most severe moment in a run), freeze the mech's velocity so the stepped-gait
//      animation (locomotion.js `_stepGait`) doesn't keep "walking" on stale speed, and hide the
//      player's own view so no lingering damaged husk sits on screen.
//   2. ArenaScene's update() loop must stop reading player input for movement/turret-aim
//      (`_drive`, plus `_handleSprint` which feeds it) and per-slot firing (`_handleFiring`)
//      the instant `_playerDead` flips true — verified as a source-text guard (same technique
//      sfxCallSites.guard.test.js already uses for this file/ArenaScene.js) since a full
//      behavioral test would need to stand up most of a live Phaser scene, which this repo's
//      test discipline reserves for the Playwright smoke test instead (see CLAUDE.md).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('../../art/index.js', () => ({
  reskinMech: vi.fn(),
  mechLayout: vi.fn(() => ({})),
  ART_SCALE: 1,
}));
vi.mock('../../audio/index.js', () => ({
  Audio: {
    ui: vi.fn(),
    impact: vi.fn(),
    deathExplosion: vi.fn(),
  },
}));

import { CombatMixin } from './combat.js';
import { Audio } from '../../audio/index.js';
import { DEATH_SCALE_MAX } from './shared.js';

// A minimal ArenaScene-shaped `this`: the real CombatMixin runs, with the Phaser-touching FX
// helpers (`_burst`/`_smokePuff`/`_deathDebris`/`_floatText`) stubbed so we can assert on their
// call arguments without a live scene — same pattern as crush.test.js/vehicleFire.test.js use
// for their own mixins.
function makeScene({ hp = 10 } = {}) {
  let destroyed = false;
  const scene = {
    px: 123, py: 456,
    vx: 40, vy: -15, speed: 42,
    playerView: { setVisible: vi.fn() },
    mech: {
      maxHp: 616,
      applyDamage: vi.fn(() => {
        destroyed = true;
        return { destroyed: true, applied: hp };
      }),
      isDestroyed: () => destroyed,
      // #231 (merged in after this test was first written): _damagePlayerAt now picks the hit
      // location via `pickLiveWeighted`, which rerolls among still-live pool entries using this
      // — a fixture with nothing ever destroyed (this test isn't exercising the redirect logic).
      isPartDestroyed: () => false,
    },
  };
  Object.assign(scene, CombatMixin);
  // Stub out AFTER mixing in CombatMixin so these override the mixin's real (Phaser-touching)
  // implementations — mirrors crush.test.js/projectiles.test.js's pattern. We're only asserting
  // _damagePlayerAt's own new behavior (calls _deathFx, freezes velocity, hides the view), not
  // exercising the real _deathFx burst/debris/tween machinery, which needs a live scene.
  scene._floatText = vi.fn();
  scene._deathFx = vi.fn();
  scene._shieldHitFlash = vi.fn();
  return scene;
}

describe('_damagePlayerAt — player death explosion + freeze (#225)', () => {
  it('fires _deathFx at the player position with the biggest scale/category on the killing hit', () => {
    const scene = makeScene();
    scene._damagePlayerAt(999);
    expect(scene._playerDead).toBe(true);
    expect(scene._deathFx).toHaveBeenCalledTimes(1);
    expect(scene._deathFx).toHaveBeenCalledWith(123, 456, DEATH_SCALE_MAX, 'massive');
  });

  it('freezes velocity/speed so the gait animation stops on this frame\'s pose', () => {
    const scene = makeScene();
    scene._damagePlayerAt(999);
    expect(scene.vx).toBe(0);
    expect(scene.vy).toBe(0);
    expect(scene.speed).toBe(0);
  });

  it('hides the player view so no lingering husk is left on screen', () => {
    const scene = makeScene();
    scene._damagePlayerAt(999);
    expect(scene.playerView.setVisible).toHaveBeenCalledWith(false);
  });

  it('still plays mechDestroyed exactly as before (additive, not replaced) — #236 dropped the MECH DOWN floating text', () => {
    const scene = makeScene();
    scene._damagePlayerAt(999);
    expect(Audio.ui).toHaveBeenCalledWith('mechDestroyed');
  });

  it('only fires the death sequence ONCE even if damage keeps landing after death', () => {
    const scene = makeScene();
    scene._damagePlayerAt(999);
    scene._damagePlayerAt(999);
    expect(scene._deathFx).toHaveBeenCalledTimes(1);
    expect(scene.playerView.setVisible).toHaveBeenCalledTimes(1);
  });
});

// Source-text guard for the ArenaScene.js update-loop gating — see file header for why this
// isn't a full behavioral test.
const DIR = dirname(fileURLToPath(import.meta.url));
const arenaScene = readFileSync(join(DIR, '..', 'ArenaScene.js'), 'utf8');

describe('#225 player-input gating in ArenaScene#update', () => {
  it('gates _handleSprint and _drive behind !this._playerDead', () => {
    const block = arenaScene.match(/if \(!this\._playerDead\) \{[\s\S]*?_drive\(intent, dt\);[\s\S]*?\n {4}\}/);
    expect(block).toBeTruthy();
    expect(block[0]).toMatch(/this\._handleSprint\(intent, delta\);/);
  });

  it('gates _handleFiring behind !this._playerDead', () => {
    expect(arenaScene).toMatch(/if \(!this\._playerDead\) this\._handleFiring\(intent, delta\);/);
  });
});
