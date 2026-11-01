// Tile rewrites serialized on original token modes. Keep this adapter local to
// Mizuki: a hidden/random predefined rewrites a tile only after real activation.
import { COLS } from '../../sim/constants.js';
export function installOfficialFacilityTiles(battle) {
  const states = new Map();
  const builds = ['NONE', 'MELEE', 'RANGED', 'ALL'];
  const passes = ['NONE', 'WALK_ONLY', 'FLY_ONLY', 'ALL'];
  function update(row, col, tile) {
    const grid = battle.grid, k = row * COLS + col;
    grid.tiles[k] = tile;
    grid.unblockable[k] = tile.pass === 'ALL' && !grid.blockable(row, col) ? 1 : 0;
    grid.deepWater[k] = tile.pass === 'ALL' && tile.terrain === 'deepsea' ? 1 : 0;
    grid.version++;
    grid._fields.clear();
  }
  return {
    apply(unit, def, modeIndex = 0) {
      const mode = def.raw.originalTileModes?.[modeIndex];
      if (!unit || !mode || states.has(unit.id)) return;
      const row = unit.tileR, col = unit.tileC, previous = battle.grid.tile(row, col);
      const options = mode.options;
      const buildable = builds[options.buildableType], passable = passes[options.passableMask];
      if (!buildable || !passable) throw new RangeError('Unknown original facility tile mode: ' + def.key);
      // Original obstacle-like terrain is traversable at crate cost despite
      // its raw NONE pass mask; the existing device installs that crate bit.
      const pass = options.overrideObstacleLikeMoveCost ? 'ALL'
        : passable === 'ALL' || passable === 'WALK_ONLY' ? 'ALL' : passable === 'FLY_ONLY' ? 'FLY' : 'NONE';
      const tile = Object.freeze({ ...previous, build: buildable, pass,
        ...(mode.rewriteHeightType ? { height: options.heightType ? 'HIGH' : 'LOW' } : {}) });
      update(row, col, tile);
      const state = { unitId: unit.id, row, col, active: true, buildable, passable,
        obstacleLike: !!options.overrideObstacleLikeMoveCost,
        ...(mode.rewriteHeightType ? { height: tile.height } : {}),
        ...(mode.rewriteHeight ? { originalFacilityHeight: mode.height } : {}) };
      states.set(unit.id, state);
      battle.on('death', ({ unit: dead }) => {
        if (dead !== unit || !state.active) return;
        state.active = false;
        if (battle.grid.tile(row, col) === tile) update(row, col, previous);
      });
    },
    snapshot: () => [...states.values()].map((v) => ({ ...v })),
  };
}
