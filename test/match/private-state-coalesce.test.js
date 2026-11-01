// Private state coalescing must not publish stale ready flags after A -> B -> A.
// All transport and timers are in memory; no listeners, workers or sockets are opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MatchMessaging } from '../../server/match/match/messaging.js';
import { PrioritySender } from '../../shared/sendFlow.js';
import { getSendMetadata, markSend } from '../../server/sendMetadata.js';

// A supplied pre-fix source is used only by this isolated harness, never written
// over production. It permits proving the same ABA cases fail before the fix.
const sendPrivate = process.env.PRIVATE_STATE_MESSAGING_BASELINE
  ? baselineMethod(process.env.PRIVATE_STATE_MESSAGING_BASELINE)
  : MatchMessaging.prototype._sendPrivate;
function baselineMethod(file) {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('  _sendPrivate(');
  const end = src.indexOf('  _maybeSendPublic(', start);
  assert.ok(start >= 0 && end > start, 'baseline contains the private send method');
  const method = src.slice(start, end).trim().replace(/^_sendPrivate/, 'function');
  return Function('markSend', `return (${method});`)(markSend);
}

function fixture(t, { initialReady = false } = {}) {
  let now = 0, nextId = 0, buffered = 0, writeOk = true, disconnect = false;
  const jobs = new Map(), frames = [], attempts = [];
  const timers = {
    setTimeout(fn, ms) { const id = ++nextId; jobs.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { jobs.delete(id); },
  };
  const clock = {
    advance(to) {
      assert.ok(to >= now, 'clock is monotonic');
      let count = 0;
      while (true) {
        let next = null;
        for (const [id, job] of jobs) if (job.at <= to && (!next || job.at < next[1].at)) next = [id, job];
        if (!next) break;
        assert.ok(++count < 10000, 'timers remain bounded');
        jobs.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = to;
    },
  };
  const ps = { playerId: 'p', isBot: false, left: false, connected: true,
    ready: initialReady, funds: 0,
    privateView() { return { t: 'm.private', playerId: this.playerId, ready: this.ready, funds: this.funds }; },
  };
  const sender = new PrioritySender({ now: () => now, buffered: () => buffered, timers, interval: 250,
    send(json) {
      attempts.push(JSON.parse(json));
      if (disconnect) ps.connected = false;
      if (!writeOk) return false;
      frames.push(JSON.parse(json)); return true;
    },
  });
  const errors = [];
  const m = Object.assign(Object.create(MatchMessaging.prototype), {
    _sendPrivate: sendPrivate, disposed: false, observers: new Map(), watchers: new Map(),
    players: new Map([[ps.playerId, ps]]), _privDirty: new Set(), _pubDirty: false,
    phase: 'PREP', round: 1, paused: false, deadline: null, _lastFlowScope: 'PREP:1:false:null',
    _notifyPrepScouts() {}, _maybeSendPublic() { this._pubDirty = false; },
    reportError(label, error) { errors.push({ label, error }); },
    sendFn(_pid, view) { return sender.enqueue(JSON.stringify(view), getSendMetadata(view)); },
  });
  t.after(() => { sender.close(); assert.deepEqual(errors, []); });
  return { m, ps, sender, frames, attempts, clock,
    send(force = false) { m._sendPrivate(ps, force, force); },
    setBuffered(value) { buffered = value; },
    setWriteOk(value) { writeOk = value; },
    disconnectOnWrite() { disconnect = true; },
  };
}

for (const initialReady of [false, true]) {
  test(`private ABA ${initialReady} -> ${!initialReady} -> ${initialReady} publishes the current ready value`, t => {
    const f = fixture(t, { initialReady });
    f.send();
    f.clock.advance(1); f.ps.ready = !initialReady; f.send();
    assert.equal(f.sender.pending('m.private'), true, 'changed ready frame is deferred');
    f.clock.advance(2); f.ps.ready = initialReady; f.send();
    f.clock.advance(250);
    assert.equal(f.frames.at(-1).ready, f.ps.ready, 'client ready must agree with the authoritative ready after drain');
    assert.equal(f.sender.pending('m.private'), false);
  });
}

test('private latest-state replacement keeps one entry and the existing 250 ms cadence', t => {
  const f = fixture(t); f.send();
  for (let i = 1; i < 250; i++) {
    f.clock.advance(i); f.ps.ready = !!(i % 2); f.ps.funds = i; f.send();
    assert.equal(f.sender.queues.medium.length, 1);
  }
  assert.equal(f.frames.length, 1, 'repeated calls do not bypass the period');
  f.clock.advance(250);
  assert.equal(f.frames.length, 2);
  assert.equal(f.frames.at(-1).ready, f.ps.ready);
  assert.equal(f.frames.at(-1).funds, 249);
  assert.equal(f.sender.queuedBytes, 0);
});

test('private successful direct sends keep identical-content deduplication', t => {
  const f = fixture(t); f.send();
  const cached = f.ps._lastPriv;
  for (let i = 0; i < 100; i++) f.send();
  assert.equal(f.frames.length, 1); assert.equal(f.attempts.length, 1);
  assert.equal(f.ps._lastPriv, cached); assert.equal(f.sender.pending('m.private'), false);
});

test('private forced high update supersedes an older deferred medium ready frame', t => {
  const f = fixture(t); f.send();
  f.clock.advance(1); f.ps.ready = true; f.send();
  assert.equal(f.sender.queues.medium.length, 1);
  f.clock.advance(2); f.ps.ready = false; f.send(true);
  assert.equal(f.sender.queues.medium.length, 0);
  assert.equal(f.frames.at(-1).ready, false);
  f.clock.advance(1000);
  assert.deepEqual(f.frames.map(frame => frame.ready), [false, false], 'the superseded true frame never arrives');
});

test('private online failed write invalidates the cache and retries without looping', t => {
  const f = fixture(t); f.ps._lastPriv = 'previous'; f.setWriteOk(false); f.send();
  assert.equal(f.ps._lastPriv, null); assert.equal(f.m._privDirty.has(f.ps), true);
  assert.equal(f.attempts.length, 1); assert.equal(f.sender.pending('m.private'), false);
  f.clock.advance(1000); assert.equal(f.attempts.length, 1, 'failure does not create a transport retry loop');
  f.setWriteOk(true); f.m.flush();
  assert.equal(f.frames.length, 1); assert.equal(f.m._privDirty.has(f.ps), false);
  assert.equal(f.ps._lastPriv, JSON.stringify(f.ps.privateView()));
  f.m.flush(); f.send(); assert.equal(f.attempts.length, 2);
});

test('private write that disconnects the player leaves no offline retry loop', t => {
  const f = fixture(t); f.ps._lastPriv = 'previous';
  f.setWriteOk(false); f.disconnectOnWrite(); f.send();
  assert.equal(f.ps.connected, false); assert.equal(f.ps._lastPriv, 'previous');
  assert.equal(f.m._privDirty.size, 0);
  f.m.flush(); f.m.flush(); f.clock.advance(1000);
  assert.equal(f.attempts.length, 1); assert.equal(f.sender.pending('m.private'), false);
});

test('private congestion still holds medium updates and resumes with only the latest view', t => {
  const f = fixture(t); f.send(true); f.setBuffered(60000);
  f.clock.advance(1); f.ps.ready = true; f.send();
  f.clock.advance(2); f.ps.ready = false; f.ps.funds = 7; f.send();
  f.clock.advance(100); assert.equal(f.frames.length, 1);
  assert.equal(f.sender.queues.medium.length, 1);
  f.setBuffered(0); f.clock.advance(650);
  assert.equal(f.frames.length, 2); assert.equal(f.frames.at(-1).ready, false);
  assert.equal(f.frames.at(-1).funds, 7); assert.equal(f.sender.queuedBytes, 0);
});
