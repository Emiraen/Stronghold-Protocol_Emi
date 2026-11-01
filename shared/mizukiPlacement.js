import { meleeOnHighGround } from './highGround.js';

// RO2 deployment uses the stage's buildable type. Ordinary Stronghold keeps
// its broader ranged-on-low-ground rule in Grid.canStand.
export function mizukiTerrainAllows(def, tile, buildableAll = false) {
  if (!def || !tile || tile.obstacle || ['start', 'end'].includes(tile.special)) return false;
  const build = tile.build;
  if (!['MELEE', 'RANGED', 'ALL'].includes(build)) return false;
  if (buildableAll || def.position === 'ALL' || meleeOnHighGround(def.raw || def)) return true;
  if (def.position === 'RANGED') return build === 'RANGED' || build === 'ALL';
  return build === 'MELEE' || build === 'ALL';
}
