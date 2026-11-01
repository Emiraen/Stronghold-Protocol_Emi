import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { Lobby, Room } from '../server/lobby.js';
import { getData } from '../server/data.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { Match as OrdinaryMatch } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { captureMatch, encodeMatchCapture, restoreMatch, snapshotMatch } from '../server/match/snapshot.js';
import { roomDoc } from '../server/persist.js';
import { restoreLobbyRooms } from '../server/matchRestore.js';
import { validateC2S } from '../shared/protocol.js';
import { ERR, DIFFICULTIES } from '../shared/constants.js';
import { MIZUKI_VARIANT, MIZUKI_MODE_ID, MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const data = getData({ log: quiet });
const ok = (result) => assert.equal(result?.ok, true, JSON.stringify(result));

// Real Lobby/Room, inert sessions and stores: no sockets or persistent user I/O.
function lobbyFixture(t) {
  const sessions = new Map(), frames = [], errors = [];
  let ordinaryCalls = 0;
  class UnexpectedOrdinaryMatch {
    constructor() { ordinaryCalls++; throw new Error('Mizuki must bypass ordinary MatchClass'); }
  }
  const registry = { byId: (id) => sessions.get(id), all: () => sessions.values(), isExpired: () => false };
  const lobby = new Lobby({ registry, getData: () => data, MatchClass: UnexpectedOrdinaryMatch,
    seedFn: () => 12345, now: () => 1_800_000_000_000,
    log: { ...quiet, error: (...args) => errors.push(args.map(String).join(' ')) },
    ranked: {}, history: {}, players: { profiles: new Map() } });
  t.after(() => lobby.shutdown());
  const peer = (index) => {
    const playerId = 'mizuki_p' + index;
    const session = { playerId, name: 'Mizuki ' + index, aid: 'mzaid' + index, connected: true,
      profileReady: true, profileBound: true, roomCode: null, spectatorCode: null,
      ws: { readyState: 1, bufferedAmount: 0, send(raw, done) { frames.push({ playerId, message: JSON.parse(raw) }); done?.(); }, terminate() {} } };
    sessions.set(playerId, session); return session;
  };
  const create = (capacity = undefined, overrides = {}) => {
    const host = peer(0), message = { mode: 'coop', difficulty: 'NORMAL', variant: MIZUKI_VARIANT,
      ...(capacity === undefined ? {} : { capacity }), ...overrides };
    const result = lobby.create(host, message);
    return { host, result, room: lobby.roomOf(host), message };
  };
  const fill = (room, count) => {
    const peers = [sessions.get(room.hostId)];
    for (let i = 1; i < count; i++) { const p = peer(i); ok(lobby.join(p, { code: room.code })); ok(lobby.ready(p, { ready: true })); peers.push(p); }
    return peers;
  };
  return { lobby, sessions, frames, errors, peer, create, fill, ordinaryCalls: () => ordinaryCalls };
}

function matchFixture(t, count = 4) {
  const scheduler = new VirtualScheduler(), frames = [], errors = [];
  const seats = Array.from({ length: count }, (_, seat) => ({ seat, playerId: 'p' + seat, name: 'P' + seat, connected: true, isBot: false }));
  const match = new MizukiMatch({ roomCode: 'MZAA', seed: 222, matchNo: 1, matchId: 'mizuki-test', hostId: 'p0', seats,
    data, scheduler, send: (playerId, message) => frames.push({ playerId, message }), broadcast: (message) => frames.push({ message }),
    onEnd() {}, log: { ...quiet, error: (...args) => errors.push(args) } });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  return { match, scheduler, seats, frames, errors };
}

function skipRecruit(match) {
  if (match.phase === PHASE.SQUAD) {
    const squadId = match.publicView().mizuki.squads[0].id;
    for (const player of match.order) ok(match.handle(player.playerId, { t: 'g.mizuki.squad', squadId }));
  }
  if (match.phase === PHASE.STRATEGY) for (const [index, player] of match.order.entries()) {
    const bandId = match.publicView().mizuki.strategyOptions[index].bandId;
    ok(match.handle(player.playerId, { t: 'g.mizuki.strategy', bandId }));
  }
  if (match.phase === PHASE.INITIAL_SUPPLY) {
    for (const player of match.order) ok(match.handle(player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' }));
  }
  if (match.phase === PHASE.RECRUIT_GROUP) {
    const groupId = match.publicView().mizuki.recruitGroups.find((group) => !group.disabled).id;
    for (const player of match.order) ok(match.handle(player.playerId, { t: 'g.mizuki.recruitGroup', groupId }));
  }
  for (let turn = 0; match.phase === PHASE.RECRUIT && turn < 32; turn++) {
    for (const player of match.order) {
      if (match.phase !== PHASE.RECRUIT || player.ready) continue;
      const recruit = match.privateView(player.playerId).mizuki.recruit;
      const choices = recruit.choices
        .filter((choice) => choice.available).sort((a, b) => a.hopeCost - b.hopeCost || a.cost - b.cost);
      ok(match.handle(player.playerId, { t: 'g.mizuki.recruit', offerId: choices[0]?.offerId ?? recruit.skipToken }));
    }
  }
  assert.equal(match.phase, PHASE.ROUTE);
}

test('Mizuki room accepts one through four humans, defaults to four, and publishes dedicated modeId', (t) => {
  for (const [capacity, expected] of [[undefined, 4], [1, 1], [2, 2], [3, 3], [4, 4]]) {
    const f = lobbyFixture(t), { host, room, result, message } = f.create(capacity);
    ok(result); assert.equal(validateC2S({ t: 'room.create', ...message }), null);
    assert.ok(room instanceof Room); assert.equal(room.capacity, expected); assert.equal(room.seats.length, expected);
    assert.equal(room.variant, MIZUKI_VARIANT); assert.equal(room.ranked, false); assert.equal(room.difficulty, 'NORMAL');
    assert.equal(room.toState().capacity, expected);
    f.lobby.recruitmentRooms.set(room.code, f.lobby.now());
    const listing = f.lobby.recruitmentItems().find((item) => item.code === room.code);
    if (expected > 1) assert.equal(listing.modeId, MIZUKI_MODE_ID);
    else assert.equal(listing, undefined); // A full one-person room needs no recruitment.
    assert.equal(f.lobby.roomOf(host), room);
  }
});

test('Mizuki rejects unsupported capacity, solo, rank, difficulty and unrelated erosion without creating rooms', (t) => {
  for (const overrides of [{ capacity: 0 }, { capacity: 5 }, { capacity: 8 }, { capacity: 12 },
    { mode: 'solo' }, { ranked: true }, { difficulty: 'HARD' }, { difficulty: 'FUNNY' },
    { difficulty: 'ANNIHILATION' }, { erosion: 1 }]) {
    const f = lobbyFixture(t), { result, room } = f.create(undefined, overrides);
    assert.equal(result.error, ERR.BAD_MSG, JSON.stringify(overrides));
    assert.equal(room, null); assert.equal(f.lobby.rooms.size, 0);
  }
  assert.deepEqual(DIFFICULTIES, ['FUNNY', 'NORMAL', 'HARD', 'ABYSS']);
});

test('Mizuki lobby restricts capacity, AI, plugins and difficulty while preserving occupied seats', (t) => {
  const f = lobbyFixture(t), { host, room, result } = f.create(); ok(result);
  ok(f.lobby.setCapacity(host, { capacity: 2 })); assert.equal(room.capacity, 2);
  assert.equal(f.lobby.setCapacity(host, { capacity: 8 }).error, ERR.BAD_MSG);
  assert.equal(f.lobby.addBot(host).error, ERR.BAD_TARGET);
  assert.equal(f.lobby.setPlugins(host, { plugins: [] }).error, ERR.PLUGIN_BLOCKED);
  assert.equal(f.lobby.setDifficulty(host, { difficulty: 'HARD' }).error, ERR.BAD_TARGET);
  ok(f.lobby.setDifficulty(host, { difficulty: 'NORMAL' }));
  ok(f.lobby.setCapacity(host, { capacity: 4 }));
  const peers = f.fill(room, 4);
  assert.equal(f.lobby.setCapacity(peers[1], { capacity: 2 }).error, ERR.NOT_HOST);
  assert.equal(f.lobby.setCapacity(host, { capacity: 2 }).error, ERR.ROOM_FULL);
  assert.equal(room.capacity, 4); assert.equal(room.seats.filter(Boolean).length, 4);
});

test('actual Lobby start selects MizukiMatch for one through four humans, bypassing default MatchClass', (t) => {
  for (const count of [1, 2, 3, 4]) {
    const f = lobbyFixture(t), { host, room, result } = f.create(count); ok(result);
    f.fill(room, count); ok(f.lobby.start(host));
    assert.ok(room.match instanceof MizukiMatch); assert.equal(f.ordinaryCalls(), 0);
    assert.equal(room.match.modeId, MIZUKI_MODE_ID); assert.equal(room.match.clientCombat, false);
    assert.equal(room.match.phase, PHASE.SQUAD); assert.equal(room.match.order.length, count);
    assert.equal(room.matchCtx.ranked, false); assert.deepEqual(f.errors, []);
    assert.deepEqual(room.match.order.map((p) => p.fieldId), Array.from({ length: count }, (_, i) => 'n:mizuki_p' + i));
  }
});

test('Mizuki start refuses unfilled rooms before constructing a match', (t) => {
  for (const [capacity, count] of [[2, 1], [4, 1], [4, 2], [4, 3]]) {
    const f = lobbyFixture(t), { host, room, result } = f.create(capacity); ok(result);
    f.fill(room, count); assert.equal(f.lobby.start(host).error, ERR.NOT_READY);
    assert.equal(room.match, null); assert.equal(f.ordinaryCalls(), 0); assert.deepEqual(f.errors, []);
  }
});

test('actual Lobby routes authoritative prep moves and rejects teammate units and combat manual intents', async (t) => {
  const f = lobbyFixture(t), { host, room, result } = f.create(4); ok(result);
  const peers = f.fill(room, 4); ok(f.lobby.start(host));
  const match = room.match;
  assert.equal((await f.lobby.routeGame(host, { t: 'g.buy', slot: 0 })).error, ERR.BAD_TARGET);
  skipRecruit(match);
  const nodeId = match.route.find((node) => node.type === 'combat').id;
  for (const peer of peers) ok(await f.lobby.routeGame(peer, { t: 'g.mizuki.route', nodeId }));
  ok(await f.lobby.routeGame(host, { t: 'g.mizuki.routeStart' }));
  assert.equal(match.phase, PHASE.PREP);
  const uid = match.players.get(host.playerId).roster[0].uid;
  const initial = match.fields.get('n:' + host.playerId);
  const def = match.ds.getChess(match.players.get(host.playerId).roster[0].chessId);
  const tile = initial.engine.snapshot().geometry.tiles.find((entry) => !entry.obstacle
    && initial.engine.battle.grid.canStand(entry.row, entry.col, { ranged: def.position === 'RANGED' }));
  const move = { t: 'g.mizuki.move', uid, to: { area: 'board', row: tile.row, col: tile.col }, dir: 'RIGHT' };
  const before = structuredClone(match.players.get(host.playerId).prep);
  assert.equal((await f.lobby.routeGame(host, { ...move, uid: match.players.get(peers[1].playerId).roster[0].uid })).error, ERR.BAD_TARGET);
  assert.deepEqual(match.players.get(host.playerId).prep, before);
  ok(await f.lobby.routeGame(host, move));
  for (const peer of peers) ok(await f.lobby.routeGame(peer, { t: 'g.mizuki.ready', on: true }));
  assert.equal(match.phase, PHASE.COMBAT);
  const fieldA = match.fields.get('n:' + host.playerId), fieldB = match.fields.get('n:' + peers[1].playerId);
  assert.equal(fieldA.engine.automatic, true);
  fieldA.engine.step(); // The first ordinary server tick deploys without a player command.
  const actor = fieldA.engine.battle.getPlayer(host.playerId).units.find((unit) => unit.uid === uid);
  assert.equal(actor.deployed, true);
  const command = { t: 'g.mizuki.deploy', battleId: fieldA.battleId, uid, row: tile.row, col: tile.col, dir: 'RIGHT' };
  for (const t of ['g.mizuki.deploy', 'g.mizuki.retreat', 'g.mizuki.skill'])
    assert.equal((await f.lobby.routeGame(host, { ...command, t })).error, ERR.WRONG_PHASE);
  assert.equal((await f.lobby.routeGame(host, move)).error, ERR.WRONG_PHASE);
  assert.equal(fieldB.engine.battle.getPlayer(peers[1].playerId).units.some((unit) => unit.uid === uid), false);
});

test('Mizuki protocol requires battle ids and legal deployment; ordinary mode rejects Mizuki intents', (t) => {
  const valid = { t: 'g.mizuki.deploy', battleId: 'test.1.mizuki_a', uid: 10001, row: 9, col: 4, dir: 'RIGHT' };
  assert.equal(validateC2S(valid), null);
  for (const patch of [{ battleId: undefined }, { uid: -1 }, { row: 19 }, { col: 21 }, { dir: 'FORWARD' }]) {
    assert.notEqual(validateC2S({ ...valid, ...patch }), null, JSON.stringify(patch));
  }
  assert.notEqual(validateC2S({ t: 'g.mizuki.skill', uid: 10001 }), null);
  const { match } = matchFixture(t, 2); match.start();
  assert.equal(match.handle('p0', { t: 'g.buy', slot: 0 }).error, ERR.BAD_TARGET);
  assert.equal(match.handle('p0', { t: 'g.move', uid: 10001, to: { zone: 'board', row: 9, col: 5 } }).error, ERR.WRONG_PHASE);
  const scheduler = new VirtualScheduler();
  const ordinary = new OrdinaryMatch({ roomCode: 'VAAA', mode: 'coop', difficulty: 'NORMAL', seed: 5,
    seats: [{ seat: 0, playerId: 'p0', name: 'P0', connected: true }], data, scheduler,
    send() {}, broadcast() {}, onEnd() {}, log: quiet });
  t.after(() => { ordinary.dispose(); scheduler.dispose(); }); ordinary.start();
  assert.equal(ordinary.handle('p0', { t: 'g.mizuki.route', nodeId: 'node_0_0' }).error, ERR.BAD_MSG);
});

test('all four squad and route voters participate; 2:2 ties follow host and clear old votes', (t) => {
  const { match } = matchFixture(t); match.start();
  ok(match.handle('p0', { t: 'g.mizuki.importDungeon', dungeon: { zones: [{ id: 'zone_1', nodes: [
    { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
    { pos: { x: 0, y: 1 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [] },
  ] }] } }));
  const squads = match.publicView().mizuki.squads;
  for (const [pid, id] of [['p0', squads[0].id], ['p1', squads[1].id], ['p2', squads[1].id]]) {
    ok(match.handle(pid, { t: 'g.mizuki.squad', squadId: id }));
  }
  assert.equal(match.phase, PHASE.SQUAD);
  ok(match.handle('p3', { t: 'g.mizuki.squad', squadId: squads[0].id }));
  assert.equal(match.selectedSquad.id, squads[0].id);
  skipRecruit(match);
  const combat = match.route.find((node) => node.type === 'combat' && !node.disabled);
  const other = match.route.find((node) => node.id !== combat.id && !node.disabled);
  ok(match.handle('p0', { t: 'g.mizuki.route', nodeId: combat.id }));
  ok(match.handle('p1', { t: 'g.mizuki.route', nodeId: other.id }));
  ok(match.handle('p2', { t: 'g.mizuki.route', nodeId: other.id }));
  assert.equal(match.phase, PHASE.ROUTE); assert.equal(Object.keys(match.votes).length, 3);
  ok(match.handle('p3', { t: 'g.mizuki.route', nodeId: combat.id }));
  assert.equal(match.phase, PHASE.ROUTE);
  ok(match.handle('p0', { t: 'g.mizuki.routeStart' }));
  assert.equal(match.phase, PHASE.PREP); assert.equal(match.currentNode.id, combat.id); assert.deepEqual(match.votes, {});
  assert.match(match.publicView().mizuki.voteRule, /平票.*房主/);
  assert.deepEqual(match.votes, {});
});

test('checkpoint capture crosses real Worker and restores route votes, roster ownership and resources', async (t) => {
  const { match } = matchFixture(t); match.start(); skipRecruit(match);
  ok(match.handle('p0', { t: 'g.mizuki.route', nodeId: match.route[0].id }));
  match.players.get('p0').gold = 17;
  const capture = captureMatch(match); assert.equal(capture.doc.engine, 'mizuki');
  const url = new URL('../server/match/snapshot.js', import.meta.url).href;
  const script = 'const {parentPort}=require("node:worker_threads"); parentPort.on("message",async capture=>{try{const {encodeMatchCapture}=await import(' + JSON.stringify(url) + ');parentPort.postMessage({ok:true,doc:encodeMatchCapture(capture)});}catch(e){parentPort.postMessage({ok:false,error:String(e)});}});';
  const worker = new Worker(script, { eval: true }); t.after(() => worker.terminate());
  const encoded = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.postMessage(capture); });
  assert.equal(encoded.ok, true, encoded.error); assert.deepEqual(encoded.doc, encodeMatchCapture(structuredClone(capture)));
  assert.equal(encoded.doc.modeId, MIZUKI_MODE_ID); assert.equal(encoded.doc.players.length, 4);
  const restored = matchFixture(t).match;
  assert.equal(restoreMatch(restored, encoded.doc, { log: quiet }), true);
  assert.equal(restored.phase, PHASE.ROUTE); assert.deepEqual(restored.votes, match.votes);
  assert.equal(restored.players.get('p0').gold, 17);
  assert.deepEqual(restored.order.map((p) => p.roster.map((u) => u.uid)), match.order.map((p) => p.roster.map((u) => u.uid)));
  assert.equal(restored.order[2].fieldId, 'n:p2');
  const corrupt = structuredClone(encoded.doc); corrupt.players[1].roster[0].uid = corrupt.players[0].roster[0].uid;
  assert.equal(restoreMatch(matchFixture(t).match, corrupt, { log: quiet }), false);
});

test('combat is excluded from persistence; explicit safe restore returns to empty PREP fields', (t) => {
  const { match } = matchFixture(t); match.start(); skipRecruit(match);
  const node = match.route.find((entry) => entry.type === 'combat');
  for (const player of match.order) ok(match.handle(player.playerId, { t: 'g.mizuki.route', nodeId: node.id }));
  ok(match.handle('p0', { t: 'g.mizuki.routeStart' }));
  assert.equal(match.phase, PHASE.PREP); assert.equal(match.fields.size, 4);
  const checkpoint = snapshotMatch(match); assert.equal(checkpoint.phase, PHASE.PREP);
  for (const player of match.order) ok(match.handle(player.playerId, { t: 'g.mizuki.ready', on: true }));
  assert.equal(match.phase, PHASE.COMBAT); assert.equal(snapshotMatch(match), null); assert.equal(captureMatch(match), null);
  const safe = match.exportCheckpoint(); assert.equal(safe.phase, PHASE.PREP); assert.ok(safe.players.every((p) => !p.ready));
  const restored = matchFixture(t).match; assert.equal(restoreMatch(restored, safe, { log: quiet }), true);
  assert.equal(restored.phase, PHASE.PREP); assert.equal(restored.fields.size, 4);
  for (const field of restored.fields.values()) assert.deepEqual(field.engine.snapshot().units, []);
});

test('Mizuki room documents restore variant/capacity without plugins or persistent users', (t) => {
  const source = lobbyFixture(t), { room, result } = source.create(4); ok(result); source.fill(room, 4);
  const doc = roomDoc(room), target = lobbyFixture(t);
  for (const [id, session] of source.sessions) target.sessions.set(id, { ...session, roomCode: room.code });
  const restored = restoreLobbyRooms(target.lobby, [structuredClone(doc)], { Room });
  assert.ok(restored); const restoredRoom = target.lobby.getRoom(room.code);
  assert.ok(restoredRoom); assert.equal(restoredRoom.variant, MIZUKI_VARIANT); assert.equal(restoredRoom.capacity, 4);
  assert.equal(restoredRoom.ranked, false); assert.equal(restoredRoom.seats.filter(Boolean).length, 4);
});

test('Mizuki never appears in public spectator listings and refuses direct lobby observation', (t) => {
  const f = lobbyFixture(t), { host, room, result } = f.create(1); ok(result); ok(f.lobby.start(host));
  const visitor = f.peer(9);
  assert.equal(f.lobby.spectatorItems().some((entry) => entry.code === room.code), false);
  assert.equal(f.lobby.joinSpectator(visitor, { code: room.code, matchId: room.matchCtx.matchId }).error, ERR.SPECTATOR);
  assert.equal(visitor.spectatorCode, null); assert.equal(room.spectators.size, 0);
  assert.equal(room.match.observers.size, 0);
  // Old saved spectator leases cannot bypass the same rule on reconnect.
  room.spectators.add(visitor.playerId); room.match.observers.add(visitor.playerId);
  visitor.spectatorCode = room.code; visitor.spectatorMatchId = room.matchCtx.matchId;
  assert.equal(f.lobby.spectatorRoom(visitor), null);
  assert.equal(visitor.spectatorCode, null); assert.equal(room.spectators.size, 0);
  assert.equal(room.match.observers.size, 0);
});

test('spectator filtering also removes remote Mizuki listings while ordinary lobby observation still works', (t) => {
  const f = lobbyFixture(t), host = f.peer(10), visitor = f.peer(11);
  ok(f.lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }));
  const room = f.lobby.roomOf(host), seen = [];
  room.matchCtx = { live: true, matchId: 'ordinary-live', ranked: false, startedAt: f.lobby.now() };
  room.match = { publicView: () => ({ round: 1, phase: 'PREP', players: [] }),
    addObserver: (id) => seen.push(id), removeObserver() {}, dispose() {} };
  assert.equal(f.lobby.spectatorItems().some((entry) => entry.code === room.code), true);
  ok(f.lobby.joinSpectator(visitor, { code: room.code, matchId: 'ordinary-live' }));
  assert.deepEqual(seen, [visitor.playerId]);
  assert.equal(f.lobby.spectatorRoom(visitor), room);
  const remote = Object.freeze({ items: Object.freeze([{ code: 'REMOTE_MZ', variant: MIZUKI_VARIANT },
    { code: 'REMOTE_NORMAL', variant: null }]), serverId: 'remote' });
  f.lobby.profiles = { spectatorDirectory: () => remote };
  ok(f.lobby.listSpectators(visitor, { rid: 51 }));
  const listing = f.frames.filter((frame) => frame.message.t === 'spectator.list').at(-1).message;
  assert.deepEqual(listing.items.map((item) => item.code), ['REMOTE_NORMAL']);
  assert.equal(remote.items.length, 2);
});
