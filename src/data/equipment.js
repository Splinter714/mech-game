// Non-weapon equipment = abilities. Each is an activated item that mounts in an ability
// slot (head / centre torso) and fires on that slot's button (R3 / L3) with a cooldown.
// `ability` names the effect the arena implements; `cooldown` is in seconds.

export const EQUIPMENT = {
  jumpJet: {
    id: 'jumpJet', name: 'Jump Jet', type: 'ability', ability: 'dash',
    cooldown: 2.2, impulse: 460,           // burst of speed in the move/aim direction
  },
  bubbleShield: {
    id: 'bubbleShield', name: 'Bubble Shield', type: 'ability', ability: 'shield',
    cooldown: 9, duration: 3,              // seconds of incoming-damage absorption
  },
  targetLock: {
    id: 'targetLock', name: 'Target Lock', type: 'ability', ability: 'lock',
    lockTime: 0.6, cone: 0.5, bonus: 1.3,  // held to acquire; locked missiles hit harder + track better
  },
};

export const EQUIPMENT_IDS = Object.keys(EQUIPMENT);

export function getEquipment(id) {
  return EQUIPMENT[id];
}
