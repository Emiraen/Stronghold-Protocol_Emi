import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATS_VERSION, MAX_RECORDS, FULL_KEEP, emptyStats, fitToBudget, migrateStats,
  saveStats, loadStats, recordResult,
} from '../../public/js/ui/stats.js';

const KEY = 'sp.pref.stats';
const receipt = (seed = 991) => ({
  seed, durationMs: 1000, modeId: 'rank_multi_normal', roundsPassed: 8, victory: true,
  players: [{ playerId: 'me', name: 'self', reward: 17, trophies: 2, victory: true,
    roundsPassed: 8, stats: { kills: 4 }, lineup: [{ id: 'unit', items: ['gear'] }],
    bonds: [{ bondId: 'bond', layers: 2, active: true }] }],
});
const history = (n = MAX_RECORDS) => ({ v: STATS_VERSION, records: Array.from({ length: n }, (_, i) => ({
  id: 'fixture-' + i, t: n - i, end: 'settled', selfId: 'me', victory: true, roundsPassed: 8,
  players: [{ playerId: 'me', name: 'self', victory: true, roundsPassed: 8,
    stats: { kills: i }, lineup: [{ id: 'unit', items: ['gear'] }],
    bonds: [{ bondId: 'bond', layers: i === FULL_KEEP + 1 ? 99 : 2, active: true }] }],
})) });
function withStorage(t, raw = null) {
  const previous = globalThis.localStorage;
  const values = new Map(raw == null ? [] : [[KEY, raw]]);
  const calls = { reads: 0, writes: 0 };
  globalThis.localStorage = {
    getItem(key) { calls.reads++; return values.get(key) ?? null; },
    setItem(key, value) { calls.writes++; values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  return { values, calls };
}

test('recording parses the existing history only once and serializes each retained record only once', t => {
  const raw = JSON.stringify({ v: STATS_VERSION, records: fitToBudget(migrateStats(history()).stats.records) });
  const { values } = withStorage(t, raw);
  const originalParse = JSON.parse, originalStringify = JSON.stringify;
  let parses = 0, stringifies = 0;
  let stored;
  try {
    JSON.parse = (...args) => { parses++; return originalParse(...args); };
    JSON.stringify = (...args) => { stringifies++; return originalStringify(...args); };
    stored = recordResult(receipt(), { myId: 'me', now: 9000 });
  } finally { JSON.parse = originalParse; JSON.stringify = originalStringify; }
  assert.ok(stored);
  assert.equal(parses, 1, 'reuse the already parsed immutable raw snapshot during save');
  assert.equal(stringifies, MAX_RECORDS, 'one serialization per record; no second whole-envelope stringify');
  const saved = JSON.parse(values.get(KEY));
  assert.equal(saved.records.length, MAX_RECORDS);
  assert.equal(saved.records[0].id, stored.id);
  assert.equal(saved.records[0].players[0].reward, 17);
});

test('optimized serialization is byte-identical to the normalized budget envelope', t => {
  const { values } = withStorage(t);
  const stats = history(100);
  const expected = JSON.stringify({ v: STATS_VERSION, records: fitToBudget(migrateStats(stats).stats.records) });
  assert.equal(saveStats(stats), true);
  assert.equal(values.get(KEY), expected);
  const records = JSON.parse(expected).records;
  assert.equal(records[FULL_KEEP + 1].players[0].lineup[0].id, 'unit');
  assert.equal(records[FULL_KEEP + 2].players[0].lineup, undefined);
});

test('pending and incomplete receipts do not touch storage or consume final receipt deduplication', t => {
  const { calls } = withStorage(t);
  assert.equal(recordResult({ ...receipt(), settlementPending: true }, { myId: 'me' }), null);
  assert.equal(recordResult({ ...receipt(), incomplete: true }, { myId: 'me' }), null);
  assert.deepEqual(calls, { reads: 0, writes: 0 });
  assert.ok(recordResult(receipt(), { myId: 'me', now: 1 }));
  assert.equal(recordResult(receipt(), { myId: 'me', now: 1 }), null);
  assert.equal(loadStats().records.length, 1);
  assert.equal(calls.writes, 1);
});

test('a newer envelope appearing between recording read and write cannot be overwritten', t => {
  const previous = globalThis.localStorage; let reads = 0, writes = 0;
  globalThis.localStorage = {
    getItem() { return ++reads === 1 ? JSON.stringify(emptyStats()) : JSON.stringify({ v: STATS_VERSION + 1, records: [] }); },
    setItem() { writes++; },
  };
  const warn = console.warn; console.warn = () => {};
  t.after(() => { console.warn = warn; if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  assert.equal(recordResult(receipt(), { myId: 'me', now: 1 }), null);
  assert.equal(writes, 0);
});

test('quota retries retain newest records and reuse already serialized pieces', t => {
  const { values } = withStorage(t); const sizes = [];
  globalThis.localStorage.setItem = (key, value) => {
    const parsed = JSON.parse(value); sizes.push(parsed.records.length);
    if (parsed.records.length > 2) throw new Error('QuotaExceededError');
    values.set(key, value);
  };
  assert.equal(saveStats(history(9)), true);
  assert.deepEqual(sizes, [9, 5, 3, 2]);
  assert.deepEqual(JSON.parse(values.get(KEY)).records.map(r => r.id), ['fixture-0', 'fixture-1']);
});

test('a rejected storage write reports failure and does not claim a stored receipt', t => {
  withStorage(t); const warn = console.warn; console.warn = () => {};
  t.after(() => { console.warn = warn; });
  globalThis.localStorage.setItem = () => { throw new Error('disabled'); };
  assert.equal(recordResult(receipt(), { myId: 'me', now: 1 }), null);
  assert.equal(loadStats().records.length, 0);
});

test('damaged values are retained for recovery and legacy normalization still self-heals', t => {
  const { values } = withStorage(t, '{broken');
  const damaged = loadStats();
  assert.equal(damaged.damaged, true);
  assert.equal(values.get(KEY + '.damaged'), '{broken');
  values.set(KEY, JSON.stringify({ v: 0, records: history(1).records }));
  const migrated = loadStats();
  assert.equal(migrated.v, STATS_VERSION);
  assert.equal(migrated.records.length, 1);
  assert.equal(JSON.parse(values.get(KEY)).v, STATS_VERSION);
});

test('public save still normalizes untrusted input and refuses future-version storage', t => {
  const { values } = withStorage(t);
  const stats = history(1); stats.records[0].injected = 'drop';
  stats.records[0].players[0].stats.invalid = Infinity;
  assert.equal(saveStats(stats), true);
  const saved = JSON.parse(values.get(KEY));
  assert.equal(saved.records[0].injected, undefined);
  assert.equal(saved.records[0].players[0].stats.invalid, undefined);
  const future = JSON.stringify({ v: STATS_VERSION + 1, records: [] });
  values.set(KEY, future);
  assert.equal(saveStats(emptyStats()), false);
  assert.equal(values.get(KEY), future);
});
