// Arena enemies mixin — enemy lifecycle (spawn/debug-spawn/reset) and the per-enemy AI
// (range-banding, facing, line-of-sight firing). Methods use `this` (the ArenaScene);
// composed onto the prototype via Object.assign. Enemy loadouts are data (data/enemies.js).
import Phaser from 'phaser';
import { Mech } from '../../data/Mech.js';
import { ENEMIES } from '../../data/enemies.js';
import { buildMechTextures, reskinMech } from '../../art/index.js';
import { hexToPixel, range } from '../../data/hexgrid.js';
import { approach } from './shared.js';

export const EnemiesMixin = {
  // ── Enemy lifecycle (#39 debug controls) ──────────────────────────────────────────
  // Build a fresh enemy with its own textures + view + AI state and track it.
  _spawnEnemy(x, y) {
    const key = `enemy${this._enemySeq++}`;
    const mech = new Mech(ENEMIES.raider);
    mech.repairAll();
    buildMechTextures(this, key, mech, { theme: 'enemy' });
    const angle = Math.PI / 2;
    const view = this._makeMechView(key, x, y, angle);
    const e = { key, mech, view, x, y, vx: 0, vy: 0, angle, turret: angle, fireCd: {}, strafeDir: 1, spawnX: x, spawnY: y };
    this.enemies.push(e);
    this.registry.set('dummyMech', this.enemies[0].mech);
    return e;
  },

  // Drop an extra enemy onto a clear, in-bounds spot away from the player.
  _spawnEnemyDebug() {
    const spots = range({ q: 0, r: 0 }, this.worldRadius - 1)
      .map((h) => hexToPixel(h.q, h.r))
      .filter((p) => !this._blocked(p.x, p.y) && Math.hypot(p.x - this.px, p.y - this.py) > 160);
    const p = spots.length ? spots[Math.floor(Math.random() * spots.length)] : { x: 0, y: -200 };
    this._spawnEnemy(p.x, p.y);
    this._floatText(p.x, p.y - 34, 'ENEMY +1', '#efc14a');
  },

  // Restore every enemy to full health at its spawn point (in place, no re-deploy).
  _resetEnemies() {
    for (const e of this.enemies) {
      e.mech.repairAll();
      e.x = e.spawnX; e.y = e.spawnY; e.vx = 0; e.vy = 0;
      e.angle = Math.PI / 2; e.turret = Math.PI / 2; e.fireCd = {};
      e.view.setAlpha(1).setPosition(e.x, e.y);
      reskinMech(this, e.key, e.mech, { theme: 'enemy' });
    }
    this._floatText(this.px, this.py - 40, 'ENEMIES RESET', '#5ec8e0');
  },

  // Debug (#28): flip enemy movement or firing on/off and toast the new state.
  _toggleAi(which) {
    if (which === 'move') this.enemyMove = !this.enemyMove;
    else this.enemyFire = !this.enemyFire;
    const label = which === 'move' ? `AI MOVE ${this.enemyMove ? 'ON' : 'OFF'}` : `AI FIRE ${this.enemyFire ? 'ON' : 'OFF'}`;
    this._floatText(this.px, this.py - 40, label, '#efc14a');
  },

  // ── Enemy AI ── each enemy maintains a range band, faces the player, fires with LOS. ──
  _updateEnemies(dt, delta) {
    this.registry.set('aiMove', this.enemyMove);
    this.registry.set('aiFire', this.enemyFire);
    for (const e of this.enemies) this._updateEnemy(e, dt, delta);
    const alive = this.enemies.filter((e) => !e.mech.isDestroyed()).length;
    this.registry.set('enemyCount', this.enemies.length);
    this.registry.set('enemiesAlive', alive);
  },

  _updateEnemy(e, dt, delta) {
    if (e.mech.isDestroyed()) { e.view.setAlpha(0.5); return; }
    const mv = e.mech.movement;
    const dxp = this.px - e.x, dyp = this.py - e.y;
    const dist = Math.hypot(dxp, dyp) || 1;
    const ux = dxp / dist, uy = dyp / dist;

    // Movement (gated by the #28 debug toggle): close if far, back off if close, else strafe.
    if (this.enemyMove) {
      let mx = 0, my = 0;
      if (dist > 260) { mx = ux; my = uy; }
      else if (dist < 150) { mx = -ux; my = -uy; }
      else { mx = -uy * e.strafeDir; my = ux * e.strafeDir; if (Math.random() < 0.01) e.strafeDir *= -1; }

      const spd = mv.maxSpeed * 0.8;
      e.vx = approach(e.vx, mx * spd, mv.accel * dt);
      e.vy = approach(e.vy, my * spd, mv.accel * dt);
      let nx = e.x + e.vx * dt, ny = e.y + e.vy * dt;
      if (this._blocked(nx, ny)) { if (!this._blocked(e.x + e.vx * dt, e.y)) { ny = e.y; e.vy = 0; } else if (!this._blocked(e.x, e.y + e.vy * dt)) { nx = e.x; e.vx = 0; } else { nx = e.x; ny = e.y; e.vx = e.vy = 0; } }
      e.x = nx; e.y = ny;
    } else {
      e.vx = approach(e.vx, 0, mv.accel * dt); e.vy = approach(e.vy, 0, mv.accel * dt);
    }

    // Aim turret + face travel (turret still tracks even when stationary, for testing).
    e.turret = Phaser.Math.Angle.RotateTo(e.turret, Math.atan2(dyp, dxp), mv.turretSlew * dt);
    if (Math.hypot(e.vx, e.vy) > 5) e.angle = Phaser.Math.Angle.RotateTo(e.angle, Math.atan2(e.vy, e.vx), mv.turnRate * dt);

    // Fire ready weapons at the player when in range with line of sight (gated by #28).
    if (this.enemyFire) for (const w of e.mech.readyWeapons()) {
      let cd = (e.fireCd[w.location] ?? 0) - delta;
      const inRange = dist < (w.weapon.range.max || 300) * 1.05;
      const los = this._wallDistance(e.x, e.y, Math.atan2(dyp, dxp), dist) === Infinity;
      if (cd <= 0 && inRange && los) {
        e.mech.consumeAmmo(w.location, w.index, 1);
        const aimErr = (Math.random() - 0.5) * 0.12;
        const mx2 = e.x + Math.cos(e.turret) * 16, my2 = e.y + Math.sin(e.turret) * 16;
        this._spawnProjectile(w, mx2, my2, Math.atan2(dyp, dxp) + aimErr, 'enemy');
        cd = this._fireInterval(w.weapon);
      }
      e.fireCd[w.location] = Math.max(0, cd);
    }
    e.mech.regenAmmo(dt);

    e.view.setPosition(e.x, e.y);
    e.view.hull.rotation = e.angle + Math.PI / 2;
    e.view.turret.rotation = e.turret + Math.PI / 2;
  },
};
