// Non-weapon equipment. Like weapons, every item carries `slots` + `tonnage` so the
// loadout validator and the Mech model can treat weapons and equipment uniformly. The
// `type` tag tells the runtime what an item DOES (dissipate heat, hold ammo, boost
// mobility). Heat/ammo are wired as data now; their full simulation comes later.

export const EQUIPMENT = {
  heatSink: {
    id: 'heatSink', name: 'Heat Sink', type: 'heatSink',
    slots: 1, tonnage: 1, dissipation: 3, // heat removed per second
  },
  ammoBin: {
    id: 'ammoBin', name: 'Ammo Bin', type: 'ammo',
    slots: 1, tonnage: 1, // rounds held depend on the weapon's ammoPerTon
  },
  jumpJet: {
    id: 'jumpJet', name: 'Jump Jet', type: 'movement',
    slots: 1, tonnage: 1, thrust: 1,
  },
  ecm: {
    id: 'ecm', name: 'ECM Suite', type: 'support',
    slots: 1, tonnage: 1.5,
  },
};

export const EQUIPMENT_IDS = Object.keys(EQUIPMENT);

export function getEquipment(id) {
  return EQUIPMENT[id];
}
