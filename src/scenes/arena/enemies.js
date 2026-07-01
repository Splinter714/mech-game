// Arena enemies mixin — enemy lifecycle (spawn/debug-spawn/reset) and the per-enemy AI.
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign. Enemy
// loadouts are data (data/enemies.js).
//
// ── #44 tactical AI ────────────────────────────────────────────────────────────────────
// The old model computed ONE preferred distance and perturbed a single orbit (advance if far,
// retreat if close, strafe otherwise, plus sine/pressure/commit timers). It always read as
// "circle-strafe at radius R." This rewrite replaces the orbit with a small STATE MACHINE
// whose states are readable tactical intents, chosen by a short decision timer (not per frame,
// so a choice is committed long enough to look deliberate):
//
//   PRESS    — close the distance; get inside optimal range (brawlers, or player fleeing).
//   KITE     — back away while keeping LOS; hold standoff (snipers, or player too close).
//   FLANK    — travel to a concrete off-axis destination at good range (varying approach
//              vectors instead of a constant-radius circle). This is the default "fighting".
//   COVER    — break line-of-sight behind a real wall (taking damage / low health), then peek.
//   HOLD     — sit at good range with LOS and shoot (healthy, well-positioned).
//
// A weapon-range-derived ROLE (brawler / skirmisher / sniper) biases the standoff distance and
// which states are favoured. Real terrain drives COVER (via _isWall / _wallDistance). Firing
// (LOS-gated, with lead) is preserved. Everything is gated by this.enemyMove / this.enemyFire.
import Phaser from 'phaser';
import { Mech } from '../../data/Mech.js';
import { ENEMIES, ENEMY_ROTATION, DEFAULT_SQUAD } from '../../data/enemies.js';
import { buildMechTextures, reskinMech } from '../../art/index.js';
import { hexToPixel, range, HEX_SIZE } from '../../data/hexgrid.js';
import { LETHAL_LOCATIONS } from '../../data/anatomy.js';
import { approach, backwardSpeedScale, ARENA_MECH_SCALE } from './shared.js';

const SQRT3 = Math.sqrt(3);   // pointy-top hex horizontal spacing factor (matches hexgrid.js)

// ── #44 tactical-AI tuning (owner: review/tune) ─────────────────────────────────────────
// Grouped so the feel can be re-tuned without hunting through _updateEnemy.

// Role thresholds: an enemy whose weapons' mean optimum range is below BRAWLER_OPT is a
// close-quarters brawler (presses in); above SNIPER_OPT it's a sniper (kites); between, a
// mid-range skirmisher (flanks). Standoff distance is derived from that mean opt, clamped.
const BRAWLER_OPT = 170;            // mean weapon opt (px) below this ⇒ brawler role
const SNIPER_OPT = 360;             // mean weapon opt (px) above this ⇒ sniper role
const STANDOFF_MIN = 90;            // never try to fight closer than this
const STANDOFF_MAX = 520;           // never try to fight farther than this
const STANDOFF_FRAC = 0.85;         // standoff = STANDOFF_FRAC × mean weapon opt (sit just inside opt)
const DEFAULT_OPT = 220;            // fallback mean opt for a weaponless mech

// Distance bands, expressed as multiples of the enemy's standoff distance. Inside TOO_CLOSE
// it wants to back off; beyond TOO_FAR it wants to close; the sweet spot is the ring between.
const TOO_CLOSE_FRAC = 0.55;        // dist < standoff×this ⇒ "player is in my face"
const TOO_FAR_FRAC = 1.45;          // dist > standoff×this ⇒ "player is out of my fight"

// Decision cadence: how long a chosen state is held before the AI re-decides. A range, so N
// enemies don't re-plan in lockstep. Kept > ~0.5s so moves read as intent, not twitch.
const DECIDE_MIN = 750;
const DECIDE_MAX = 1500;

// FLANK: when the AI decides to reposition it picks a destination at standoff range, offset
// from the current player-bearing by a flank angle. The angle is re-picked per flank decision
// (from this spread) and its sign is the enemy's persistent orbit handedness (spaces enemies
// out — some go left, some right). Larger angle ⇒ wider, less orbit-like arcs.
const FLANK_ANGLE_MIN = 0.55;       // rad — min off-axis flank angle (~31°)
const FLANK_ANGLE_MAX = 1.35;       // rad — max off-axis flank angle (~77°)
const FLANK_REACH = 0.45;           // fraction of the flank leg that counts as "arrived"

// COVER: how far to probe for a wall that breaks LOS, and how close to the cover edge to sit.
const COVER_SEARCH_STEP = 40;       // px between sampled cover candidate points
const COVER_SEARCH_RING = 3;        // how many rings of hexes out to search for cover
const COVER_HEALTH_TRIGGER = 0.45;  // lethal-part health fraction below which COVER is favoured
const COVER_DAMAGE_WINDOW = 1400;   // ms after taking a hit that the enemy prefers cover
const PEEK_DIST = 26;               // px past a cover edge the enemy leans out to shoot

// Artillery posture (#44 follow-up): a mech whose weapons are ALL indirect-fire (every one is
// homing or arcing, so it never needs line-of-sight to hit) camps behind cover as its PRIMARY
// state — it bombards over walls and never willingly exposes itself. When it can't find cover
// it falls back to holding at standoff. These bound how far it ranges and how often it hunts a
// fresh camp spot even while safely behind a wall (so it isn't perfectly static).
const ARTY_RECAMP_MIN = 2600;       // ms — min interval an all-indirect mech holds one camp spot
const ARTY_RECAMP_MAX = 5200;       // ms — max before it looks for a fresh cover position

// Off-screen spawn (#44 follow-up): enemies appear OUTSIDE the camera viewport and walk in.
// The spawn point is the visible-world rectangle's edge pushed out by this margin (px), placed
// on a random bearing from the player, then clamped inside the world disc so it stays on the map.
const OFFSCREEN_MARGIN = 120;       // px beyond the visible edge to drop a spawning enemy
const SPAWN_WORLD_INSET = 1.5;      // hexes of inset from the world edge kept clear for spawns

// Movement feel.
const MOVE_SPEED_FRAC = 0.85;       // fraction of chassis maxSpeed the AI drives at
const ARRIVE_SLOW = 70;             // px from a destination where the enemy eases to a stop
const REPICK_ON_ARRIVE = true;      // arriving at a FLANK/COVER goal forces an early re-decide

// Reactivity: bias state choice on what the player is doing.
const PLAYER_FLEE_DOT = 0.35;       // player velocity·(away from enemy) above this ⇒ "fleeing"
const PLAYER_VULN_HEALTH = 0.4;     // player lethal-part health below this ⇒ press the kill
const TRACKED_DOT = 0.965;          // player aim·(toward enemy) above this ⇒ "being tracked" (~15°)
const TRACKED_BREAK_CHANCE = 0.7;   // odds a tracked enemy juke-breaks its current plan on a decide

// Small helpers ---------------------------------------------------------------------------
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Mean optimum range of a mech's mounted weapons → drives role + standoff. Approximation.
function meanOpt(mech) {
  const ws = mech.weapons().map((w) => w.weapon).filter(Boolean);
  if (!ws.length) return DEFAULT_OPT;
  return ws.reduce((a, w) => a + (w.range?.opt ?? DEFAULT_OPT), 0) / ws.length;
}
function roleFor(opt) {
  if (opt < BRAWLER_OPT) return 'brawler';
  if (opt > SNIPER_OPT) return 'sniper';
  return 'skirmisher';
}

// Is one weapon indirect-fire — homing or arcing, so it hits WITHOUT line-of-sight? Mirrors the
// direct/indirect split in targeting.js `_fireAngle` (guidance 'homing' or path 'arcing').
function isIndirectWeapon(weapon) {
  const d = weapon?.delivery;
  return !!d && (d.guidance === 'homing' || d.path === 'arcing');
}

// Does a mech's ENTIRE loadout fire indirectly (every mounted weapon is homing/arcing)? Such a
// mech never needs LOS to hit, so it can camp behind cover as a primary posture and bombard over
// walls. A mech with any direct weapon must expose/peek to shoot. False if it has no weapons.
function isAllIndirect(mech) {
  const ws = mech.weapons().map((w) => w.weapon).filter(Boolean);
  return ws.length > 0 && ws.every(isIndirectWeapon);
}

// Lowest health fraction among the enemy's lethal parts (head/cockpit/centreTorso) — the AI
// reads "am I hurt?" off this to decide whether to seek cover / disengage.
function lethalHealth(mech) {
  let lo = 1;
  for (const loc of LETHAL_LOCATIONS) {
    if (loc === 'cockpit') continue;   // shares the head part; head covers it
    const f = mech.partHealthFraction(loc);
    if (f < lo) lo = f;
  }
  return lo;
}

export const EnemiesMixin = {
  // ── Enemy lifecycle (#39 debug controls) ──────────────────────────────────────────
  // Build a fresh enemy with its own textures + view + AI state and track it. `typeId`
  // selects a loadout from data/enemies.js (defaults to the rotation for variety).
  _spawnEnemy(x, y, typeId = 'raider') {
    const key = `enemy${this._enemySeq++}`;
    const def = ENEMIES[typeId] ?? ENEMIES.raider;
    const mech = new Mech(def);
    mech.repairAll();
    buildMechTextures(this, key, mech, { theme: 'enemy' });
    const angle = Math.PI / 2;
    const view = this._makeMechView(key, x, y, angle);
    const opt = meanOpt(mech);
    const e = {
      key, mech, view, x, y, vx: 0, vy: 0, angle, turret: angle, fireCd: {},
      spawnX: x, spawnY: y, typeId,
      // #44 tactical-AI state.
      role: roleFor(opt),
      standoff: clamp(opt * STANDOFF_FRAC, STANDOFF_MIN, STANDOFF_MAX),
      handed: Math.random() < 0.5 ? 1 : -1,   // persistent flank handedness (spaces enemies out)
      // #44 follow-up: an all-indirect (homing/arcing) loadout camps cover as its primary posture.
      allIndirect: isAllIndirect(mech),
    };
    this._resetAiState(e);
    this.enemies.push(e);
    this.registry.set('dummyMech', this.enemies[0].mech);
    return e;
  },

  // Zero an enemy's transient AI decision state (state machine + timers + memory). Split out
  // so spawn and reset share it and can't drift; guarantees no stale carry-over / NaN.
  _resetAiState(e) {
    e.state = 'flank';
    e.decideAt = 0;               // ms until the next decision (0 ⇒ decide next frame)
    e.goal = null;                // {x, y} destination for flank/cover moves
    e.lastHealth = lethalHealth(e.mech);
    e.hurtUntil = 0;              // scene-time until which recent damage biases toward cover
    e.recampAt = 0;               // ms until an all-indirect mech hunts a fresh camp spot
  },

  // #44 follow-up: the default opening squad — one of each mech type — dropped OFF-SCREEN so
  // they walk into view and engage per their AI (the bombardier heads for cover, the brawler
  // closes, etc.). Called once from ArenaScene.create() in place of the old single fixed spawn.
  _spawnSquad(types = DEFAULT_SQUAD) {
    for (const typeId of types) {
      const p = this._offscreenSpawnPoint();
      this._spawnEnemy(p.x, p.y, typeId);
    }
  },

  // A spawn point OUTSIDE the current camera viewport but inside the world disc, on a random
  // bearing from the player — so the enemy starts unseen and walks in. The camera follows the
  // player, so "off-view" is a radius from the player: half the visible world rect's diagonal,
  // plus OFFSCREEN_MARGIN. The viewport size in world units is the canvas size (game.scale)
  // divided by the camera zoom (= dpr). We read it from the scale manager + registry because
  // those are valid synchronously in create() — unlike cam.worldView / cam.width, which are only
  // filled after the first camera update (so a squad spawned during create() would land on-view).
  // The result is clamped into the world radius so a spawn can't land off-map or on blocked
  // terrain (nudged inward until clear); a ring point is the fallback if every try is blocked.
  _offscreenSpawnPoint() {
    const zoom = this.registry.get('dpr') || this.cameras.main.zoom || 1;
    const vw = this.scale.width / zoom;   // world-space viewport width
    const vh = this.scale.height / zoom;  // world-space viewport height
    const viewR = 0.5 * Math.hypot(vw, vh) + OFFSCREEN_MARGIN;
    const maxR = (this.worldRadius - SPAWN_WORLD_INSET) * HEX_SIZE * SQRT3;   // ~world edge in px
    for (let tries = 0; tries < 24; tries++) {
      const ang = Math.random() * Math.PI * 2;
      // Distance from the player: just off-view, but never past the world edge.
      const d = Math.min(viewR + Math.random() * 120, maxR);
      let x = this.px + Math.cos(ang) * d, y = this.py + Math.sin(ang) * d;
      // Clamp inside the world disc, then nudge off any blocked terrain toward the centre.
      const fromC = Math.hypot(x, y);
      if (fromC > maxR) { x *= maxR / fromC; y *= maxR / fromC; }
      for (let n = 0; n < 6 && this._blocked(x, y); n++) { x *= 0.85; y *= 0.85; }
      if (!this._blocked(x, y)) return { x, y };
    }
    return { x: 0, y: -maxR * 0.8 };   // last-resort clear-ish fallback (map is open near centre)
  },

  // Drop an extra enemy from OFF-SCREEN so it walks into view (#44 follow-up), cycling the
  // loadout rotation so successive spawns differ in role instead of stacking identical orbits.
  _spawnEnemyDebug() {
    const typeId = ENEMY_ROTATION[this._enemySeq % ENEMY_ROTATION.length];
    const p = this._offscreenSpawnPoint();
    const e = this._spawnEnemy(p.x, p.y, typeId);
    this._floatText(this.px, this.py - 34, `${e.mech.name || 'ENEMY'} INBOUND`, '#efc14a');
  },

  // Restore every enemy to full health at its spawn point (in place, no re-deploy).
  _resetEnemies() {
    for (const e of this.enemies) {
      e.mech.repairAll();
      e.x = e.spawnX; e.y = e.spawnY; e.vx = 0; e.vy = 0;
      e.angle = Math.PI / 2; e.turret = Math.PI / 2; e.fireCd = {};
      this._resetAiState(e);   // #44: fresh decision state, no mid-plan carry-over
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

  // ── Enemy AI update loop ────────────────────────────────────────────────────────────
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
    const bearing = Math.atan2(dyp, dxp);           // from enemy → player
    const ux = dxp / dist, uy = dyp / dist;

    if (this.enemyMove) {
      // Track incoming damage: any drop in lethal health opens a "prefer cover" window.
      const hp = lethalHealth(e.mech);
      if (hp < e.lastHealth - 0.001) e.hurtUntil = this.time.now + COVER_DAMAGE_WINDOW;
      e.lastHealth = hp;

      // Re-decide on a cadence timer (or immediately after arriving at a goal). Between
      // decisions the enemy commits to its current state, so behaviour reads deliberately.
      e.decideAt -= delta;
      e.recampAt -= delta;   // all-indirect camp-hold timer (see _decideEnemyState)
      const arrived = e.goal && Math.hypot(e.goal.x - e.x, e.goal.y - e.y) < ARRIVE_SLOW;
      if (e.decideAt <= 0 || (REPICK_ON_ARRIVE && arrived && (e.state === 'flank' || e.state === 'cover'))) {
        this._decideEnemyState(e, dist, bearing, hp);
        e.decideAt = rand(DECIDE_MIN, DECIDE_MAX);
      }

      // Resolve the current state into a movement-intent vector (mx, my), roughly unit length.
      const { mx, my } = this._enemyMoveIntent(e, dist, bearing, ux, uy);

      // #45: backing away (relative to turret facing) is slower.
      const backScale = backwardSpeedScale(mx, my, e.turret);
      // Ease to a stop near a point goal so the enemy doesn't jitter on top of it.
      let speedFrac = MOVE_SPEED_FRAC;
      if (e.goal) {
        const gd = Math.hypot(e.goal.x - e.x, e.goal.y - e.y);
        if (gd < ARRIVE_SLOW) speedFrac *= clamp(gd / ARRIVE_SLOW, 0, 1);
      }
      const spd = mv.maxSpeed * speedFrac * backScale;
      e.vx = approach(e.vx, mx * spd, mv.accel * dt);
      e.vy = approach(e.vy, my * spd, mv.accel * dt);
      let nx = e.x + e.vx * dt, ny = e.y + e.vy * dt;
      if (this._blocked(nx, ny)) {
        if (!this._blocked(e.x + e.vx * dt, e.y)) { ny = e.y; e.vy = 0; }
        else if (!this._blocked(e.x, e.y + e.vy * dt)) { nx = e.x; e.vx = 0; }
        else { nx = e.x; ny = e.y; e.vx = e.vy = 0; }
        // Bumped a wall while pathing to a goal — abandon it so we re-plan promptly.
        if (e.goal) e.decideAt = Math.min(e.decideAt, 200);
      }
      e.x = nx; e.y = ny;
    } else {
      e.vx = approach(e.vx, 0, mv.accel * dt); e.vy = approach(e.vy, 0, mv.accel * dt);
    }

    // Aim turret + face travel (turret still tracks even when stationary, for testing).
    e.turret = Phaser.Math.Angle.RotateTo(e.turret, bearing, mv.turretSlew * dt);
    if (Math.hypot(e.vx, e.vy) > 5) e.angle = Phaser.Math.Angle.RotateTo(e.angle, Math.atan2(e.vy, e.vx), mv.turnRate * dt);

    // Fire ready weapons at the player when in range with line of sight (gated by #28), with
    // a small lead so shots aren't always behind a moving player.
    if (this.enemyFire) for (const w of e.mech.readyWeapons()) {
      let cd = (e.fireCd[w.location] ?? 0) - delta;
      const inRange = dist < (w.weapon.range.max || 300) * 1.05;
      const aim = this._enemyFireAngle(e, w, dxp, dyp, dist);
      const los = this._wallDistance(e.x, e.y, bearing, dist) === Infinity;
      if (cd <= 0 && inRange && los) {
        e.mech.consumeAmmo(w.location, w.index, 1);
        const aimErr = (Math.random() - 0.5) * 0.12;
        const mx2 = e.x + Math.cos(e.turret) * 16, my2 = e.y + Math.sin(e.turret) * 16;
        this._spawnProjectile(w, mx2, my2, aim + aimErr, 'enemy');
        cd = this._fireInterval(w.weapon);
      }
      e.fireCd[w.location] = Math.max(0, cd);
    }
    e.mech.regenAmmo(dt);

    e.view.setPosition(e.x, e.y);
    e.view.hull.rotation = e.angle + Math.PI / 2;
    e.view.turret.rotation = e.turret + Math.PI / 2;
    // Place + rotate all four pivoting parts each frame at the enemy's turret facing, tilt 0.
    this._syncTilts(e.view, e.mech, e.turret, ARENA_MECH_SCALE, 0, 0, {}, dt);
  },

  // ── State selection ─────────────────────────────────────────────────────────────────
  // Choose the enemy's next tactical state from the situation: role, distance band, health,
  // LOS, and what the player is doing. This is the "brain"; _enemyMoveIntent then realises it.
  _decideEnemyState(e, dist, bearing, hp) {
    const tooClose = dist < e.standoff * TOO_CLOSE_FRAC;
    const tooFar = dist > e.standoff * TOO_FAR_FRAC;
    const hasLos = this._wallDistance(e.x, e.y, bearing, dist) === Infinity;
    const hurt = hp < COVER_HEALTH_TRIGGER || this.time.now < e.hurtUntil;

    // Player-reaction signals.
    const pspeed = Math.hypot(this.vx || 0, this.vy || 0);
    const fleeDot = pspeed > 8 ? (-(this.vx * Math.cos(bearing) + this.vy * Math.sin(bearing)) / pspeed) : 0;
    const playerFleeing = fleeDot > PLAYER_FLEE_DOT;         // moving away from this enemy
    const playerVulnerable = lethalHealth(this.mech) < PLAYER_VULN_HEALTH;
    // "Is the player aiming at me?" — player turret facing vs bearing from player to enemy.
    const toEnemy = Math.atan2(e.y - this.py, e.x - this.px);
    const trackDot = Math.cos(this.turretAngle - toEnemy);
    const beingTracked = trackDot > TRACKED_DOT && dist < e.standoff * 1.3;

    // 0) ARTILLERY posture (#44 follow-up): a mech whose whole loadout is indirect-fire never
    //    needs LOS to hit, so it CAMPS behind cover as its default — bombarding over walls and
    //    never willingly exposing itself. It holds one camp spot for a spell (recampAt), then
    //    hunts a fresh covered position; if no cover is reachable it just holds at standoff. It
    //    still opens the distance if the player crowds it (tooClose), staying an area denier.
    if (e.allIndirect) {
      if (tooClose) { e.state = 'kite'; e.goal = null; return; }
      // Already safely behind cover and its hold-timer hasn't elapsed → sit tight and shell.
      const behindCover = !hasLos;
      if (behindCover && e.recampAt > 0) { e.state = 'cover'; return; }
      const cover = this._findCoverSpot(e, bearing);
      if (cover) { e.state = 'cover'; e.goal = cover; e.recampAt = rand(ARTY_RECAMP_MIN, ARTY_RECAMP_MAX); return; }
      // No cover in reach → hold at standoff and keep lobbing (still doesn't need to expose).
      e.state = tooFar ? 'press' : 'hold'; e.goal = null; return;
    }

    // 1) Hurt / under fire → break contact behind cover if any exists; else kite out.
    if (hurt) {
      const cover = this._findCoverSpot(e, bearing);
      if (cover) { e.state = 'cover'; e.goal = cover; return; }
      e.state = 'kite'; e.goal = null; return;
    }

    // 2) Distance-band overrides — get back into the fight ring first.
    if (tooClose && e.role !== 'brawler') { e.state = 'kite'; e.goal = null; return; }
    if (tooFar) { e.state = 'press'; e.goal = null; return; }

    // 3) Opportunistic press: a fleeing or wounded player invites a committed push (brawlers
    //    always lean this way). Don't over-close a sniper, though.
    if ((playerFleeing || playerVulnerable || e.role === 'brawler') && !tooClose && e.role !== 'sniper') {
      e.state = 'press'; e.goal = null; return;
    }

    // 4) Being visibly tracked → juke: pick a fresh flank goal (often flipping side) to spoil
    //    the player's aim rather than holding a predictable line.
    if (beingTracked && Math.random() < TRACKED_BREAK_CHANCE) {
      if (Math.random() < 0.5) e.handed *= -1;   // sometimes reverse orbit direction
      e.state = 'flank'; e.goal = this._flankGoal(e, bearing); return;
    }

    // 5) No LOS on the player → reposition to a spot that has a firing lane.
    if (!hasLos) { e.state = 'flank'; e.goal = this._flankGoal(e, bearing); return; }

    // 6) Default: mostly FLANK (travel a new approach vector), occasionally HOLD and shoot
    //    from a good position. Snipers hold more (they want a stable firing line).
    const holdChance = e.role === 'sniper' ? 0.45 : 0.28;
    if (Math.random() < holdChance) { e.state = 'hold'; e.goal = null; }
    else { e.state = 'flank'; e.goal = this._flankGoal(e, bearing); }
  },

  // Pick a FLANK destination: a point at standoff range from the player, offset around the
  // player by a flank angle on the enemy's handedness. This makes enemies travel to distinct
  // off-axis spots (varying approach vectors) instead of holding a constant-radius orbit.
  _flankGoal(e, bearing) {
    const ang = rand(FLANK_ANGLE_MIN, FLANK_ANGLE_MAX) * e.handed;
    // Angle from the PLAYER out to the desired spot = (player→enemy bearing) rotated by `ang`.
    const outAng = bearing + Math.PI + ang;
    let gx = this.px + Math.cos(outAng) * e.standoff;
    let gy = this.py + Math.sin(outAng) * e.standoff;
    // Nudge the goal off blocked terrain by pulling it back toward the player until clear.
    for (let t = 0; t < 5 && this._blocked(gx, gy); t++) {
      gx = (gx + this.px) / 2; gy = (gy + this.py) / 2;
    }
    return { x: gx, y: gy };
  },

  // Search nearby hexes for a point that (a) is passable, (b) breaks LOS from the player to
  // that point (so the enemy is behind cover there), and (c) isn't absurdly far. Returns the
  // nearest such point, or null if no cover is reachable — real terrain reasoning via _isWall.
  _findCoverSpot(e, bearing) {
    const here = { q: 0, r: 0 };
    // Candidate hex centres within a few rings of the enemy.
    const cand = range(here, COVER_SEARCH_RING)
      .map((h) => {
        const c = hexToPixel(h.q, h.r);
        return { x: e.x + c.x, y: e.y + c.y };
      })
      .filter((p) => !this._blocked(p.x, p.y));
    let best = null, bestScore = Infinity;
    for (const p of cand) {
      const d = Math.hypot(p.x - this.px, p.y - this.py);
      const ang = Math.atan2(p.y - this.py, p.x - this.px);
      // A spot is cover if the player's line of sight to it is broken by a wall before it.
      const losBlocked = this._wallDistance(this.px, this.py, ang, d) < d - COVER_SEARCH_STEP;
      if (!losBlocked) continue;
      // Prefer near cover that keeps us in the fight (not driven to the map edge).
      const travel = Math.hypot(p.x - e.x, p.y - e.y);
      const rangePenalty = Math.abs(d - e.standoff) * 0.25;
      const score = travel + rangePenalty;
      if (score < bestScore) { bestScore = score; best = p; }
    }
    return best;
  },

  // ── Movement realisation ────────────────────────────────────────────────────────────
  // Turn the current state into a movement-intent vector (mx, my), roughly unit length.
  _enemyMoveIntent(e, dist, bearing, ux, uy) {
    switch (e.state) {
      case 'press':  // close the gap; stop pressing once inside optimal so we don't faceplant.
        if (dist <= e.standoff * 0.8) return this._strafeIntent(e, ux, uy);
        return { mx: ux, my: uy };

      case 'kite':   // back away from the player while keeping LOS; sidestep a touch so it
                     // isn't a dead-straight retreat the player can walk down.
        return { mx: -ux * 0.85 - uy * 0.3 * e.handed, my: -uy * 0.85 + ux * 0.3 * e.handed };

      case 'flank':  // steer toward the flank/cover destination.
      case 'cover': {
        // An all-indirect bombardier with no goal is already camped — hold dead still and shell
        // over the wall (it never needs to expose). A direct-fire mech without a goal drifts.
        if (!e.goal) return e.allIndirect ? { mx: 0, my: 0 } : this._strafeIntent(e, ux, uy);
        const gx = e.goal.x - e.x, gy = e.goal.y - e.y;
        const gm = Math.hypot(gx, gy) || 1;
        // Near a COVER goal: a direct-fire mech peeks (leans toward the player to shoot); an
        // all-indirect bombardier stays tucked (no peek — it lobs/locks over the wall).
        if (e.state === 'cover' && gm < PEEK_DIST * 2) {
          return e.allIndirect ? { mx: 0, my: 0 } : { mx: ux * 0.4, my: uy * 0.4 };
        }
        return { mx: gx / gm, my: gy / gm };
      }

      case 'hold':   // hold position, a gentle strafe so we're not a static target.
      default:
        return this._strafeIntent(e, ux, uy);
    }
  },

  // A light lateral drift perpendicular to the player bearing (handedness = orbit side). Used
  // by HOLD / in-band PRESS so the enemy isn't a sitting duck without committing to a full orbit.
  _strafeIntent(e, ux, uy) {
    return { mx: -uy * e.handed * 0.6, my: ux * e.handed * 0.6 };
  },

  // Firing aim with a simple lead: aim where the player will be by the time a projectile
  // arrives (hitscan → no lead). Keeps the existing small aim error at the call site.
  _enemyFireAngle(e, w, dxp, dyp, dist) {
    const d = w.weapon.delivery;
    const vel = d.hit === 'hitscan' ? 0 : (d.velocity || 0);
    if (vel <= 0) return Math.atan2(dyp, dxp);
    const t = dist / vel;
    const lx = this.px + (this.vx || 0) * t, ly = this.py + (this.vy || 0) * t;
    return Math.atan2(ly - e.y, lx - e.x);
  },
};
