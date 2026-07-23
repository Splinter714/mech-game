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
import { playerMechArt } from '../../art/playerMechLook.js';
import { Mech } from '../../data/Mech.js';
import { Controls, PadEdges, PAD } from '../../input/Controls.js';
import { initialSprintState } from '../../data/sprint.js';
import { initialDashState } from '../../data/dash.js';
import { MAX_PLAYERS, makePlayer, showsPlayerColor } from '../../data/players.js';
import { mechKeyForPlayer, joinerBuild } from '../../data/coopGarage.js';
import { LEASH_RADIUS, clampToLeash, leashFocus } from '../../data/leash.js';
import {
  makeRespawnState, pickRespawnPoint, respawnReadout, respawnMarkerLayout, startRespawn, tickRespawn,
} from '../../data/respawn.js';
import { separatePlayers } from '../../data/playerCollision.js';
import { nearestValidPixel } from '../../data/spawnPlacement.js';
import { axialKey, pixelToHex } from '../../data/hexgrid.js';
import { isPassable } from '../../data/terrain.js';
import { livePlayersOf, playersOf, primaryPlayerOf, statusSpotColorsFor } from './players.js';
import { DEPTH, PLAYER_WALL_COLLIDE_RADIUS } from './shared.js';
import { Audio } from '../../audio/index.js';

// The identifying ring drawn on the ground under each mech. Sized to sit just outside the
// chassis silhouette so it reads as a marking on the ground rather than part of the machine,
// and drawn at DEPTH.GROUND_FX (the footfall-decal tier) so it can never render over a unit.
const MARKER_RADIUS = 30;

// #394 (playtest follow-up): the in-world respawn cue is a DROP ZONE, not a ground ring. Jackson
// on the first cut: "I'm seeing a respawn circle on the ground, which looks kinda weird" — a
// circle lying flat in the terrain reads as one more painted decal among the craters. The
// replacement is closing corner brackets plus a standing beacon column (geometry in
// data/respawn.js `respawnMarkerLayout`); the countdown is carried by the SHAPE closing in, so it
// reads from across the arena without anyone reading the number. The HUD carries the same clock as
// a powerup-style ring (HudScene `_updateBuffHud`) — Jackson asked for both, not either.
const RESPAWN_CHEVRON = 7;      // half-width of the chevron sliding down the beacon column
const RESPAWN_PHASE_MS = 900;   // one slide/breath cycle
// #421 (biome legibility): the dark backing every stroke of the drop-zone marker is drawn over.
const MARKER_EDGE = 0x0b0e14;
const MARKER_EDGE_W = 1.6;

export const CoopMixin = {
  // #348: the two shared "can a player be HERE?" primitives behind both co-op placements
  // (respawn and the mid-sortie joiner). `_isPassablePos` is the cheap map-lookup predicate;
  // `_validPlayerPos` snaps an arbitrary point to the nearest place a mech can actually stand.
  //
  // The snap goes through `nearestValidPixel`, whose ring search is capped by the FIXED,
  // world-independent `MAX_SEARCH_STEPS` (#345 — a budget derived from the world size is what
  // froze the game for minutes once #340 grew the corridor). Nothing here reintroduces one.
  _isPassablePos(x, y) {
    if (!this.terrain) return true;   // no terrain (unit-test scenes / pre-worldgen) → no constraint
    const h = pixelToHex(x, y);
    return isPassable(this.terrain.get(axialKey(h.q, h.r)));
  },

  // The one "could this player have DRIVEN from where they are to (x, y)?" test, shared by every
  // co-op displacement — the teammate shove and the leash clamp. It is locomotion's own swept
  // wall/terrain check at the same `PLAYER_WALL_COLLIDE_RADIUS` (#320), so nothing in co-op can
  // put a mech somewhere its own movement would have refused to go.
  _canMoveTo() {
    if (!this._blockedAlongSegment) return () => true;
    return (p, x, y) => !this._blockedAlongSegment(p.x, p.y, x, y, PLAYER_WALL_COLLIDE_RADIUS);
  },

  _validPlayerPos(pt) {
    if (!this.terrain) return pt;
    return nearestValidPixel(this.terrain, this.worldRadius, pt.x, pt.y);
  },

  // Build ONE player: its mech, its own textures (accent-tinted per player), its view, its
  // ground marker, its controls, and its own copies of the input-shaped state phase 1 left
  // shared. `index` is both the player id and the pad index it reads.
  _makePlayerAt(index, x, y, mech) {
    const textureKey = index === 0 ? 'playerMech' : `playerMech${index}`;
    const player = makePlayer({ id: index, mech, x, y, textureKey });
    // #404: EVERY player is accent-tinted now, player 1 and single-player included — the rim
    // tint over every segment and the head is simply what a player mech looks like.
    // #435: a PLAYER mech bakes the fine-grained walk cycle (PLAYER_HULL_FRAMES) — it's the only
    // mech that actually cycles its hull frames, so it's the only one that pays for them.
    // #404: the whole player look — accent, powerup status spot, walk-frame count — comes from
    // the one shared definition (art/playerMechLook.js), the same one the garage preview uses.
    buildMechTextures(this, textureKey, mech, playerMechArt(index));
    player.view = this._makeMechView(textureKey, x, y, player.angle, true);
    // Created hidden: `_updatePlayerMarkers` owns visibility every frame, and starting hidden
    // means a solo player never sees a one-frame flash of a ring before that rule first runs.
    player.marker = this.add.circle(x, y, MARKER_RADIUS)
      .setStrokeStyle(2, player.color, 0.55)
      .setDepth(DEPTH.GROUND_FX)
      .setVisible(false);
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
    // START on any UNCLAIMED pad is the join button (#387: up to four players). One PadEdges per
    // joiner pad — indices 1..MAX_PLAYERS-1 — keyed by pad index. The scene's existing `padEdges`
    // watches pad 0 (player 1's debug/exit buttons) and must stay that way, so pad 0 is not here.
    this._joinEdges = {};
    for (let pad = 1; pad < MAX_PLAYERS; pad++) this._joinEdges[pad] = new PadEdges(this, pad);
    // #394: one shared world-space layer for every downed player's respawn countdown ring, redrawn
    // each frame by `_updateRespawnMarkers`. WORLD_UI (6) so the beacon sits legibly over the death
    // FX at the wreck, the same tier the objective/powerup beacons use. The per-player seconds
    // readouts are pooled text objects created lazily as slots are needed.
    this._respawnGfx = this.add.graphics().setDepth(DEPTH.WORLD_UI);
    this._respawnTexts = [];
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

  // Per-frame: has another controller asked to join? Press START on an unclaimed gamepad.
  //
  // #349 keeps this path alive alongside the garage flow (Jackson: "keep both") — the garage is
  // the normal way in, this is late drop-in for someone who wanders over mid-run. What changed
  // is WHICH mech they get: their own saved build if it is usable, falling back to phase 2's
  // copy-of-player-1 only if it is not (see `_mechForPlayer`).
  //
  // #387: watch EVERY not-yet-claimed pad, not just pad 1. Players claim pads 0..count-1, so the
  // unclaimed pads are indices count..MAX_PLAYERS-1. `_addPlayer` assigns the joiner index =
  // current count and binds it to pad = that index, so drop-ins line up pad-for-slot as they join
  // in order (pad 2 → player 3 → mech3, pad 3 → player 4 → mech4).
  _updateCoopJoin() {
    if (!this._joinEdges) return;
    if (playersOf(this).length >= MAX_PLAYERS) return;
    for (let pad = playersOf(this).length; pad < MAX_PLAYERS; pad++) {
      if (this._joinEdges[pad]?.pressed(PAD.START)) { this._addPlayer(); return; }
    }
  },

  _addPlayer() {
    const index = playersOf(this).length;
    const host = primaryPlayerOf(this);
    // A fresh, fully-healthy mech for this player, built from whichever saved garage slot is
    // theirs. Going through the registry's allMechs keeps it data-driven — #349 changed only
    // the SOURCE of the build, not this wiring.
    const mech = this._mechForPlayer(index);
    // Drop in alongside player 1, just far enough not to overlap, and well inside the leash.
    // #348: that fixed +70/+70 offset is the same class of bug as the respawn one — in #340's
    // narrow corridor a host hugging the lane edge would put the joiner straight into impassable
    // terrain. Snap it to reachable ground (host's own position is passable by construction, so
    // the search terminates immediately in the normal case).
    const spot = this._validPlayerPos({ x: host.x + 70, y: host.y + 70 });
    const player = this._makePlayerAt(index, spot.x, spot.y, mech);
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
    return separatePlayers(live, { canMove: this._canMoveTo() });
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
    // #348: the clamp is clipped through the SAME swept wall/terrain test the player's own
    // locomotion and the teammate shove use, so the leash can never drag a mech through a
    // corridor boundary or a base wall. Terrain wins over the leash when they conflict — a
    // player may stay briefly outside the radius, which the centroid framing below tolerates.
    if (live.length > 1) clampToLeash(live, focus, LEASH_RADIUS, { canMove: this._canMoveTo() });
    // Re-derive the focus from the clamped positions so the anchor sits on where they actually
    // are rather than where they were about to be.
    const framed = leashFocus(players, (p) => !p.dead) ?? focus;
    this._camAnchor?.setPosition(framed.x, framed.y);
  },

  // Keep each player's ground marker pinned under its mech, and hide it with the mech on death.
  //
  // A SOLO player gets no ring at all (#348 playtest) — a colour that identifies you from nobody
  // is just clutter. `showsPlayerColor` is the same rule the reticle tint already used. Deciding
  // it here, per frame, rather than at construction time is what makes a mid-sortie START join
  // work in both directions: the rings switch on for both players the moment player 2 exists.
  _updatePlayerMarkers() {
    const players = playersOf(this);
    const colored = showsPlayerColor(players.length);
    for (const p of players) {
      if (!p.marker) continue;
      p.marker.setPosition(p.x, p.y);
      p.marker.setVisible(colored && !p.dead);
    }
  },

  // #400/#404: keep every player's center-torso STATUS SPOT current. It shows the active-powerup
  // colours — sectioned when several, black when none — in SOLO AND CO-OP alike (#404: it used to
  // be hijacked for player identity in co-op). The turret raster is the same 9-texture cost as a damage reskin, so only
  // rebuild (through `_reskinPlayer`) when the resolved colour list actually changes — a cached
  // key, exactly like combat.js gates its own reskin. Separate from `_updatePlayerMarkers` so the
  // cheap per-frame ring update never drags in a texture rebuild.
  _updateStatusSpots() {
    for (const p of playersOf(this)) {
      if (p._statusSpotKey !== statusSpotColorsFor(this, p).join(',')) this._reskinPlayer(p);
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

  // #394: draw each downed player's respawn countdown at their wreck, so both players can see how
  // long until that teammate is back. A draining ring (12 o'clock, clockwise) in the powerup
  // cooldown-pie idiom, tinted the downed player's own colour, with the remaining seconds inside.
  //
  // When the clock has run out but the out-of-combat gate is HOLDING placement (the survivor is
  // still under fire), the readout says HOLD over a full, gently pulsing ring rather than showing a
  // stuck "0s" — the pause is the design, so it should read as "waiting on the fight", not a bug.
  //
  // Shares the arena update loop's early-out contract with `_updateRespawns`: outside co-op no
  // player is ever `dead` with a live respawn clock, so the loop simply draws nothing.
  _updateRespawnMarkers() {
    const g = this._respawnGfx;
    if (!g) return;
    g.clear();
    const texts = this._respawnTexts;
    let slot = 0;
    for (const p of playersOf(this)) {
      if (!p.dead) continue;
      const readout = respawnReadout(p.respawn);
      if (!readout) continue;
      const phase = ((this.time?.now ?? 0) % RESPAWN_PHASE_MS) / RESPAWN_PHASE_MS;
      const L = respawnMarkerLayout(readout, phase);
      const color = p.color ?? 0xffffff;
      const cx = p.x, cy = p.y;
      // Held on the combat gate: the brackets sit at their tightest and BREATHE, so a paused clock
      // reads as "waiting on the fight" rather than as a frozen widget.
      const breathe = L.holding ? 0.55 + 0.45 * Math.sin(this.time.now / 220) : 1;

      // The four closing corner brackets. They are the countdown: wide at the moment of death,
      // tight around the landing spot as the clock runs out.
      // #421: every stroke of this marker is drawn TWICE — a wider near-black pass first, then
      // the player's colour on top. The identifying colour is what makes the cue readable at a
      // glance, and on snow/sand a saturated line over bright ground is exactly what washes out;
      // the dark backing gives it an edge on any biome without changing the colour itself.
      const backed = (width, alpha, path) => {
        g.lineStyle(width + MARKER_EDGE_W * 2, MARKER_EDGE, alpha * 0.65);
        path();
        g.lineStyle(width, color, alpha);
        path();
      };
      for (const corner of L.corners) {
        for (const arm of corner.arms) {
          backed(3, 0.95 * breathe, () => {
            g.beginPath();
            g.moveTo(cx + arm.x1, cy + arm.y1);
            g.lineTo(cx + arm.x2, cy + arm.y2);
            g.strokePath();
          });
        }
      }
      // The beacon column standing out of the wreck, with a chevron sliding down it — the piece
      // that gets the cue OFF the ground plane, which is what made the old ring read as a decal.
      backed(2, 0.45 * breathe, () => {
        g.beginPath();
        g.moveTo(cx + L.beam.x, cy + L.beam.y1);
        g.lineTo(cx + L.beam.x, cy + L.beam.y2);
        g.strokePath();
      });
      const w = RESPAWN_CHEVRON;
      backed(3, 0.95 * breathe, () => {
        g.beginPath();
        g.moveTo(cx - w, cy + L.chevronY - w);
        g.lineTo(cx, cy + L.chevronY);
        g.lineTo(cx + w, cy + L.chevronY - w);
        g.strokePath();
      });

      // The number, above the bracket square rather than inside a ring: whole seconds while
      // counting, HOLD while gated.
      let t = texts[slot];
      if (!t) {
        t = this.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '15px', fontStyle: 'bold' })
          .setStroke('#0b0e14', 4)   // #421: same dark backing as the brackets, for light biomes
          .setOrigin(0.5, 1).setDepth(DEPTH.WORLD_UI);
        texts[slot] = t;
      }
      t.setText(readout.holding ? 'HOLD' : `${Math.ceil(readout.seconds)}`)
        .setColor('#' + color.toString(16).padStart(6, '0'))
        .setPosition(cx, cy + L.textY)
        .setVisible(true);
      slot++;
    }
    for (let i = slot; i < texts.length; i++) texts[i].setVisible(false);
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
    // #348: constrain the choice to ground the player can actually stand on. The predicate is the
    // same passability test every other placement in the game uses, and the winner is then snapped
    // through `nearestValidPixel` so the result is guaranteed passable even in the degenerate case
    // where no candidate (nor the view centre) was valid. That search is bounded by
    // `MAX_SEARCH_STEPS` — a FIXED cap, deliberately not derived from the world size (#345).
    const pt = this._validPlayerPos(pickRespawnPoint(view, threats, {
      isValid: (x, y) => this._isPassablePos(x, y),
    }));
    player.mech.repairAll();
    player.mech.tickShield?.(0);
    player.x = pt.x; player.y = pt.y;
    player.vx = 0; player.vy = 0; player.speed = 0;
    player.dead = false;
    this._statRespawn?.(player);   // #423
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

  // Re-raster one player's mech textures, preserving its identifying accent AND its current
  // center-torso status spot (#400/#404). Every call site that reskins a player must go through
  // here or a respawned/repaired player 2 would silently revert to player 1's colours (or drop
  // its status spot back to the default reactor purple). Caches the key `_updatePlayerMarkers`
  // compares against so the per-frame sync doesn't redundantly rebuild right after.
  _reskinPlayer(player) {
    const statusSpot = statusSpotColorsFor(this, player);
    player._statusSpotKey = statusSpot.join(',');
    buildMechTextures(this, player.textureKey ?? 'playerMech', player.mech,
      playerMechArt(player.id, { statusSpot }));
  },

  // The world-space distance from the camera focus at which a player is hard-stopped, published
  // so the HUD could show it later. Read by nothing today; kept as the single named dial.
  get leashRadius() { return LEASH_RADIUS; },
};
