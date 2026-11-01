import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/index.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { PlayerStore } from '../server/playerStore.js';
import { TestClient } from './helpers/wsClient.js';
import { Net } from '../public/js/net.js';
import { MIZUKI_VARIANT } from '../shared/mizuki-constants.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };
const latest = (client, type) => client.log.findLast((message) => message.t === type);
function decodeTransport(client) {
  const decoder = new Net();
  decoder._stateDelta = true; decoder._stateCompact = true; decoder._stateStream = true;
  const append = client.log.push.bind(client.log);
  client.log.push = message => {
    const decoded = ['net.state', 'net.delta'].includes(message.t) ? decoder._decodeState(message) : message;
    return decoded ? append(decoded) : client.log.length;
  };
}
const ok = async (client, message) => {
  const reply = await client.request(message, 8000);
  assert.equal(reply.t, 'ok', message.t + ': ' + JSON.stringify(reply));
  return reply;
};
async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for network state');
    await delay(20);
  }
}

test('four authenticated clients confirm departure, prepare four automatic fields and reconnect to authoritative state', { timeout: 45000 }, async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, log,
    stateFile: null, accountFile: null, announcementFile: null, admin: false, studio: false, workerPool: null,
    ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }), players: new PlayerStore({ file: null }),
    profileConfig: { role: 'main', id: 'main', secret: '', accountFile: null,
      mainUrl: 'http://127.0.0.1', secondaryUrl: 'http://127.0.0.1' },
    ratePerSec: 1000, rateBurst: 2000, heavyPerSec: 1000, heavyBurst: 2000,
    bandwidthMbps: 10000,
  });
  const clients = [];
  t.after(async () => { await Promise.allSettled(clients.map((client) => client.terminate())); await server.close(); });
  const url = 'ws://127.0.0.1:' + server.port + '/ws';
  const suffix = randomBytes(3).toString('hex');
  const identities = [];
  for (let index = 0; index < 4; index++) {
    const client = await TestClient.connect(url);
    decodeTransport(client);
    clients.push(client);
    const name = 'Mz' + suffix + index;
    const welcome = await client.hello(name, undefined, { stateDelta: 1, stateCompact: 1, stateStream: 1,
      auth: { action: 'register', password: 'mizuki-isolated-network-test' } });
    client.id = welcome.playerId;
    identities.push({ name, welcome });
  }
  await ok(clients[0], { t: 'room.create', mode: 'coop', difficulty: 'NORMAL', variant: MIZUKI_VARIANT, capacity: 4, ranked: false });
  const roomState = await clients[0].waitFor('room.state', (message) => message.variant === MIZUKI_VARIANT, 8000);
  for (const client of clients.slice(1)) await ok(client, { t: 'room.join', code: roomState.code });
  for (const client of clients.slice(1)) await ok(client, { t: 'room.ready', ready: true });
  await ok(clients[0], { t: 'room.start' });
  const match = server.lobby.rooms.get(roomState.code).match;
  assert.equal(match.variant, MIZUKI_VARIANT);
  assert.equal(match.phase, 'MIZUKI_SQUAD');
  const chatId = server.lobby.rooms.get(roomState.code).matchCtx.matchId;
  for (const client of clients) {
    const history = await client.waitFor('chat.history', message => message.channel === 'match');
    assert.equal(history.matchId, chatId, 'exploration chat receives its authoritative channel before recruitment');
    assert.deepEqual(history.items, []);
  }
  const chatText = '节点外集合 ' + suffix;
  await ok(clients[0], { t: 'chat.send', channel: 'match', matchId: chatId, text: chatText });
  for (const client of clients) {
    const message = await client.waitFor('chat.message', value => value.channel === 'match' && value.text === chatText);
    assert.equal(message.matchId, chatId);
    assert.equal(message.playerId, clients[0].id);
  }
  const squads = match.publicView().mizuki.squads;
  assert.equal(squads.length, 13, 'all original base squads are selectable');
  assert.equal(new Set(squads.map((squad) => squad.id)).size, 13);
  assert.equal((await clients[0].request({ t: 'g.mizuki.squad', squadId: 'unknown_squad' })).t, 'error');
  for (const client of clients) await ok(client, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  assert.equal(match.phase, 'MIZUKI_STRATEGY');
  assert.equal(match.publicView().mizuki.selectedSquad.name, '指挥分队');
  const selectedStrategies = new Set();
  for (const client of clients) {
    const strategies = match.privateView(client.id).mizuki.strategy.options;
    assert.ok(strategies.length > 0, 'existing covenant strategy choices remain available');
    const strategy = strategies.find((choice) => !selectedStrategies.has(choice.bandId));
    await ok(client, { t: 'g.mizuki.strategy', bandId: strategy.bandId });
    selectedStrategies.add(strategy.bandId);
    assert.equal(match.players.get(client.id).bandId, strategy.bandId);
  }
  assert.equal(match.phase, 'MIZUKI_INITIAL_SUPPLY');
  for (const client of clients) await ok(client, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
  assert.equal(match.phase, 'MIZUKI_RECRUIT_GROUP');
  for (const client of clients) {
    assert.equal(match.privateView(client.id).mizuki.recruitGroup.options.length, 4);
    await ok(client, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  }
  assert.equal(match.phase, 'MIZUKI_RECRUIT');
  for (const client of clients) {
    let guard = 0;
    while (match.phase === 'MIZUKI_RECRUIT' && !match.players.get(client.id).ready && guard++ < 12) {
      const state = match.privateView(client.id).mizuki;
      const choices = state.recruit?.choices || [];
      const owned = new Set(state.roster.map((unit) => unit.chessId));
      const offer = choices.find((choice) => choice.hopeCost <= state.hope && choice.cost <= 10 && !owned.has(choice.chessId))
        || choices.find((choice) => choice.hopeCost <= state.hope && !owned.has(choice.chessId));
      await ok(client, { t: 'g.mizuki.recruit', offerId: offer?.offerId ?? state.recruit.skipToken });
    }
    assert.ok(guard < 12, 'initial ticket queue should converge');
  }
  assert.equal(match.phase, 'MIZUKI_ROUTE');
  const route = match.publicView().mizuki.route.find((node) => node.type === 'combat');
  assert.ok(route);
  for (const client of clients) await ok(client, { t: 'g.mizuki.route', nodeId: route.id });
  assert.equal(match.phase, 'MIZUKI_ROUTE', 'a final route vote does not bypass the split approval window');
  assert.equal(match.fields.size, 0);
  assert.equal((await clients[1].request({ t: 'g.mizuki.routeStart' })).t, 'error', 'only the leader can depart');
  await ok(clients[0], { t: 'g.mizuki.routeStart' });
  assert.equal(match.phase, 'PREP');
  assert.deepEqual([...match.fields.keys()], clients.map((client) => 'n:' + client.id));
  for (const client of clients) {
    const player = match.players.get(client.id);
    const lineup = player.roster.slice(0, match.squadCapacity).map((unit) => unit.uid);
    await ok(client, { t: 'g.mizuki.lineup', uids: lineup });
    assert.deepEqual(match.privateView(client.id).mizuki.lineup, lineup);
    for (const unit of player.roster) {
      const prep = match.privateView(client.id).mizuki.prep;
      const tile = prep.legalTiles[unit.uid].find(([row, col]) => !prep.board.some((piece) => piece.row === row && piece.col === col));
      assert.ok(tile, 'original map has a legal preparation tile for the operator');
      if (client === clients[0]) assert.equal((await clients[1].request({ t: 'g.mizuki.move', uid: unit.uid, to: { area: 'board', row: tile[0], col: tile[1] }, dir: 'RIGHT' })).t, 'error', 'preparation rejects another doctor operator UID');
      await ok(client, { t: 'g.mizuki.move', uid: unit.uid, to: { area: 'board', row: tile[0], col: tile[1] }, dir: 'RIGHT' });
    }
  }
  for (const field of match.fields.values()) {
    assert.equal(Object.values(field.engine.snapshot().rosters).flat().filter((unit) => unit.deployed).length, 0);
    assert.match(field.engine.fieldMeta().stageId, /^ro2_/);
    assert.equal(field.engine.battle.flags.dpInit, 10);
    assert.ok(field.engine.officialWaves, 'original action scheduler, no autochess fallback');
    assert.equal(field.engine.automatic, true); assert.equal(field.engine.battle.started, false);
  }
  for (const client of clients) await ok(client, { t: 'g.mizuki.ready', on: true });
  assert.equal(match.phase, 'COMBAT');
  const fieldA = match.fields.get('n:' + clients[0].id);
  const fieldB = match.fields.get('n:' + clients[3].id);
  const first = match.players.get(clients[0].id).roster[0];
  const teammate = match.players.get(clients[1].id).roster[0];
  assert.ok(first && teammate);
  for (const message of [
    { t: 'g.mizuki.deploy', battleId: fieldB.battleId, uid: first.uid, row: 3, col: 3, dir: 'RIGHT' },
    { t: 'g.mizuki.deploy', battleId: fieldA.battleId, uid: teammate.uid, row: 3, col: 3, dir: 'RIGHT' },
  ]) assert.equal((await clients[0].request(message)).t, 'error', 'cross-field and teammate commands must be rejected');
  // Periodic battle updates use b.snap; m.public is the reliable match/HUD
  // baseline and may still contain the initial undeployed preparation state.
  await until(() => clients.every(client => client.log.findLast(message => message.t === 'b.snap'
    && message.fieldId === 'n:' + client.id)?.rosters[client.id]?.some(unit => unit.deployed)));
  const ownUnit = fieldA.engine.snapshot().rosters[clients[0].id].find((unit) => unit.deployed);
  for (const type of ['deploy', 'retreat', 'skill']) assert.equal((await clients[0].request({ t: 'g.mizuki.' + type, battleId: fieldA.battleId, uid: ownUnit.uid, row: 1, col: 2, dir: 'RIGHT' })).t, 'error', 'automatic combat rejects manual ' + type);
  assert.equal(fieldA.engine.snapshot().rosters[clients[0].id].find((unit) => unit.uid === ownUnit.uid).deployed, true);
  assert.equal(fieldA.engine.snapshot().controlMode, 'automatic');
  assert.ok(fieldA.engine.snapshot().units.filter((unit) => unit.side === 'ally').every((unit) => !unit.skill?.manual));
  const before = fieldB.engine.snapshot().rosters[clients[3].id].find((unit) => unit.deployed);
  await clients[3].terminate();
  await until(() => !match.players.get(clients[3].id).connected);
  const resumed = await TestClient.connect(url); clients.push(resumed);
  decodeTransport(resumed);
  const identity = identities[3];
  const welcome = await resumed.hello(identity.name, identity.welcome.token,
    { stateDelta: 1, stateCompact: 1, stateStream: 1, auth: { action: 'login', ticket: identity.welcome.authTicket } });
  resumed.id = welcome.playerId;
  const chatHistory = await resumed.waitFor('chat.history', message => message.channel === 'match');
  assert.equal(chatHistory.matchId, chatId);
  assert.ok(chatHistory.items.some(message => message.text === chatText), 'exploration messages survive combat entry and reconnect');
  assert.equal(resumed.id, clients[3].id);
  await until(() => latest(resumed, 'm.public')?.variant === MIZUKI_VARIANT, 8000);
  const restored = latest(resumed, 'm.public');
  assert.equal(restored.mizuki.fields.length, 4);
  const after = restored.mizuki.fields.find((field) => field.fieldId === 'n:' + resumed.id).rosters[resumed.id];
  assert.equal(after.find((unit) => unit.uid === before.uid).deployed, true);
  assert.equal(after.filter((unit) => unit.uid === before.uid).length, 1, 'reconnect cannot duplicate operators');
  assert.equal(match.players.get(resumed.id).connected, true);
});
