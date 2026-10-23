import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give } from './harness.js';
import { buildResult, assignTitles } from '../../server/match/results.js';

const outcome = { victory: false, hiddenReached: false, hiddenCleared: false, reason: 'defeat' };
const fail = () => { throw new Error('injected result failure'); };
function fixture(t) {
  const h = makeMatch({ mode: 'coop', humans: 3, fake: true }).start(); h.toPrep(1);
  t.after(() => h.m.dispose());
  return { h, m: h.m, p: h.m.order };
}

test('result isolation: one title stat failure does not suppress healthy candidates', () => {
  const gd = { titles: [{ id: 'best', stat: 'activatedLayers', rule: 'max' }] };
  const reports = [];
  const title = assignTitles(gd, [
    { playerId: 'bad', seat: 0, activatedLayers: fail },
    { playerId: 'good', seat: 1, activatedLayers: () => 8 },
  ], false, (ps, stat, error) => reports.push([ps.playerId, stat, error.message]));
  assert.equal(title.get('good').id, 'best'); assert.equal(title.has('bad'), false);
  assert.equal(reports.length, 1); assert.deepEqual(reports[0].slice(0, 2), ['bad', 'activatedLayers']);
});

test('result isolation: skin/display failure preserves genuine economic fields and all healthy rows', t => {
  const { m, p } = fixture(t);
  const piece = give(m, p[0], 'chess_char_2_02_a');
  p[0].hand[p[0].hand.indexOf(piece)] = null; p[0].board.set('9,3', piece); p[0].skinFor = fail;
  p[0].stats.rankedDamage = 123; p[1].stats.rankedDamage = 456;
  const result = buildResult(m, outcome);
  assert.equal(result.players.length, 3); assert.equal(result.incomplete, undefined);
  assert.deepEqual(result.players[0].lineup, []); assert.equal(result.players[0].stats.rankedDamage, 123);
  assert.equal(result.players[1].stats.rankedDamage, 456);
  assert.ok(result.displayErrors.some(e => e.playerId === p[0].playerId && e.stage === 'display'));
  assert.ok(m.errors.some(e => e.label.includes('result display player p_0')));
});

test('result isolation: invalid economic stats remain explicit failure without zero reward or empty healthy rows', t => {
  const { m, p } = fixture(t); p[0].stats = null; p[2].stats.rankedDamage = 999;
  const result = buildResult(m, outcome); const bad = result.players[0];
  assert.equal(result.players.length, 3); assert.equal(result.incomplete, true); assert.equal(bad.stats, null);
  assert.equal(Object.hasOwn(bad, 'roundsPassed'), false); assert.equal(Object.hasOwn(bad, 'reward'), false);
  assert.equal(Object.hasOwn(bad, 'trophies'), false); assert.equal(bad.settlementError.code, 'RESULT_STATS_UNAVAILABLE');
  assert.equal(result.players[2].stats.rankedDamage, 999); assert.ok(Number.isFinite(result.players[2].reward));
  assert.deepEqual(result.settlementErrors.map(e => e.playerId), ['p_0']); assert.equal(m._resultJob(result), null);
});

test('result isolation: non-finite statistic cannot silently become a valid settlement', t => {
  const { m, p } = fixture(t); p[0].stats.rankedDamage = NaN;
  const result = buildResult(m, outcome);
  assert.equal(result.incomplete, true); assert.equal(result.players[0].stats, null);
  assert.ok(result.players[1].stats); assert.equal(m._resultJob(result), null);
  p[0].stats.rankedDamage = 0; p[0].stats.assists = NaN;
  const invalidAssists = buildResult(m, outcome);
  assert.equal(invalidAssists.incomplete, true); assert.equal(invalidAssists.players[0].stats, null);
});

test('result isolation: job boundary independently rejects a missing or null-stat human without inventing entries', t => {
  const { m, p } = fixture(t); p[0].aid = '1234567890abcdef';
  for (const modify of [res => { res.players.shift(); }, res => { res.players[0].stats = null; }]) {
    const result = buildResult(m, outcome); modify(result);
    assert.equal(m._resultJob(result), null); assert.equal(result.incomplete, true);
    assert.equal(result.settlementErrors[0].playerId, p[0].playerId);
  }
});

test('result isolation: display-only failure still permits genuine complete economic submission', async t => {
  const { m, p } = fixture(t); let complete = 0, ended = 0;
  const piece = give(m, p[0], 'chess_char_2_02_a');
  p[0].hand[p[0].hand.indexOf(piece)] = null; p[0].board.set('9,3', piece); p[0].skinFor = fail;
  m.completeMatch = async job => { complete++; assert.equal(job.result.incomplete, undefined); return { result: job.result }; };
  m.onEndFn = () => ended++;
  await m.finish(outcome);
  assert.equal(complete, 1); assert.equal(ended, 1); assert.equal(m.historyPersisted, true);
  assert.equal(m.lastResultMsg.players.length, 3); assert.equal(m.pendingResultJob, undefined);
});

test('result isolation: incomplete finish displays healthy rows but neither submits nor auto-retries economic completion', async t => {
  const { h, m, p } = fixture(t); let complete = 0, ranked = 0, ended = 0;
  m.completeMatch = () => { complete++; fail(); }; m._settleRanked = () => { ranked++; fail(); };
  m.onEndFn = () => ended++; p[0].stats = null;
  await m.finish(outcome); await m.finish(outcome);
  assert.equal(complete, 0); assert.equal(ranked, 0); assert.equal(ended, 1); assert.equal(m.finishRetry, undefined);
  assert.equal(m.pendingResultJob.blocked, 'RESULT_INCOMPLETE'); assert.equal(m.pendingResultJob.job, null);
  assert.equal(m.lastResultMsg.incomplete, true); assert.equal(m.lastResultMsg.players.length, 3);
  for (const ps of p) {
    assert.equal(h.lastTo(ps.playerId, 'm.result').incomplete, true);
    const notice = h.lastTo(ps.playerId, 'm.toast');
    assert.equal(notice.text, '发生错误！请复制诊断信息并联系服主');
    assert.equal(notice.diagnostic.code, 'RESULT_INCOMPLETE');
  }
});

for (const mode of ['before', 'after']) test(`result receipt: completion failure ${mode} commit never triggers blind replay`, async t => {
  const { h, m, p } = fixture(t); let calls = 0, commits = 0, ended = 0;
  m.completeMatch = async () => { calls++; if (mode === 'after') commits++; fail(); };
  m.onEndFn = () => ended++;
  await m.finish(outcome); await m.finish(outcome);
  assert.equal(calls, 1); assert.equal(commits, mode === 'after' ? 1 : 0); assert.equal(ended, 1);
  assert.equal(m.finishRetry, undefined); assert.equal(m.pendingResultJob.blocked, 'RESULT_SETTLEMENT_FAILED');
  assert.equal(m.pendingResultJob.receipt, 'unknown'); assert.equal(m.lastResultMsg.incomplete, true);
  for (const ps of p) {
    assert.equal(h.lastTo(ps.playerId, 'm.toast').diagnostic.code, 'RESULT_SETTLEMENT_FAILED');
    assert.equal(h.lastTo(ps.playerId, 'm.toast').text, '发生错误！请复制诊断信息并联系服主');
  }
});

test('result receipt: partial direct ranked settlement and failed persistence are never replayed', async t => {
  const { m } = fixture(t); let rankedCalls = 0, flushes = 0;
  m._settleRanked = async () => { rankedCalls++; };
  m.rankedStore = { flush: async () => { flushes++; fail(); } };
  await m.finish(outcome); await m.finish(outcome);
  assert.equal(rankedCalls, 1); assert.equal(flushes, 1); assert.equal(m.finishRetry, undefined);
  assert.equal(m.pendingResultJob.receipt, 'unknown');
});
