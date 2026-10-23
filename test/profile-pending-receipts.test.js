import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PendingResults } from '../server/profileService.js';

const mid = '1'.repeat(32), aid = 'a'.repeat(32), pid = 'p1';
const completeJob = () => ({ match: { matchId: mid }, ranked: true,
  seats: [{ aid, playerId: pid, isBot: false }], entries: [{ who: { aid, playerId: pid }, row: { roundsPassed: 1 } }],
  result: { t: 'm.result', players: [{ playerId: pid, stats: { kills: 1 } }] } });
const historyJob = () => ({ matchId: mid, seats: [{ aid, playerId: pid, isBot: false }], summary: { players: [{ playerId: pid }] } });
const log = { error() {} };
const fail = () => { throw new Error('injected lost economic response'); };
function fixture(t, call) {
  const dir = mkdtempSync(join(tmpdir(), 'stronghold-pending-receipt-'));
  const file = join(dir, 'pending.json'), received = [];
  const pending = new PendingResults(file, call, (job, value) => received.push([job, value]), log);
  t.after(() => { pending.close(); rmSync(dir, { recursive: true, force: true }); });
  return { pending, file, received };
}

for (const mode of ['before', 'after']) test(`economic receipt: failure ${mode} commit blocks automatic and repeated submissions`, async t => {
  let calls = 0, commits = 0;
  const { pending, file, received } = fixture(t, async () => { calls++; if (mode === 'after') commits++; fail(); });
  await assert.rejects(pending.submit('complete', [completeJob()]), { code: 'RESULT_SETTLEMENT_FAILED' });
  await pending.drain(); pending.start(); await pending.finished;
  await assert.rejects(pending.submit('complete', [completeJob()]), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(calls, 1); assert.equal(commits, mode === 'after' ? 1 : 0); assert.equal(received.length, 0);
  assert.equal(pending.jobs.get(`complete:${mid}`).blocked.receipt, 'unknown'); assert.equal(pending.timer, undefined);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobs[0].blocked.receipt, 'unknown');
});

test('economic receipt: before dispatch persisted marker survives crash/reopen and never sends again', async t => {
  let calls = 0, release;
  const { pending, file } = fixture(t, async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const first = pending.submit('complete', [completeJob()]);
  const marker = JSON.parse(readFileSync(file, 'utf8')).jobs[0];
  assert.equal(marker.blocked.receipt, 'unknown');
  let reopenedCalls = 0; const reopened = new PendingResults(file, async () => { reopenedCalls++; }, () => {}, log);
  t.after(() => reopened.close());
  await reopened.drain();
  await assert.rejects(reopened.submit('complete', [completeJob()]), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(reopenedCalls, 0); assert.equal(reopened.timer, undefined); assert.equal(calls, 1);
  release({ result: completeJob().result }); await first;
});

test('economic receipt: legacy pending request without a receipt is unknown on startup, not proof of no commit', async t => {
  const { pending, file } = fixture(t, async () => fail()); pending.close();
  writeFileSync(file, JSON.stringify({ version: 1, jobs: [{ id: `complete:${mid}`, op: 'complete', args: [completeJob()] }] }));
  let calls = 0; const reopened = new PendingResults(file, async () => { calls++; }, () => {}, log); t.after(() => reopened.close());
  await reopened.drain(); await assert.rejects(reopened.submit('complete', [completeJob()]), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(calls, 0); assert.equal(reopened.jobs.size, 1);
});

test('economic receipt: successful response is reused by concurrent waiters and clears the durable block', async t => {
  let calls = 0, release; const answer = { result: completeJob().result };
  const { pending, file, received } = fixture(t, async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const first = pending.submit('complete', [completeJob()]); const second = pending.submit('complete', [completeJob()]);
  release(answer); assert.deepEqual(await first, answer); assert.deepEqual(await second, answer);
  assert.equal(calls, 1); assert.equal(received.length, 1); assert.equal(pending.jobs.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).jobs, []);
});

test('economic receipt: response received but clearing durable pending fails, so the request is blocked rather than resent', async t => {
  let calls = 0; const { pending } = fixture(t, async () => { calls++; return { result: completeJob().result }; });
  const save = pending.save.bind(pending); let saves = 0;
  pending.save = () => { if (++saves === 3) throw new Error('injected pending clear failure'); return save(); };
  await assert.rejects(pending.submit('complete', [completeJob()]), { code: 'RESULT_SETTLEMENT_FAILED' });
  await pending.drain(); assert.equal(calls, 1); assert.equal(pending.jobs.size, 1); assert.equal(pending.timer, undefined);
});

test('history-only receipt: non-economic historyRecord retains its existing retry path', async t => {
  let calls = 0; const { pending } = fixture(t, async op => { assert.equal(op, 'historyRecord'); if (++calls === 1) fail(); return null; });
  const result = pending.submit('historyRecord', [historyJob()]); await pending.finished;
  assert.ok(pending.timer); assert.equal(pending.jobs.values().next().value.blocked, undefined);
  await pending.drain(); assert.equal(await result, null); assert.equal(calls, 2); assert.equal(pending.jobs.size, 0);
});

test('economic receipt: blocked unknown settlement does not prevent a different first-time request', async t => {
  const calls = []; const { pending } = fixture(t, async (_op, [job]) => {
    calls.push(job.match.matchId); if (job.match.matchId === mid) fail(); return { result: job.result };
  });
  await assert.rejects(pending.submit('complete', [completeJob()]), { code: 'RESULT_SETTLEMENT_FAILED' });
  const next = completeJob(); next.match.matchId = '2'.repeat(32);
  next.seats[0].aid = next.entries[0].who.aid = 'b'.repeat(32);
  const saved = await pending.submit('complete', [next]);
  assert.deepEqual(saved.result, next.result); assert.deepEqual(calls, [mid, next.match.matchId]);
  assert.equal(pending.jobs.size, 1); assert.equal(pending.jobs.values().next().value.blocked.receipt, 'unknown');
});

test('economic receipt: inability to persist the dispatch barrier means authority is never called', async t => {
  let calls = 0; const { pending } = fixture(t, async () => { calls++; fail(); });
  const save = pending.save.bind(pending); let saves = 0;
  pending.save = () => { if (++saves >= 2) throw new Error('injected barrier write failure'); return save(); };
  await assert.rejects(pending.submit('complete', [completeJob()]), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(calls, 0); assert.equal(pending.jobs.size, 1); assert.equal(pending.timer, undefined);
});
