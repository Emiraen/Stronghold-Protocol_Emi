import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { getData } from '../server/data.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { RealScheduler } from '../server/match/scheduler.js';
import { INTERVAL_MS } from '../server/match/fields.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { Network, SessionRegistry, encode, sendRaw, sendOptions } from '../server/net.js';

const target = process.argv[2], roomsCount = Number(process.argv.find(arg => arg.startsWith('--rooms='))?.split('=')[1] || 2);
const seconds = Number(process.argv.find(arg => arg.startsWith('--seconds='))?.split('=')[1] || 10);
const legacy = process.argv.includes('--legacy'), bandwidthMbps = Number(process.argv.find(arg => arg.startsWith('--bandwidth='))?.split('=')[1] || 3);
const cold = process.argv.includes('--cold');
if (!Number.isInteger(roomsCount) || roomsCount < 1 || roomsCount > 8 || !Number.isFinite(seconds) || seconds < 1 || seconds > 60) throw new Error('Invalid benchmark bounds');
const data = getData({ log: { info() {}, warn() {}, error() {} } }), rooms = [], clients = [], sockets = [], stats = [];
const scheduler = new RealScheduler({ onError: error => { throw error; } });
const network = new Network({ registry: new SessionRegistry(), handler: {}, options: { bandwidthMbps },
  tcpMetrics: { register() {}, remove() {}, get() { return null; }, close() {} } });
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: {
  serverNoContextTakeover: true, clientNoContextTakeover: true, threshold: 192, concurrencyLimit: 4,
  zlibDeflateOptions: { level: 9, memLevel: 7 }, zlibInflateOptions: { chunkSize: 16 * 1024 },
} });
let measuring = false;
const summarize = values => { const sorted = values.slice().sort((a, b) => a - b); return {
  p50Ms: sorted[Math.floor(sorted.length * .5)] || 0, p95Ms: sorted[Math.floor(sorted.length * .95)] || 0,
  p99Ms: sorted[Math.floor(sorted.length * .99)] || 0, maxMs: sorted.at(-1) || 0 }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
wss.on('connection', (ws, request) => {
  const index = Number(request.url.slice(1)), room = Math.floor(index / 4);
  sockets[index] = ws; network.handleConnection(ws, request);
  const conn = network.conns.get(ws), old = legacy && index === 0;
  conn.deltaEnabled = !old; conn.compactEnabled = !old; conn.streamEnabled = !old; conn.fieldMetadataEnabled = !old;
  const original = ws.send.bind(ws);
  ws.send = (message, ...args) => {
    if (measuring) { stats[room].payloadBytes += Buffer.byteLength(message); stats[room].frames++; }
    return original(message, ...args);
  };
});
try {
  if (!wss.address()) await once(wss, 'listening');
  const port = wss.address().port;
  for (let index = 0; index < roomsCount * 4; index++) {
    const record = { index, room: Math.floor(index / 4), legacy: legacy && index === 0, fields: {}, pingMs: [], payloadBytes: 0 };
    const client = new WebSocket('ws://127.0.0.1:' + port + '/' + index, { perMessageDeflate: true });
    client.on('message', buffer => {
      if (!measuring) return;
      record.payloadBytes += buffer.byteLength;
      const message = JSON.parse(buffer.toString()), key = message.k || (message.t === 'b.snap' ? 'b.snap:' + message.fieldId : '');
      if (key.startsWith('b.snap:')) record.fields[key] = (record.fields[key] || 0) + 1;
    });
    client.on('pong', buffer => { if (measuring) record.pingMs.push(performance.now() - Number(buffer.toString())); });
    clients.push({ client, record }); await once(client, 'open');
  }
  for (let room = 0; room < roomsCount; room++) {
    const ids = Array.from({ length: 4 }, (_, seat) => `r${room}p${seat}`), peers = sockets.slice(room * 4, room * 4 + 4);
    const record = { room, rawBytes: 0, payloadBytes: 0, frames: 0, callbackMs: [] }; stats.push(record);
    const send = (message, targets) => {
      const encoded = encode(message), options = sendOptions(message);
      if (measuring) record.rawBytes += Buffer.byteLength(encoded) * targets.length;
      for (const ws of targets) sendRaw(ws, encoded, options);
    };
    const match = new MizukiMatch({ roomCode: 'TCP' + room, seed: 619, matchId: 'mizuki-tcp-' + room, hostId: ids[0],
      seats: ids.map((playerId, seat) => ({ playerId, seat, connected: true })), data, scheduler,
      log: { info() {}, warn() {}, error(...args) { throw new Error(args.map(String).join(' ')); } },
      send: (id, message) => send(message, [peers[ids.indexOf(id)]]), broadcast: message => send(message, peers), onEnd() {} });
    rooms.push(match);
    const command = (id, message) => { const result = match.handle(id, message); if (!result.ok) throw new Error(JSON.stringify({ id, message, result })); };
    const tick = match._tickBattle.bind(match);
    match._tickBattle = () => { const start = performance.now(); tick(); if (measuring) record.callbackMs.push(performance.now() - start); };
    match.start();
    for (const player of match.order) command(player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
    for (const [index, player] of match.order.entries()) command(player.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[index].bandId });
    for (const player of match.order) command(player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
    for (const player of match.order) command(player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
    for (const player of match.order) while (match.phase === PHASE.RECRUIT && !player.ready) command(player.playerId,
      { t: 'g.mizuki.recruit', offerId: match.privateView(player.playerId).mizuki.recruit.skipToken });
    const operators = match.fullCatalog.operators.filter(operator => operator.rarity === 4).slice(0, 6);
    if (operators.length !== 6) throw new Error('Six four-star operators required');
    for (const player of match.order) for (const operator of operators) match._grantMetaChess(player, operator.operatorId);
    const route = match.privateView(ids[0]).mizuki.route.find(node => node.type === 'combat' && node.available);
    for (const player of match.order) command(player.playerId, { t: 'g.mizuki.route', nodeId: route.id });
    command(ids[0], { t: 'g.mizuki.routeStart' });
    for (const player of match.order) for (const unit of player.roster) {
      const prep = match.privateView(player.playerId).mizuki.prep;
      const [row, col] = prep.legalTiles[unit.uid].find(([r, c]) => !prep.board.some(piece => piece.row === r && piece.col === c));
      command(player.playerId, { t: 'g.mizuki.move', uid: unit.uid, to: { area: 'board', row, col }, dir: 'RIGHT' });
    }
    for (const player of match.order) command(player.playerId, { t: 'g.mizuki.ready', on: true });
    if (!cold) match._stopBattle();
  }
  const setupDrainAt = performance.now();
  const startupRawBufferedBytes = sockets.reduce((sum, ws) => sum + ws.bufferedAmount, 0);
  if (!cold) {
    // Setup issues hundreds of reliable user actions synchronously, unlike a
    // paced human session. Measure that backlog separately before steady play.
    while (sockets.some(ws => ws.bufferedAmount > 0 || network.conns.get(ws).flow.queuedBytes > 0
      || network.conns.get(ws).bandwidth.interval() > network.conns.get(ws).bandwidth.baseMs)) {
      if (performance.now() - setupDrainAt > 20000) throw new Error('Synthetic setup did not drain in twenty seconds');
      await delay(50);
    }
    await delay(750);
    for (const match of rooms) { match.battleLastAt = scheduler.now(); match.battleTimer = scheduler.setInterval(() => match._tickBattle(), INTERVAL_MS); }
  }
  const setupDrainMs = performance.now() - setupDrainAt;
  await delay(1000);
  const tickStart = rooms.map(match => match.battleTicks), wireStart = sockets.map(ws => ws._socket.bytesWritten);
  const monitor = monitorEventLoopDelay({ resolution: 10 }); monitor.enable();
  const pingTimer = setInterval(() => { for (const { client } of clients) if (client.readyState === WebSocket.OPEN) client.ping(String(performance.now())); }, 500);
  const start = performance.now(), cpuStart = process.cpuUsage(); measuring = true;
  await delay(seconds * 1000);
  for (const match of rooms) match._stopBattle();
  await delay(300);
  const elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart); measuring = false;
  monitor.disable(); clearInterval(pingTimer);
  const activeMs = elapsedMs - 300;
  const clientResults = clients.map(({ record }, index) => ({ ...record,
    fields: Object.fromEntries(Object.entries(record.fields).map(([key, count]) => [key, count * 1000 / activeMs])),
    ping: summarize(record.pingMs), tcpBytes: sockets[index]._socket.bytesWritten - wireStart[index],
    flow: { factor: network.conns.get(sockets[index]).bandwidth.factor, bufferedAmount: sockets[index].bufferedAmount } }));
  for (const record of clientResults) delete record.pingMs;
  const rates = clientResults.filter(record => !record.legacy).flatMap(record => Object.values(record.fields));
  const output = { rooms: roomsCount, players: clients.length, legacyPeers: legacy ? 1 : 0, bandwidthMbps, cold, setupDrainMs, startupRawBufferedBytes, elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000, rawBytes: stats.reduce((sum, record) => sum + record.rawBytes, 0),
    payloadBytes: stats.reduce((sum, record) => sum + record.payloadBytes, 0), tcpBytes: clientResults.reduce((sum, record) => sum + record.tcpBytes, 0),
    eventLoop: { p95Ms: monitor.percentile(95) / 1e6, p99Ms: monitor.percentile(99) / 1e6, maxMs: monitor.max / 1e6 },
    fairness: { minModernHz: Math.min(...rates), maxModernHz: Math.max(...rates), ratio: Math.min(...rates) / Math.max(...rates) },
    roomResults: stats.map((record, index) => ({ ...record, callbackMs: summarize(record.callbackMs),
      battleTicks: rooms[index].battleTicks - tickStart[index], simulationRealtimeRatio: (rooms[index].battleTicks - tickStart[index]) / 60 / (activeMs / 1000) })),
    clientResults,
    note: 'Real Match/Network timers and localhost WebSockets; production deflate settings, six four-star operators each; includes WebSocket/TCP framing, excludes TLS/IP headers; synthetic authenticated-state setup, its reliable burst drains before steady measurement unless --cold.' };
  if (target) writeFileSync(target, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ ...output, clientResults: undefined, roomResults: output.roomResults.map(({ callbackMs, battleTicks, simulationRealtimeRatio }) => ({ callbackMs, battleTicks, simulationRealtimeRatio })) }, null, 2));
} finally {
  for (const match of rooms) match.dispose(); scheduler.dispose(); network.close();
  for (const { client } of clients) client.terminate();
  for (const ws of sockets) ws?.terminate();
  await new Promise(resolve => wss.close(resolve));
}
