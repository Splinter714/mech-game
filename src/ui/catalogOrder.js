// Pure catalog ordering (#78): given a canonical id list and an optional `isLocked(id)`
// predicate, return the ids reordered so every UNLOCKED item comes first (in its given
// canonical order) followed by every LOCKED item (also in canonical order among themselves).
// It's a stable partition — nothing is reordered beyond the locked/unlocked split — so
// unlocking an item promotes it back into its canonical slot among the unlocked. With no
// `isLocked` predicate (e.g. the Weapon Lab's fully-unlocked usage) the order is returned
// untouched (identity). No Phaser here so it can be unit-tested directly.
export function orderByLock(ids, isLocked) {
  if (typeof isLocked !== 'function') return [...ids];
  const unlocked = [];
  const locked = [];
  for (const id of ids) (isLocked(id) ? locked : unlocked).push(id);
  return [...unlocked, ...locked];
}
