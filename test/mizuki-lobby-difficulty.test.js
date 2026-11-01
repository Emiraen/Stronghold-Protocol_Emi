import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby, Room } from '../server/lobby.js';
import { getData } from '../server/data.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { mizukiDifficultyInitial, mizukiDifficultyLight } from '../server/modes/mizuki/Difficulty.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { roomDoc } from '../server/persist.js';
import { restoreLobbyRooms, restoreLobbyMatch } from '../server/matchRestore.js';
import { validateRecruitmentItems } from '../server/recruitmentDirectory.js';
import { validateC2S } from '../shared/protocol.js';
import { ERR } from '../shared/constants.js';
import { MIZUKI_VARIANT, MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const data = getData({ log: quiet });
const command = (match, playerId, message) => assert.equal(match.handle(playerId, message).ok, true);
const creation = (extra = {}) => ({ mode: 'coop', difficulty: 'NORMAL', variant: MIZUKI_VARIANT, capacity: 1, ...extra });
const grades = Array.from({ length: 19 }, (_, grade) => grade);

function fixture(t) {
  const sessions = new Map(), ordinaryOptions = [];
  class OrdinaryMatch {
    constructor(options) { ordinaryOptions.push(options); this.options = options; }
    start() {}
    dispose() {}
  }
  const registry = { byId: id => sessions.get(id), all: () => sessions.values(), isExpired: () => false };
  const lobby = new Lobby({ registry, getData: () => data, MatchClass: OrdinaryMatch, seedFn: () => 512,
    now: () => 1_800_000_000_000, log: quiet, ranked: {}, history: {}, players: { profiles: new Map() } });
  t.after(() => lobby.shutdown());
  const peer = (index = 0) => {
    const playerId = 'mzgrade_p' + index;
    const session = { playerId, name: playerId, aid: 'mzgrade_a' + index, connected: true,
      profileReady: true, profileBound: true, roomCode: null, spectatorCode: null,
      ws: { readyState: 1, bufferedAmount: 0, send(_raw, done) { done?.(); }, terminate() {} } };
    sessions.set(playerId, session); return session;
  };
  return { lobby, peer, ordinaryOptions };
}

test('room.create accepts every N0-N18 grade and rejects malformed or cross-mode grade fields', () => {
  for (const grade of grades) assert.equal(validateC2S({ t: 'room.create', ...creation({ mizukiDifficultyGrade: grade }) }), null);
  assert.equal(validateC2S({ t: 'room.create', ...creation() }), null);
  for (const grade of [-1, 19, 1.5, '18', null, true, NaN, Infinity]) {
    assert.notEqual(validateC2S({ t: 'room.create', ...creation({ mizukiDifficultyGrade: grade }) }), null);
  }
  for (const variant of [undefined, 'entertainment_multi', 'entertainment_cyclops', 'entertainment_endless', 'entertainment_annihilation']) {
    assert.notEqual(validateC2S({ t: 'room.create', ...creation({ variant, mizukiDifficultyGrade: 0 }) }), null);
  }
});

test('actual lobby creation applies every selected grade to initial resources and public match state', (t) => {
  for (const grade of grades) {
    const { lobby, peer } = fixture(t), host = peer();
    assert.equal(lobby.create(host, creation({ mizukiDifficultyGrade: grade })).ok, true);
    const room = lobby.roomOf(host);
    assert.equal(room.toState().mizukiDifficultyGrade, grade);
    assert.equal(lobby.start(host).ok, true);
    const match = room.match, initial = mizukiDifficultyInitial(grade);
    assert.ok(match instanceof MizukiMatch); assert.equal(match.difficultyGrade, grade);
    assert.equal(match.publicView().mizuki.difficultyGrade, grade);
    assert.equal(match.light, mizukiDifficultyLight(grade));
    assert.equal(match.squadCapacity, initial.initialSquadCapacity + 1); assert.equal(match.key, initial.initialKey + 2);
    assert.equal(match.cognition.unlockedNodeIds.length, 58);
    assert.deepEqual(match.collectibles, grade >= 16 ? ['rogue_2_relic_fight_159'] : []);
    for (const player of match.order) assert.deepEqual(
      [player.hope, player.gold, player.life, player.maxLife, player.shield],
      [initial.initialPopulation, initial.initialGold + 15, initial.initialHp + 3, initial.initialMaxHp + 3, initial.initialShield]);
    assert.equal(match.exportCheckpoint().mizuki.difficultyGrade, grade);
  }
});

test('missing grade defaults to N0 and a failed grade request preserves an existing room', (t) => {
  const { lobby, peer } = fixture(t), host = peer();
  assert.equal(lobby.create(host, creation()).ok, true);
  const room = lobby.roomOf(host); assert.equal(room.mizukiDifficultyGrade, 0);
  for (const grade of [-1, 19, 1.5, '18', null, true, NaN, Infinity]) {
    assert.equal(lobby.create(host, creation({ mizukiDifficultyGrade: grade })).error, ERR.BAD_MSG);
    assert.equal(lobby.roomOf(host), room); assert.equal(lobby.rooms.size, 1);
  }
  assert.equal(lobby.start(host).ok, true); assert.equal(room.match.difficultyGrade, 0);
});

test('ordinary rooms neither accept the grade field nor receive it in states, saves or match options', (t) => {
  const { lobby, peer, ordinaryOptions } = fixture(t), host = peer();
  const ordinary = { mode: 'solo', difficulty: 'NORMAL' };
  for (const grade of [0, 18]) assert.equal(lobby.create(host, { ...ordinary, mizukiDifficultyGrade: grade }).error, ERR.BAD_MSG);
  assert.equal(lobby.rooms.size, 0);
  assert.equal(lobby.create(host, ordinary).ok, true);
  const room = lobby.roomOf(host);
  assert.equal(Object.hasOwn(room, 'mizukiDifficultyGrade'), false);
  assert.equal(Object.hasOwn(room.toState(), 'mizukiDifficultyGrade'), false);
  assert.equal(Object.hasOwn(roomDoc(room), 'mizukiDifficultyGrade'), false);
  assert.equal(lobby.start(host).ok, true);
  assert.equal(ordinaryOptions.length, 1); assert.equal(Object.hasOwn(ordinaryOptions[0], 'mizukiDifficultyGrade'), false);
});

test('teammates receive the selected grade without changing the signed recruitment-directory contract', (t) => {
  const { lobby, peer } = fixture(t), host = peer();
  assert.equal(lobby.create(host, creation({ capacity: 2, mizukiDifficultyGrade: 13 })).ok, true);
  const room = lobby.roomOf(host); lobby.recruitmentRooms.set(room.code, lobby.now());
  const listing = lobby.recruitmentItems();
  assert.equal(validateRecruitmentItems(listing, lobby.serverId).length, 1);
  assert.equal(Object.hasOwn(listing[0], 'mizukiDifficultyGrade'), false);
  const teammate = peer(1); assert.equal(lobby.join(teammate, { code: room.code }).ok, true);
  assert.equal(lobby.roomOf(teammate).toState().mizukiDifficultyGrade, 13);
});

test('N18 room settings and match checkpoints survive lobby restart recovery', async (t) => {
  const source = fixture(t), host = source.peer();
  assert.equal(source.lobby.create(host, creation({ mizukiDifficultyGrade: 18 })).ok, true);
  const original = source.lobby.roomOf(host); assert.equal(source.lobby.start(host).ok, true);
  const savedRoom = structuredClone(roomDoc(original)), checkpoint = structuredClone(original.match.exportCheckpoint());
  assert.equal(savedRoom.mizukiDifficultyGrade, 18);
  const target = fixture(t), reconnected = target.peer(); reconnected.roomCode = original.code;
  assert.equal(restoreLobbyRooms(target.lobby, [savedRoom], { Room }).rooms, 1);
  const room = target.lobby.rooms.get(original.code); assert.equal(room.toState().mizukiDifficultyGrade, 18);
  assert.equal(await restoreLobbyMatch(target.lobby, room, checkpoint), true);
  assert.equal(room.match.difficultyGrade, 18); assert.equal(room.match.light, 70);
  assert.deepEqual(room.match.collectibles, ['rogue_2_relic_fight_159']);
  assert.equal(room.match.exportCheckpoint().mizuki.difficultyGrade, 18);
  // Older room documents omitted this setting even when the checkpoint's
  // in-game selector had already chosen a higher grade.
  const legacy = fixture(t), oldDoc = { ...savedRoom }; delete oldDoc.mizukiDifficultyGrade;
  legacy.peer().roomCode = original.code;
  assert.equal(restoreLobbyRooms(legacy.lobby, [oldDoc], { Room }).rooms, 1);
  const legacyRoom = legacy.lobby.rooms.get(original.code);
  assert.equal(legacyRoom.mizukiDifficultyGrade, 0);
  assert.equal(await restoreLobbyMatch(legacy.lobby, legacyRoom, checkpoint), true);
  assert.equal(legacyRoom.toState().mizukiDifficultyGrade, 18);
  assert.equal(roomDoc(legacyRoom).mizukiDifficultyGrade, 18);
});

test('old room documents default to N0 and corrupted saved grade settings are refused', (t) => {
  const source = fixture(t), host = source.peer(); assert.equal(source.lobby.create(host, creation()).ok, true);
  const original = source.lobby.roomOf(host), doc = structuredClone(roomDoc(original)); delete doc.mizukiDifficultyGrade;
  const legacy = fixture(t); legacy.peer().roomCode = original.code;
  assert.equal(restoreLobbyRooms(legacy.lobby, [doc], { Room }).rooms, 1);
  assert.equal(legacy.lobby.rooms.get(original.code).mizukiDifficultyGrade, 0);
  for (const grade of [-1, 19, 0.5, '18', null]) {
    const target = fixture(t); target.peer().roomCode = original.code;
    assert.equal(restoreLobbyRooms(target.lobby, [{ ...doc, mizukiDifficultyGrade: grade }], { Room }).rooms, 0);
  }
});

test('lobby-selected N18 reaches production combat difficulty rules without an in-game difficulty command', (t) => {
  const { lobby, peer } = fixture(t), host = peer();
  assert.equal(lobby.create(host, creation({ mizukiDifficultyGrade: 18 })).ok, true);
  assert.equal(lobby.start(host).ok, true);
  const match = lobby.roomOf(host).match;
  const dungeon = { zones: [{ id: 'zone_1', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] }] };
  command(match, host.playerId, { t: 'g.mizuki.importDungeon', dungeon });
  command(match, host.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_3' });
  const band = match.strategyOptions.find(option => data.bands[option.bandId]?.buffs?.every(buff => buff.key === 'env_gbuff_new_with_verify'));
  command(match, host.playerId, { t: 'g.mizuki.strategy', bandId: band.bandId });
  command(match, host.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
  command(match, host.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match);
  command(match, host.playerId, { t: 'g.mizuki.route', nodeId: match.route[0].id });
  command(match, host.playerId, { t: 'g.mizuki.routeStart' }); assert.equal(match.phase, PHASE.PREP);
  const engine = match.fields.get('n:' + host.playerId).engine, difficulty = engine.snapshot().mizukiDifficulty;
  assert.equal(difficulty.grade, 18); assert.equal(difficulty.areaCount, 1);
  assert.equal(difficulty.normal.hp, 1.3); assert.equal(difficulty.normal.res, 20);
  assert.deepEqual(difficulty.elite.arrival, { duration: 20, atk: 1.3, phys: 0.5, arts: 0.5 });
});

test('direct Mizuki construction validates the optional initial grade before allocating match resources', (t) => {
  const scheduler = new VirtualScheduler(), options = { data, scheduler, seats: [{ playerId: 'p0', seat: 0 }],
    send() {}, broadcast() {}, onEnd() {} };
  t.after(() => scheduler.dispose());
  for (const mizukiDifficultyGrade of [-1, 19, 0.5, '18', null]) {
    assert.throws(() => new MizukiMatch({ ...options, mizukiDifficultyGrade }), /Invalid Mizuki difficulty grade/);
  }
});
