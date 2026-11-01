// Focused transport regression: the CPU fast paths must preserve state/recovery semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Network, SessionRegistry, encode, send, sendRaw, sendOptions, markSend } from '../server/net.js';
import { Net } from '../public/js/net.js';
import { MIZUKI_VARIANT } from '../shared/mizuki-constants.js';

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.frames = []; }
  send(data, callback) { this.frames.push(data); callback?.(); }
  close(code = 1000, reason = '') { this.readyState = 3; this.emit('close', code, reason); }
  terminate() { this.close(1006); }
}

function harness(t) {
  const tcpMetrics = { register() {}, remove() {}, get() { return null; }, close() {} };
  const network = new Network({ registry: new SessionRegistry(), handler: {}, tcpMetrics });
  const ws = new Socket();
  network.handleConnection(ws);
  const conn = network.conns.get(ws);
  conn.deltaEnabled = true;
  t.after(() => { ws.close(); network.close(); });
  return { ws, conn, network };
}

function reconstruct(previous, frame) {
  if (frame.t === 'net.state') return frame.v;
  let value = structuredClone(previous);
  for (const operation of frame.p) {
    const [path, next] = operation;
    if (!path.length) { value = next; continue; }
    let parent = value;
    for (const key of path.slice(0, -1)) parent = parent[key];
    if (operation.length === 1) delete parent[path.at(-1)];
    else parent[path.at(-1)] = next;
  }
  return value;
}

function largeView() {
  return { t: 'm.public', phase: 'PREP', round: 4, serverNow: 1234,
    players: Array.from({ length: 4 }, (_, seat) => ({ playerId: `p${seat}`, lp: 99,
      name: `名字\\\"\n${seat}🐟`, board: Array.from({ length: 12 }, (_, uid) => ({
        uid, row: uid % 3, col: uid, chessId: `chess_${uid}`, items: [],
        bonds: { egirShip: { count: 5, layers: 3000 }, indomShip: { count: 2, layers: 7 } },
      })) })) };
}

test('state fast path preserves full state, sparse changes, deletion and duplicate suppression', (t) => {
  const { ws } = harness(t);
  const before = largeView();
  assert.equal(send(ws, before), true);
  const full = JSON.parse(ws.frames.at(-1));
  assert.equal(full.t, 'net.state');
  assert.deepEqual(full.v, before);
  const after = structuredClone(before);
  after.serverNow++;
  after.players[1].lp--;
  delete after.players[2].board[3].bonds.indomShip;
  assert.equal(send(ws, after), true);
  const delta = JSON.parse(ws.frames.at(-1));
  assert.equal(delta.t, 'net.delta');
  assert.equal(delta.b, full.n);
  assert.deepEqual(reconstruct(full.v, delta), after);
  assert.ok(Buffer.byteLength(ws.frames.at(-1)) < Buffer.byteLength(ws.frames[0]) / 10);
  const count = ws.frames.length;
  assert.equal(send(ws, after), true);
  assert.equal(ws.frames.length, count, 'unchanged state does not use downstream bandwidth');
  let completed = 0;
  assert.equal(sendRaw(ws, encode(after), { onComplete: () => completed++ }), true);
  assert.equal(completed, 1, 'recovery completion frames still reach the transport');
  assert.deepEqual(reconstruct(after, JSON.parse(ws.frames.at(-1))), after);
});

test('broadcast recipients reuse one parsed state but retain independent sequence numbers', (t) => {
  const first = harness(t), second = harness(t);
  const before = largeView();
  const data = encode(before);
  assert.equal(sendRaw(first.ws, data), true);
  assert.equal(sendRaw(second.ws, data), true);
  assert.strictEqual(first.conn.stateBases.get('m.public').v, second.conn.stateBases.get('m.public').v);

  const changed = structuredClone(before);
  changed.players[0].board[0].bonds.egirShip.layers++;
  changed.players[1].lp--;
  const next = encode(changed);
  assert.equal(sendRaw(first.ws, next), true);
  assert.equal(sendRaw(second.ws, next), true);
  for (const { ws } of [first, second]) {
    const original = JSON.parse(ws.frames[0]);
    const update = JSON.parse(ws.frames[1]);
    assert.deepEqual(reconstruct(original.v, update), changed);
    assert.equal(update.n, 2);
  }
  assert.strictEqual(first.conn.stateBases.get('m.public').v, second.conn.stateBases.get('m.public').v);

  const third = harness(t);
  assert.equal(sendRaw(third.ws, next), true);
  assert.deepEqual(JSON.parse(third.ws.frames[0]).v, changed);
  assert.equal(JSON.parse(third.ws.frames[0]).n, 1);
});

test('deferred broadcast recipients reuse immutable frames after global LRU eviction', t => {
  const first = harness(t), second = harness(t), churn = harness(t);
  const options = { type: 'b.snap', fieldId: 'retained', priority: 'medium', key: 'retained', periodic: false };
  const before = { ...largeView(), t: 'b.snap', fieldId: 'retained' }, encoded = encode(before);
  sendRaw(first.ws, encoded, options);
  second.ws.bufferedAmount = 60 * 1024;
  assert.equal(sendRaw(second.ws, encoded, options), false);
  for (let index = 0; index < 24; index++) sendRaw(churn.ws, encode({ ...largeView(), round: 100 + index }));
  second.ws.bufferedAmount = 0; second.conn.flow.level = 0; second.conn.flow.drain();
  assert.strictEqual(second.conn.stateBases.get('b.snap:retained').v, first.conn.stateBases.get('b.snap:retained').v);
  assert.deepEqual(JSON.parse(second.ws.frames.at(-1)).v, before);
  const changed = structuredClone(before); changed.players[0].lp--;
  const next = encode(changed); sendRaw(first.ws, next, options); sendRaw(second.ws, next, options);
  for (const { ws } of [first, second]) assert.deepEqual(reconstruct(before, JSON.parse(ws.frames.at(-1))), changed);
});

test('cached broadcast deltas use each recipient baseline and honor a reset', (t) => {
  const first = harness(t), second = harness(t);
  const before = largeView();
  const middle = structuredClone(before);
  middle.players[0].lp = 80;
  const after = structuredClone(middle);
  after.players[1].lp = 70;
  for (const { ws } of [first, second]) sendRaw(ws, encode(before));
  sendRaw(first.ws, encode(middle));
  const frame = encode(after);
  sendRaw(first.ws, frame);
  sendRaw(second.ws, frame);
  const firstDelta = JSON.parse(first.ws.frames.at(-1));
  const secondDelta = JSON.parse(second.ws.frames.at(-1));
  assert.equal(firstDelta.b, 2);
  assert.equal(secondDelta.b, 1);
  assert.deepEqual(reconstruct(middle, firstDelta), after);
  assert.deepEqual(reconstruct(before, secondDelta), after);
  sendRaw(first.ws, encode({ t: 'welcome' }));
  sendRaw(first.ws, frame);
  const restored = JSON.parse(first.ws.frames.at(-1));
  assert.equal(restored.t, 'net.state');
  assert.equal(restored.n, 1);
  assert.equal(restored.e, 1);
  assert.deepEqual(restored.v, after);
});

test('non-state fast path keeps welcome, battle and room boundaries resetting state bases', (t) => {
  const { ws, conn } = harness(t);
  const view = largeView();
  for (const boundary of [
    { t: 'welcome' }, { t: 'b.start', fieldId: 'n:p0' },
    { t: 'm.field', fieldId: 'n:p0' }, { t: 'room.state', code: 'AAAA' },
  ]) {
    send(ws, view);
    const epoch = conn.stateEpoch;
    send(ws, { t: 'pong', rid: 3, serverNow: 999 });
    assert.equal(conn.stateBases.size, 1, 'ordinary replies leave baselines alone');
    assert.equal(conn.stateEpoch, epoch);
    send(ws, boundary);
    assert.deepEqual(JSON.parse(ws.frames.at(-1)), boundary);
    assert.equal(conn.stateBases.size, 0);
    assert.equal(conn.stateEpoch, epoch + 1);
    send(ws, view);
    const restored = JSON.parse(ws.frames.at(-1));
    assert.equal(restored.t, 'net.state');
    assert.equal(restored.n, 1);
    assert.equal(restored.e, epoch + 1);
    assert.deepEqual(restored.v, view);
  }
  const epoch = conn.stateEpoch;
  sendRaw(ws, '{ "t": "welcome" }');
  assert.equal(conn.stateBases.size, 0, 'unclassified raw frames retain legacy parsing');
  assert.equal(conn.stateEpoch, epoch + 1);
});

test('full JSON embedding preserves normalization and legacy/unclassified sends', (t) => {
  const { ws, conn } = harness(t);
  const view = { t: 'b.snap', fieldId: 'n:p0', droppable: false,
    omitted: undefined, nan: NaN, sparse: Object.assign(new Array(2), { 1: 2 }), text: '引号"\n\\\u0000🐟',
    custom: { toJSON() { return { actual: 'normalized' }; } } };
  const canonical = JSON.parse(encode(view));
  send(ws, view);
  assert.deepEqual(JSON.parse(ws.frames.at(-1)).v, canonical);
  sendRaw(ws, '{ "t": "b.pool", "hp": 1, "hp": 2 }');
  assert.deepEqual(JSON.parse(ws.frames.at(-1)).v, { t: 'b.pool', hp: 2 });
  conn.deltaEnabled = false;
  send(ws, view);
  assert.deepEqual(JSON.parse(ws.frames.at(-1)), canonical, 'legacy client still receives ordinary messages');
});

test('battle snapshots retain independent baselines for each field', (t) => {
  const { ws, conn } = harness(t);
  const first = { ...largeView(), t: 'b.snap', fieldId: 'n:p0' };
  const second = { ...largeView(), t: 'b.snap', fieldId: 'n:p1', round: 8 };
  sendRaw(ws, encode(first));
  sendRaw(ws, encode(second));
  assert.equal(JSON.parse(ws.frames[0]).n, 1);
  assert.equal(JSON.parse(ws.frames[1]).n, 1);

  const nextFirst = structuredClone(first);
  const nextSecond = structuredClone(second);
  nextFirst.players[0].lp--;
  nextSecond.players[1].lp -= 2;
  sendRaw(ws, encode(nextFirst));
  sendRaw(ws, encode(nextSecond));
  for (const [index, previous, current] of [[2, first, nextFirst], [3, second, nextSecond]]) {
    const delta = JSON.parse(ws.frames[index]);
    assert.equal(delta.t, 'net.delta');
    assert.equal(delta.k, `b.snap:${current.fieldId}`);
    assert.equal(delta.b, 1);
    assert.equal(delta.n, 2);
    assert.deepEqual(reconstruct(previous, delta), current);
  }
  assert.deepEqual(conn.stateBases.get('b.snap:n:p0').v, nextFirst);
  assert.deepEqual(conn.stateBases.get('b.snap:n:p1').v, nextSecond);
});

test('native shared JSON path isolates queued Mizuki data from mutable source snapshots', t => {
  const first = harness(t), second = harness(t);
  const view = { t: 'm.public', variant: MIZUKI_VARIANT, round: 1, mizuki: {
    roster: Array.from({ length: 8 }, (_, uid) => ({ uid, note: '干员技能🐟\"\n'.repeat(20), hp: 100 })),
    geometry: { tiles: Array.from({ length: 30 }, (_, col) => ({ col, obstacle: false })) },
  } };
  const queued = encode(view), original = JSON.parse(queued);
  view.mizuki.roster[3].hp = 7; view.mizuki.geometry.tiles[4].obstacle = true;
  sendRaw(first.ws, queued);
  assert.deepEqual(JSON.parse(first.ws.frames.at(-1)).v, original, 'mutation cannot change an encoded frame');
  const next = encode(view); sendRaw(first.ws, next);
  assert.deepEqual(reconstruct(original, JSON.parse(first.ws.frames.at(-1))), view, 'same live objects are serialized afresh');
  const different = structuredClone(view); different.mizuki.roster[3].privateName = 'second player secret';
  sendRaw(second.ws, encode(different));
  assert.deepEqual(JSON.parse(second.ws.frames.at(-1)).v, different);
  const firstBase = first.conn.stateBases.get('m.public').v;
  assert.equal(firstBase.mizuki.roster[3].privateName, undefined, 'exact wire interning cannot leak another recipient data');
  assert.notStrictEqual(firstBase.mizuki.roster, second.conn.stateBases.get('m.public').v.mizuki.roster);
  const previousRoster = firstBase.mizuki.roster; view.round++; sendRaw(first.ws, encode(view));
  assert.deepEqual(first.conn.stateBases.get('m.public').v.mizuki.roster, previousRoster, 'unchanged data survives a fresh native JSON parse');
});

test('native JSON parser retains normalization, literal markers and protected keys', t => {
  const { ws } = harness(t);
  let reads = 0;
  const getter = { t: 'm.public', get mizuki() { reads++; return { value: reads }; } };
  assert.deepEqual(JSON.parse(encode(getter)), { t: 'm.public', mizuki: { value: 1 } });
  assert.equal(reads, 1, 'wire optimization does not invoke live getters a second time');
  const views = [
    { roster: Array.from({ length: 4 }, (_, id) => ({ id, text: '转义\"\n🐟'.repeat(30), embedded: '"geometry":{"roster":[0]}'.repeat(10), sparse: [, NaN, undefined], custom: { toJSON() { return { actual: '值' }; } } })) },
    { roster: [{ text: '__netImmutableSubtree0', note: 'ordinary marker collision'.repeat(20) }] },
    { roster: [JSON.parse('{"constructor":{"secret":"original"}}')], geometry: { text: 'x'.repeat(300) } },
    { roster: [{ exponent: JSON.rawJSON('1e2'), negativeZero: JSON.rawJSON('-0'), escaped: JSON.rawJSON('"\\u0061"'), note: 'raw JSON spelling'.repeat(30) }] },
  ];
  let before;
  for (const [round, mizuki] of views.entries()) {
    const encoded = encode({ t: 'm.public', round, mizuki }), expected = JSON.parse(encoded);
    sendRaw(ws, encoded);
    assert.deepEqual(reconstruct(before, JSON.parse(ws.frames.at(-1))), expected); before = expected;
  }
  const raw = '{ "t": "m.public", "mizuki": { "roster": [1], "roster": [2] }, "round": 9 }';
  sendRaw(ws, raw);
  assert.deepEqual(reconstruct(before, JSON.parse(ws.frames.at(-1))), JSON.parse(raw));
});

test('coalesced unsent snapshots do not advance the delivered baseline', (t) => {
  const { ws, conn } = harness(t);
  let now = 0;
  conn.flow.now = () => now;
  const before = { ...largeView(), t: 'b.snap', fieldId: 'n:p0' };
  sendRaw(ws, encode(before));
  const baseline = conn.stateBases.get('b.snap:n:p0');
  const middle = structuredClone(before);
  middle.players[0].lp--;
  const latest = structuredClone(middle);
  latest.players[1].lp--;
  const options = { type: 'b.snap', priority: 'medium', key: 'b.snap:n:p0', periodic: true };
  ws.bufferedAmount = 60 * 1024;
  assert.equal(sendRaw(ws, encode(middle), options), false);
  assert.equal(sendRaw(ws, encode(latest), options), false);
  assert.equal(ws.frames.length, 1);
  assert.strictEqual(conn.stateBases.get('b.snap:n:p0'), baseline);
  assert.equal(conn.flow.queues.medium.length, 1, 'only the latest pending field snapshot remains');
  assert.equal(conn.flow.queues.medium[0].data, encode(latest));

  ws.bufferedAmount = 0;
  conn.flow.drain();
  now += conn.flow.resumeMs;
  conn.flow.drain();
  assert.equal(ws.frames.length, 2);
  const delta = JSON.parse(ws.frames.at(-1));
  assert.equal(delta.t, 'net.delta');
  assert.equal(delta.b, baseline.n);
  assert.equal(delta.n, baseline.n + 1);
  assert.deepEqual(reconstruct(before, delta), latest);
  assert.equal(conn.flow.queues.medium.length, 0);
});

test('synchronous send failures never commit a new state baseline', (t) => {
  for (const mode of ['throw', 'callback']) {
    const { ws, conn } = harness(t);
    const before = largeView();
    sendRaw(ws, encode(before));
    let commits = 0;
    const setBaseline = conn.stateBases.set.bind(conn.stateBases);
    conn.stateBases.set = (...args) => { commits++; return setBaseline(...args); };
    ws.send = (_data, callback) => {
      if (mode === 'throw') throw new Error('local test send failure');
      callback(new Error('local test send failure'));
    };
    const after = structuredClone(before);
    after.players[0].lp--;
    const sent = sendRaw(ws, encode(after));
    if (mode === 'throw') assert.equal(sent, false);
    assert.equal(conn.closing, true);
    assert.equal(commits, 0, `${mode} failure must not commit prepared state`);
    assert.equal(conn.stateBases.size, 0, 'closed connection releases its old baselines');
  }
});

test('unchanged large Mizuki subtrees are skipped while nested changes retain exact state and UTF-8 budgets', t => {
  const { ws, conn } = harness(t), reserved = [];
  const reserve = conn.bandwidth.reserve.bind(conn.bandwidth);
  conn.bandwidth.reserve = bytes => { reserved.push(bytes); return reserve(bytes); };
  const before = { ...largeView(), t: 'b.snap', fieldId: '水月🐟',
    geometry: { tiles: Array.from({ length: 100 }, (_, row) => ({ row, col: 0, obstacle: false, label: '深蓝之树🐟' })) },
    roster: Array.from({ length: 20 }, (_, uid) => ({ uid, detail: '干员技能介绍'.repeat(40), loadout: { stats: { atk: 100 } } })),
    prep: { legalTiles: Object.fromEntries(Array.from({ length: 20 }, (_, uid) => [uid, Array.from({ length: 100 }, (_, row) => [row, 0])])) } };
  sendRaw(ws, encode(before));
  assert.equal(reserved.at(-1), Buffer.byteLength(ws.frames.at(-1)));
  const same = structuredClone(before); same.serverNow++;
  sendRaw(ws, encode(same));
  let delta = JSON.parse(ws.frames.at(-1));
  assert.deepEqual(delta.p, [[['serverNow'], same.serverNow]]);
  assert.equal(reserved.at(-1), Buffer.byteLength(ws.frames.at(-1)));
  const changed = structuredClone(same);
  changed.geometry.tiles[9].obstacle = true;
  changed.roster[7].loadout.stats.atk = 1234;
  changed.prep.legalTiles[3].pop();
  sendRaw(ws, encode(changed));
  delta = JSON.parse(ws.frames.at(-1));
  assert.deepEqual(reconstruct(same, delta), changed);
  assert.equal(reserved.at(-1), Buffer.byteLength(ws.frames.at(-1)));
  assert.equal(conn.closing, false);
});

test('subtree equality preserves the existing protected-key replacement boundary', t => {
  const { ws } = harness(t);
  const before = { ...largeView(), geometry: JSON.parse('{"tiles":[{"constructor":{"value":"original"}}]}') };
  send(ws, before);
  const after = structuredClone(before); after.serverNow++;
  send(ws, after);
  const delta = JSON.parse(ws.frames.at(-1));
  assert.ok(delta.p.some(([path]) => path[0] === 'geometry'));
  assert.ok(delta.p.every(([path]) => !path.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))));
  assert.deepEqual(reconstruct(before, delta), after);
  assert.equal(Object.prototype.value, undefined);
});

test('four Mizuki fields retain twenty-Hz transport cadence and still yield to actual backpressure', t => {
  const { ws, conn } = harness(t);
  let now = 0;
  conn.monotonicNow = () => now; conn.flow.now = () => now; conn.bandwidth.now = () => now;
  conn.bandwidth.at = now; conn.bandwidth.sampleAt = now;
  conn.rtt = 120; conn.rttAt = now;
  assert.ok(conn.periodicInterval() >= 400, 'ordinary mode retains its existing default pacing');
  const snapshot = (field, tick) => markSend({ t: 'b.snap', fieldId: 'n:p' + field, battleId: 'b' + field,
    tick, time: tick / 30, units: [] }, { cadenceMs: 33 });
  for (let frame = 0; frame < 20; frame++) {
    now = frame * 50;
    for (let field = 0; field < 4; field++) send(ws, snapshot(field, frame * 3));
  }
  assert.equal(ws.frames.length, 80);
  for (let field = 0; field < 4; field++) assert.equal(ws.frames.map(JSON.parse).filter(value => value.k === 'b.snap:n:p' + field).length, 20);
  assert.equal(JSON.parse(ws.frames[0]).v.cadenceMs, undefined, 'cadence is process-local metadata');
  ws.bufferedAmount = 60 * 1024; now += 50;
  for (let field = 0; field < 4; field++) send(ws, snapshot(field, 60));
  assert.equal(ws.frames.length, 80, 'actual buffer pressure still defers replaceable snapshots');
  assert.equal(conn.flow.queues.medium.length, 4);
  ws.bufferedAmount = 0; conn.flow.drain(); now += 250; conn.flow.drain(); now += 250; conn.flow.drain();
  assert.equal(ws.frames.length, 84);
  assert.equal(conn.flow.queues.medium.length, 0);
});

test('negotiated field streams preserve complete team HUD, default own field, reliable events and watch changes', async t => {
  const { ws, conn, network } = harness(t);
  conn.compactEnabled = true; conn.streamEnabled = true;
  const decoder = new Net(); decoder._stateDelta = true; decoder._stateCompact = true; decoder._stateStream = true;
  const sendReliable = message => sendRaw(ws, encode(message), { type: message.t });
  sendReliable({ t: 'm.private', playerId: 'p1', mizuki: { fieldId: 'a' } });
  const field = (id, owner) => ({ t: 'b.snap', time: 1, tick: 30, fieldId: id, battleId: 'battle-' + id,
    partyId: 'party', kind: 'normal', active: true, players: [owner], units: [[1, 2, 3]],
    geometry: { tiles: [1] }, stage: { id: 'native' }, meta: { units: [] }, killed: 1, total: 4,
    dps: { [owner]: 5 }, objectiveLossByPlayer: { [owner]: 2 }, damageRows: [{ key: owner, total: 5 }] });
  const a = field('a', 'p1'), b = field('b', 'p2');
  send(ws, markSend(a, { cadenceMs: 33 }));
  const before = ws.frames.length;
  send(ws, markSend(b, { cadenceMs: 33 }));
  assert.equal(ws.frames.length, before, 'unwatched periodic field is not transported');
  const publicState = { t: 'm.public', variant: MIZUKI_VARIANT, players: [], mizuki: { fields: [a, b].map(({ time, ...value }) => ({ ...value, t: time })) } };
  sendReliable(publicState);
  const decoded = ws.frames.map(encoded => decoder._decodeState(JSON.parse(encoded))).at(-1);
  assert.equal(decoded.mizuki.fields[0].fieldId, 'a');
  assert.equal(decoded.mizuki.fields[0].stage.id, 'native');
  assert.equal(decoded.mizuki.fields[1].__overview, true);
  for (const key of ['killed', 'total', 'dps', 'players', 'objectiveLossByPlayer', 'damageRows']) {
    assert.deepEqual(decoded.mizuki.fields[1][key], b[key]);
  }
  sendReliable({ t: 'b.ev', fieldId: 'b', battleId: b.battleId, events: [['die', 1]] });
  assert.equal(JSON.parse(ws.frames.at(-1)).t, 'b.ev', 'reliable events are never filtered');
  conn.session = { playerId: 'p1', profileReady: true, ws };
  network.handler.onMessage = () => ({ ok: true });
  await network.dispatchMessage(conn, { t: 'g.watch', fieldId: 'b', viewOnly: true }, network.now());
  assert.equal(conn.streamFieldId, 'b');
  sendReliable({ t: 'm.private', playerId: 'p1', mizuki: { fieldId: 'a' } });
  assert.equal(conn.streamFieldId, 'b', 'own-field updates do not steal an explicit watch target');
  sendReliable({ ...publicState, mizuki: { fields: [{ ...a, fieldId: 'new', battleId: 'new-battle', t: 2 }] } });
  assert.equal(conn.streamFieldId, 'new', 'stale stage subscriptions recover to an existing field');
});

test('legacy non-delta peers retain default periodic pacing', t => {
  const { ws, conn } = harness(t); conn.deltaEnabled = false;
  let now = 0; conn.monotonicNow = () => now; conn.flow.now = () => now;
  conn.bandwidth.now = () => now; conn.bandwidth.at = now; conn.bandwidth.sampleAt = now;
  for (let tick = 0; tick < 20; tick++) {
    now = tick * 50;
    send(ws, markSend({ t: 'b.snap', fieldId: 'legacy', tick }, { cadenceMs: 33 }));
  }
  assert.ok(ws.frames.length <= 4, 'legacy full snapshots cannot claim twenty-Hz priority');
});

test('bottom-up patch lengths retain the original exact shortest-patch choices', t => {
  const { ws } = harness(t);
  function originalPatch(before, after, path = []) {
    if (before === after) return [];
    const a = before && typeof before === 'object', b = after && typeof after === 'object';
    if (!a || !b || Array.isArray(before) !== Array.isArray(after)
      || (Array.isArray(after) && before.length !== after.length)) return [[path, after]];
    const patch = [];
    for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) patch.push([[...path, key]]);
    for (const key of Object.keys(after)) {
      if (!Object.hasOwn(before, key)) patch.push([[...path, key], after[key]]);
      else patch.push(...originalPatch(before[key], after[key], [...path, key]));
    }
    if (!patch.length) return [];
    const replacement = [[path, after]];
    return JSON.stringify(patch).length < JSON.stringify(replacement).length ? patch : replacement;
  }
  let randomState = 173;
  const random = max => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % max; };
  let before = { ...largeView(), mizuki: {}, geometry: { nested: [{ text: '水月🐟\\\"\n'.repeat(20), value: 1 }, { value: 2 }] } };
  send(ws, before);
  for (let index = 0; index < 100; index++) {
    const after = structuredClone(before); after.serverNow++;
    after.players[random(after.players.length)].board[random(12)].items = Array.from({ length: random(4) }, () => '物品🐟' + random(100));
    after.geometry.nested[random(2)].value = random(10000);
    if (random(2)) after.geometry.extra = { text: '中文字\\\"\n' + random(100), value: random(1000) };
    else delete after.geometry.extra;
    send(ws, after);
    const frame = JSON.parse(ws.frames.at(-1));
    if (frame.t === 'net.delta') assert.deepEqual(frame.p, originalPatch(before, after), `iteration ${index}`);
    assert.deepEqual(reconstruct(before, frame), after);
    before = after;
  }
});

test('deflate input and actual TCP pressure have separate finite gates and exact wire accounting', t => {
  const { ws, conn } = harness(t);
  ws.extensions = 'permessage-deflate'; ws._socket = { writableLength: 0, bytesWritten: 0 };
  conn.bandwidth.register(ws);
  let now = 0; conn.monotonicNow = () => now; conn.flow.now = () => now;
  conn.bandwidth.now = () => now; conn.bandwidth.at = now; conn.bandwidth.sampleAt = now;
  const snapshot = tick => markSend({ t: 'b.snap', fieldId: 'own', tick, units: [] }, { cadenceMs: 10 });
  ws.bufferedAmount = 100 * 1024;
  send(ws, snapshot(1));
  assert.equal(ws.frames.length, 1, 'a transient deflate input does not latch a slow TCP socket');
  assert.equal(conn.flow.level, 0);
  const initial = conn.bandwidth.tokens, release = conn.bandwidth.reserve(500000, { deferToWire: true });
  assert.equal(conn.bandwidth.tokens, initial, 'raw compression input is not counted as compressed line traffic');
  ws._socket.bytesWritten += 12345; conn.bandwidth.collect(ws); release();
  assert.equal(conn.bandwidth.tokens, initial - 12345, 'actual TCP bytes debit the exact shared budget');
  ws.bufferedAmount = 2 * 1024 * 1024; now += 50;
  send(ws, snapshot(2));
  assert.equal(ws.frames.length, 1, 'large pending compression work still pauses replaceable snapshots');
  assert.equal(conn.flow.level, 2);
  send(ws, { t: 'b.ev', fieldId: 'own', events: [['die', 4]] });
  assert.equal(JSON.parse(ws.frames.at(-1)).t, 'b.ev', 'reliable events bypass the compression soft gate');
  conn.flow.level = 0; ws.bufferedAmount = 100 * 1024; ws._socket.writableLength = 60 * 1024;
  send(ws, snapshot(3));
  assert.equal(conn.flow.level, 2, 'a genuinely slow TCP socket keeps the original fifty-KiB gate');
  conn.flow.level = 0; ws.bufferedAmount = 0; ws._socket.writableLength = 0;
  ws._socket.bytesWritten += conn.bandwidth.capacity * 3; conn.bandwidth.collect(ws);
  const count = ws.frames.length; send(ws, snapshot(4));
  assert.equal(ws.frames.length, count, 'actual compressed TCP debt still gates every periodic sender');
  assert.equal(conn.flow.level, 2);
  ws.bufferedAmount = 16 * 1024 * 1024;
  send(ws, { t: 'b.ev', fieldId: 'own', events: [['die', 5]] });
  assert.equal(conn.closing, true, 'raw memory pressure retains the hard sixteen-MiB guard');
});


test('stream metadata capability selects lazy full legacy frames per recipient', t => {
  const modern = harness(t), legacy = harness(t), original = { t: 'b.snap', fieldId: 'f', battleId: 'b', time: 1, units: [[1, 0]] };
  modern.conn.fieldMetadataEnabled = true;
  let built = 0;
  const complete = { ...original, meta: { units: [{ id: 1 }] }, geometry: { rows: 9 }, stage: { id: 'stage' } };
  markSend(original, { cadenceMs: 10, legacyMessage: () => { built++; return markSend(complete, { cadenceMs: 10 }); } });
  const data = encode(original), options = sendOptions(original);
  sendRaw(modern.ws, data, options);
  assert.equal(built, 0);
  assert.deepEqual(JSON.parse(modern.ws.frames.at(-1)).v, original);
  sendRaw(legacy.ws, data, options);
  assert.equal(built, 1);
  assert.deepEqual(JSON.parse(legacy.ws.frames.at(-1)).v, complete);
  assert.equal(JSON.parse(modern.ws.frames.at(-1)).v.meta, undefined);
  const legacy2 = harness(t); sendRaw(legacy2.ws, data, options);
  assert.equal(built, 1, 'legacy recipients share one encoded fallback per immutable source frame');
  assert.deepEqual(JSON.parse(legacy2.ws.frames.at(-1)).v, complete);
});
