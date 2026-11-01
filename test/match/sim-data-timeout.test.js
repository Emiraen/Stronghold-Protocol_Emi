import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import { fetchSimDataFile, loadBrowserSim, SIM_DATA_FILES } from '../../public/js/battle/simLoader.js';
import { DATA } from './harness.js';

const base = new URL('../../server/sim/', import.meta.url).href;
const fileName = (url) => String(url).split('/').pop().replace(/.json$/, '');
const served = (url) => ({ ok: true, json: async () => structuredClone(DATA[fileName(url)]) });

test('headers that never settle time out even if fetch ignores AbortSignal', { timeout: 2000 }, async () => {
  let signal;
  const result = await fetchSimDataFile('/data/chess.json', { timeoutMs: 15, fetchFn: (_, options) => {
    signal = options.signal; assert.equal(options.cache, 'no-cache'); return new Promise(() => {});
  } });
  assert.equal(result, null); assert.equal(signal.aborted, true);
});

test('JSON body that never settles is covered by the same deadline', { timeout: 2000 }, async () => {
  let signal;
  const result = await fetchSimDataFile('/data/chess.json', { timeoutMs: 15, fetchFn: async (_, options) => {
    signal = options.signal; return { ok: true, json: () => new Promise(() => {}) };
  } });
  assert.equal(result, null); assert.equal(signal.aborted, true);
});

test('HTTP error does not read its body and returns null', async () => {
  let read = false;
  assert.equal(await fetchSimDataFile('/data/chess.json', { fetchFn: async () => ({ ok: false, status: 503, json: () => { read = true; } }) }), null);
  assert.equal(read, false);
});

test('synchronous fetch errors, async rejection, missing response and parse errors return null', async () => {
  for (const fetchFn of [() => { throw new Error('sync'); }, async () => { throw new Error('network'); }, async () => null, async () => ({ ok: true, json: async () => { throw new SyntaxError('JSON'); } })]) {
    assert.equal(await fetchSimDataFile('/data/chess.json', { fetchFn }), null);
  }
});

test('success clears its timer and never aborts a completed request', async (t) => {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const handles = new Set(); let clears = 0, signal;
  t.mock.method(globalThis, 'setTimeout', (...args) => { const h = set(...args); handles.add(h); return h; });
  t.mock.method(globalThis, 'clearTimeout', (h) => { if (handles.delete(h)) clears++; return clear(h); });
  const value = { chess: ['ok'] };
  assert.equal(await fetchSimDataFile('/data/chess.json', { timeoutMs: 15, fetchFn: async (_, options) => { signal = options.signal; return { ok: true, json: async () => value }; } }), value);
  assert.equal(clears, 1); assert.equal(handles.size, 0);
  await sleep(30); assert.equal(signal.aborted, false);
});

test('early fetch and JSON failures also cancel their timers', async (t) => {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout; const handles = new Set();
  t.mock.method(globalThis, 'setTimeout', (...args) => { const h = set(...args); handles.add(h); return h; });
  t.mock.method(globalThis, 'clearTimeout', (h) => { handles.delete(h); return clear(h); });
  await fetchSimDataFile('/data/chess.json', { fetchFn: async () => { throw new Error('failed'); } });
  await fetchSimDataFile('/data/chess.json', { fetchFn: async () => ({ ok: true, json: async () => { throw new Error('parse'); } }) });
  assert.equal(handles.size, 0);
});

test('late rejection after timeout is handled without a detached rejection', { timeout: 2000 }, async () => {
  let rejectHeaders, rejectBody;
  assert.equal(await fetchSimDataFile('/headers', { timeoutMs: 10, fetchFn: () => new Promise((_, reject) => { rejectHeaders = reject; }) }), null);
  assert.equal(await fetchSimDataFile('/body', { timeoutMs: 10, fetchFn: async () => ({ ok: true, json: () => new Promise((_, reject) => { rejectBody = reject; }) }) }), null);
  rejectHeaders(new Error('late headers')); rejectBody(new Error('late body'));
  await nextTurn();
});

test('11-file loader retries only a failed file once, then returns complete frozen data', async () => {
  const calls = new Map();
  const sim = await loadBrowserSim({ base, fetchFn: async (url) => {
    const n = fileName(url); calls.set(n, (calls.get(n) || 0) + 1);
    if (n === 'enemies' && calls.get(n) === 1) throw new Error('transient');
    return served(url);
  } });
  assert.equal(SIM_DATA_FILES.length, 11); assert.equal(calls.size, 11);
  assert.equal([...calls.values()].reduce((a,b) => a+b,0), 12); assert.equal(calls.get('enemies'), 2);
  for (const n of SIM_DATA_FILES) assert.equal(Object.isFrozen(sim.raw[n]), true);
  assert.ok(sim.spec && sim.ds);
});

test('missing data still fails validation after exactly two attempts', async () => {
  const calls = new Map();
  await assert.rejects(loadBrowserSim({ base, fetchFn: async (url) => {
    const n = fileName(url); calls.set(n, (calls.get(n) || 0) + 1);
    return n === 'bonds' ? { ok: false, status: 503 } : served(url);
  } }), /simulation data unavailable: bonds/);
  assert.equal(calls.get('bonds'), 2); assert.equal([...calls.values()].reduce((a,b) => a+b,0), 12);
});

test('loader bounds both hanging attempts of every file without an infinite wait', { timeout: 3000 }, async (t) => {
  const set = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => set(fn, ms === 15000 ? 10 : ms, ...args));
  let calls = 0; const signals = [];
  await assert.rejects(loadBrowserSim({ base, fetchFn: (_, options) => { calls++; signals.push(options.signal); return new Promise(() => {}); } }), /simulation data unavailable: chess, enemies, tokens, stages, waves, bonds, items, garrisons, bands, effects, backups/);
  assert.equal(calls, 22); assert.equal(signals.every(s => s.aborted), true);
});

test('provided content data still clones and freezes all files without network IO', async () => {
  const sim = await loadBrowserSim({ base, data: DATA, fetchFn: () => { throw new Error('must not fetch'); } });
  for (const n of SIM_DATA_FILES) { assert.notEqual(sim.raw[n], DATA[n]); assert.equal(Object.isFrozen(sim.raw[n]), true); }
});
