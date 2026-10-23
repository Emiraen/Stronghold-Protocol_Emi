import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfileReplication } from '../server/profileReplication.js';
import { PendingResults, createProfileAccess } from '../server/profileService.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32), MID = '1'.repeat(32);
const log = { error() {}, warn() {}, info() {} };
const job = (aid = A, mid = MID, ranked = true) => ({ ranked, match: { matchId: mid },
  seats: [{ aid, playerId: 'p1', isBot: false }], entries: [{ who: { aid, playerId: 'p1' }, row: { roundsPassed: 1 } }],
  result: { players: [{ playerId: 'p1' }] } });
const historyJob = (aid = B, mid = '3'.repeat(32)) => ({ matchId: mid,
  seats: [{ aid, playerId: 'p1', isBot: false }], summary: { players: [{ playerId: 'p1' }] } });
function memoryStores() {
  return Object.fromEntries(['players', 'ranked', 'history'].map(name => [name, { profiles: new Map(),
    writer: { save() {} }, async flush() {} }]));
}
function fixture(t, execute) {
  const dir = mkdtempSync(join(tmpdir(), 'stronghold-quarantine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stores = memoryStores(), file = join(dir, 'replication.json');
  const replication = new ProfileReplication({ role: 'main', stores, file, execute: (...args) => execute(stores, ...args) });
  return { replication, stores, file, disk: () => JSON.parse(readFileSync(file, 'utf8')) };
}
async function isolate(f) { await assert.rejects(f.replication.transact('complete', [job()]), /injected/); }

test('quarantine: unknown complete evidence survives restart and is never executed again', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; throw Error('injected'); });
  await isolate(f);
  const retained = f.disk().economicQuarantine[`complete:${MID}`];
  assert.deepEqual(retained.args, [job()]); assert.ok(retained.plan[0].before);
  assert.equal(retained.blocked.receipt, 'unknown'); assert.equal(f.disk().intent, undefined);
  const reopened = new ProfileReplication({ role: 'main', stores: memoryStores(), file: f.file, execute: () => { calls++; } });
  await reopened.recover(); assert.equal(reopened.initialized, true);
  await assert.rejects(reopened.transact('complete', [job()]), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(calls, 1); assert.deepEqual(reopened.state.economicQuarantine[`complete:${MID}`], retained);
});

test('quarantine: independent identity, loadout, presentation and history transactions continue', async t => {
  const calls = []; const f = fixture(t, async (s, op, args) => {
    calls.push(op); if (op === 'complete') throw Error('injected');
    if (op === 'record') s.players.profiles.set(args[0], { aid: args[0], name: args[1] });
    if (op === 'loadout' || op === 'presentation') s.players.profiles.get(args[0])[op] = args[1];
    if (op === 'historyRecord') s.history.profiles.set(B, { items: [], name: 'B' });
    return 'ok';
  });
  await isolate(f);
  for (const [op, args] of [['record', [B, 'healthy']], ['loadout', [B, { one: 1 }]],
    ['presentation', [B, { avatar: 'one' }]], ['historyRecord', [historyJob()]]]) {
    assert.equal(await f.replication.transact(op, args), 'ok');
  }
  assert.equal(f.replication.initialized, true); assert.deepEqual(calls, ['complete', 'record', 'loadout', 'presentation', 'historyRecord']);
  assert.equal(f.stores.players.profiles.get(B).name, 'healthy');
});

test('quarantine: conflicting account and ranking-wide mutations reject without execution', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; throw Error('injected'); }); await isolate(f);
  for (const [op, args] of [['record', [A, 'unsafe']], ['historyRecord', [historyJob(A)]],
    ['complete', [job(B, '2'.repeat(32))]], ['rank.nameCards', [B, null]]]) {
    await assert.rejects(f.replication.transact(op, args), { code: 'RESULT_SETTLEMENT_FAILED' });
  }
  assert.throws(() => f.replication.assertIndependent('leaderboard'), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.throws(() => f.replication.exportSnapshot(), { code: 'RESULT_SETTLEMENT_FAILED' });
  await assert.rejects(f.replication.bootstrap({}), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(calls, 1);
});

test('quarantine: confirmed commit materializes before an unknown intent is isolated', async t => {
  const f = fixture(t, async () => { throw Error('must not execute'); });
  f.replication.state.intent = { op: 'complete', args: [job()], plan: [{ aid: A, before: { rank: null } }] };
  f.replication.state.commit = { patches: [{ aid: B, fields: { rank: { aid: B, points: 81 } } }] }; f.replication.save();
  let flushed = false; f.stores.ranked.flush = async () => { flushed = true; };
  const save = f.replication.save.bind(f.replication);
  f.replication.save = () => { if (f.replication.state.economicQuarantine) assert.equal(flushed, true); return save(); };
  await f.replication.recover();
  assert.equal(f.stores.ranked.profiles.get(B).points, 81); assert.equal(f.replication.state.commit, undefined);
  assert.equal(f.replication.quarantinedIntents().length, 1); assert.equal(f.replication.initialized, true);
});

test('quarantine: persistence failure never drops the original intent or permits unrelated writes', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; throw Error('injected'); });
  const save = f.replication.save.bind(f.replication);
  f.replication.save = () => { if (f.replication.state.economicQuarantine) throw Error('quarantine disk failure'); return save(); };
  await assert.rejects(f.replication.transact('complete', [job()]), /quarantine disk failure/);
  assert.equal(f.replication.state.intent.op, 'complete'); assert.equal(f.replication.state.economicQuarantine, undefined);
  assert.equal(f.disk().intent.op, 'complete');
  await assert.rejects(f.replication.transact('record', [B, 'later']), /quarantine disk failure/);
  assert.equal(calls, 1);
});

test('quarantine: failed confirmed-commit materialization keeps both evidence and recovery dependency', async t => {
  const f = fixture(t, async () => { throw Error('must not execute'); });
  f.replication.state.intent = { op: 'complete', args: [job()], plan: [{ aid: A, before: { rank: null } }] };
  f.replication.state.commit = { patches: [{ aid: B, fields: { rank: { aid: B, points: 81 } } }] }; f.replication.save();
  f.stores.ranked.flush = async () => { throw Error('commit flush failed'); };
  await assert.rejects(f.replication.recover(), /commit flush failed/);
  assert.ok(f.disk().intent); assert.ok(f.disk().commit); assert.equal(f.disk().economicQuarantine, undefined);
  await assert.rejects(f.replication.transact('record', [B, 'later']), /commit flush failed/);
});

test('quarantine: unresolved account lease is retained while independent leases may release', async t => {
  const f = fixture(t, async () => { throw Error('injected'); }); await isolate(f);
  f.replication.state.grants = { [A]: { token: 'ta' }, [B]: { token: 'tb' } };
  f.replication.updateReleases(new Set());
  assert.deepEqual(f.replication.state.releases, [{ aid: B, token: 'tb' }]);
});

test('quarantine: an incoming conflicted patch never advances the global received cursor', async t => {
  const f = fixture(t, async () => { throw Error('injected'); }); await isolate(f);
  const peer = '11111111-1111-4111-8111-111111111111';
  f.replication.state.owners[A] = { serverId: 'secondary', token: 'ta' };
  await assert.rejects(f.replication.exchange({ id: peer, cursor: 0, releases: [], pending: [{
    aid: A, sequence: 1, token: 'ta', fields: { rank: { aid: A, points: 100 } }, base: { rank: 0 }, versions: { rank: 1 },
  }] }, { current: () => false }), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(f.replication.state.received, 0); assert.equal(f.replication.version(A, 'rank'), 0);
});

test('quarantine: independent confirmed incoming patch and heartbeat can continue without replaying economics', async t => {
  const f = fixture(t, async () => { throw Error('injected'); }); await isolate(f);
  const peer = '11111111-1111-4111-8111-111111111111';
  f.replication.state.owners[B] = { serverId: 'secondary', token: 'tb' };
  const response = await f.replication.exchange({ id: peer, cursor: 0, releases: [], pending: [{
    aid: B, sequence: 1, token: 'tb', fields: { identity: { aid: B, name: 'healthy' } }, base: { identity: 0 }, versions: { identity: 1 },
  }] }, { current: () => false });
  assert.equal(response.ack, 1); assert.equal(f.stores.players.profiles.get(B).name, 'healthy');
  assert.equal(f.replication.quarantinedIntents().length, 1);
});

test('pending: unknown account blocks only its own jobs and retains account identity for lease protection', async t => {
  const f = fixture(t, async () => {}); const calls = [];
  const pending = new PendingResults(null, async (op, [value]) => { calls.push(op); if (op === 'complete') throw Error('injected'); return value; }, () => {}, log);
  t.after(() => pending.close());
  await assert.rejects(pending.submit('complete', [job()]), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(pending.affectsAid(A), true); assert.equal(pending.affectsAid(B), false);
  assert.deepEqual([...pending.activeAids()], [A]);
  await assert.rejects(pending.submit('historyRecord', [historyJob(A)]), { code: 'RESULT_SETTLEMENT_FAILED' });
  await pending.submit('historyRecord', [historyJob(B)]);
  assert.deepEqual(calls, ['complete', 'historyRecord']); assert.equal(pending.jobs.size, 1);
  assert.equal(f.replication.initialized, true);
});

test('pending: one failed history job does not starve a later independent job in the same drain', async t => {
  const calls = []; const pending = new PendingResults(null, async (_op, [value]) => {
    calls.push(value.matchId); if (value.matchId === MID) throw Error('history first failed'); return value;
  }, () => {}, log); t.after(() => pending.close());
  const first = historyJob(A, MID), second = historyJob(B);
  pending.jobs.set(`historyRecord:${MID}`, { id: `historyRecord:${MID}`, op: 'historyRecord', args: [first] });
  pending.jobs.set(`historyRecord:${second.matchId}`, { id: `historyRecord:${second.matchId}`, op: 'historyRecord', args: [second] });
  await pending.drain();
  assert.deepEqual(calls, [MID, second.matchId]); assert.equal(pending.jobs.size, 1);
  assert.equal(pending.jobs.values().next().value.args[0].matchId, MID); assert.ok(pending.timer);
});

test('peer quarantine: versioned status persists and missing, stale or disconnected exchanges never clear it', async t => {
  const f = fixture(t, async () => {});
  const secondary = new ProfileReplication({ role: 'secondary', stores: memoryStores(), file: f.file, execute() {} });
  secondary.state.initialized = true;
  const reply = (economicQuarantine) => ({ replication: { ack: 0, events: [], cursor: 0, head: 0, released: [],
    ...(economicQuarantine === undefined ? {} : { economicQuarantine }) } });
  await secondary.sync(async () => reply({ schema: 1, rankingPending: true, aids: [A] }));
  assert.equal(secondary.hasRankUncertainty(), true); assert.ok(secondary.quarantinedAids().has(A));
  await secondary.sync(async () => reply(undefined));
  await secondary.sync(async () => reply({ schema: 1, rankingPending: false, aids: [] }));
  await assert.rejects(secondary.sync(async () => { throw Error('offline'); }), /offline/);
  assert.equal(secondary.hasRankUncertainty(), true);
  const restarted = new ProfileReplication({ role: 'secondary', stores: memoryStores(), file: f.file, execute() {} });
  assert.equal(restarted.hasRankUncertainty(), true); assert.ok(restarted.quarantinedAids().has(A));
  assert.throws(() => restarted.assertIndependent('login', [A]), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.doesNotThrow(() => restarted.assertIndependent('login', [B]));
});

test('peer quarantine: confirmed inbound facts still materialize and unrelated heartbeat progress continues', async t => {
  const f = fixture(t, async () => {});
  const secondary = new ProfileReplication({ role: 'secondary', stores: memoryStores(), file: f.file, execute() {} });
  secondary.state.initialized = true;
  await secondary.sync(async () => ({ replication: { ack: 0, cursor: 1, head: 1, released: [],
    economicQuarantine: { schema: 1, rankingPending: true, aids: [A] },
    events: [{ revision: 1, patch: { aid: A, fields: { rank: { aid: A, points: 81 } }, base: { rank: 0 }, versions: { rank: 1 } } }],
  } }));
  assert.equal(secondary.stores.ranked.profiles.get(A).points, 81);
  assert.equal(secondary.state.cursor, 1); assert.equal(secondary.hasRankUncertainty(), true);
});

function accessFixture(t) {
  const stores = { players: new PlayerStore({ file: null }), ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }) };
  stores.players.record(A, 'quarantined'); stores.players.record(B, 'healthy');
  Object.assign(stores.ranked.ensure(B, 'healthy'), { points: 1800, wins: 9, placementDone: true });
  const access = createProfileAccess({ role: 'main', id: 'main', secret: '', accountFile: null,
    mainUrl: 'http://127.0.0.1', secondaryUrl: 'http://127.0.0.1' }, stores, log);
  t.after(() => access.close()); return { access, stores };
}
async function seedUnknown(access) {
  access.replication.state.intent = { op: 'complete', args: [job()], plan: [{ aid: A, before: { rank: null, history: null } }] };
  await access.replication.recover();
}

test('access: unrelated login works with explicit rankingPending without masquerading as unranked', async t => {
  const { access } = accessFixture(t); await seedUnknown(access); await access.ready();
  const socket = { close() {}, terminate() {} }, session = { connected: true, ws: socket };
  assert.deepEqual(await access.login(session, 'healthy', A, socket, false, B), { aid: B });
  const snapshot = await access.authority.call('read', [B]);
  assert.equal(snapshot.summary.ranked, true); assert.equal(snapshot.summary.points, 1800);
  assert.equal(snapshot.summary.wins, 9); assert.equal(snapshot.summary.globalRank, null);
  assert.equal(snapshot.summary.rankingPending, true); assert.equal(snapshot.summary.rankUnavailable, true);
  assert.equal(snapshot.authorizedSummary.rankingPending, true); assert.equal(snapshot.rankingPending, true);
  assert.equal(access.replication.quarantinedIntents().length, 1);
});

test('access: authenticated resolved account, not spoofed requested account, controls quarantine conflict', async t => {
  const { access } = accessFixture(t); await seedUnknown(access);
  const socket = { close() {}, terminate() {} }, session = { connected: true, ws: socket };
  await assert.rejects(access.login(session, 'healthy-looking', B, socket, false, A), { code: 'RESULT_SETTLEMENT_FAILED' });
});

test('access: legacy blocked pending job no longer denies all logins and uses authenticated aid', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'stronghold-pending-login-'));
  const file = join(dir, 'pending.json');
  writeFileSync(file, JSON.stringify({ version: 1, jobs: [{ id: `complete:${MID}`, op: 'complete', args: [job()] }] }));
  const stores = { players: new PlayerStore({ file: null }), ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }) };
  stores.players.record(A, 'pending'); stores.players.record(B, 'healthy');
  const access = createProfileAccess({ role: 'main', id: 'main', secret: '', accountFile: null, pendingFile: file,
    mainUrl: 'http://127.0.0.1', secondaryUrl: 'http://127.0.0.1' }, stores, log);
  t.after(() => { access.close(); rmSync(dir, { recursive: true, force: true }); });
  await access.ready();
  const socket = { close() {}, terminate() {} }, session = { connected: true, ws: socket };
  assert.deepEqual(await access.login(session, 'healthy', A, socket, false, B), { aid: B });
  const badSocket = { close() {}, terminate() {} }, bad = { connected: true, ws: badSocket };
  await assert.rejects(access.login(bad, 'spoof', B, badSocket, false, A), { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobs.length, 1);
});

test('access: independent cosmetic and history writes continue while leaderboard and rank rewards reject', async t => {
  const { access, stores } = accessFixture(t); await seedUnknown(access);
  const socket = { close() {}, terminate() {} }, session = { connected: true, ws: socket };
  await access.login(session, 'healthy', A, socket, false, B);
  await access.authority.call('record', [B, 'still healthy', session.loginLease]);
  await access.replication.transact('historyRecord', [historyJob(B)]);
  assert.equal(stores.players.profiles.get(B).name, 'still healthy');
  assert.throws(() => access.leaderboard(), { code: 'RESULT_SETTLEMENT_FAILED' });
  await assert.rejects(access.authority.call('leaderboard', []), { code: 'RESULT_SETTLEMENT_FAILED' });
  await assert.rejects(access.replication.transact('rank.nameCards', [B, null]), { code: 'RESULT_SETTLEMENT_FAILED' });
});
