// Non-weapon equipment = abilities. Each is an activated item that mounts in the ability
// slot (centre torso) and fires on that slot's button (L3 / Space) with a cooldown.
// `ability` names the effect the arena implements; `cooldown` is in seconds.
//
// (Target Lock was removed in #31: lock-on is now a default aim-assist mechanic and
// homing weapons track on their own, so it's no longer an equipped item.)

export const EQUIPMENT = {
  jumpJet: {
    id: 'jumpJet', name: 'Jump Jet', type: 'ability', ability: 'dash',
    cooldown: 2.2, impulse: 460,           // burst of speed in the move/aim direction
  },
  bubbleShield: {
    id: 'bubbleShield', name: 'Bubble Shield', type: 'ability', ability: 'shield',
    cooldown: 9, duration: 3,              // seconds of incoming-damage absorption
  },
};

export const EQUIPMENT_IDS = Object.keys(EQUIPMENT);

export function getEquipment(id) {
  return EQUIPMENT[id];
}
