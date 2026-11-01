import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { createMizukiExplorationState } from '../server/modes/mizuki/exploration.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';
import { mizukiCommanderProgress } from '../server/modes/mizuki/Difficulty.js';
import { mizukiVirtueSpec } from '../server/modes/mizuki/NativeBlessings.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const FRAME = 1000 / 30;
const FIXTURE_DUNGEON = { zones: [{ id: 'zone_1', nodes: [
  { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
] }] };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, a + ' != ' + b);
const command = (match, playerId, message) => {
  const result = match.handle(playerId, message); assert.equal(result.ok, true, JSON.stringify(result)); return result;
};
function fixture(t, { count = 1, grade = 0, dungeon } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [];
  const options = { scheduler, data: DATA, roomCode: 'MZDI', seed: 512, dungeon: dungeon || FIXTURE_DUNGEON,
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat })),
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) }, send() {}, broadcast() {}, onEnd() {} };
  const match = new MizukiMatch(options); t.after(() => { match.dispose(); scheduler.dispose(); }); match.start();
  command(match, 'p0', { t: 'g.mizuki.difficulty', grade });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_3' });
  for (const [index, player] of match.order.entries()) command(match, player.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[index].bandId });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match); assert.equal(match.phase, PHASE.ROUTE);
  return { match, scheduler, errors, options };
}
function prepare(match) {
  for (const player of match.order) assert.equal(match._addOperator(player, 'chess_char_1_02_a'), true);
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.route', nodeId: match.route.find((node) => node.stageId === 'ro2_n_1_1').id });
  command(match, 'p0', { t: 'g.mizuki.routeStart' });
  for (const player of match.order) {
    const field = match.fields.get(player.fieldId), grid = field.engine.battle.grid;
    const tile = field.engine.snapshot().geometry.tiles.find((value) => grid.canStand(value.row, value.col, { ranged: false }) && !grid.isObstacle(value.row, value.col));
    command(match, player.playerId, { t: 'g.mizuki.move', uid: player.roster[0].uid, to: { area: 'board', row: tile.row, col: tile.col }, dir: 'RIGHT' });
  }
}
function beginCombat(match) {
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.ready', on: true });
  assert.equal(match.phase, PHASE.COMBAT);
}
function grantVirtue(match, id) {
  match.floorState.enteredZones.push('fixture_floor');
  match.floorState.virtues = [{ id, zoneId: 'fixture_floor', used: false }];
}
function startRescue(match, scheduler) {
  const field = match.fields.get('n:p1'), b = field.engine.battle; b.start();
  const key = b._pending[0]?.enemyKey || field.engine.officialWaves.waves[0].fragments[0].actions.find((entry) => entry.action.key)?.action.key;
  const enemy = b.spawnEnemy(key, { route: field.setup.routes[0] }); assert.ok(enemy); b.leak(enemy);
  for (const normal of match.fields.values()) { normal.engine.battle.start(); normal.engine.battle.forceEnd('cleared'); }
  scheduler.advance(FRAME * 2);
  const rescue = [...match.fields.values()].find((value) => value.kind === 'unite'); assert.ok(rescue); return rescue;
}

test('production COMBAT and one-helper rescue both install original virtues and publish them in snapshots/results', (t) => {
  const { match, scheduler, errors } = fixture(t, { count: 2 }); grantVirtue(match, 'rogue_2_virtue_1'); prepare(match);
  const spec = mizukiVirtueSpec('rogue_2_virtue_1');
  const normal = match.fields.get('n:p0'), enemy = normal.engine.battle.spawnEnemy('enemy_1007_slime', { route: normal.setup.routes[0] });
  assert.equal(normal.engine.snapshot().mizukiVirtues[0].id, 'rogue_2_virtue_1');
  close(enemy.s.atk / enemy.base.atk, spec.enemy.atk); close(enemy.s.moveSpeed / enemy.base.moveSpeed, spec.enemy.move);
  normal.engine.battle.kill(enemy, null); beginCombat(match);
  const rescue = startRescue(match, scheduler);
  assert.equal(rescue.engine.snapshot().mizukiVirtues[0].id, 'rogue_2_virtue_1');
  let replay;
  for (let guard = 0; guard < 1200 && !replay; guard++) { rescue.engine.step(); replay = rescue.engine.battle.enemies.find((unit) => !unit._officialFacility); }
  assert.ok(replay); close(replay.s.atk / replay.base.atk, spec.enemy.atk);
  rescue.engine.battle.kill(replay, null); rescue.engine.battle.forceEnd('cleared'); scheduler.advance(FRAME * 2);
  assert.equal(match.phase, PHASE.REWARD); assert.equal(rescue.engine.result().mizukiVirtues[0].id, 'rogue_2_virtue_1'); assert.deepEqual(errors, []);
});

test('native objective HP losses survive normal-to-rescue settlement exactly once', (t) => {
  const { match, scheduler } = fixture(t, { count: 2 }); prepare(match); beginCombat(match);
  const owner = match.players.get('p1'), helper = match.players.get('p0');
  const beforeLife = owner.life, beforeShield = owner.shield, helperLife = helper.life, beforeLight = match.light;
  const normal = match.fields.get('n:p0'); normal.engine.battle.emit('lpLoss', { amount: 1, source: { ownerId: 'p1' } });
  assert.equal(normal.engine.snapshot().nativeLifeLoss, 1);
  const rescue = startRescue(match, scheduler);
  rescue.engine.battle.emit('lpLoss', { amount: 2, source: { ownerId: 'p0', sourcePlayerId: 'p1' } }); rescue.engine.battle.forceEnd('cleared');
  scheduler.advance(FRAME * 2);
  assert.equal(match.phase, PHASE.REWARD);
  assert.equal(owner.life + owner.shield, beforeLife + beforeShield - 3); assert.equal(helper.life, helperLife);
  assert.equal(match.light, beforeLight - 5 - (owner.life * 2 < owner.maxLife ? 5 : 0));
  scheduler.advance(FRAME * 4); assert.equal(owner.life + owner.shield, beforeLife + beforeShield - 3); assert.equal(helper.life, helperLife);
});

test('native objective HP loss reaches immediate field defeat at zero objective HP', (t) => {
  const { match } = fixture(t); prepare(match);
  const engine = match.fields.get('n:p0').engine;
  engine.teamHp = 2; engine.battle.emit('lpLoss', { amount: 2 });
  assert.equal(engine.teamHp, 0); assert.equal(engine.outcome, 'defeat'); assert.equal(engine.finished, true);
  assert.equal(engine.result().nativeLifeLoss, 2);
});

test('gene actions require real stock, leave NO_TARGET stock intact, and evolve persistent PREP cards at N0', (t) => {
  const { match, options } = fixture(t); prepare(match);
  assert.equal(match.handle('p0', { t: 'g.mizuki.useItem', itemId: 'rogue_2_pill' }).error, 'NO_FUNDS');
  assert.equal(match._grantNativeItem('rogue_2_pill', 2), true);
  assert.equal(match.handle('p0', { t: 'g.mizuki.useItem', itemId: 'rogue_2_pill' }).error, 'NO_TARGET');
  assert.equal(match.nativeItems.rogue_2_pill, 2);
  match.order[0].roster[0].mutationId = 'rogue_2_mutation_2';
  const used = command(match, 'p0', { t: 'g.mizuki.useItem', itemId: 'rogue_2_pill' });
  assert.equal(used.changes.length, 1); assert.equal(match.order[0].roster[0].mutationId, 'rogue_2_mutation_19');
  assert.equal(match.nativeItems.rogue_2_pill, 1);
  const doc = match.exportCheckpoint(), restored = new MizukiMatch(options); t.after(() => restored.dispose());
  assert.equal(restored.restoreCheckpoint(structuredClone(doc)), true); assert.deepEqual(restored.nativeItems, match.nativeItems);
  assert.equal(restored.order[0].roster[0].mutationId, 'rogue_2_mutation_19');
  const invalid = structuredClone(doc); invalid.mizuki.nativeItems.rogue_2_pill = -1;
  const rejected = new MizukiMatch(options); t.after(() => rejected.dispose()); assert.equal(rejected.restoreCheckpoint(invalid), false);
  beginCombat(match); const field = match.fields.get('n:p0'); field.engine.battle.start();
  const unit = field.engine.battle.getPlayer('p0').units.find((value) => value.kind === 'op');
  close(unit.s.physTakenMul, 0.65); close(unit.s.defIgnorePct, 0.35);
  const snapshot = field.engine.snapshot(); assert.equal(snapshot.mizukiInfection.enabled, false);
  assert.ok(snapshot.mizukiInfection.effects.length > 0);
  assert.ok(snapshot.mizukiInfection.effects.every((effect) => snapshot.officialEnemyEffects.some((visible) => visible.id === effect.id)));
  assert.equal(match.handle('p0', { t: 'g.mizuki.useItem', itemId: 'rogue_2_pill' }).error, 'WRONG_PHASE');
  assert.equal(match.nativeItems.rogue_2_pill, 1);
});

test('bigpill evolves all affected roster cards across owners while healthy cards stay untouched', (t) => {
  const { match } = fixture(t, { count: 2 });
  for (const player of match.order) for (const id of ['chess_char_1_02_a', 'chess_char_1_03_a']) assert.equal(match._addOperator(player, id), true);
  for (const player of match.order) player.roster[0].mutationId = 'rogue_2_mutation_2';
  assert.equal(match._grantNativeItem('rogue_2_bigpill'), true);
  const result = command(match, 'p1', { t: 'g.mizuki.useItem', itemId: 'rogue_2_bigpill' });
  assert.equal(result.changes.length, 2); assert.equal(match.nativeItems.rogue_2_bigpill, 0);
  for (const player of match.order) { assert.equal(player.roster[0].mutationId, 'rogue_2_mutation_19'); assert.equal(player.roster[1].mutationId, null); }
  assert.deepEqual(match.publicView().mizuki.nativeItems, match.nativeItems);
});

test('NORMAL sixth ending floor receives SAN while an inserted SP region neither rolls nor advances scaling', (t) => {
  const zones = Object.fromEntries(['zone_1', 'zone_2', 'zone_3', 'zone_4', 'zone_5', 'zone_7'].map((id, i) => ['floor' + i,
    { id, zoneType: 'NORMAL', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] }]));
  const special = { id: 'zone_7', zoneType: 'SP', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] };
  const dungeon = { zones: { floor0: zones.floor0, special, ...Object.fromEntries(Object.entries(zones).slice(1)) } };
  const { match } = fixture(t, { dungeon });
  const party = match.expedition.partyFor('p0');
  const enter = (zoneKey) => match._withParty(party, () => { match.explorationState = { ...createMizukiExplorationState(dungeon), zoneKey }; match._enterRoute(); });
  enter('special'); assert.equal(match.floorState.pending, null);
  assert.equal(match._difficultyAreaCount({ ...createMizukiExplorationState(dungeon), zoneKey: 'special' }), 1);
  enter('floor5'); assert.ok(match.floorState.pending);
  assert.equal(match.floorState.pending.check.zoneId, 'floor5');
  assert.equal(match._difficultyAreaCount({ ...createMizukiExplorationState(dungeon), zoneKey: 'floor5' }), 6);
});

for (const [id, count, level, exp, totalExp, hopeGain] of [['rogue_2_virtue_3', 70, 4, 10, 80, 13], ['rogue_2_virtue_10', 120, 5, 20, 130, 19]]) {
  test(id + ' settles real commander levels once after rescue and persists its used state', (t) => {
    const { match, scheduler, options, errors } = fixture(t, { count: 2 }); grantVirtue(match, id); prepare(match);
    const beforeHope = match.order.map((player) => player.hope), beforeMaxLife = match.order.map((player) => player.maxLife);
    beginCombat(match); const rescue = startRescue(match, scheduler);
    assert.deepEqual(match.commander, { level: 1, exp: 0, totalExp: 0 }, 'normal fields cannot settle before rescue ends');
    assert.equal(match.floorState.virtues[0].used, false);
    rescue.engine.battle.forceEnd('cleared'); scheduler.advance(FRAME * 2);
    assert.equal(match.phase, PHASE.REWARD); assert.deepEqual(match.commander, { level, exp, totalExp });
    assert.deepEqual(match.order.map((player, i) => player.hope - beforeHope[i]), [hopeGain, hopeGain]);
    assert.deepEqual(match.order.map((player, i) => player.maxLife - beforeMaxLife[i]), [1, 1]); assert.equal(match.floorState.virtues[0].used, true);
    const view = match.publicView().mizuki; assert.equal(view.commander.level, level); assert.equal(view.commander.exp, exp);
    assert.equal(view.virtues[0].effectStatus, 'used');
    const doc = match.exportCheckpoint(), restored = new MizukiMatch(options); t.after(() => restored.dispose());
    assert.equal(restored.restoreCheckpoint(structuredClone(doc)), true); assert.deepEqual(restored.commander, match.commander);
    const hope = restored.order.map((player) => player.hope); restored._settleBattleVirtues();
    assert.deepEqual(restored.commander, match.commander); assert.deepEqual(restored.order.map((player) => player.hope), hope);
    const bad = structuredClone(doc); bad.mizuki.commander.exp++;
    const rejected = new MizukiMatch(options); t.after(() => rejected.dispose()); assert.equal(rejected.restoreCheckpoint(bad), false);
    assert.deepEqual(errors, []);
  });
}

test('original command thresholds are per-level costs through level eleven and reject invalid experience', () => {
  assert.deepEqual(mizukiCommanderProgress(9), { level: 1, exp: 9, totalExp: 9 });
  assert.deepEqual(mizukiCommanderProgress(10), { level: 2, exp: 0, totalExp: 10 });
  assert.deepEqual(mizukiCommanderProgress(33), { level: 2, exp: 23, totalExp: 33 });
  assert.deepEqual(mizukiCommanderProgress(34), { level: 3, exp: 0, totalExp: 34 });
  assert.deepEqual(mizukiCommanderProgress(615), { level: 11, exp: 80, totalExp: 615 });
  for (const invalid of [-1, 1.5, NaN, Infinity]) assert.throws(() => mizukiCommanderProgress(invalid));
});

test('generosity virtue adapts its unavailable source pool through the Mizuki collectible draw', (t) => {
  const { match } = fixture(t); grantVirtue(match, 'rogue_2_virtue_7');
  const virtue = match.floorState.virtues[0];
  assert.equal(match.publicView().mizuki.virtues[0].effectStatus, 'active');
  assert.deepEqual(mizukiVirtueSpec(virtue.id).rewards, [{ poolId: 'pool_meide', count: 1 }, { poolId: 'pool_meide', count: 1 }]);
  const before = match.collectibles.length;
  match._applyVirtueRewards(virtue);
  assert.equal(match.collectibles.length, before + 2);
  assert.equal(virtue.rewardedCollectibles.length, 2);
  assert.equal(virtue.used, true);
  assert.ok(virtue.rewardedCollectibles.every(id => match.collectibles.includes(id)));
});
