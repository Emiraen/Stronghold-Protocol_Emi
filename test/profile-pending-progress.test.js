import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingResults } from '../server/profileService.js';

function job(match = '1', account = 'a') {
  const aid = account.repeat(32), playerId = 'p1';
  return { match: { matchId: match.repeat(32) }, ranked: true,
    seats: [{ aid, playerId, isBot: false }], entries: [{ who: { aid, playerId }, row: { roundsPassed: 1 } }],
    result: { t: 'm.result', players: [{ playerId, stats: { kills: 1 } }] } };
}
const log = { error() {} };
const turns = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('pending progress: hung first completion cannot block an independent second match and cannot be blindly replayed', async t => {
  const calls = [], received = []; let release;
  const pending = new PendingResults(null, (_op, [next]) => {
    calls.push(next.match.matchId);
    if (next.match.matchId === '1'.repeat(32)) return new Promise(resolve => { release = resolve; });
    return { result: next.result };
  }, (entry, value) => received.push([entry.id, value]), log);
  pending.requestTimeoutMs = 15; t.after(() => pending.close());
  const a = job(), b = job('2', 'b');
  const first = assert.rejects(pending.submit('complete', [a]), { code: 'RESULT_SETTLEMENT_FAILED' });
  const second = pending.submit('complete', [b]); await first; const saved = await second;
  assert.deepEqual(saved.result, b.result); assert.equal(calls.length, 2); assert.equal(received.length, 1);
  assert.equal(pending.jobs.get('complete:' + a.match.matchId).blocked.receipt, 'unknown');
  await pending.drain(); await assert.rejects(pending.submit('complete', [a]), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(calls.length, 2);
  release({ result: a.result }); await turns();
  assert.equal(received.length, 2); assert.equal(pending.jobs.size, 0); assert.equal(calls.length, 2);
});

test('pending progress: late rejection stays quarantined while later independent jobs settle', async t => {
  let reject; const pending = new PendingResults(null, (_op, [next]) => next.match.matchId === '1'.repeat(32)
    ? new Promise((_, no) => { reject = no; }) : { result: next.result }, () => {}, log);
  pending.requestTimeoutMs = 15; t.after(() => pending.close());
  await assert.rejects(pending.submit('complete', [job()]), { code: 'RESULT_SETTLEMENT_FAILED' });
  reject(new Error('late lost receipt')); await turns();
  assert.equal((await pending.submit('complete', [job('2', 'b')])).result.t, 'm.result');
  assert.equal(pending.jobs.size, 1); assert.equal(pending.running, false);
});

test('pending progress: successful receipt on the timeout microtask boundary cannot be resurrected as blocked', async t => {
  let fireTimeout, release, calls = 0; const received = [];
  const timer = t.mock.method(globalThis, 'setTimeout', callback => { fireTimeout = callback; return {}; });
  const pending = new PendingResults(null, () => { calls++; return new Promise(resolve => { release = resolve; }); },
    (_entry, value) => received.push(value), log); t.after(() => pending.close());
  const next = job(), result = pending.submit('complete', [next]);
  fireTimeout(); release({ result: next.result });
  assert.deepEqual((await result).result, next.result); await turns();
  assert.equal(pending.jobs.size, 0); assert.equal(received.length, 1); assert.equal(calls, 1);
  assert.equal(pending.running, false); timer.mock.restore();
});

test('pending progress: parent-owned failure callback remains available when a released worker cannot consume rejection', async t => {
  const failures = [];
  const pending = new PendingResults(null, () => new Promise(() => {}), () => {}, log);
  pending.requestTimeoutMs = 10; pending.failed = (entry, error) => failures.push([entry.id, error.code]);
  t.after(() => pending.close());
  await assert.rejects(pending.submit('complete', [job()]), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.deepEqual(failures, [['complete:' + '1'.repeat(32), 'RESULT_SETTLEMENT_TIMEOUT']]);
  assert.equal(pending.jobs.size, 1); assert.equal(pending.jobs.values().next().value.blocked.receipt, 'unknown');
});

test('pending progress: a timed-out non-economic execution cannot consume the receipt of its history retry', async t => {
  const releases = [], received = [];
  const pending = new PendingResults(null, () => new Promise(resolve => releases.push(resolve)),
    (_entry, value) => received.push(value), log); pending.requestTimeoutMs = 15;
  t.after(() => pending.close());
  const h = job(), history = { matchId: h.match.matchId, seats: h.seats, summary: { players: h.result.players } };
  const saved = pending.submit('historyRecord', [history]); await pending.finished;
  assert.equal(releases.length, 1); const retry = pending.drain(); assert.equal(releases.length, 2);
  releases[0]('old-execution'); await turns(); assert.equal(received.length, 0); assert.equal(pending.jobs.size, 1);
  releases[1]('new-execution'); await retry; assert.equal(await saved, 'new-execution');
  assert.deepEqual(received, ['new-execution']); assert.equal(pending.jobs.size, 0);
});
