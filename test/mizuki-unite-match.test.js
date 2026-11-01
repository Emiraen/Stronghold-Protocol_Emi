import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const FRAME = 1000 / 30;
const command = (match, playerId, message) => { const result = match.handle(playerId, message); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
function fixture(t, count = 3, extra = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [];
  const match = new MizukiMatch({ seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat })),
    roomCode: 'RSCU', seed: 512, data: DATA, scheduler, hostId: 'p0',
    dungeon: { zones: [{ id: 'zone_1', nodes: [
      { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [{ x: 1, y: 0 }] },
      { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [] },
    ] }] },
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) }, send() {}, broadcast() {}, onEnd() {}, ...extra });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  match.start();
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_3' });
  for (const [index, player] of match.order.entries()) command(match, player.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[index].bandId });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match);
  for (let seat = 0; seat < Math.min(2, count); seat++) for (const id of (seat === 0 ? ['chess_char_1_02_a', 'chess_char_1_03_a'] : ['chess_char_1_02_a'])) assert.equal(match._addOperator(match.order[seat], id), true);
  const node = match.route.find(value => value.stageId === 'ro2_n_1_1'); assert.ok(node);
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.route', nodeId: node.id });
  command(match, 'p0', { t: 'g.mizuki.routeStart' });
  for (const player of match.order) for (const unit of player.roster) {
    const field = match.fields.get(player.fieldId), grid = field.engine.battle.grid;
    const tile = field.engine.snapshot().geometry.tiles.find((value) => grid.canStand(value.row, value.col, { ranged: unit.position === 'RANGED' })
      && !(player.prep?.board || []).some((place) => place.row === value.row && place.col === value.col));
    command(match, player.playerId, { t: 'g.mizuki.move', uid: unit.uid, to: { area: 'board', row: tile.row, col: tile.col }, dir: 'RIGHT' });
  }
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.ready', on: true });
  return { match, scheduler, errors, initialLife: match.order.map((player) => player.life) };
}
function endNormal(match, leakerId) {
  const source = match.fields.get('n:' + leakerId), battle = source.engine.battle; battle.start();
  const key = battle._pending[0]?.enemyKey || source.engine.officialWaves.waves[0].fragments[0].actions.find((entry) => entry.action.key)?.action.key;
  assert.ok(key); const route = source.setup.routes[0];
  const enemy = battle.spawnEnemy(key, { route, mods: { hpMul: 1.2, atkMul: 1.3, defMul: 1.4, resMul: 1.1 } });
  assert.ok(enemy); const original = { hp: enemy.base.maxHp, atk: enemy.base.atk, def: enemy.base.def, res: enemy.base.res, route: structuredClone(route) };
  battle.leak(enemy);
  for (const field of match.fields.values()) {
    field.engine.battle.start();
    const unit = field.engine.battle.players[0]?.units[0];
    if (unit) { unit.hp = unit.s.maxHp * 0.37; unit.skill.setSpTotal(3); }
    field.engine.battle.forceEnd('cleared');
  }
  return original;
}
function rescueField(match) { return [...match.fields.values()].find((field) => field.kind === 'unite'); }
function firstReplay(field) {
  for (let i = 0; i < 1200 && !field.engine.battle.enemies.some((enemy) => !enemy._officialFacility); i++) field.engine.step();
  const enemy = field.engine.battle.enemies.find((value) => !value._officialFacility); assert.ok(enemy); return enemy;
}

test('three-person party chooses exactly the original first helper and replays its leaker on the original RO2 map at reduced HP/ATK', (t) => {
  const { match, scheduler, errors, initialLife } = fixture(t), original = endNormal(match, 'p2');
  const normal = match.fields.get('n:p0'), carry = normal.engine.result().perPlayer.p0.unitsEnd[0];
  scheduler.advance(FRAME * 2); const rescue = rescueField(match); assert.ok(rescue);
  assert.deepEqual(rescue.players, ['p0']); assert.equal(rescue.engine.battle.players.length, 1);
  assert.deepEqual(rescue.engine.battle.rect, normal.engine.battle.rect);
  assert.equal(rescue.engine.battle.stageId, 'ro2_n_1_1'); assert.equal(rescue.engine.battle.flags.layerGainsEnabled, false);
  rescue.engine.step(); const unit = rescue.engine.battle.getPlayer('p0').units[0];
  assert.ok(Math.abs(unit.hp / unit.s.maxHp - carry.hpPct) < 1e-8); assert.equal(unit.carry.sp, carry.sp);
  assert.ok(unit.skill.spTotal >= carry.sp && unit.skill.spTotal < carry.sp + 1);
  const replay = firstReplay(rescue);
  assert.equal(replay.sourcePlayerId, 'p2'); assert.ok(Math.abs(replay.base.maxHp - original.hp * 0.75) < 1e-8); assert.ok(Math.abs(replay.base.atk - original.atk * 0.75) < 1e-8);
  assert.equal(replay.base.def, original.def); assert.equal(replay.base.res, original.res);
  assert.deepEqual(replay._mizukiReplaySpawn.route, original.route);
  rescue.engine.battle.kill(replay, unit); rescue.engine.battle.forceEnd('cleared'); scheduler.advance(FRAME * 2);
  assert.equal(match.phase, PHASE.REWARD); assert.deepEqual(match.order.map((player) => player.life), initialLife); assert.deepEqual(errors, []);
});

test('two-person rescue preserves source billing and ignores children born inside the rescue', (t) => {
  const { match, scheduler, errors, initialLife } = fixture(t, 2); endNormal(match, 'p1'); scheduler.advance(FRAME * 2);
  const rescue = rescueField(match), replay = firstReplay(rescue); assert.deepEqual(rescue.players, ['p0']);
  const child = rescue.engine.battle.spawnEnemy(replay.defId, { route: replay._mizukiReplaySpawn.route, countInTotal: true });
  assert.equal(child.uniteRuntime, true); rescue.engine.battle.leak(child); rescue.engine.battle.leak(replay);
  rescue.engine.battle.forceEnd('cleared'); scheduler.advance(FRAME * 2);
  assert.deepEqual(match.order.map((player, i) => player.life - initialLife[i]), [0, -1], 'only the original source loses personal life'); assert.equal(match.phase, PHASE.REWARD); assert.deepEqual(errors, []);
});

test('solo party settles its own leaks without constructing any rescue field', (t) => {
  const { match, scheduler, errors, initialLife } = fixture(t, 1); endNormal(match, 'p0'); scheduler.advance(FRAME * 2);
  assert.equal(rescueField(match), undefined); assert.equal(match.players.get('p0').life, initialLife[0] - 1); assert.equal(match.phase, PHASE.REWARD); assert.deepEqual(errors, []);
});

test('one-helper rescue balance is configurable without altering original defense or resistance', (t) => {
  const { match, scheduler } = fixture(t, 2, { uniteBalance: { hpMul: 0.6, atkMul: 0.8 } }), original = endNormal(match, 'p1');
  scheduler.advance(FRAME * 2); const replay = firstReplay(rescueField(match));
  assert.equal(replay.base.maxHp, original.hp * 0.6); assert.equal(replay.base.atk, original.atk * 0.8);
  assert.equal(replay.base.def, original.def); assert.equal(replay.base.res, original.res);
});

test('post-rescue reward checkpoints restore party-owned rescue field identities and reject a foreign party', (t) => {
  const { match, scheduler } = fixture(t, 2); endNormal(match, 'p1'); scheduler.advance(FRAME * 2);
  const rescue = rescueField(match), replay = firstReplay(rescue); rescue.engine.battle.kill(replay, null);
  rescue.engine.battle.forceEnd('cleared'); scheduler.advance(FRAME * 2); assert.equal(match.phase, PHASE.REWARD);
  const doc = match.exportCheckpoint(); assert.ok(doc.players.every((player) => player.fieldId.startsWith('u:party-')));
  const restore = (checkpoint) => {
    const clock = new VirtualScheduler({ instantCombat: false }), next = new MizukiMatch({ ...match.opts, scheduler: clock });
    t.after(() => { next.dispose(); clock.dispose(); }); return { restored: next.restoreCheckpoint(checkpoint), match: next };
  };
  const restored = restore(structuredClone(doc)); assert.equal(restored.restored, true); assert.equal(restored.match.phase, PHASE.REWARD);
  assert.deepEqual(restored.match.order.map((player) => player.layers), match.order.map((player) => player.layers));
  const bad = structuredClone(doc); bad.players[0].fieldId = 'u:party-foreign'; assert.equal(restore(bad).restored, false);
  for (const player of match.order) {
    const groups = [...new Set(player.rewards.map(reward => reward.group).filter(Boolean))];
    assert.ok(groups.includes('recruitTicket'));
    for (const group of groups) {
      const reward = player.rewards.find(value => value.group === group); assert.ok(reward);
      command(match, player.playerId, { t: 'g.mizuki.reward', rewardId: reward.id });
    }
  }
  assert.equal(match.phase, PHASE.RECRUIT);
  skipMizukiRecruit(match);
  assert.equal(match.phase, PHASE.ROUTE); assert.ok(match.order.every((player) => player.fieldId === 'n:' + player.playerId));
  assert.equal(restore(match.exportCheckpoint()).restored, true, 'cleared rescue IDs cannot outlive a later party merge');
});
