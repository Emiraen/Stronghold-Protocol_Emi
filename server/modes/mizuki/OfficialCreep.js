// RO2 CreepTile + trap_061_creep. Values come from the extracted client prefabs
// and sktok_creep; this module never changes the shared terrain implementation.
import { COLS } from '../../sim/constants.js';
import { roundHalfEven } from '../../sim/detmath.js';

const MARKER = 'buff_creep[tile]';
const FOUR_WAYS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const PROTECT_TIME = 10;
const board = (entries) => Object.fromEntries((entries || []).map((v) => [v.key, v.valueStr || v.value]));
const alive = (u) => u.alive && u.deployed && !u.hidden;
const ground = (u) => !u.isFlying && !u.s.flags.airborne;
const position = (u) => [roundHalfEven(u.y), roundHalfEven(u.x)];

export function installOfficialCreep(battle, level) {
  const tiles = new Map(), controllers = new Map(), exposed = new Map();
  const rows = level.mapData?.map || [];
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
    const raw = level.mapData.tiles[rows[rows.length - 1 - r][c]];
    if (!['tile_creep', 'tile_creepf'].includes(raw?.tileKey)) continue;
    tiles.set(r * COLS + c, { row: r, col: c, active: board(raw.blackboard).mode === 1,
      since: battle.time, source: 'original_tile' });
  }
  const tileAt = (r, c) => Number.isInteger(r) && Number.isInteger(c) ? tiles.get(r * COLS + c) : null;
  const isActive = (r, c) => !!tileAt(r, c)?.active;
  const onCreep = (u) => ground(u) && isActive(...position(u));
  function activate(r, c, { source = 'enemy' } = {}) {
    const tile = tileAt(r, c);
    if (!tile || tile.active) return false;
    Object.assign(tile, { active: true, since: battle.time, source });
    battle.fx('mizuki:creep', { row: r, col: c, active: true });
    return true;
  }
  function deactivate(r, c) {
    const tile = tileAt(r, c);
    if (!tile?.active) return false;
    tile.active = false;
    battle.fx('mizuki:creep', { row: r, col: c, active: false });
    return true;
  }
  function pulse() {
    const destinations = new Set();
    // Validate all sources before changing any destination. A new tile cannot
    // propagate recursively during the same cast of the original skill.
    for (const tile of tiles.values()) {
      if (!tile.active || battle.time + 1e-9 < tile.since + PROTECT_TIME) continue;
      // EntityCategory DEFAULT | OBSTACLE, allies, all motions. The blocker is
      // on the SOURCE tile; deployment on a clean destination does not reject it.
      if (battle.allyUnits.some((u) => alive(u) && (u.kind !== 'device' || u.obstacle)
        && position(u)[0] === tile.row && position(u)[1] === tile.col)) continue;
      for (const [dr, dc] of FOUR_WAYS) {
        const target = tileAt(tile.row + dr, tile.col + dc);
        if (target && !target.active) destinations.add(target);
      }
    }
    for (const tile of destinations) activate(tile.row, tile.col, { source: 'sktok_creep' });
    return destinations.size;
  }
  function bindController(unit, definition) {
    controllers.set(unit.id, { unit, bb: definition.bb });
  }
  battle.on('elementHit', ({ target, dmg }) => {
    if (target?.side !== 'enemy' || !onCreep(target)) return;
    const active = [...controllers.values()].find(({ unit }) => alive(unit));
    if (active) dmg.mul = (dmg.mul ?? 1) * active.bb.ep_damage_scale;
  });
  battle.on('tick', ({ dt }) => {
    const controller = [...controllers.values()].find(({ unit }) => alive(unit));
    for (const unit of battle.units) {
      const affected = alive(unit) && unit.kind !== 'device' && onCreep(unit);
      if (affected) battle.addBuff(unit, { key: MARKER, duration: dt * 2, refresh: 'replace' });
      else if (unit.findBuff(MARKER)) battle.removeBuff(unit, MARKER);
      if (!affected || unit.side !== 'ally' || !controller) { exposed.delete(unit.id); continue; }
      const elapsed = (exposed.get(unit.id) || 0) + dt;
      if (elapsed + 1e-9 < 1) { exposed.set(unit.id, elapsed); continue; }
      exposed.set(unit.id, elapsed - 1);
      const bb = controller.bb;
      battle.dealDamage(null, unit, { type: 'arts', amount: bb.damage, noSp: true,
        sourceless: true, canDodge: false, tags: ['dot', 'periodic', 'mizuki:creep'] });
      if (bb.element_damage > 0) battle.dealDamage(null, unit, { type: 'element', element: 'neural',
        amount: bb.element_damage, sourceless: true, canDodge: false, tags: ['mizuki:creep'] });
    }
  });
  const api = { isActive, activate, deactivate, pulse, bindController,
    snapshot: () => ({ tiles: [...tiles.values()].map((tile) => ({ ...tile })),
      controllers: [...controllers.values()].map(({ unit }) => unit.id) }) };
  battle._mizukiCreep = api;
  return api;
}
