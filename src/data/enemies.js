// Enemy mech definitions — data, not code (mirrors WEAPONS / CHASSIS). The arena builds a
// fresh Mech from one of these configs on spawn, so the scene layer never hardcodes an
// enemy's chassis or weapons. **Add an enemy = one entry here.**
export const ENEMIES = {
  raider: {
    chassisId: 'light',
    name: 'Raider',
    mounts: { rightArm: ['autocannon'], leftTorso: ['clusterRocket'] },
  },
};
