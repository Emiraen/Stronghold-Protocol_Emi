import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryStore } from '../server/historyStore.js';
import { PlayerStore } from '../server/playerStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { createProfileAccess, PendingResults } from '../server/profileService.js';
import { getData } from '../server/data.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32), MID = '1'.repeat(32);
const log = { info() {}, warn() {}, error() {} };
const DATA = getData({ log });
const account = (current, revision = 1, record = current, totalPut = record) => ({ current, record, totalPut, revision });
const turn = () => new Promise(resolve => setImmediate(resolve));
const bankJob = (aid = A, id = MID) => ({ matchId: id,
  seats: [{ aid, playerId: 'mizuki-bank', isBot: false }], summary: { players: [] },
  bankUpdates: [{ aid, account: account(1) }] });
const blockedComplete = () => ({ id: 'complete:' + MID, op: 'complete',
  args: [{ match: { matchId: MID }, ranked: false, seats: [{ aid: A, playerId: 'p0', isBot: false }],
    entries: [], result: { t: 'm.result', players: [{ playerId: 'p0' }] } }],
  blocked: { code: 'RESULT_SETTLEMENT_FAILED', receipt: 'unknown' } });

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mizuki-bank-persistence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function bankMatch(t, onBankAccountUpdate) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const match = new MizukiMatch({ roomCode: 'BANK', hostId: 'p0', seed: 821,
    data: DATA, scheduler, seats: [{ playerId: 'p0', seat: 0, connected: true, left: false }],
    bankAccounts: new Map([['p0', account(25)]]), onBankAccountUpdate,
    log, send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  match.start();
  match.currentNode = { id: 'bank-investment-test', type: 'shop', graphType: 'BATTLE_SHOP', floor: 1 };
  match._enterShop();
  match.players.get('p0').gold = 5;
  match.key = 2;
  assert.equal(match.phase, PHASE.SHOP);
  return match;
}

function profileFixture(dir) {
  const stores = { players: new PlayerStore({ file: join(dir, 'players.json'), log }),
    ranked: new RankedStore({ file: join(dir, 'ranked.json'), log }),
    history: new HistoryStore({ file: join(dir, 'history.json'), log }) };
  const config = { role: 'main', id: 'main', secret: '', accountFile: null, dataDir: dir,
    mainUrl: 'http://main.invalid', secondaryUrl: 'http://secondary.invalid',
    replicationFile: join(dir, 'replication.json'), pendingFile: join(dir, 'pending.json') };
  return { stores, config, access: createProfileAccess(config, stores, log) };
}

test('investment accounts are isolated by role aid and survive an atomic store write and reload', async t => {
  const dir = directory(t), file = join(dir, 'history.json');
  const history = new HistoryStore({ file, log });
  assert.equal(history.updateMizukiBank(A, account(28, 1, 28, 28)), true);
  assert.equal(history.updateMizukiBank(B, account(4, 1, 9, 12)), true);
  await history.flush();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.profiles.find(profile => profile.aid === A).mizukiBank.current, 28);
  assert.equal(saved.profiles.find(profile => profile.aid === B).mizukiBank.current, 4);
  const reopened = new HistoryStore({ file, log });
  assert.deepEqual(reopened.mizukiBank(A), account(28, 1, 28, 28));
  assert.deepEqual(reopened.mizukiBank(B), account(4, 1, 9, 12));
  const snapshot = reopened.mizukiBank(A); snapshot.current = 999;
  assert.equal(reopened.mizukiBank(A).current, 28, 'reads cannot mutate the stored role account');
});

test('out-of-order or repeated investment snapshots never undo a newer withdrawal', async t => {
  const file = join(directory(t), 'history.json'), history = new HistoryStore({ file, log });
  history.updateMizukiBank(A, account(30, 7, 30, 35));
  history.updateMizukiBank(A, account(22, 9, 30, 35));
  history.updateMizukiBank(A, account(31, 8, 31, 36));
  history.updateMizukiBank(A, account(29, 9, 31, 36));
  await history.flush();
  assert.deepEqual(history.mizukiBank(A), account(22, 9, 30, 35));
  assert.deepEqual(new HistoryStore({ file, log }).mizukiBank(A), account(22, 9, 30, 35));
});

test('real Match.handle deposits and withdrawals notify persistence before changing run resources', t => {
  const calls = [];
  const match = bankMatch(t, (playerId, value) => {
    calls.push({ playerId, value: structuredClone(value), gold: match.players.get(playerId).gold,
      key: match.key, previous: match.bankAccounts.get(playerId).current });
    return true;
  });
  const player = match.players.get('p0');
  assert.equal(match.handle('p0', { t: 'g.mizuki.bank', action: 'deposit', count: 1 }).ok, true);
  assert.equal(player.gold, 4); assert.equal(match.key, 2);
  assert.deepEqual(match.bankAccounts.get('p0'), { current: 26, record: 26, totalPut: 26 });
  assert.equal(match.privateView('p0').mizuki.shop.bank.current, 26);
  assert.equal(match.handle('p0', { t: 'g.mizuki.bank', action: 'withdraw', count: 8 }).ok, true);
  assert.equal(player.gold, 12); assert.equal(match.key, 1);
  assert.deepEqual(match.bankAccounts.get('p0'), { current: 18, record: 26, totalPut: 26 });
  assert.deepEqual(calls, [
    { playerId: 'p0', value: { current: 26, record: 26, totalPut: 26 }, gold: 5, key: 2, previous: 25 },
    { playerId: 'p0', value: { current: 18, record: 26, totalPut: 26 }, gold: 4, key: 2, previous: 26 },
  ]);
});

for (const failure of ['throw', 'false']) test(`an investment that cannot enter persistence (${failure}) does not consume run resources`, t => {
  const match = bankMatch(t, () => { if (failure === 'throw') throw new Error('injected durable queue failure'); return false; });
  const player = match.players.get('p0'), before = structuredClone(player), revision = match.revision;
  const bank = structuredClone(match.bankAccounts.get('p0')), key = match.key;
  const result = match.handle('p0', { t: 'g.mizuki.bank', action: 'deposit', count: 1 });
  assert.equal(result.error, 'INTERNAL');
  assert.deepEqual(player, before); assert.deepEqual(match.bankAccounts.get('p0'), bank);
  assert.equal(match.key, key); assert.equal(match.revision, revision);
});

test('a durably queued investment may finish syncing after the current Match.handle response', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const match = bankMatch(t, () => pending);
  assert.equal(match.handle('p0', { t: 'g.mizuki.bank', action: 'deposit', count: 1 }).ok, true);
  assert.equal(match.players.get('p0').gold, 4);
  assert.equal(match.bankAccounts.get('p0').current, 26);
  release(true); await pending;
});

test('requireQueued rejects both pre-enqueue quarantine branches synchronously', t => {
  let dispatched = 0;
  const pending = new PendingResults(null, () => { dispatched++; }, () => {}, log);
  t.after(() => pending.close());
  const blocked = blockedComplete(); pending.jobs.set(blocked.id, blocked);
  assert.throws(() => pending.submit('historyRecord', [bankJob()], { requireQueued: true }),
    { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(pending.jobs.size, 1, 'the rejected bank snapshot was never queued');
  assert.throws(() => pending.submit('complete', blocked.args, { requireQueued: true }),
    { code: 'RESULT_SETTLEMENT_FAILED' });
  assert.equal(dispatched, 0);
});

test('requireQueued cannot dispatch when saving the queue fails', t => {
  let dispatched = 0;
  const pending = new PendingResults(null, () => { dispatched++; }, () => {}, log);
  t.after(() => pending.close());
  pending.save = () => { throw new Error('injected pending file failure'); };
  assert.throws(() => pending.submit('historyRecord', [bankJob()], { requireQueued: true }), /pending file failure/);
  assert.equal(pending.jobs.size, 0); assert.equal(dispatched, 0);
});

test('real profile access stores each bank update in the role archive and replication history field', async t => {
  const dir = directory(t), { stores, config, access } = profileFixture(dir);
  t.after(() => access.close()); await access.ready();
  const first = access.history.updateMizukiBank(A, account(26, 1));
  const queued = JSON.parse(readFileSync(config.pendingFile, 'utf8')).jobs;
  assert.equal(queued.length, 1); assert.equal(queued[0].args[0].bankUpdates[0].aid, A);
  await first;
  await access.history.updateMizukiBank(B, account(7, 1));
  await access.history.updateMizukiBank(A, account(18, 2, 26, 26));
  assert.deepEqual(access.history.mizukiBank(A), account(18, 2, 26, 26));
  assert.deepEqual(access.history.mizukiBank(B), account(7, 1));
  assert.equal(access.replication.state.log.some(entry => entry.patch.aid === A && entry.patch.fields.history), true);
  assert.deepEqual(JSON.parse(readFileSync(config.pendingFile, 'utf8')).jobs, []);
  assert.deepEqual(new HistoryStore({ file: stores.history.file, log }).mizukiBank(A), account(18, 2, 26, 26));
});

test('a queued investment survives a profile RPC failure and is replayed from the pending file after restart', async t => {
  const dir = directory(t), first = profileFixture(dir);
  await first.access.ready();
  const call = first.access.authority.call.bind(first.access.authority);
  t.mock.method(first.access.authority, 'call', (op, args) => {
    if (op === 'historyRecord') throw new Error('injected unavailable profile authority');
    return call(op, args);
  });
  void first.access.history.updateMizukiBank(A, account(26, 1));
  await turn();
  const queued = JSON.parse(readFileSync(first.config.pendingFile, 'utf8')).jobs;
  assert.equal(queued.length, 1); assert.equal(queued[0].args[0].bankUpdates[0].account.current, 26);
  first.access.close();
  const recovered = profileFixture(dir); t.after(() => recovered.access.close());
  await recovered.access.ready();
  assert.deepEqual(recovered.access.history.mizukiBank(A), account(26, 1));
  assert.deepEqual(JSON.parse(readFileSync(recovered.config.pendingFile, 'utf8')).jobs, []);
  assert.deepEqual(new HistoryStore({ file: recovered.stores.history.file, log }).mizukiBank(A), account(26, 1));
});

test('profile access refuses to queue investments until its archive replication is initialized', async t => {
  const { access } = profileFixture(directory(t));
  t.after(() => access.close()); await access.ready();
  access.replication.state.initialized = false;
  assert.throws(() => access.history.updateMizukiBank(A, account(1)), /档案尚未初始化/);
});

test('an old authority successful history receipt cannot discard an ignored investment', async t => {
  const first = profileFixture(directory(t)); t.after(() => first.access.close()); await first.access.ready();
  const record = first.stores.history.record.bind(first.stores.history);
  // The deployed pre-bank HistoryStore destructures only matchId/seats/summary.
  // It accepts an empty players array, ignores bankUpdates and returns true.
  t.mock.method(first.stores.history, 'record', value => record({ ...value, bankUpdates: undefined }));
  let resolved = false;
  void first.access.history.updateMizukiBank(A, account(26, 1)).then(() => { resolved = true; });
  await turn(); assert.equal(await first.access.drain(), false);
  assert.equal(resolved, false);
  const jobs = JSON.parse(readFileSync(first.config.pendingFile, 'utf8')).jobs;
  assert.equal(jobs.length, 1); assert.deepEqual(jobs[0].args[0].bankUpdates[0].account, account(26, 1));
  assert.equal(first.stores.history.mizukiBank(A).current, 0, 'old authority did not actually save the bank');
  assert.deepEqual(first.access.history.mizukiBank(A), account(26, 1), 'durable pending bank remains visible locally');
});

test('pending aid-bound bank cache survives old replication, withdrawal and process restart', async t => {
  const dir = directory(t), first = profileFixture(dir); await first.access.ready();
  const call = first.access.authority.call.bind(first.access.authority);
  t.mock.method(first.access.authority, 'call', (op, args) => op === 'historyRecord' ? Promise.resolve(true) : call(op, args));
  void first.access.history.updateMizukiBank(A, account(26, 1));
  void first.access.history.updateMizukiBank(A, account(18, 2, 26, 26));
  void first.access.history.updateMizukiBank(B, account(7, 1));
  await turn(); assert.equal(await first.access.drain(), false);
  // ProfileReplication.put replaces the whole history object from authority.
  first.access.replication.put(A, 'history', { name: '', items: [], mizukiBank: account(0, 0) });
  assert.deepEqual(first.access.history.mizukiBank(A), account(18, 2, 26, 26));
  assert.deepEqual(first.access.history.mizukiBank(B), account(7, 1));
  const detached = first.access.history.mizukiBank(A); detached.current = 999;
  assert.equal(first.access.history.mizukiBank(A).current, 18);
  first.access.close();
  const recovered = profileFixture(dir); t.after(() => recovered.access.close());
  const recoveredCall = recovered.access.authority.call.bind(recovered.access.authority);
  t.mock.method(recovered.access.authority, 'call', (op, args) => op === 'historyRecord' ? Promise.resolve(null) : recoveredCall(op, args));
  await recovered.access.ready();
  assert.deepEqual(recovered.access.history.mizukiBank(A), account(18, 2, 26, 26));
  assert.deepEqual(recovered.access.history.mizukiBank(B), account(7, 1));
  assert.doesNotThrow(() => recovered.access.history.mizukiEndingUnlocks(A), 'bank-only pending does not lock entering another run');
  assert.equal(JSON.parse(readFileSync(recovered.config.pendingFile, 'utf8')).jobs.length, 3);
  // Once authority understands banks, idempotent revision reads acknowledge all
  // preserved updates without resurrecting the older deposit over a withdrawal.
  recovered.access.authority.call.mock.restore();
  assert.equal(await recovered.access.drain(), true);
  assert.deepEqual(recovered.access.history.mizukiBank(A), account(18, 2, 26, 26));
  assert.deepEqual(new HistoryStore({ file: recovered.stores.history.file, log }).mizukiBank(A), account(18, 2, 26, 26));
  assert.equal(JSON.parse(readFileSync(recovered.config.pendingFile, 'utf8')).jobs.length, 0);
});

test('generic non-bank historyRecord still accepts the existing null success receipt', async t => {
  const { access, config } = profileFixture(directory(t)); t.after(() => access.close()); await access.ready();
  const receipt = await access.history.record({ matchId: MID, seats: [{ aid: A, playerId: 'p0', isBot: false }],
    summary: { players: [{ playerId: 'p0', victory: true }] } });
  assert.equal(receipt, null);
  assert.equal(JSON.parse(readFileSync(config.pendingFile, 'utf8')).jobs.length, 0);
});

test('bank pending bounds reject synchronously before saving or dispatching another transaction', t => {
  let dispatched = 0;
  const pending = new PendingResults(null, () => { dispatched++; }, () => {}, log); t.after(() => pending.close());
  for (let index = 0; index < 256; index++) pending.jobs.set('old:' + index, { op: 'historyRecord', args: [bankJob()] });
  assert.throws(() => pending.submit('historyRecord', [bankJob()], { requireQueued: true }), { code: 'BANK_SYNC_QUEUE_FULL' });
  assert.equal(pending.jobs.size, 256); assert.equal(dispatched, 0);
});
