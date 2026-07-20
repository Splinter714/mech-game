// Arena CO-OP mixin (#348, phase 2 of local co-op — parent #335). This is the phase where it
// becomes a co-op game: a second player joins, the camera is shared and leashed, players are
// told apart by colour, friendly fire is on, and a downed player comes back.
//
// Everything here is scene WIRING. The rules themselves are pure and unit-tested elsewhere:
//   data/leash.js    — the hard-stop leash (Jackson rejected zoom-out and rubber-band by name)
//   data/playerCollision.js — players are solid to each other (soft push, never a deadlock)
//   data/respawn.js  — the 20s clock, the out-of-combat gate, and the far-edge placement
//   data/players.js  — the collection, nearest-player targeting, the identifying colours
//
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign.
import { buildMechTextures } from '../../art/index.js';
import { Mech } from '../../data/Mech.js';
import { Controls, PadEdges, PAD } from '../../input/Controls.js';
import { initialSprintState } from '../../data/sprint.js';
import { initialDashState } from '../../data/dash.js';
import { MAX_PLAYERS, makePlayer, playerAccent } from '../../data/players.js';
import { mechKeyForPlayer, joinerBuild } from '../../data/coopGarage.js';
import { LEASH_RADIUS, clampToLeash, leashFocus } from '../../data/leash.js';
import {
  makeRespawnState, pickRespawnPoint, startRespawn, tickRespawn,
} from '../../data/respawn.js';
import { separatePlayers } from '../../data/playerCollision.js';
import { livePlayersOf, playersOf, primaryPlayerOf } from './players.js';
import { DEPTH, PLAYER_WALL_COLLIDE_RADIUS } from './shared.js';
import { Audio } from '../../audio/index.js';

// The identifying ring drawn on the ground under each mech. Sized to sit just outside the
// chassis silhouette so it reads as a marking on the ground rather than part of the machine,
// and drawn at DEPTH.GROUND_FX (the footfall-decal tier) so it can never render over a unit.
const MARKER_RADIUS = 30;

export const CoopMixin = {
  // Build ONE player: its mech, its own textures (accent-tinted per player), its view, its
  // ground marker, its controls, and its own copies of the input-shaped state phase 1 left
  // shared. `index` is both the player id and the pad index it reads.
  _makePlayerAt(index, x, y, mech) {
    const textureKey = index === 0 ? 'playerMech' : `playerMech${index}`;
    const player = makePlayer({ id: index, mech, x, y, textureKey });
    // #348: player 1's accent is null, so its textures are byte-identical to single-player.
    buildMechTextures(this, textureKey, mech, { theme: 'player', accent: playerAccent(index) });
    player.view = this._makeMechView(textureKey, x, y, player.angle, true);
    player.marker = this.add.circle(x, y, MARKER_RADIUS)
      .setStrokeStyle(2, player.color, 0.55)
      .setDepth(DEPTH.GROUND_FX);
    // Player 1 owns the keyboard + mouse and pad 0; every later player is pad-only. See the
    // Controls constructor comment for why the joiner is deliberately never keyboard-capable.
    player.controls = new Controls(this, { padIndex: index, keyboard: index === 0 });
    player.fireCooldowns = {};
    player.heldAudio = {};
    player.sprint = initialSprintState();
    player.dash = initialDashState();
    player.respawn = makeRespawnState();
    return player;
  },

  // Called once from create(), AFTER the first player exists. Sets up the shared camera anchor
  // and the join watcher.
  _initCoop() {
    // The camera follows a dedicated invisible ANCHOR rather than any one player's container,
    // because what it frames is the CENTROID — which is not a game object. With one player the
    // anchor sits exactly on that player every frame, so the framing is identical to before.
    const first = primaryPlayerOf(this);
    this._camAnchor = this.add.container(first.x, first.y);
    this.cameras.main.startFollow(this._camAnchor, true, 0.12, 0.12);
    // Pad-1 START is the join button. A separate PadEdges bound to pad index 1 — the scene's
    // existing `padEdges` watches pad 0 (player 1's debug/exit buttons) and must stay that way.
    this._joinEdges = new PadEdges(this, 1);
    // #349: players who joined from the GARAGE are already decided before the arena loads —
    // put them on the field immediately rather than making them press START again.
    this._spawnGarageCoopPlayers();
  },

  // #349: the garage publishes `coopMechKeys` — one key in solo, both in co-op. Every key past
  // the first is a player who built their own mech and is deploying with player 1. Absent (an
  // old session, or the smoke test driving the arena directly) reads as solo, so this is inert
  // on every pre-#349 path.
  _spawnGarageCoopPlayers() {
    const keys = this.registry.get('coopMechKeys') ?? [];
    for (let i = 1; i < keys.length && playersOf(this).length < MAX_PLAYERS; i++) this._addPlayer();
  },

  // Per-frame: has a second controller asked to join? Press START on gamepad 2.
  //
  // #349 keeps this path alive alongside the garage flow (Jackson: "keep both") — the garage is
  // the normal way in, this is late drop-in for someone who wanders over mid-run. What changed
  // is WHICH mech they get: their own saved 'mech2' build if it is usable, falling back to
  // phase 2's copy-of-player-1 only if it is not (see `_mechForPlayer`).
  _updateCoopJoin() {
    if (!this._joinEdges) return;
    if (playersOf(this).length >= MAX_PLAYERS) return;
    if (!this._joinEdges.pressed(PAD.START)) return;
    this._addPlayer();
  },

  _addPlayer() {
    const index = playersOf(this).length;
    const host = primaryPlayerOf(this);
    // A fresh, fully-healthy mech for this player, built from whichever saved garage slot is
    // theirs. Going through the registry's allMechs keeps it data-driven — #349 changed only
    // the SOURCE of the build, not this wiring.
    const mech = this._mechForPlayer(index);
    // Drop in alongside player 1, just far enough not to overlap, and well inside the leash.
    const player = this._makePlayerAt(index, host.x + 70, host.y + 70, mech);
    player.angle = host.angle;
    player.turretAngle = host.turretAngle;
    playersOf(this).push(player);
    this._floatText(player.x, player.y - 30, `PLAYER ${index + 1}`, '#4fc3f7');
    Audio.ui('deploy');
  },

  // A second mech for player `index`: a FRESH Mech through the model's own constructor.
  // Emphatically not a reference to player 1's Mech — the two must take damage completely
  // independently — and not a hand-rolled deep copy either, since `new Mech(...)` is the one
  // place that knows how to derive a full-health mech from a build.
  //
  // #349 replaced the SOURCE, exactly as phase 2 predicted it would, without touching the
  // wiring: the build now comes from that player's own persistent garage slot, with phase 2's
  // copy-of-player-1 kept as the fallback for a slot that was never finished. `joinerBuild`
  // (data/coopGarage.js) is the pure decision; this is just the Mech construction around it.
  _mechForPlayer(index) {
    const host = primaryPlayerOf(this).mech;
    const saved = this.allMechs?.[mechKeyForPlayer(index)];
    const mech = new Mech(joinerBuild(saved, host));
    mech.configureShield(this._playerShieldConfig ?? {});
    return mech;
  },

  // ── Player-vs-player collision (#348 playtest answer: "Add player collision") ──
  // Runs after every player has been driven and BEFORE `_updateCoopCamera`'s leash clamp, so the
  // leash keeps the final word on position — see data/playerCollision.js for why this is a soft
  // symmetric push rather than the hard movement block every other solid pair in the game uses,
  // and for why a shove and a leash pin cannot deadlock a player.
  //
  // The push is clipped against the same wall/terrain sweep the player's own locomotion uses, at
  // the same `PLAYER_WALL_COLLIDE_RADIUS` (#320), so being shoved by a teammate can never put a
  // mech somewhere it could not have walked — which is the gate-mouth/breach case specifically:
  // in a breach the pair separate along the gap, and a player already against the wall simply
  // does not take their half of the push.
  _separatePlayers() {
    const live = livePlayersOf(this);
    if (live.length < 2) return 0;
    const canMove = (p, x, y) => !this._blockedAlongSegment(p.x, p.y, x, y, PLAYER_WALL_COLLIDE_RADIUS);
    return separatePlayers(live, { canMove });
  },

  // ── The shared leashed camera ──
  // Order matters and is the whole implementation: every player has already been driven this
  // frame, so clamp them back inside the leash FIRST, then place the anchor on the resulting
  // centroid. Clamping after framing would let the camera chase a position no player is allowed
  // to occupy, which is exactly the drift a hard stop is supposed to prevent.
  _updateCoopCamera() {
    const players = playersOf(this);
    const live = livePlayersOf(this);
    const focus = leashFocus(players, (p) => !p.dead);
    if (!focus) return;
    if (live.length > 1) clampToLeash(live, focus, LEASH_RADIUS);
    // Re-derive the focus from the clamped positions so the anchor sits on where they actually
    // are rather than where they were about to be.
    const framed = leashFocus(players, (p) => !p.dead) ?? focus;
    this._camAnchor?.setPosition(framed.x, framed.y);
  },

  // Keep each player's ground marker pinned under its mech, and hide it with the mech on death.
  _updatePlayerMarkers() {
    for (const p of playersOf(this)) {
      if (!p.marker) continue;
      p.marker.setPosition(p.x, p.y);
      p.marker.setVisible(!p.dead);
    }
  },

  // ── Respawn ──
  // A downed player waits 20s AND for the team to be out of combat for ~1.5s, then walks back on
  // at the far edge of the current view. The out-of-combat gate is the design (Jackson): it stops
  // a respawn landing mid-firefight and dying instantly, and it gives the survivor a reason to
  // break contact rather than tank the fight.
  //
  // Respawn only exists while SOMEONE is still alive. With everybody down the run ends as it
  // always did (run.js `allPlayersDeadIn`), so a solo player's death is completely unchanged —
  // no 20-second wait was added to single player.
  _updateRespawns(delta) {
    const players = playersOf(this);
    if (players.length < 2) return;
    const live = livePlayersOf(this);
    if (!live.length) return;
    // How long ago ANY still-standing player last took a hit — the out-of-combat signal. Reading
    // the live players (not the corpse) is the point: it is the SURVIVOR's safety that gates the
    // return, exactly as Jackson framed it.
    const lastHit = Math.max(...live.map((p) => p.lastHitAt ?? -Infinity));
    const sinceHit = lastHit === -Infinity ? Infinity : this.time.now - lastHit;
    for (const p of players) {
      if (!p.dead) continue;
      p.respawn = startRespawn(p.respawn ?? makeRespawnState());
      const { state, ready } = tickRespawn(p.respawn, delta, sinceHit);
      p.respawn = state;
      if (ready) this._respawnPlayer(p);
    }
  },

  _respawnPlayer(player) {
    const wv = this.cameras.main.worldView;
    const view = { x: wv.x, y: wv.y, width: wv.width, height: wv.height };
    // "The far edge of the current view", measured against the live threats — so the returning
    // mech comes back on the opposite side of the screen from the fighting. This is the spatial
    // half of the same intent the out-of-combat gate expresses in time.
    const threats = (this.enemies ?? [])
      .filter((e) => !e.mech.isDestroyed())
      .map((e) => ({ x: e.x, y: e.y }));
    const pt = pickRespawnPoint(view, threats);
    player.mech.repairAll();
    player.mech.tickShield?.(0);
    player.x = pt.x; player.y = pt.y;
    player.vx = 0; player.vy = 0; player.speed = 0;
    player.dead = false;
    player.lastHitAt = -Infinity;
    player.respawn = makeRespawnState();
    player.view?.setVisible(true);
    player.view?.setPosition(pt.x, pt.y);
    player.marker?.setPosition(pt.x, pt.y);
    // Rebuild the textures: the mech died with stumps where its destroyed parts were, and
    // repairAll only fixes the model. Same accent, so it comes back the same colour.
    this._reskinPlayer(player);
    this._floatText(pt.x, pt.y - 30, 'REDEPLOY', '#7bd17b');
    Audio.ui('deploy');
  },

  // Re-raster one player's mech textures, preserving its identifying accent. Every call site
  // that reskins a player must go through here or a respawned/repaired player 2 would silently
  // revert to player 1's colours.
  _reskinPlayer(player) {
    buildMechTextures(this, player.textureKey ?? 'playerMech', player.mech,
      { theme: 'player', accent: playerAccent(player.id) });
  },

  // The world-space distance from the camera focus at which a player is hard-stopped, published
  // so the HUD could show it later. Read by nothing today; kept as the single named dial.
  get leashRadius() { return LEASH_RADIUS; },
};
