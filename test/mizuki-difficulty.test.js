import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { getData } from '../server/data.js';
import { createMizukiExplorationState } from '../server/modes/mizuki/exploration.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { validateC2S } from '../shared/protocol.js';
import { mizukiDifficultyOptions, mizukiDifficultyInitial, mizukiDifficultyLight,
  mizukiDifficultyHopeDelta, mizukiDifficultyDeployDelta, mizukiDifficultyModifiers } from '../server/modes/mizuki/Difficulty.js';
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, a + ' != ' + b);
const create = (grade = 0, areaCount = 1) => new MizukiCombat({ battleId: 'difficulty', seed: 42,
  stageId: 'act1autochess_m02', rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, content: 'none',
  difficultyGrade: grade, difficultyAreaCount: areaCount, timeLimit: 180,
  players: [{ playerId: 'p0', seat: 0, units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] }],
  spawns: [{ time: 150, enemyKey: 'enemy_1007_slime' }] });
const enemy = (c, rank = 'NORMAL', extra = {}) => c.battle.spawnEnemy('difficulty_' + rank, { pos: [9, 2], def: {
  key: 'difficulty_' + rank, name: rank, rank, stats: { maxHp: 10000, atk: 100, def: 20,
    res: 5, aspd: 100, bat: 2, moveSpeed: 1, ...extra } } });

test('all nineteen original NORMAL grade choices and initial resources are available', () => {
  assert.deepEqual(mizukiDifficultyOptions().map((value) => value.grade), Array.from({ length: 19 }, (_, i) => i));
  for (let grade = 0; grade <= 18; grade++) {
    const init = mizukiDifficultyInitial(grade); assert.equal(init.initialHp, 4); assert.equal(init.initialPopulation, 6);
    assert.equal(init.initialGold, 6); assert.equal(init.initialSquadCapacity, 6);
  }
  assert.deepEqual([0, 5, 6, 9, 10, 18].map(mizukiDifficultyLight), [100, 100, 85, 85, 70, 70]);
  assert.equal(mizukiDifficultyHopeDelta(4, 3), 1); assert.equal(mizukiDifficultyHopeDelta(3, 6), 0);
  assert.equal(mizukiDifficultyHopeDelta(18, 2), 0);
  assert.equal(mizukiDifficultyDeployDelta(13), 0); assert.equal(mizukiDifficultyDeployDelta(14), -1);
});

test('area rates include first ordinary floor and compound; grade rates replace preceding grades', () => {
  close(mizukiDifficultyModifiers(1, 1).hp, 1.01);
  close(mizukiDifficultyModifiers(15, 3).hp, 1.15 ** 3);
  close(mizukiDifficultyModifiers(16, 6).atk, 1.2 ** 6);
  close(mizukiDifficultyModifiers(17, 6).hp, 1.25 ** 6);
  close(mizukiDifficultyModifiers(18, 6).hp, 1.3 ** 6);
  close(mizukiDifficultyModifiers(13).elementalLoss, 1.15 ** 3);
  close(mizukiDifficultyModifiers(15, 1, 'ELITE').hp, 1.15 * 1.2 * 1.2);
  close(mizukiDifficultyModifiers(15, 1, 'BOSS').atk, 1.15 * 1.15 * 1.2);
  close(mizukiDifficultyModifiers(15, 1, 'BOSS').def, 1.15 * 1.2);
});

test('real enemy preprocessing applies rank multipliers, RES, ASPD and speed without altering original defs', () => {
  const base = create(0), c = create(15, 3);
  const source = enemy(base, 'BOSS'), scaled = enemy(c, 'BOSS');
  close(scaled.base.maxHp / source.base.maxHp, 1.15 ** 3 * 1.2 ** 2);
  close(scaled.base.atk / source.base.atk, 1.15 ** 3 * 1.15 * 1.2);
  close(scaled.base.def / source.base.def, 1.15 * 1.2);
  close(scaled.base.res - source.base.res, 20); close(scaled.base.aspd - source.base.aspd, 15);
  close(scaled.base.moveSpeed / source.base.moveSpeed, 1.15);
  assert.equal(scaled.def.maxHp, source.def.maxHp);
  const hp = scaled.base.maxHp; c.difficultyEffects.applyEnemy(scaled); assert.equal(scaled.base.maxHp, hp);
  const replay = c.battle.spawnEnemy('difficulty_BOSS', { def: scaled.def, pos: [9, 2] });
  close(replay.base.maxHp, hp);
  close(c.battle.allyUnits[0].s.elemTakenMul, 1.15 ** 3);
});

test('N18 arrival mitigation covers only physical/arts for twenty seconds and normal units are excluded', () => {
  const c = create(18), elite = enemy(c, 'ELITE'), normal = enemy(c);
  close(elite.s.atk, elite.base.atk * 1.3); close(elite.s.physTakenMul, 0.5); close(elite.s.artsTakenMul, 0.5);
  assert.equal(elite.s.trueTakenMul, 1); assert.equal(elite.s.elementalTakenMul, 1);
  assert.equal(normal.s.physTakenMul, 1); assert.equal(normal.s.atk, normal.base.atk);
  c.battle.time = 19.99; c.battle._tickBuffs(19.99); close(elite.s.physTakenMul, 0.5);
  c.battle.time = 20.01; c.battle._tickBuffs(0.02); close(elite.s.physTakenMul, 1); close(elite.s.atk, elite.base.atk);
});

test('host-only grade selection locks after squad and N16 initial original relic survives checkpoint', (t) => {
  const scheduler = new VirtualScheduler(), data = getData({ log: { warn() {}, error() {}, info() {} } });
  const opts = { data, scheduler, roomCode: 'GRAD', seed: 77,
    seats: [{ playerId: 'p0', seat: 0 }, { playerId: 'p1', seat: 1 }], send() {}, broadcast() {}, onEnd() {} };
  const m = new MizukiMatch(opts); t.after(() => { m.dispose(); scheduler.dispose(); }); m.start();
  assert.equal(m.handle('p1', { t: 'g.mizuki.difficulty', grade: 18 }).error, 'BAD_TARGET');
  assert.equal(m.handle('p0', { t: 'g.mizuki.difficulty', grade: 19 }).error, 'BAD_TARGET');
  assert.equal(m.handle('p0', { t: 'g.mizuki.difficulty', grade: 16 }).ok, true);
  assert.equal(m.light, 70); assert.deepEqual(m.collectibles, ['rogue_2_relic_fight_159']);
  const restored = new MizukiMatch(opts); t.after(() => restored.dispose());
  assert.equal(restored.restoreCheckpoint(m.exportCheckpoint()), true); assert.equal(restored.difficultyGrade, 16);
  assert.deepEqual(restored.collectibles, m.collectibles);
  for (const p of m.order) m.handle(p.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  assert.equal(m.phase, PHASE.STRATEGY);
  assert.equal(m.handle('p0', { t: 'g.mizuki.difficulty', grade: 0 }).error, 'WRONG_PHASE');
});

function matchFixture(t, count = 1, dungeon = null, cognition) {
  const scheduler = new VirtualScheduler(), options = { scheduler, data: getData({ log: { warn() {}, error() {}, info() {} } }),
    seed: 123, roomCode: 'FLOO', ...(dungeon ? { dungeon } : {}), ...(cognition ? { cognition } : {}),
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat })), send() {}, broadcast() {}, onEnd() {} };
  const match = new MizukiMatch(options); t.after(() => { match.dispose(); scheduler.dispose(); }); match.start();
  for (const player of match.order) match.handle(player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  for (const [index, player] of match.order.entries()) match.handle(player.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[index].bandId });
  for (const player of match.order) match.handle(player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
  for (const player of match.order) match.handle(player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  for (let guard = 0; guard < 12 && match.phase === PHASE.RECRUIT; guard++) for (const player of match.order) {
    const view = match.privateView(player.playerId).mizuki.recruit;
    if (view?.ticket) match.handle(player.playerId, { t: 'g.mizuki.recruit', offerId: view.skipToken });
  }
  assert.equal(match.phase, PHASE.ROUTE); return { match, options };
}
const dungeon = () => ({ zones: Object.fromEntries([['one', 'zone_1'], ['two', 'zone_2'], ['portal', 'zone_7'], ['three', 'zone_3']]
  .map(([key, id]) => [key, { id, zoneType: key === 'portal' ? 'SP' : 'NORMAL',
    nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] }])) });
const importCombatRoute = (match, stageId) => {
  const route = { zones: [{ id: 'zone_1', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: stageId, next: [] }] }] };
  const result = match.handle(match.hostId, { t: 'g.mizuki.importDungeon', dungeon: route, sourceLabel: 'difficulty test fixture' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const node = match.route.find(value => value.stageId === stageId && value.type === 'combat');
  assert.ok(node, 'imported route exposes ' + stageId);
  return node;
};
const enterArea = (match, key) => {
  const party = match.expedition.partyFor('p0');
  match._withParty(party, () => { match.explorationState = { ...createMizukiExplorationState(dungeon()), zoneKey: key }; match.archiveMode = false; match._enterRoute(); });
};

test('original SAN checks skip opening/special areas, team votes reroll once and checkpoint retains pending targets', (t) => {
  const { match: m, options } = matchFixture(t, 2, dungeon(), { totalScore: 22400 });
  for (const player of m.order) for (const id of m.catalog.slice(0, 3)) m._addOperator(player, id);
  assert.equal(m.floorState.pending, null); m.light = 0; m.difficultyGrade = 17; enterArea(m, 'two');
  const first = structuredClone(m.floorState.pending); assert.ok(first); assert.equal(first.check.kind, 'mutation');
  assert.equal(m.handle('p0', { t: 'g.mizuki.routeStart' }).error, 'WRONG_PHASE');
  assert.equal(m.dice, 7, 'full cognition adds two original starting dice');
  assert.equal(m.handle('p0', { t: 'g.mizuki.sanVote', id: first.id, choice: 'reroll' }).ok, true); assert.equal(m.dice, 7);
  assert.equal(m.handle('p1', { t: 'g.mizuki.sanVote', id: first.id, choice: 'reroll' }).ok, true); assert.equal(m.dice, 6);
  const second = structuredClone(m.floorState.pending); assert.notEqual(second.id, first.id);
  assert.ok(m.order.every((player) => player.roster.every((unit) => !unit.mutationId)));
  assert.equal(m.handle('p0', { t: 'g.mizuki.sanVote', id: first.id, choice: 'accept' }).error, 'BAD_TARGET');
  const doc = m.exportCheckpoint(), restored = new MizukiMatch(options); t.after(() => restored.dispose());
  assert.equal(restored.restoreCheckpoint(JSON.parse(JSON.stringify(doc))), true);
  assert.deepEqual(restored.floorState.pending, second);
  const bad = structuredClone(doc); bad.mizuki.floorState.pending.check.grade = 16;
  const rejected = new MizukiMatch(options); t.after(() => rejected.dispose()); assert.equal(rejected.restoreCheckpoint(bad), false);
  for (const player of m.order) assert.equal(m.handle(player.playerId, { t: 'g.mizuki.sanVote', id: second.id, choice: 'accept' }).ok, true);
  assert.equal(m.floorState.pending, null); assert.equal(m.floorState.mutations.checks.length, 1);
  assert.ok(m.order.flatMap((player) => player.roster).some((unit) => /^rogue_2_mutation_1[3-8]$/.test(unit.mutationId)));
  enterArea(m, 'portal'); assert.equal(m.floorState.pending, null); assert.equal(m._difficultyAreaCount(m.partyStates.values().next().value.explorationState), 2);
});

test('single-player SAN vote is accepted by the wire protocol and immediately unlocks the route', (t) => {
  const { match: m } = matchFixture(t, 1, dungeon());
  for (const id of m.catalog.slice(0, 3)) m._addOperator(m.players.get('p0'), id);
  m.light = 0; m.difficultyGrade = 17; enterArea(m, 'two');
  const pending = structuredClone(m.floorState.pending); assert.ok(pending);
  const message = { t: 'g.mizuki.sanVote', rid: 1, id: pending.id, choice: 'accept' };
  assert.equal(validateC2S(message), null);
  assert.equal(validateC2S({ ...message, choice: 'wait' }), 'bad field choice');
  assert.equal(m.handle('p0', message).ok, true);
  assert.equal(m.floorState.pending, null);
  assert.equal(m.phase, PHASE.ROUTE);
});

test('pending SAN votes settle when an undecided member disconnects or leaves', (t) => {
  for (const departure of ['disconnect', 'leave']) {
    const { match: m } = matchFixture(t, 2, dungeon());
    for (const player of m.order) for (const id of m.catalog.slice(0, 3)) m._addOperator(player, id);
    m.light = 0; m.difficultyGrade = 17; enterArea(m, 'two');
    const pending = structuredClone(m.floorState.pending); assert.ok(pending);
    assert.equal(m.handle('p0', { t: 'g.mizuki.sanVote', id: pending.id, choice: 'accept' }).ok, true);
    assert.equal(m.floorState.pending.id, pending.id);
    const recall = m.handle('p0', { t: 'g.mizuki.recallPropose', targetIds: ['p1'] });
    assert.equal(recall.error, 'WRONG_PHASE');
    if (departure === 'disconnect') m.onDisconnect('p1'); else m.onLeave('p1');
    assert.equal(m.floorState.pending, null, departure + ' should remove the missing voter from the electorate');
    assert.equal(m.phase, PHASE.ROUTE, departure + ' should advance beyond the SAN modal');
  }
});

test('SAN reroll resolves against the remaining online voters, while zero online voters wait for reconnection', (t) => {
  const { match: m } = matchFixture(t, 2, dungeon(), { totalScore: 22400 });
  for (const player of m.order) for (const id of m.catalog.slice(0, 3)) m._addOperator(player, id);
  m.light = 0; m.difficultyGrade = 17; enterArea(m, 'two');
  const first = structuredClone(m.floorState.pending); assert.ok(first); assert.equal(first.check.canReroll, true);
  const diceBeforeVote = m.dice;
  m.handle('p0', { t: 'g.mizuki.sanVote', id: first.id, choice: 'reroll' });
  assert.equal(m.dice, diceBeforeVote, 'one outstanding online vote must not spend the reroll yet');
  m.onDisconnect('p1');
  assert.equal(m.dice, diceBeforeVote - 1);
  const second = m.floorState.pending; assert.ok(second); assert.notEqual(second.id, first.id);
  assert.deepEqual(second.votes, {});

  m.onDisconnect('p0');
  assert.equal(m.floorState.pending.id, second.id, 'without an online voter the result must remain available');
  m.onReconnect('p0');
  assert.equal(m.handle('p0', { t: 'g.mizuki.sanVote', id: second.id, choice: 'accept' }).ok, true);
  assert.equal(m.floorState.pending, null, 'a reconnecting member can finish the pending result');
});

test('third ordinary area grants one ordinary original curse and does not repeat after checkpoint or node refresh', (t) => {
  const { match: m } = matchFixture(t, 1, dungeon()); m.difficultyGrade = 2;
  enterArea(m, 'three'); assert.ok(/^rogue_2_relic_curse_[1-6]$/.test(m.floorState.curse));
  assert.equal(m.collectibles.filter((id) => id === m.floorState.curse).length, 1);
  const before = structuredClone(m.floorState); enterArea(m, 'three'); assert.deepEqual(m.floorState, before);
  enterArea(m, 'portal'); assert.equal(m.collectibles.filter((id) => id === m.floorState.curse).length, 1);
});

test('any original leak loses light even behind life shields; below-half loss is independent', (t) => {
  const { match: m } = matchFixture(t); const party = m.expedition.partyFor('p0');
  const node = importCombatRoute(m, 'ro2_n_1_1');
  m._withParty(party, () => {
    m.currentNode = structuredClone(node); m._enterPrep();
    const field = [...m.fields.values()][0]; field.engine.battle.leakedCount = 1;
    m.lastResults = new Map([['p0', { leaked: [{ enemyKey: 'difficulty_fixture', counted: true }] }]]);
    const player = m.players.get('p0'), life = player.life; player.shield = 1;
    m._settlePartyBattle(new Map([['p0', 1]])); assert.equal(player.life, life); assert.equal(m.light, 95);
    player.life = 1; player.shield = 0; m._settlePartyBattle(new Map([['p0', 0]])); assert.equal(m.light, 85);
  });
});

test('original crate card placement in PREP survives engine rebuild and checkpoint exactly once', (t) => {
  const { match: m, options } = matchFixture(t); const party = m.expedition.partyFor('p0'); let tile;
  const node = importCombatRoute(m, 'ro2_n_6_2');
  m._withParty(party, () => { m.currentNode = structuredClone(node); m._enterPrep(); });
  let field = [...m.fields.values()][0]; const b = field.engine.battle;
  for (let row = b.rect.r0; row <= b.rect.r1 && !tile; row++) for (let col = b.rect.c0; col <= b.rect.c1; col++) {
    if (b.grid.canStand(row, col, { ranged: false }) && !b.grid.isObstacle(row, col)) { tile = { row, col }; break; }
  }
  const dp = b.getPlayer('p0').dp;
  assert.equal(m.handle('p0', { t: 'g.mizuki.facility', battleId: field.battleId, key: 'trap_001_crate', ...tile, dir: 'RIGHT' }).ok, true);
  assert.equal(b.getPlayer('p0').dp, dp - 5); assert.equal(field.engine.snapshot().facilityCards[0].count, 9);
  m._withParty(party, () => m._prepareFields()); field = [...m.fields.values()][0];
  assert.equal(field.engine.snapshot().facilityCards[0].count, 9); assert.equal(field.engine.battle.getPlayer('p0').dp, dp - 5);
  assert.equal(field.engine.battle.grid.isObstacle(tile.row, tile.col), true);
  const restored = new MizukiMatch(options); t.after(() => restored.dispose()); assert.equal(restored.restoreCheckpoint(m.exportCheckpoint()), true);
  const saved = [...restored.fields.values()][0]; assert.equal(saved.engine.snapshot().facilityCards[0].count, 9);
  assert.equal(saved.engine.battle.getPlayer('p0').dp, dp - 5); assert.equal(saved.engine.battle.grid.isObstacle(tile.row, tile.col), true);
  field.engine.battle.start();
  assert.equal(field.engine.command('p0', { type: 'deployFacility', key: 'trap_001_crate', ...tile, dir: 'RIGHT' }).error, 'COOLDOWN');
});
