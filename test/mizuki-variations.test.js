import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { officialMizukiStageOptions } from '../server/modes/mizuki/official-stages.js';
import { normalizeMizukiDungeon, createMizukiExplorationState, mizukiExplorationView } from '../server/modes/mizuki/exploration.js';
import { MIZUKI_VARIATION_IDS, MIZUKI_VARIATION_POLICY, mizukiVariationForZone, mizukiVariationSpec } from '../server/modes/mizuki/Variations.js';
import { generateMizukiDungeon } from '../server/modes/mizuki/RouteGeneration.js';

const catalog = createMizukiCatalog(getData({ log: { info() {}, warn() {}, error() {} } }));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

function combat(variation) {
  const players = [{ playerId: 'p0', units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] }];
  const instance = new MizukiCombat({ fieldId: 'mizuki-variation-test', seed: 42, stageId: 'act1autochess_m02',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, data: catalog.source, players,
    flags: { dpInit: 999, dpMax: 999 }, spawns: [], variation });
  return { instance, battle: instance.battle, unit: instance.battle.getPlayer('p0').units[0], players };
}

test('all eight original variation definitions resolve to executable effects', () => {
  assert.equal(MIZUKI_VARIATION_IDS.length, 8);
  assert.deepEqual(MIZUKI_VARIATION_IDS.map(id => mizukiVariationSpec(id).id), MIZUKI_VARIATION_IDS);
  assert.equal(mizukiVariationSpec('rogue_2_variation_5').effects.recruitTicketChance, 0.3);
  assert.equal(mizukiVariationSpec('rogue_2_variation_8').effects.revealOnlyNext, true);
  assert.match(MIZUKI_VARIATION_POLICY.selection, /equal-weight/);
});

test('generated regions deterministically receive a variation and the exploration variation adds two nodes of depth', () => {
  const seed = Array.from({ length: 5000 }, (_, index) => index + 1)
    .find(value => mizukiVariationForZone(value, 'zone_1') === 'rogue_2_variation_1');
  assert.ok(seed);
  assert.equal(mizukiVariationForZone(seed, 'zone_1'), mizukiVariationForZone(seed, 'zone_1'));
  const dungeon = generateMizukiDungeon({ seed, stageOptions: officialMizukiStageOptions() });
  const zone = dungeon.zones.zone_1;
  assert.equal(zone.variation, 'rogue_2_variation_1');
  assert.equal(Math.max(...zone.nodes.map(node => node.pos.x)), 6);
  assert.equal(zone.nodes.filter(node => node.pos.x === 6).length, 1);
});

test('generated ordinary regions always contain complete reachable node columns across route seeds', () => {
  const terminal = { zone_1: 'BATTLE_SHOP', zone_2: 'WISH', zone_3: 'BATTLE_BOSS', zone_4: 'WISH', zone_5: 'BATTLE_BOSS' };
  for (let seed = 1; seed <= 128; seed++) {
    const { zones } = generateMizukiDungeon({ seed, stageOptions: officialMizukiStageOptions() });
    for (const [zoneId, lastType] of Object.entries(terminal)) {
      const zone = zones[zoneId], nodes = zone.nodes;
      assert.ok(nodes.length > 0, `${zoneId} must not collapse to an empty route at seed ${seed}`);
      const byPosition = new Map(nodes.map(node => [`${node.pos.x}:${node.pos.y}`, node]));
      const maxDepth = Math.max(...nodes.map(node => node.pos.x));
      assert.ok(nodes.some(node => node.pos.x === 0), `${zoneId} has an entry column`);
      assert.ok(nodes.filter(node => node.pos.x === maxDepth).every(node => node.type === lastType), `${zoneId} keeps its terminal node type`);
      assert.ok(nodes.every(node => node.next.every(next => next.x === node.pos.x + 1 && byPosition.has(`${next.x}:${next.y}`))),
        `${zoneId} edges point to nodes in the next column`);
      const reached = new Set(nodes.filter(node => node.pos.x === 0).map(node => `${node.pos.x}:${node.pos.y}`));
      for (let depth = 0; depth < maxDepth; depth++) for (const node of nodes.filter(node => node.pos.x === depth && reached.has(`${depth}:${node.pos.y}`)))
        for (const next of node.next) reached.add(`${next.x}:${next.y}`);
      assert.equal(reached.size, nodes.length, `${zoneId} has no disconnected nodes at seed ${seed}`);
    }
  }
});

test('native zone variations survive import and hide every node outside the next choices', () => {
  const payload = { zones: [{ id: 'zone_1', variation: 'rogue_2_variation_8', nodes: [
    { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [{ x: 1, y: 0 }] },
    { pos: { x: 1, y: 0 }, type: 'REST', next: [{ x: 2, y: 0 }] },
    { pos: { x: 2, y: 0 }, type: 'BATTLE_ELITE', stage: 'ro2_e_1_1', next: [] },
  ] }] };
  const imported = normalizeMizukiDungeon(payload);
  assert.equal(imported.dungeon.zones['0'].variation, 'rogue_2_variation_8');
  const state = createMizukiExplorationState(payload);
  const stages = officialMizukiStageOptions();
  const initial = mizukiExplorationView(state, stages);
  assert.equal(initial.nodes.find(node => node.id === 'mzgraph:0:0:0').type, 'BATTLE_NORMAL');
  assert.equal(initial.nodes.find(node => node.id === 'mzgraph:0:1:0').type, 'UNKNOWN');
  const next = { ...state, cursor: 'mzgraph:0:0:0', trace: ['mzgraph:0:0:0'] };
  const view = mizukiExplorationView(next, stages);
  assert.equal(view.nodes.find(node => node.id === 'mzgraph:0:1:0').type, 'REST');
  assert.equal(view.nodes.find(node => node.id === 'mzgraph:0:2:0').type, 'UNKNOWN');
  assert.throws(() => normalizeMizukiDungeon({ zones: [{ id: 'zone_1', variation: 'invented', nodes: payload.zones[0].nodes }] }), /variation/);
});

test('combat variations change attack speed, healing, enemy RES, and enemy DEF on live units', () => {
  const fight = combat('rogue_2_variation_2');
  const { battle, unit } = fight;
  let deployable = null;
  for (let row = battle.grid.rect.r0; row <= battle.grid.rect.r1 && !deployable; row++)
    for (let col = battle.grid.rect.c0; col <= battle.grid.rect.c1; col++) if (battle.grid.canStand(row, col, { ranged: false })
      && !battle.grid.isObstacle(row, col)) { deployable = { row, col }; break; }
  assert.ok(deployable);
  assert.equal(fight.instance.command('p0', { type: 'deploy', uid: 101, row: deployable.row, col: deployable.col, dir: 'RIGHT' }).ok, true);
  close(unit.s.aspd, unit.base.aspd + 50);
  unit.hp = unit.s.maxHp - 100;
  close(battle.heal(null, unit, 100), 30);
  const enemy = battle.spawnEnemy('enemy_1007_slime');
  assert.ok(enemy);
  const enemyBaseline = combat(null).battle.spawnEnemy('enemy_1007_slime');
  assert.ok(enemyBaseline);
  close(enemy.s.aspd, enemyBaseline.s.aspd + 50);
  const boss = battle.spawnEnemy('enemy_1007_slime', { tag: 'boss' });
  const bossBaseline = combat(null).battle.spawnEnemy('enemy_1007_slime', { tag: 'boss' });
  close(boss.s.aspd, bossBaseline.s.aspd);
  const rankedBoss = battle.spawnEnemy('variation-test-boss', { def: { ...enemy.def, key: 'variation-test-boss', rank: 'BOSS' } });
  close(rankedBoss.s.aspd, enemyBaseline.s.aspd);
  const woundedEnemy = enemy.hp = enemy.s.maxHp - 100;
  close(battle.heal(null, enemy, 100), Math.min(100, enemy.s.maxHp - woundedEnemy));

  const resistance = combat('rogue_2_variation_5').battle.spawnEnemy('enemy_1007_slime');
  assert.ok(resistance);
  close(resistance.s.res, enemyBaseline.s.res + 15);

  const reinforced = combat('rogue_2_variation_6');
  const tough = reinforced.battle.spawnEnemy('enemy_1007_slime');
  assert.ok(tough);
  close(tough.s.def, enemyBaseline.s.def * 1.5);
});
