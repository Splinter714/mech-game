// #440 — column descriptors + sort comparator for the interactive stats tables (pure, no Phaser).
//
// Each descriptor names the reduced-report field it reads (`key`), a short header `label`, a
// formatter tag (`fmt`) the overlay maps to a display string, an `align` hint, and a one-line
// `def` shown as a hover tooltip. Keeping this here (not in the Phaser overlay) means the column
// set and the sort math are unit-testable.
//
//   fmt tags: 'str' name | 'int' integer | 'num' 1dp | 'pct' 0-1 → % | 'secs' ms → Ns

export const WEAPON_COLUMNS = [
  { key: 'name', label: 'Weapon', fmt: 'str', align: 'left',
    def: 'Weapon — the mounted weapon.' },
  { key: 'shotsFired', label: 'Shots', fmt: 'int',
    def: 'Shots Fired — trigger pulls this run.' },
  { key: 'hits', label: 'Hits', fmt: 'int',
    def: 'Hits — pulls that connected with a target.' },
  { key: 'accuracy', label: 'Acc', fmt: 'pct',
    def: 'Accuracy — hits ÷ shots fired.' },
  { key: 'damageDealt', label: 'Dmg', fmt: 'num',
    def: 'Damage Dealt — total damage this weapon applied.' },
  { key: 'overkill', label: 'Overkill', fmt: 'num',
    def: 'Overkill — damage dealt beyond what was needed to kill.' },
  { key: 'firingTimeMs', label: 'Firing', fmt: 'secs',
    def: 'Time Firing — seconds the weapon was actively cycling (reloads excluded).' },
  { key: 'reloads', label: 'Reloads', fmt: 'int',
    def: 'Reloads — number of reloads this run.' },
  { key: 'reloadTimeMs', label: 'Reloading', fmt: 'secs',
    def: 'Time Reloading — seconds spent reloading.' },
  { key: 'effectiveBurstDps', label: 'DPS burst', fmt: 'num',
    def: 'Real DPS (Burst) — measured damage over firing time only.' },
  { key: 'effectiveSustainedDps', label: 'DPS sust', fmt: 'num',
    def: 'Real DPS (Sustained) — measured damage over firing + reload time.' },
  { key: 'effectiveCombatDps', label: 'DPS combat', fmt: 'num',
    def: 'Real DPS (In Combat) — measured damage over total time spent in combat.' },
  { key: 'theoreticalBurstDps', label: 'Max burst', fmt: 'num',
    def: 'Max DPS (Burst) — stat-sheet burst DPS assuming every shot lands.' },
  { key: 'theoreticalSustainedDps', label: 'Max sust', fmt: 'num',
    def: 'Max DPS (Sustained) — stat-sheet sustained DPS assuming every shot lands.' },
  { key: 'landingRatio', label: 'Landing', fmt: 'pct',
    def: 'Landing % — sustained DPS you actually landed as a fraction of the gun’s theoretical max.' },
];

export const ENEMY_COLUMNS = [
  { key: 'displayName', label: 'Enemy', fmt: 'str', align: 'left',
    def: 'Enemy — the enemy kind (brood-spawned units fold under their base kind).' },
  { key: 'spawned', label: 'Seen', fmt: 'int',
    def: 'Seen — units of this kind that entered the run.' },
  { key: 'killed', label: 'Killed', fmt: 'int',
    def: 'Killed — units of this kind you destroyed.' },
  { key: 'avgTtkMs', label: 'TTK', fmt: 'secs',
    def: 'TTK — average time from the first hit on a unit to its death.' },
  { key: 'effectiveHp', label: 'Eff HP', fmt: 'num',
    def: 'Effective HP — average damage needed to kill one unit.' },
  { key: 'realHp', label: 'Real HP', fmt: 'num',
    def: 'Real HP — the unit’s designed total durability (structure + armor + shield); compare against Eff HP to see wasted/overkilled damage.' },
  { key: 'weaponAccuracy', label: 'Their acc', fmt: 'pct',
    def: 'Their Accuracy — fraction of this kind’s shots that hit you.' },
  { key: 'effectiveDps', label: 'Their DPS', fmt: 'num',
    def: 'Their DPS — damage this kind dealt you per second of engagement.' },
  { key: 'damageToYou', label: 'Dmg→you', fmt: 'num',
    def: 'Damage to You — total damage this kind dealt you.' },
  { key: 'threatShare', label: 'Threat', fmt: 'pct',
    def: 'Threat Share — % of all damage you took that came from this kind.' },
  { key: 'threatPerUnit', label: 'Threat/unit', fmt: 'pct',
    def: 'Threat/unit — each kind’s per-unit danger (damage per unit) as a share of all kinds combined; sums to 100%.' },
  { key: 'damageToKind', label: 'Your dmg', fmt: 'num',
    def: 'Your Damage to Them — total damage you dealt this kind.' },
  { key: 'overkill', label: 'Overkill', fmt: 'num',
    def: 'Overkill — your damage to this kind beyond what was needed to kill.' },
];

// Sort comparator over reduced-entry rows. `dir` is +1 asc / -1 desc. String columns compare by
// locale; numeric columns numerically, with non-finite/missing values sinking to the bottom.
export function compareRows(a, b, col, dir = 1) {
  const d = dir < 0 ? -1 : 1;
  if (!col) return 0;
  if (col.fmt === 'str') {
    const va = String(a?.[col.key] ?? '');
    const vb = String(b?.[col.key] ?? '');
    return d * va.localeCompare(vb);
  }
  const va = Number(a?.[col.key]);
  const vb = Number(b?.[col.key]);
  const fa = Number.isFinite(va);
  const fb = Number.isFinite(vb);
  // Missing / non-finite values always sink to the BOTTOM, regardless of sort direction.
  if (!fa && !fb) return 0;
  if (!fa) return 1;
  if (!fb) return -1;
  if (va === vb) return 0;
  return d * (va < vb ? -1 : 1);
}

// The sort direction a header defaults to on its FIRST click: names read best A→Z (asc), numbers
// most-interesting-first (desc).
export function defaultDir(col) {
  return col && col.fmt === 'str' ? 1 : -1;
}
