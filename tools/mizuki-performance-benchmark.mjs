import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { getData } from '../server/data.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { Network, SessionRegistry, encode, sendRaw, sendOptions } from '../server/net.js';

const log = { info() {}, warn() {}, error(...value) { throw new Error(value.map(String).join(' ')); } };
const scheduler = new VirtualScheduler({ instantCombat: false });
let measuring = false;
const wireEnabled = process.argv.includes('--wire');
const sampleTarget = process.argv[3]?.startsWith('--') ? null : process.argv[3];
let sampleWritten = false, wireBytes = 0, wireFrames = 0;
const wireByKey = {};
class MeterSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; }
  send(data, callback) {
    if (measuring) { wireFrames++; wireBytes += Buffer.byteLength(data);
      const key = /"k":("(?:[^"\\]|\\.)*")/.exec(data.slice(0, 300));
      const name = key ? JSON.parse(key[1]) : 'other'; wireByKey[name] = (wireByKey[name] || 0) + 1;
    }
    callback?.();
  }
  close(code = 1000, reason = '') { this.readyState = 3; this.emit('close', code, reason); }
  terminate() { this.close(1006); }
}
const sockets = wireEnabled ? Array.from({ length: 4 }, () => new MeterSocket()) : [];
const network = wireEnabled ? new Network({ registry: new SessionRegistry(), handler: {},
  now: () => scheduler.now(), monotonicNow: () => scheduler.now(),
  options: { bandwidthMbps: 10000 },
  tcpMetrics: { register() {}, remove() {}, get() { return null; }, close() {} } }) : null;
for (const ws of sockets) { network.handleConnection(ws); network.conns.get(ws).deltaEnabled = true; }
// The real sender drains deferred traffic every 25 ms. Advance that timer with
// the same virtual clock as combat, rather than starving real timers in this
// synchronous ten-second simulation loop.
if (network) scheduler.setInterval(() => { for (const conn of network.conns.values()) conn.flow.drain(); }, 25);
const frames = new Map();
function frame(message, recipients = 1, data = null) {
  if (!measuring) return;
  if (message.t === 'm.public' && sampleTarget && !sampleWritten) {
    writeFileSync(sampleTarget, JSON.stringify(message)); sampleWritten = true;
  }
  const bytes = Buffer.byteLength(data ?? JSON.stringify(message));
  const previous = frames.get(message.t) || { count: 0, bytes: 0, deliveredBytes: 0 };
  previous.count++; previous.bytes += bytes; previous.deliveredBytes += bytes * recipients;
  frames.set(message.t, previous);
}
const match = new MizukiMatch({ roomCode: 'PERF', seed: 619, matchId: 'mizuki-perf-benchmark', hostId: 'p0',
  seats: Array.from({ length: 4 }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
  data: getData({ log }), scheduler, log,
  send: (id, message) => { const data = network ? encode(message) : null; frame(message, 1, data);
    if (network) sendRaw(sockets[Number(id.slice(1))], data, sendOptions(message)); },
  broadcast: message => { const data = network ? encode(message) : null; frame(message, 4, data); if (network) {
    const options = sendOptions(message);
    for (const ws of sockets) sendRaw(ws, data, options);
  } }, onEnd() {} });
const command = (playerId, message) => {
  const result = match.handle(playerId, message);
  if (result.ok !== true) throw new Error(JSON.stringify({ playerId, message, result }));
};
try {
  match.start();
  for (const player of match.order) command(player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  for (const [index, player] of match.order.entries()) command(player.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[index].bandId });
  for (const player of match.order) command(player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  for (const player of match.order) command(player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  for (const player of match.order) for (let guard = 0; match.phase === PHASE.RECRUIT && !player.ready && guard < 20; guard++) {
    command(player.playerId, { t: 'g.mizuki.recruit', offerId: match.privateView(player.playerId).mizuki.recruit.skipToken });
  }
  const operators = match.fullCatalog.operators.filter(operator => operator.rarity === 4).slice(0, 6);
  if (operators.length !== 6) throw new Error('Performance benchmark requires six real four-star operators per player');
  for (const player of match.order) for (const operator of operators) match._grantMetaChess(player, operator.operatorId);
  const route = match.privateView('p0').mizuki.route.find(node => node.type === 'combat' && node.available);
  if (!route) throw new Error('No initial combat node');
  for (const player of match.order) command(player.playerId, { t: 'g.mizuki.route', nodeId: route.id });
  command('p0', { t: 'g.mizuki.routeStart' });
  for (const player of match.order) for (const unit of player.roster) {
    const prep = match.privateView(player.playerId).mizuki.prep;
    const [row, col] = prep.legalTiles[unit.uid].find(([r, c]) => !prep.board.some(piece => piece.row === r && piece.col === c));
    command(player.playerId, { t: 'g.mizuki.move', uid: unit.uid, to: { area: 'board', row, col }, dir: 'RIGHT' });
  }
  for (const player of match.order) command(player.playerId, { t: 'g.mizuki.ready', on: true });
  let snapshots = 0;
  for (const field of match.fields.values()) {
    const snapshot = field.engine.snapshot.bind(field.engine);
    field.engine.snapshot = () => { if (measuring) snapshots++; return snapshot(); };
  }
  const durations = [];
  measuring = true;
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  for (let index = 0; index < 300 && !match.ended; index++) {
    const before = performance.now(); scheduler.advance(1000 / 30); durations.push(performance.now() - before);
  }
  const elapsed = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  durations.sort((a, b) => a - b);
  const output = { players: 4, operatorsPerPlayer: operators.length, simulatedWallSeconds: 10,
    elapsedMs: elapsed, p50CallbackMs: durations[Math.floor(durations.length * .5)],
    cpuMs: (cpu.user + cpu.system) / 1000,
    p95CallbackMs: durations[Math.floor(durations.length * .95)], p99CallbackMs: durations[Math.floor(durations.length * .99)], maxCallbackMs: Math.max(...durations),
    snapshots, fields: match.fields.size, battleTicks: match.battleTicks,
    frames: Object.fromEntries(frames), deliveredMiB: [...frames.values()].reduce((sum, value) => sum + value.deliveredBytes, 0) / 1024 / 1024,
    ...(wireEnabled ? { wire: { frames: wireFrames, byKey: wireByKey, payloadBytes: wireBytes, payloadMiB: wireBytes / 1024 / 1024,
      aggregateMbps: wireBytes * 8 / 10 / 1e6, perPlayerMbps: wireBytes * 8 / 10 / 4 / 1e6,
      note: 'Actual server/net.js delta-encoded payloads on four uncongested mock WebSockets; excludes WebSocket/TLS headers and compression.' } } : {}) };
  const target = process.argv[2]; if (target) writeFileSync(target, JSON.stringify(output, null, 2));
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} finally { match.dispose(); scheduler.dispose(); for (const ws of sockets) ws.close(); network?.close(); }
