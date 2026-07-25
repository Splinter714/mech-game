// #508: damaging hazard terrain (mud/quicksand/brokenIce/debris/cinderField) — the tick pass
// that turns `terrainHazardDps` (data/terrain.js) into real damage. Same indiscriminate,
// stand-in-it-and-it-hurts-you shape as burning ground (#319/#347, `_updateFirePatches` in
// projectiles.js) — this file is that pattern applied to STATIC terrain instead of a spreading
// napalm patch, so it reuses the same 500ms tick cadence and the same damage entry points
// (`_damagePlayerAt`/`_damageEnemyAt`) rather than inventing a new damage-application path.
import { livePlayersOf } from './players.js';
import { terrainHazardDps } from '../../data/terrain.js';

export const HazardTilesMixin = {
  _updateHazardTerrain() {
    const now = this.time.now;
    if (now < this._nextHazardTick) return;
    this._nextHazardTick = now + 500;

    for (const pl of livePlayersOf(this)) {
      const dps = terrainHazardDps(this._terrainAt(pl.x, pl.y));
      if (dps > 0) this._damagePlayerAt(Math.max(1, Math.round(dps * 0.5)), pl);
    }
    // #87: snapshot — a killing tick removes the enemy from `this.enemies` synchronously.
    for (const e of [...this.enemies]) {
      if (e.mech.isDestroyed()) continue;
      const dps = terrainHazardDps(this._terrainAt(e.x, e.y));
      if (dps > 0) this._damageEnemyAt(e, e.x, e.y, Math.max(1, Math.round(dps * 0.5)), 0x8a6d3b);
    }
  },
};
