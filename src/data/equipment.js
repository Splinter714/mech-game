// Non-weapon equipment. Intentionally empty for now: heat sinks, ammo bins, thrusters,
// and the old jammer were removed to keep the build screen simple while heat/ammo and
// movement gear aren't simulated yet. The exports stay so the item lookup, loadout
// validator, and Mech model keep treating "equipment" uniformly — add an entry here
// (with a real in-game effect) when one is actually needed.

export const EQUIPMENT = {};

export const EQUIPMENT_IDS = Object.keys(EQUIPMENT);

export function getEquipment(id) {
  return EQUIPMENT[id];
}
