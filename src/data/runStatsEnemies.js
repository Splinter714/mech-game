// #440 — brood/base pooling for the enemy tables (pure, no Phaser).
//
// A carrier-deployed unit (e.g. a Broodhauler's drones) is stat-tagged with a "Brood" suffix on
// its kind (see enemies.js `_spawnKind`'s statKind param, wired from enemyBehaviors.js
// `deployNearby`) so its damage can be told apart from its dock-spawned twin — #439 confirmed
// they're otherwise the EXACT SAME unit. Rather than show it as an opaque extra row, it folds back
// under its base kind as an indented "of which: brood-spawned" SUBSET line.
//
// #440 bug fix: the PARENT "Drone" row must be the COMBINED base+brood total in EVERY column, with
// all ratio/average columns RE-DERIVED FROM THE POOLED RAW COUNTERS (not shown base-only while the
// seen count folds brood in — which made the brood subset's damage exceed its own parent, an
// impossible "subset"). The "└ of which brood-spawned" line is then a genuine subset: <= parent in
// every column. `splitBroodSubsets` returns { base, brood } where base[kind] is the POOLED parent
// and brood[kind] is the brood-only subset.

export const BROOD_SUFFIX = 'Brood';

function div(a, b) { return b > 0 ? a / b : 0; }
const perSec = (dmg, ms) => div(dmg, ms / 1000);

// The additive raw counters an enemy entry carries (reduceRun/aggregateRuns keep these in the
// reduced shape). threatShare rides along too: it shares one run-global denominator (Σtaken), so
// pooling base+brood is exactly base.threatShare + brood.threatShare.
const RAW_KEYS = [
  'spawned', 'killed', 'damageToYou', 'damageToKind', 'overkill',
  'engagedMs', 'ttkSumMs', 'ttkCount', 'shotsFired', 'hits', 'threatShare',
];

function rawOf(e) {
  const r = {};
  for (const k of RAW_KEYS) r[k] = e?.[k] ?? 0;
  return r;
}

function addRaw(a, b) {
  const out = {};
  for (const k of RAW_KEYS) out[k] = a[k] + b[k];
  return out;
}

// Re-derive a full display entry (every ratio/average) from pooled raw counters.
function deriveEnemy(kind, r) {
  return {
    kind,
    spawned: r.spawned,
    killed: r.killed,
    avgTtkMs: div(r.ttkSumMs, r.ttkCount),
    weaponAccuracy: Math.min(1, div(r.hits, r.shotsFired)),
    effectiveDps: perSec(r.damageToYou, r.engagedMs),
    effectiveHp: div(r.damageToKind, r.killed),
    damageToYou: r.damageToYou,
    threatShare: r.threatShare,
    damageToKind: r.damageToKind,
    overkill: r.overkill,
    engagedMs: r.engagedMs,
    ttkSumMs: r.ttkSumMs,
    ttkCount: r.ttkCount,
    shotsFired: r.shotsFired,
    hits: r.hits,
  };
}

export function splitBroodSubsets(enemies) {
  const baseRaw = {};    // kind -> reduced base entry
  const broodRaw = {};   // baseKind -> reduced brood entry
  for (const [kind, e] of Object.entries(enemies ?? {})) {
    if (kind.endsWith(BROOD_SUFFIX) && kind.length > BROOD_SUFFIX.length) {
      broodRaw[kind.slice(0, -BROOD_SUFFIX.length)] = e;
    } else {
      baseRaw[kind] = e;
    }
  }
  const base = {};
  const brood = {};
  // Preserve first-seen order: base kinds in their original order, then any brood-only kinds.
  const kinds = [];
  for (const k of Object.keys(baseRaw)) kinds.push(k);
  for (const k of Object.keys(broodRaw)) if (!baseRaw[k]) kinds.push(k);
  for (const kind of kinds) {
    const be = baseRaw[kind];
    const bre = broodRaw[kind];
    if (be && bre) {
      // Pool base + brood into the parent; brood is a genuine subset (<= parent everywhere).
      base[kind] = deriveEnemy(kind, addRaw(rawOf(be), rawOf(bre)));
      brood[kind] = deriveEnemy(kind, rawOf(bre));
    } else if (be) {
      base[kind] = be;                            // no brood twin — leave the entry as-is
    } else {
      base[kind] = deriveEnemy(kind, rawOf(bre)); // only brood ever seen — promote, no subset
    }
  }
  return { base, brood };
}

export function displayName(kind) {
  return kind.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}
