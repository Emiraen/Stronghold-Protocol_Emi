import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryStore } from '../server/historyStore.js';
import { Lobby } from '../server/lobby.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { createProfileAccess } from '../server/profileService.js';
import { getData } from '../server/data.js';
import { normalizeCognition, MIZUKI_COGNITION_MAX_SCORE } from '../server/modes/mizuki/Cognition.js';
import { MIZUKI_VARIANT } from '../shared/mizuki-constants.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);
const log = { info() {}, warn() {}, error() {}, debug() {} };
const data = getData({ log });
const matchId = number => number.toString(16).padStart(32, '0');
const seats = [{ aid: A, playerId: 'p0', seat: 0, name: 'host' }, { aid: B, playerId: 'p1', seat: 1, name: 'mate' }];
const summary = (score = 250, cellPoints = score) => ({
  mode: 'coop', variant: MIZUKI_VARIANT, modeId: 'mode_mizuki', difficulty: 'NORMAL', difficultyGrade: 0,
  victory: false, mizuki: { explorationScore: score, cellPoints },
  players: seats.map(seat => ({ playerId: seat.playerId, victory: false, roundsPassed: 1 })),
});
const record = (history, number, result = summary(), rowSeats = seats) => {
  assert.equal(history.record({ matchId: matchId(number), seats: rowSeats, ranked: false, summary: result }), true);
};
function fileFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mizuki-cognition-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'history.json');
}

test('actual Mizuki settlement credits each human role once, including a failed expedition', () => {
  const history = new HistoryStore();
  const humans = [...seats, { aid: C, playerId: 'bot', isBot: true }];
  const result = summary(250, 300);result.players.push({ playerId: 'bot', victory: false });
  record(history, 1, result, humans);
  for (const aid of [A, B]) assert.deepEqual(history.mizukiCognition(aid), { ...normalizeCognition({ totalScore: 250 }), totalCells: 300 });
  assert.deepEqual(history.mizukiCognition(C), { ...normalizeCognition(), totalCells: 0 });
  record(history, 1, result, humans);
  assert.equal(history.mizukiCognition(A).totalScore, 250);assert.equal(history.mizukiCognition(A).totalCells, 300);
  const view = history.mizukiCognition(A);view.unlockedNodeIds.push('fake');view.totalScore = 999;
  assert.deepEqual(history.mizukiCognition(A), { ...normalizeCognition({ totalScore: 250 }), totalCells: 300 });
});

test('personal settlement rows override the leader score and cells for split exploration', () => {
  const history = new HistoryStore(), result = summary(999, 999);
  result.players[0].mizuki = { explorationScore: 120, cellPoints: 150 };
  result.players[1].mizuki = { explorationScore: 340, cellPoints: 425 };
  record(history, 2, result);
  assert.equal(history.mizukiCognition(A).totalScore, 120);assert.equal(history.mizukiCognition(A).totalCells, 150);
  assert.equal(history.mizukiCognition(B).totalScore, 340);assert.equal(history.mizukiCognition(B).totalCells, 425);
  const malformed = summary(500, 500);malformed.players[0].mizuki = { explorationScore: -1, cellPoints: 500 };
  record(history, 3, malformed);
  assert.equal(history.mizukiCognition(A).totalScore, 120, 'invalid personal scores cannot fall back to the leader');
  assert.equal(history.mizukiCognition(B).totalScore, 840, 'legacy rows without personal metadata retain the summary fallback');
});

test('same account distinct player receipts remain independent and repeated seats do not double-credit', () => {
  const history = new HistoryStore(), result = summary(50, 60);
  const repeated = [{ aid: A, playerId: 'p0' }, { aid: A, playerId: 'p1' }, { aid: A, playerId: 'p1' }];
  record(history, 1, result, repeated);
  assert.equal(history.mizukiCognition(A).totalScore, 100);assert.equal(history.mizukiCognition(A).totalCells, 120);
  record(history, 1, result, repeated);
  assert.equal(history.mizukiCognition(A).totalScore, 100);
});

test('permanent match-player receipts prevent score and cell replay after history rolls past ten and reloads', async t => {
  const file = fileFixture(t), history = new HistoryStore({ file, log });
  for (let number = 1; number <= 12; number++) record(history, number, summary(25, 30));
  assert.equal(history.list(A).length, 10);assert.equal(history.detail(A, matchId(1)), null);
  assert.equal(history.mizukiCognition(A).totalScore, 300);assert.equal(history.mizukiCognition(A).totalCells, 360);
  record(history, 1, summary(25, 30));
  assert.equal(history.mizukiCognition(A).totalScore, 300);
  await history.flush();
  const reopened = new HistoryStore({ file, log });
  record(reopened, 2, summary(25, 30));await reopened.flush();
  assert.equal(reopened.mizukiCognition(A).totalScore, 300);assert.equal(reopened.mizukiCognition(A).totalCells, 360);
  const saved = JSON.parse(readFileSync(file, 'utf8')).profiles.find(profile => profile.aid === A);
  assert.equal(saved.mizuki.cognitionReceipts.length, 12);
  assert.equal(new Set(saved.mizuki.cognitionReceipts).size, 12);
});

test('ending unlocks, cognition and real-time bank records survive updates and a disk reload together', async t => {
  const file = fileFixture(t), history = new HistoryStore({ file, log });
  history.updateMizukiBank(A, { current: 14, record: 20, totalPut: 25, revision: 1 });
  const first = summary(210, 250);first.victory = true;first.endingId = 'ro2_ending_1';
  first.players[0].victory = true;first.players[1].victory = true;record(history, 1, first);
  const second = summary(190, 228);second.victory = true;second.endingId = 'ro2_ending_2';
  second.players[0].victory = true;second.players[1].victory = true;record(history, 2, second);
  history.updateMizukiBank(A, { current: 10, record: 20, totalPut: 25, revision: 2 });
  await history.flush();
  const reopened = new HistoryStore({ file, log });
  assert.deepEqual(reopened.mizukiCognition(A), { ...normalizeCognition({ totalScore: 400 }), totalCells: 478 });
  assert.deepEqual(reopened.mizukiBank(A), { current: 10, record: 20, totalPut: 25, revision: 2 });
  assert.ok(reopened.mizukiEndingUnlocks(A).includes('ro2_ending_3'));
});

test('a fully purchased cognition tree continues receiving lifetime cells without granting extra tokens', () => {
  const history = new HistoryStore();record(history, 1, summary(MIZUKI_COGNITION_MAX_SCORE, 30000));
  const before = history.mizukiCognition(A);assert.equal(before.earnedTokens, 112);
  record(history, 2, summary(1000, 1300));
  const after = history.mizukiCognition(A);
  assert.equal(after.totalScore, MIZUKI_COGNITION_MAX_SCORE);assert.equal(after.earnedTokens, 112);
  assert.deepEqual(after.unlockedNodeIds, before.unlockedNodeIds);assert.equal(after.totalCells, 31300);
});

test('ordinary results and malformed score metadata cannot grant cognition or cells', () => {
  const history = new HistoryStore();
  const ordinary = summary();ordinary.variant = null;record(history, 1, ordinary);
  for (const [index, value] of [-1, 1.5, '200', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, undefined].entries()) {
    const invalid = summary();invalid.mizuki.explorationScore = value;record(history, index + 2, invalid);
  }
  assert.deepEqual(history.mizukiCognition(A), { ...normalizeCognition(), totalCells: 0 });
  assert.deepEqual(history.mizukiCognition('invalid-aid'), { ...normalizeCognition(), totalCells: 0 });
});

test('loading recomputes cognition fields and preserves cognition-only profiles without display history', t => {
  const file = fileFixture(t);
  writeFileSync(file, JSON.stringify({ version: 1, profiles: [{ aid: A, name: 'role', items: [],
    mizuki: { cognition: { totalScore: 400, earnedTokens: 999, tokens: 999, unlockedNodeIds: ['fake'] },
      totalCells: 600, cognitionReceipts: [matchId(1) + ':p0', 'bad', matchId(1) + ':p0'] } }] }));
  const history = new HistoryStore({ file, log });
  assert.deepEqual(history.mizukiCognition(A), { ...normalizeCognition({ totalScore: 400 }), totalCells: 600 });
  record(history, 1, summary(200, 300));
  assert.equal(history.mizukiCognition(A).totalScore, 400);assert.equal(history.mizukiCognition(A).totalCells, 600);
});

test('production profile history access synchronizes cognition and lifetime cells through its durable completion path', async t => {
  const file = fileFixture(t), dir = join(file, '..');
  const stores = { history: new HistoryStore({ file, log }), players: new PlayerStore({ file: join(dir, 'players.json'), log }),
    ranked: new RankedStore({ file: join(dir, 'ranked.json'), log }) };
  const config = { role: 'main', id: 'main', secret: '', accountFile: null, dataDir: dir,
    mainUrl: 'http://main.invalid', secondaryUrl: 'http://secondary.invalid',
    replicationFile: join(dir, 'replication.json'), pendingFile: join(dir, 'pending.json') };
  const access = createProfileAccess(config, stores, log);t.after(() => access.close());await access.ready();
  assert.deepEqual(access.history.mizukiCognition(A), { ...normalizeCognition(), totalCells: 0 });
  const value = { matchId: matchId(1), seats, ranked: false, summary: summary(320, 400) };
  await access.history.record(value);await access.history.record(value);
  assert.deepEqual(access.history.mizukiCognition(A), { ...normalizeCognition({ totalScore: 320 }), totalCells: 400 });
  assert.ok(access.replication.state.log.some(entry => entry.patch.aid === A && entry.patch.fields.history));
  assert.deepEqual(new HistoryStore({ file, log }).mizukiCognition(A), access.history.mizukiCognition(A));
});

function lobbyFixture(t, history) {
  const sessions = new Map(), ordinaryOptions = [];
  class OrdinaryMatch { constructor(options) { ordinaryOptions.push(options); } start() {} dispose() {} }
  const registry = { byId: id => sessions.get(id), all: () => sessions.values(), isExpired: () => false };
  const lobby = new Lobby({ registry, getData: () => data, MatchClass: OrdinaryMatch, seedFn: () => 512,
    now: () => 1_800_000_000_000, log, ranked: {}, history, players: { profiles: new Map() } });
  t.after(() => lobby.shutdown());
  const peer = (playerId, aid) => {
    const session = { playerId, aid, name: playerId, connected: true, profileReady: true, profileBound: true,
      roomCode: null, spectatorCode: null, ws: { readyState: 1, bufferedAmount: 0, send(_raw, done) { done?.(); }, terminate() {} } };
    sessions.set(playerId, session);return session;
  };
  return { lobby, peer, ordinaryOptions };
}

test('new Mizuki lobbies open the full tree for zero-score and experienced hosts without altering profiles', t => {
  const history = new HistoryStore();
  const result = summary();result.players[0].mizuki = { explorationScore: 400, cellPoints: 450 };
  result.players[1].mizuki = { explorationScore: 2000, cellPoints: 2500 };record(history, 1, result);
  const snapshots = [A, B, C].map(aid => history.mizukiCognition(aid));
  const cognition = normalizeCognition({ totalScore: MIZUKI_COGNITION_MAX_SCORE });
  const untouchedHistory = new Map([[A, snapshots[0]], [B, snapshots[1]], [C, snapshots[2]]]);
  const source = { mizukiCognition() { assert.fail('new runs must not use the host account to lock the tree'); },
    mizukiEndingUnlocks: aid => history.mizukiEndingUnlocks(aid) };
  for (const aid of [C, A, B]) {
    const { lobby, peer } = lobbyFixture(t, source), host = peer('p0', aid), mate = peer('p1', B);
    assert.equal(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', variant: MIZUKI_VARIANT, capacity: 2 }).ok, true);
    const room = lobby.roomOf(host);assert.equal(lobby.join(mate, { code: room.code }).ok, true);
    assert.equal(lobby.ready(mate, { ready: true }).ok, true);assert.equal(lobby.start(host).ok, true);
    assert.deepEqual(room.match.cognition, cognition);
    assert.equal(room.match.cognitionMods.rawNodes.length, 58);
    assert.equal(room.match.cognitionMods.sanRerollEnabled, true);
    assert.equal(room.match.cognitionMods.wishRerollEnabled, true);
    assert.equal(room.match.cognitionMods.portalUnlocked, true);
    assert.equal(room.match.cognitionMods.shopDiscount, .4);
    assert.equal(Object.hasOwn(room.match.opts, 'cognition'), false);
    assert.deepEqual(history.mizukiCognition(aid), untouchedHistory.get(aid));
  }
});

test('ordinary lobby match construction never reads or receives Mizuki cognition', t => {
  const history = { mizukiCognition() { assert.fail('ordinary matches must not query Mizuki profile state'); } };
  const { lobby, peer, ordinaryOptions } = lobbyFixture(t, history), host = peer('p0', A);
  assert.equal(lobby.create(host, { mode: 'solo', difficulty: 'NORMAL' }).ok, true);
  assert.equal(lobby.start(host).ok, true);
  assert.equal(ordinaryOptions.length, 1);assert.equal(Object.hasOwn(ordinaryOptions[0], 'cognition'), false);
});
