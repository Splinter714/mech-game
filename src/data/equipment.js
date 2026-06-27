// Non-weapon equipment. Intentionally empty for now: heat sinks and ammo bins are gone
// (there's no heat system, and ammo lives on each weapon as a self-regenerating
// magazine), and thrusters/jammer were unimplemented. The exports stay so the item
// lookup, loadout validator, and Mech model keep treating "equipment" uniformly — add
// an entry here (with a real in-game effect) when one is actually needed.

export const EQUIPMENT = {};

export const EQUIPMENT_IDS = Object.keys(EQUIPMENT);

export function getEquipment(id) {
  return EQUIPMENT[id];
}
