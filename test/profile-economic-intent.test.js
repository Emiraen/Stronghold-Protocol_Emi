import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileReplication } from '../server/profileReplication.js';

const aid = 'a'.repeat(32), mid = '1'.repeat(32);
const job = () => ({ match: { matchId: mid }, ranked: true, seats: [{ aid, playerId: 'p1', isBot: false }] });
function stores() {
  return Object.fromEntries(['players', 'ranked', 'history'].map(name => [name, { profiles: new Map(), file: null,
    writer: { save() {} }, async flush() {} }]));
}
function fixture(t, execute) {
  const dir = mkdtempSync(join(tmpdir(), 'stronghold-economic-intent-')), file = join(dir, 'replication.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateStores = stores();
  const replication = new ProfileReplication({ role: 'main', stores: stateStores, file, execute: (...args) => execute(stateStores, ...args) });
  return { replication, stores: stateStores, file, disk: () => JSON.parse(readFileSync(file, 'utf8')) };
}

for (const mode of ['before', 'after']) test(`economic intent: ${mode}-mutation failure is never executed again during recover or next transaction`, async t => {
  let executions = 0; const f = fixture(t, async (s) => {
    executions++; if (mode === 'after') s.ranked.profiles.set(aid, { aid, points: 50, settlements: {} });
    throw new Error('injected incomplete economic execution');
  });
  await assert.rejects(f.replication.transact('complete', [job()]), /injected incomplete/);
  assert.equal(executions, 1); assert.equal(f.disk().economicQuarantine[`complete:${mid}`].blocked.receipt, 'unknown');
  await f.replication.recover();
  await assert.rejects(f.replication.transact('record', [aid, 'later']), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(executions, 1); assert.equal(f.replication.initialized, true);
  let restartedCalls = 0; const restarted = new ProfileReplication({ role: 'main', stores: stores(), file: f.file, execute: async () => { restartedCalls++; } });
  await restarted.recover();
  await assert.rejects(restarted.finishIntent(), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(restartedCalls, 0); assert.equal(restarted.state.economicQuarantine[`complete:${mid}`].op, 'complete');
});

test('economic intent: legacy unknown complete intent is blocked on startup without consulting or executing all profiles', async t => {
  let executions = 0; const f = fixture(t, async () => { executions++; });
  f.replication.state.intent = { op: 'complete', args: [job()], plan: [{ aid, before: { rank: null, history: null } }] };
  f.replication.save();
  const restarted = new ProfileReplication({ role: 'main', stores: stores(), file: f.file, execute: async () => { executions++; } });
  await restarted.recover();
  assert.equal(executions, 0); assert.equal(restarted.state.economicQuarantine[`complete:${mid}`].blocked.receipt, 'unknown');
});

test('economic intent: healthy newly created complete transaction executes exactly once and materializes commit', async t => {
  let executions = 0; const f = fixture(t, async s => {
    executions++; s.ranked.profiles.set(aid, { aid, points: 77, settlements: {} });
    s.history.profiles.set(aid, { name: 'one', items: [] }); return 'confirmed';
  });
  assert.equal(await f.replication.transact('complete', [job()]), 'confirmed');
  await f.replication.recover();
  assert.equal(executions, 1); assert.equal(f.replication.state.intent, undefined);
  assert.equal(f.replication.state.commit, undefined); assert.equal(f.replication.initialized, true);
});

test('economic intent: known commit patches recover without rerunning reward execute after materialization failure', async t => {
  let executions = 0; const f = fixture(t, async s => {
    executions++; s.ranked.profiles.set(aid, { aid, points: 81, settlements: { [mid + ':p1']: { after: 81 } } });
    s.history.profiles.set(aid, { name: 'one', items: [] });
  });
  f.stores.ranked.flush = async () => { throw new Error('injected state materialization failure'); };
  await assert.rejects(f.replication.transact('complete', [job()]), /materialization failure/);
  assert.equal(f.disk().intent, undefined); assert.ok(f.disk().commit); assert.equal(executions, 1);
  const freshStores = stores(); let restartedCalls = 0;
  const restarted = new ProfileReplication({ role: 'main', stores: freshStores, file: f.file, execute: async () => { restartedCalls++; } });
  await restarted.recover();
  assert.equal(restartedCalls, 0); assert.equal(freshStores.ranked.profiles.get(aid).points, 81);
  assert.equal(restarted.state.commit, undefined); assert.equal(restarted.initialized, true);
});

test('economic intent: unknown intent cannot suppress materialization of a separately known commit', async t => {
  let executions = 0; const f = fixture(t, async () => { executions++; });
  f.replication.state.intent = { op: 'complete', args: [job()], plan: [{ aid, before: { rank: null } }] };
  f.replication.state.commit = { patches: [{ aid, fields: { rank: { aid, points: 91 } } }] }; f.replication.save();
  await f.replication.recover();
  assert.equal(executions, 0); assert.equal(f.stores.ranked.profiles.get(aid).points, 91);
  assert.equal(f.replication.state.commit, undefined); assert.equal(f.replication.state.economicQuarantine[`complete:${mid}`].blocked.receipt, 'unknown');
});

test('economic intent: confirmed snapshot materialization is retained without reward execution', async t => {
  let executions = 0; const f = fixture(t, async () => { executions++; });
  f.replication.state.commit = { snapshot: { players: [], ranked: [[aid, { aid, points: 101 }]], history: [] } }; f.replication.save();
  await f.replication.recover();
  assert.equal(executions, 0); assert.equal(f.stores.ranked.profiles.get(aid).points, 101); assert.equal(f.replication.state.commit, undefined);
});

test('economic intent: non-economic history intent retains existing recovery behavior', async t => {
  let executions = 0; const f = fixture(t, async (s, op) => {
    executions++; assert.equal(op, 'historyRecord'); s.history.profiles.set(aid, { name: 'one', items: [] });
  });
  f.replication.state.intent = { op: 'historyRecord', args: [{ seats: [{ aid, isBot: false }] }], plan: [{ aid, before: { history: null } }] };
  f.replication.save(); await f.replication.recover();
  assert.equal(executions, 1); assert.equal(f.replication.state.intent, undefined); assert.equal(f.replication.state.commit, undefined);
});
