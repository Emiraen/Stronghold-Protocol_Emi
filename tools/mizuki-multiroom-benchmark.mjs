import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Session } from 'node:inspector';
import { getData } from '../server/data.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { Network, SessionRegistry, encode, sendRaw, sendOptions } from '../server/net.js';

const roomsCount = Math.max(1, Math.min(8, Number(process.argv.find(value => value.startsWith('--rooms='))?.split('=')[1]) || 2));
const seconds = Math.max(1, Math.min(60, Number(process.argv.find(value => value.startsWith('--seconds='))?.split('=')[1]) || 10));
const target = process.argv[2], scheduler = new VirtualScheduler({ instantCombat: false });
const compact = process.argv.includes('--compact');
const stream = process.argv.includes('--stream');
const profileTarget = process.argv.find(value => value.startsWith('--profile='))?.slice('--profile='.length);
const log = { info() {}, warn() {}, error(...args) { throw new Error(args.map(String).join(' ')); } };
const data = getData({ log }), rooms = [], stats = [];
let measuring = false;
const summarize = values => { const sorted = values.slice().sort((a, b) => a - b); return {
  p50Ms: sorted[Math.floor(sorted.length * .5)] || 0, p95Ms: sorted[Math.floor(sorted.length * .95)] || 0,
  p99Ms: sorted[Math.floor(sorted.length * .99)] || 0, maxMs: sorted.at(-1) || 0 }; };
class MeterSocket extends EventEmitter {
  constructor(room) { super(); this.room = room; this.readyState = 1; this.bufferedAmount = 0; this.fields = {}; }
  send(encoded, callback) {
    if (measuring) {
      const record = stats[this.room]; record.wireFrames++; record.payloadBytes += Buffer.byteLength(encoded);
      const key = /"k":("(?:[^"\\]|\\.)*")/.exec(encoded.slice(0, 300));
      const name = key ? JSON.parse(key[1]) : 'other';
      if (name.startsWith('b.snap:')) this.fields[name] = (this.fields[name] || 0) + 1;
    }
    callback?.();
  }
  close(code = 1000, reason = '') { this.readyState = 3; this.emit('close', code, reason); }
  terminate() { this.close(1006); }
}
const network = new Network({ registry: new SessionRegistry(), handler: {},
  now: () => scheduler.now(), monotonicNow: () => scheduler.now(), options: { bandwidthMbps: 10000 },
  tcpMetrics: { register() {}, remove() {}, get() { return null; }, close() {} } });
scheduler.setInterval(() => { for (const conn of network.conns.values()) conn.flow.drain(); }, 25);
function setup(room) {
  const ids = Array.from({ length: 4 }, (_, seat) => `r${room}p${seat}`);
  const sockets = ids.map(() => new MeterSocket(room));
  for (const ws of sockets) { network.handleConnection(ws); const conn = network.conns.get(ws); conn.deltaEnabled = true;
    conn.compactEnabled = compact; conn.streamEnabled = compact && stream; conn.fieldMetadataEnabled = conn.streamEnabled; }
  const record = { room, rawBytes: 0, wireFrames: 0, payloadBytes: 0, snapshots: 0, callbackMs: [], fields: [] };
  stats.push(record);
  const send = (message, targets) => {
    const encoded = encode(message), options = sendOptions(message);
    if (measuring) record.rawBytes += Buffer.byteLength(encoded) * targets.length;
    for (const ws of targets) sendRaw(ws, encoded, options);
  };
  const match = new MizukiMatch({ roomCode: 'PRF' + room, seed: 619, matchId: 'mizuki-parallel-' + room, hostId: ids[0],
    seats: ids.map((playerId, seat) => ({ playerId, seat, connected: true })), data, scheduler, log,
    send: (id, message) => send(message, [sockets[ids.indexOf(id)]]), broadcast: message => send(message, sockets), onEnd() {} });
  const command = (id, message) => { const result = match.handle(id, message); if (!result.ok) throw new Error(JSON.stringify({ id, message, result })); };
  const tick = match._tickBattle.bind(match);
  match._tickBattle = () => { const start = performance.now(); tick(); if (measuring) record.callbackMs.push(performance.now() - start); };
  match.start();
  for (const player of match.order) command(player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  for (const [index, player] of match.order.entries()) command(player.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[index].bandId });
  for (const player of match.order) command(player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  for (const player of match.order) command(player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  for (const player of match.order) while (match.phase === PHASE.RECRUIT && !player.ready) {
    command(player.playerId, { t: 'g.mizuki.recruit', offerId: match.privateView(player.playerId).mizuki.recruit.skipToken });
  }
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
  for (const field of match.fields.values()) {
    const snapshot = field.engine.snapshot.bind(field.engine);
    field.engine.snapshot = (...args) => { if (measuring) record.snapshots++; return snapshot(...args); };
  }
  rooms.push({ match, sockets });
}
try {
  for (let room = 0; room < roomsCount; room++) setup(room);
  const profiler = profileTarget ? new Session() : null;
  const profileCall = method => new Promise((resolve, reject) => profiler.post(method, (error, value) => error ? reject(error) : resolve(value)));
  if (profiler) { profiler.connect(); await profileCall('Profiler.enable'); await profileCall('Profiler.start'); }
  const durations = [], start = performance.now(), cpuStart = process.cpuUsage();
  measuring = true;
  for (let tick = 0; tick < seconds * 30; tick++) {
    const at = performance.now(); scheduler.advance(1000 / 30); durations.push(performance.now() - at);
  }
  measuring = false;
  const elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
  if (profiler) { const result = await profileCall('Profiler.stop'); writeFileSync(profileTarget, JSON.stringify(result.profile)); profiler.disconnect(); }
  const roomResults = stats.map((record, room) => ({ room, players: 4, fields: rooms[room].match.fields.size,
    battleTicks: rooms[room].match.battleTicks, snapshots: record.snapshots, callback: summarize(record.callbackMs),
    rawBytes: record.rawBytes, payloadBytes: record.payloadBytes, aggregateMbps: record.payloadBytes * 8 / seconds / 1e6,
    deliveredHzByClient: rooms[room].sockets.map(ws => Object.fromEntries(Object.entries(ws.fields).map(([key, count]) => [key, count / seconds]))) }));
  const rates = roomResults.flatMap(room => room.deliveredHzByClient.flatMap(client => Object.values(client)));
  const output = { rooms: roomsCount, compact, stream, players: roomsCount * 4, fields: roomsCount * 4, simulatedWallSeconds: seconds,
    elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, realtimeRatio: seconds * 1000 / elapsedMs,
    allRoomsStep: summarize(durations), over33msSteps: durations.filter(value => value > 1000 / 30).length,
    fairness: { minimumHz: Math.min(...rates), maximumHz: Math.max(...rates), ratio: Math.min(...rates) / Math.max(...rates) },
    rawBytes: stats.reduce((sum, record) => sum + record.rawBytes, 0),
    payloadBytes: stats.reduce((sum, record) => sum + record.payloadBytes, 0), roomsResults: roomResults,
    note: 'Actual Match and Network, shared virtual clock and 25 ms sender drains; six real four-star operators per player; uncongested mock WebSockets, no TLS/deflate.' };
  if (target) writeFileSync(target, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally { for (const room of rooms) { room.match.dispose(); for (const ws of room.sockets) ws.close(); } network.close(); scheduler.dispose(); }
