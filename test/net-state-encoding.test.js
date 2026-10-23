// Focused transport regression: the CPU fast paths must preserve state/recovery semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Network, SessionRegistry, encode, send, sendRaw } from '../server/net.js';

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
  return { ws, conn };
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
