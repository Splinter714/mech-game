// Central event-name constants. Scenes communicate through the global game event
// emitter and the registry; never use bare event strings (a typo silently no-ops).

export const MECH_DEPLOYED = 'mech-deployed';   // garage → arena: deploy this build
export const RETURN_TO_GARAGE = 'return-to-garage';
export const MECH_DAMAGED = 'mech-damaged';     // arena: a part took damage
export const PART_DESTROYED = 'part-destroyed';
export const MECH_DESTROYED = 'mech-destroyed';
export const HEAT_CHANGED = 'heat-changed';
export const LOADOUT_CHANGED = 'loadout-changed'; // garage: a mount/unmount happened
