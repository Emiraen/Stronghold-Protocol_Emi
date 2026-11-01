import { readFileSync } from 'node:fs';

const SOURCE = JSON.parse(readFileSync(new URL('../../../data/mizuki/battle-dice.json', import.meta.url), 'utf8'));
const DICE = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8')).modules.dice.dice;
const board = entries => Object.fromEntries((entries || []).map(entry => [entry.key, entry.valueStr ?? entry.value]));
const specs = new Map(Object.values(SOURCE.dice).map(value => {
  const skill = value.skill.levels[0];
  return [value.itemId, { ...value, position: 'ALL', battleDice: true, name: value.raw.name, stats: value.raw.phases[0].attributesKeyFrames[0].data,
    skill, bb: board(skill.blackboard), talents: {}, grid: [[0, 0]] }];
}));

export const mizukiBattleDiceSpec = id => specs.get(DICE[id]?.battleDiceId || id) || null;

export function mizukiBattleDiceResult(spec, roll) {
  if (!spec || !Number.isInteger(roll) || roll < 1 || roll > spec.faces) return null;
  const tier = spec.thresholds.findIndex(max => roll <= max), key = 'dice_interval[' + tier + '].';
  return { roll, faces: spec.faces, tier, duration: spec.bb[key + 'duration'], aspd: spec.bb[key + 'attack_speed'],
    move: spec.bb[key + 'move_speed'], redeployScale: tier >= 3 ? 0 : tier >= 2 ? 0.5 : 1 };
}

export function applyMizukiBattleDice(battle, unit, spec, { roll } = {}) {
  const result = mizukiBattleDiceResult(spec, roll ?? 1 + Math.floor(battle.rng() * spec.faces));
  if (!result) throw new TypeError('Invalid native Mizuki battle die');
  const affected = new WeakSet(), expiresAt = battle.time + result.duration;
  const apply = enemy => {
    if (!unit.alive || !unit.deployed || battle.time >= expiresAt - 1e-9 || !enemy?.alive || !enemy.deployed || affected.has(enemy)) return;
    affected.add(enemy);
    battle.addBuff(enemy, { key: 'mizuki:dice:' + unit.id, duration: result.duration,
      mods: { aspd: result.aspd, moveMul: 1 + result.move } });
  };
  for (const enemy of battle.enemies) apply(enemy);
  const offSpawn = battle.on('enemySpawn', ({ enemy }) => apply(enemy));
  const offTick = battle.on('tick', () => {
    if (unit.alive && unit.deployed && battle.time < expiresAt - 1e-9) return;
    battle.off(offSpawn); battle.off(offTick);
    if (unit.alive) battle.retreat(unit, { reason: 'expired', permanent: true });
  });
  if (result.redeployScale < 1) for (const ally of battle.allyUnits) {
    if (ally.side !== 'ally' || ally.alive && ally.deployed) continue;
    for (const target of [ally, ally.mem]) for (const key of ['respawnAt', 'readyAt', 'deckReadyAt']) {
      if (target && Number.isFinite(target[key]) && target[key] > battle.time)
        target[key] = battle.time + (target[key] - battle.time) * result.redeployScale;
    }
  }
  unit.mem.mizukiBattleDice = { ...result, since: battle.time, expiresAt };
  battle.fx('mizuki:effect', { x: unit.x, y: unit.y, unitId: unit.id, key: 'rogue_active_01', duration: 2 });
  battle.fx('mizuki:dice-roll', { x: unit.x, y: unit.y, id: unit.id, tier: result.tier });
  return result;
}

export function snapshotMizukiBattleDiceEffects(battle) {
  return battle.allyUnits.flatMap(unit => {
    const dice = unit.mem?.mizukiBattleDice;
    if (!dice || !unit.alive || !unit.deployed || battle.time >= dice.expiresAt) return [];
    return ['rogue_trai_01', 'rogue_buff_0' + (dice.tier + 1)].map(key => ({
      id: 'mizuki:dice:' + unit.id + ':' + key, key, unitId: unit.id, x: unit.x, y: unit.y,
      since: dice.since, duration: dice.duration, loop: true, active: true,
    }));
  });
}
