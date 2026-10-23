import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';

const outcome = { victory: false, reason: 'defeat' };
const microtasks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(t) {
  const h = makeMatch({ mode: 'coop', humans: 3, fake: true }).start(); h.toPrep(1);
  t.after(() => h.m.dispose()); return h;
}

test('result progress: full statistics preview appears before any economic response', async t => {
  const h = fixture(t), m = h.m; let calls = 0, release;
  m.completeMatch = job => { calls++; return new Promise(resolve => { release = () => resolve({ result: job.result }); }); };
  const finished = m.finish(outcome);
  assert.equal(h.lastTo('p_0', 'm.result').settlementPending, true);
  assert.equal(h.lastTo('p_0', 'm.result').matchId, m.matchId);
  assert.ok(h.lastTo('p_0', 'm.result').players[0].stats);
  await microtasks(); assert.equal(calls, 1); assert.equal(h.endedCount, 0);
  release(); await finished;
  assert.equal(h.lastTo('p_0', 'm.result').settlementPending, undefined);
  assert.equal(h.endedCount, 1); assert.equal(m.historyPersisted, true);
});

test('result progress: a hung economic request releases the match within three seconds without resubmitting', async t => {
  const h = fixture(t), m = h.m; let calls = 0;
  m.completeMatch = () => { calls++; return new Promise(() => {}); };
  const finished = m.finish(outcome); await microtasks();
  h.sched.advance(2999); await microtasks(); assert.equal(h.endedCount, 0);
  h.sched.advance(1); await finished;
  assert.equal(h.endedCount, 1); assert.equal(h.ended.settlementPending, true);
  assert.equal(m.pendingResultJob.receipt, 'unknown');
  await m.finish(outcome); assert.equal(calls, 1); assert.equal(h.endedCount, 1);
});

test('result progress: a delayed real receipt updates only through the archived-result bridge', async t => {
  const h = fixture(t), m = h.m; let release; const late = [];
  m.opts.onResultUpdate = result => late.push(result);
  m.completeMatch = job => new Promise(resolve => { release = () => resolve({ result: job.result }); });
  const finished = m.finish(outcome); await microtasks(); h.sched.advance(3000); await finished;
  const publicCount = h.bc.filter(msg => msg.t === 'm.public').length;
  release(); await microtasks();
  assert.equal(late.length, 1); assert.equal(late[0].matchId, m.matchId);
  assert.equal(late[0].settlementPending, undefined); assert.equal(m.pendingResultJob, undefined);
  assert.equal(h.bc.filter(msg => msg.t === 'm.public').length, publicCount);
  assert.equal(h.endedCount, 1);
});

test('result progress: a late rejection retains evidence and sends an explicit failed receipt rather than false success', async t => {
  const h = fixture(t), m = h.m; let reject; const late = [];
  m.opts.onResultUpdate = result => late.push(result);
  m.completeMatch = () => new Promise((_, no) => { reject = no; });
  const finished = m.finish(outcome); await microtasks(); h.sched.advance(3000); await finished;
  reject(new Error('injected ambiguous receipt')); await microtasks();
  assert.equal(late.length, 1); assert.equal(late[0].incomplete, true);
  assert.equal(m.pendingResultJob.blocked, 'RESULT_SETTLEMENT_FAILED');
  assert.equal(m.pendingResultJob.receipt, 'unknown'); assert.equal(h.endedCount, 1);
});

for (const callback of ['throws', 'rejects', 'hangs']) test('result progress: onEnd ' + callback + ' does not trap finish or duplicate notification', async t => {
  const h = fixture(t), m = h.m; let ends = 0;
  m.completeMatch = async job => ({ result: job.result });
  m.onEndFn = () => { ends++; if (callback === 'throws') throw new Error('injected end throw');
    return callback === 'rejects' ? Promise.reject(new Error('injected end rejection')) : new Promise(() => {}); };
  await m.finish(outcome); await m.finish(outcome); await microtasks();
  assert.equal(ends, 1); assert.equal(m.lastResultMsg.settlementPending, undefined);
  if (callback !== 'hangs') assert.ok(m.errors.some(e => e.label === 'onEnd'));
});

test('result progress: one recipient send failure cannot stop remaining results or release callback', async t => {
  const h = fixture(t), m = h.m; const send = m.sendTo.bind(m);
  m.sendTo = (pid, msg) => { if (pid === 'p_0' && msg.t === 'm.result') throw new Error('injected send failure'); return send(pid, msg); };
  m.completeMatch = async job => ({ result: job.result }); await m.finish(outcome);
  assert.equal(h.endedCount, 1);
  assert.equal(h.lastTo('p_1', 'm.result').settlementPending, undefined);
  assert.equal(h.lastTo('p_2', 'm.result').matchId, m.matchId);
  assert.ok(m.errors.some(e => e.label.includes('result send player p_0')));
});

test('result progress: failed elimination terminates visibly instead of trapping SETTLE or starting a corrupt next round', async t => {
  const h = fixture(t), m = h.m; let submissions = 0;
  m.completeMatch = () => { submissions++; throw new Error('must not submit corrupt state'); };
  m.order[0].lp = 0; m.order[0].eliminate = () => { throw new Error('partial cleanup'); };
  m.settle(null, null); await m.finishPromise;
  assert.equal(m.ended, true); assert.equal(m.phase, 'RESULT'); assert.equal(h.endedCount, 1);
  assert.equal(submissions, 0); assert.equal(m.lastResultMsg.incomplete, true);
  assert.ok(m.lastResultMsg.settlementErrors.some(e => e.code === 'RESULT_ELIMINATION_FAILED'));
});
