import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRecord, recordResult, loadStats, liveMatch } from '../../public/js/ui/stats.js';
import { reportResult } from '../../public/js/screens/result.js';

const complete = () => ({ victory: true, roundsPassed: 8, players: [
  { playerId: 'bad', seat: 0, name: 'First', roundsPassed: 8, reward: 19, trophies: 2, lp: 10, stats: { kills: 3 } },
  { playerId: 'good', seat: 1, name: 'Second', roundsPassed: 8, reward: 23, trophies: 4, lp: 20, stats: { kills: 9 }, rank: { after: 100 } },
] });

test('incomplete result: result report preserves healthy rows and leaves failed economic values unavailable, not zero', () => {
  const result = complete(); result.incomplete = true; result.players[0].stats = null;
  result.players[0].settlementError = { code: 'RESULT_STATS_UNAVAILABLE' };
  const report = reportResult(result); const [bad, good] = report.players;
  assert.equal(report.incomplete, true); assert.deepEqual(bad.stats, {});
  for (const key of ['roundsPassed', 'reward', 'trophies', 'lp', 'rank']) assert.equal(bad[key], null, key);
  assert.equal(bad.settlementError.code, 'RESULT_STATS_UNAVAILABLE');
  assert.equal(good.stats.kills, 9); assert.equal(good.reward, 23); assert.equal(good.roundsPassed, 8);
  assert.equal(result.players[0].stats, null, 'display must not mutate server evidence');
});

test('incomplete result: stats:null alone receives explicit unavailable state instead of false normal defaults', () => {
  const result = complete(); result.players[0].stats = null;
  const report = reportResult(result);
  assert.equal(report.incomplete, true); assert.equal(report.players[0].reward, null);
  assert.equal(report.players[0].settlementError.code, 'RESULT_STATS_UNAVAILABLE');
});

test('incomplete result: buildRecord and recordResult reject incomplete, errors and null stats without touching storage', t => {
  const previous = globalThis.localStorage; let writes = 0;
  globalThis.localStorage = { getItem() { throw new Error('should not read'); }, setItem() { writes++; throw new Error('should not write'); } };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  for (const mark of [
    res => { res.incomplete = true; },
    res => { res.settlementErrors = [{ playerId: 'bad', code: 'RESULT_STATS_UNAVAILABLE' }]; },
    res => { res.players[0].settlementError = { code: 'RESULT_STATS_UNAVAILABLE' }; },
    res => { res.players[0].stats = null; },
  ]) {
    const result = complete(); mark(result);
    assert.equal(buildRecord(result, { myId: 'good', now: 1 }), null);
    assert.equal(recordResult(result, { myId: 'good', now: 1 }), null);
  }
  assert.equal(writes, 0); assert.ok(buildRecord(complete(), { myId: 'good', now: 1 }));
});

test('incomplete result: actual settlement entry bypasses reward animation and report labels the failure', () => {
  const flow = readFileSync(new URL('../../public/js/screens/settle.js', import.meta.url), 'utf8');
  const report = readFileSync(new URL('../../public/js/screens/result.js', import.meta.url), 'utf8');
  const screen = flow.slice(flow.indexOf('export function ResultScreen()'));
  assert.ok(screen.indexOf('res?.incomplete') < screen.indexOf('<${SettleFlow}'));
  assert.ok(screen.includes('return html`<${ResultView}'));
  assert.ok(report.includes("p.settlementError ? trA('结算未完成')"));
  assert.ok(report.includes('!r.incomplete && !r.settlementPending && showSettlement'));
});

test('pending result keeps battle statistics but suppresses all provisional economy without mutating the receipt', () => {
  const result = { ...complete(), settlementPending: true };
  const report = reportResult(result);
  assert.equal(report.settlementPending, true); assert.equal(report.incomplete, false);
  assert.equal(report.roundsPassed, 8);
  assert.equal(report.players[0].stats.kills, 3);
  assert.equal(report.players[1].stats.kills, 9);
  for (const row of report.players) {
    assert.equal(row.roundsPassed, 8);
    for (const key of ['reward', 'trophies', 'rank']) assert.equal(row[key], null, key);
  }
  assert.equal(result.players[1].rank.after, 100);
  assert.equal(result.players[1].reward, 23);
});

test('pending result cannot consume deduplication; authoritative receipt later records exactly once', t => {
  const previous = globalThis.localStorage; const saved = new Map();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  const result = { ...complete(), matchId: 'receipt-one', seed: 123, durationMs: 1000 };
  const ctx = { myId: 'good', now: 1 };
  assert.equal(buildRecord({ ...result, settlementPending: true }, ctx), null);
  assert.equal(recordResult({ ...result, settlementPending: true }, ctx), null);
  assert.equal(saved.size, 0);
  assert.ok(recordResult(result, ctx));
  assert.equal(recordResult(result, ctx), null);
  assert.equal(loadStats().records.length, 1);
  assert.equal(loadStats().records[0].players[1].reward, 23);
});

test('late authoritative history does not reset a newer live match tracker', t => {
  const previous = globalThis.localStorage; const tracker = { ...liveMatch }; const saved = new Map();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  Object.assign(liveMatch, { active: true, startedAt: 400, sawStart: true, aliveRound: 3, settledSerial: 9 });
  t.after(() => { Object.assign(liveMatch, tracker); if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  assert.ok(recordResult(complete(), { myId: 'good', now: 1, historyOnly: true }));
  assert.equal(liveMatch.active, true); assert.equal(liveMatch.settledSerial, 9);
  assert.equal(liveMatch.startedAt, 400); assert.equal(liveMatch.aliveRound, 3);
});

test('pending settlement bypasses reward animations and uses the existing report status styling', () => {
  const flow = readFileSync(new URL('../../public/js/screens/settle.js', import.meta.url), 'utf8');
  const report = readFileSync(new URL('../../public/js/screens/result.js', import.meta.url), 'utf8');
  const screen = flow.slice(flow.indexOf('export function ResultScreen()'));
  assert.ok(screen.indexOf('res?.settlementPending') < screen.indexOf('<${SettleFlow}'));
  assert.ok(report.includes("trA('结算处理中')"));
  assert.ok(report.includes("r.incomplete || r.settlementPending ? 'status'"));
});
