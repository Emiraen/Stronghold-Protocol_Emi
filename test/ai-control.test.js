import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAgentControl, operationCatalog } from '../public/js/ai/control.js';
import { invokeAgent } from '../public/js/ai/rpc.js';

const MATCH = 'a'.repeat(32);
function emitter() {
  const listeners = new Map();
  return { on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); }, emit(type, value) { for (const fn of listeners.get(type) || []) fn(value); }, count() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); } };
}
function fixture(extra = {}) {
  let s = { connection: { status: 'online' }, me: { playerId: 'self', name: 'AI', token: 'secret' }, session: { entered: true }, room: { code: 'ABCD' }, match: { public: { matchId: MATCH, phase: 'PREP', round: 3 }, private: { funds: 20, board: [], hand: [] }, field: { fieldId: 'f1' } }, matchChat: { matchId: MATCH, items: [] } };
  const changes = new Set(), net = { ...emitter(), status: 'online', serverId: 'main', calls: [], async request(type, fields) { this.calls.push({ type, fields }); return { t: 'ok', token: 'secret' }; } };
  const store = { get: () => s, subscribe(fn) { changes.add(fn); return () => changes.delete(fn); }, set(next) { const before = s; s = { ...s, ...next }; for (const fn of changes) fn(s, before); } };
  const runner = { ...emitter(), state: () => ({ fieldId: 'f1' }), unitIdOf: (uid, ownerId) => uid === 7 && ownerId === 'self' ? 101 : null, unitStats: id => id === 101 ? { id, hp: 90, atk: 500 } : null };
  const api = createAgentControl({ net, store, runner, ...extra });
  return { api, net, store, runner, changes };
}

test('catalog covers normal player requests and excludes internal results/debug/profile writers', () => {
  const names = operationCatalog().map(x => x.type);
  for (const type of ['g.move', 'g.buy', 'chat.send', 'room.join', 'room.card', 'room.setPlugins', 'spectator.join']) assert.ok(names.includes(type));
  for (const type of ['b.result', 'b.progress', 'b.yield', 'g.test', 'hello', 'session.release', 'profile.presentation', 'room.contentReady']) assert.ok(!names.includes(type));
  assert.ok(operationCatalog().find(x => x.type === 'room.loadout').optional.includes('ops'));
});
test('state is detached, redacted and exposes current match and connection identifiers', () => {
  const { api, store } = fixture();
  const s = api.state(); s.match.private.funds = 0;
  assert.equal(store.get().match.private.funds, 20);
  assert.equal(s.me.token, undefined); assert.equal(s.matchId, MATCH); assert.equal(s.serverId, 'main'); api.dispose();
});
test('valid player request uses existing net acknowledgement and never simulation hooks', async () => {
  const { api, net } = fixture();
  const result = await api.request('g.move', { uid: 7, to: { area: 'board', row: 9, col: 3 }, dir: 'RIGHT' }, { matchId: MATCH, round: 3, phase: 'PREP' });
  assert.equal(result.accepted, true); assert.equal(result.reply.token, undefined); assert.equal(net.calls[0].type, 'g.move'); api.dispose();
});
test('invalid, internal, stale and offline operations are rejected before sending', async () => {
  const { api, net } = fixture();
  for (const type of ['b.result', 'b.progress', 'g.test', 'hello', 'profile.loadout']) await assert.rejects(api.request(type), { code: 'FORBIDDEN_OPERATION' });
  await assert.rejects(api.request('g.buy', { slot: 99 }), { code: 'BAD_MSG' });
  await assert.rejects(api.request('g.refresh', { rid: 5 }), { code: 'BAD_INPUT' });
  await assert.rejects(api.request('g.refresh', { unknown: true }), { code: 'BAD_INPUT' });
  await assert.rejects(api.request('g.refresh', {}, { round: 2 }), { code: 'STALE_STATE' });
  net.status = 'reconnecting'; await assert.rejects(api.request('g.refresh'), { code: 'OFFLINE' });
  assert.equal(net.calls.length, 0); api.dispose();
});
test('chat and tactical discussion reuse normal room channel and actual matchId', async () => {
  const { api, net, store } = fixture();
  await api.strategy({ text: '我守左侧，请补右侧高台。' });
  assert.deepEqual(net.calls[0], { type: 'chat.send', fields: { text: '我守左侧，请补右侧高台。', channel: 'match', matchId: MATCH } });
  await api.chat({ text: '招募队友', channel: 'lobby' }); assert.equal(net.calls[1].fields.matchId, undefined);
  await assert.rejects(api.chat({ text: 'x'.repeat(201) }), { code: 'BAD_MSG' });
  store.set({ match: {}, matchChat: {} }); await assert.rejects(api.strategy({ text: 'hello' }), { code: 'NO_MATCH' }); api.dispose();
});
test('library resolves real operator records and bounded searches from current data adapter', async () => {
  const records = JSON.parse(fs.readFileSync(new URL('../data/chess.json', import.meta.url), 'utf8'));
  const data = { load: async () => records, lookup: (_, id) => records[id] || null, list: () => Object.values(records) };
  const { api } = fixture({ data });
  const result = await api.library({ query: '隐现', limit: 2 }); assert.ok(result.total >= 1); assert.ok(result.items[0].stats.atk > 0);
  const first = Object.keys(records)[0]; assert.equal((await api.library({ id: first })).record.chessId, first);
  await assert.rejects(api.library({ file: '../account-auth' }), { code: 'BAD_INPUT' });
  await assert.rejects(api.library({ limit: 101 }), { code: 'BAD_INPUT' }); api.dispose();
});
test('live stats map piece uid to battle id without calculating or mutating stats', () => {
  const { api } = fixture(); assert.equal(api.unit({ uid: 7 }).unit.id, 101); assert.equal(api.unit({ unitId: 101 }).unit.hp, 90); assert.equal(api.unit({ uid: 8 }).found, false); api.dispose();
});
test('cursor paging preserves unread events and bounds queues, snapshots clear across fields', () => {
  const { api, net, runner, store } = fixture();
  for (let n = 0; n < 300; n++) net.emit('*', { t: 'm.toast', n, password: 'hidden' });
  const batch = api.events({ limit: 2 }); assert.equal(batch.truncated, true); assert.equal(batch.events.length, 2); assert.equal(batch.next, batch.events[1].seq); assert.equal(batch.events[0].data.password, undefined);
  assert.equal(api.events({ after: batch.next, limit: 1 }).events[0].seq, batch.next + 1);
  runner.emit('snap', { units: [[101, 3, 9, 90, 100]] }); assert.ok(api.state().battle.snapshot);
  store.set({ match: { ...store.get().match, field: { fieldId: 'f2' } } }); assert.equal(api.state().battle.snapshot, null);
  net.emit('*', { t: 'b.start', spec: { token: 'hidden', huge: 'x'.repeat(80000) } }); assert.equal(api.events({ after: 300 }).events[0].data.spec, undefined);
  api.dispose(); assert.equal(net.count(), 0); assert.equal(runner.count(), 0); assert.equal(store.get().me.playerId, 'self'); assert.throws(() => api.state(), { code: 'CLOSED' });
});
test('cross-server room and spectator operations use existing normal workflows', async () => {
  const calls = []; const { api } = fixture({ joinRoom: async x => { calls.push(x); return true; }, switchServer: async x => { calls.push(x); return true; }, watchMatch: async x => { calls.push(x); return false; } });
  assert.equal((await api.join({ target: 'ABCD' })).accepted, true); assert.equal((await api.switchServer({ id: 'secondary' })).accepted, true); assert.equal((await api.watch({ target: { code: 'ABCD' } })).accepted, false); assert.deepEqual(calls.slice(0, 2), ['ABCD', 'secondary']); api.dispose();
});
test('avatar waits for normal sync and rejects identity changes or shutdown', async () => {
  let s = { profileId: 'p1', identityEpoch: 1, profileReady: true, sync: 'synced', card: '' }; const listeners = new Set();
  const change = patch => { s = { ...s, ...patch }; for (const fn of [...listeners]) fn(); };
  const appearance = { get: () => s, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, setPlayerCard(card) { change({ card, sync: 'pending' }); return true; } };
  const { api } = fixture({ appearance }); const wait = api.avatar({ charId: 'char_498_inside' });
  change({ sync: 'synced' }); assert.equal((await wait).saved, true);
  const changed = api.avatar({ charId: 'char_498_inside' }); change({ identityEpoch: 2 }); await assert.rejects(changed, { code: 'IDENTITY_CHANGED' });
  change({ sync: 'synced' }); const closing = api.avatar({ charId: 'char_498_inside' }); api.dispose(); await assert.rejects(closing, { code: 'CLOSED' }); assert.equal(listeners.size, 0);
});
test('RPC exposes only fixed player operations, no reflection or arbitrary code', async () => {
  const { api } = fixture(); assert.ok((await invokeAgent(api, 'catalog')).coordinates.rows === 19);
  assert.equal((await invokeAgent(api, 'context')).funds, 20);
  for (const method of ['constructor', '__proto__', 'dispose', 'eval', 'setPaused']) await assert.rejects(invokeAgent(api, method), { code: 'NO_METHOD' }); api.dispose();
});

test('four pending actions bound resource use and server rejection is preserved', async () => {
  const { api, net } = fixture(); const pending = [];
  net.request = () => new Promise(resolve => pending.push(resolve));
  const calls = Array.from({ length: 4 }, () => api.request('g.refresh'));
  await assert.rejects(api.request('g.refresh'), { code: 'BUSY' });
  for (const resolve of pending) resolve({ t: 'ok' }); await Promise.all(calls);
  net.request = async () => { throw Object.assign(new Error('wrong phase'), { code: 'WRONG_PHASE' }); };
  await assert.rejects(api.request('g.refresh'), { code: 'WRONG_PHASE' }); api.dispose();
});
test('account transition clears buffered private events and no login means no actions', async () => {
  const { api, net, store } = fixture();
  net.emit('*', { t: 'welcome', authTicket: 'private-ticket', token: 'private-token' });
  assert.equal(api.events().events[0].data.authTicket, undefined);
  assert.equal(api.events().events[0].data.token, undefined);
  net.emit('*', { t: 'm.private', funds: 20 });
  store.set({ me: { playerId: 'other', name: 'other' } }); assert.equal(api.events().events.length, 0);
  store.set({ session: { entered: false }, me: {} }); await assert.rejects(api.request('g.refresh'), { code: 'NO_SESSION' }); api.dispose();
});
test('profile rejection never masquerades as saved, and voice/operator fields are validated', async () => {
  let s = { profileId: 'p1', identityEpoch: 1, profileReady: true, sync: 'synced', card: '' }; const listeners = new Set();
  const appearance = { get: () => s, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, setPlayerCard() { s = { ...s, sync: 'pending' }; return true; } };
  const { api } = fixture({ appearance }); const wait = api.avatar({ charId: 'char_498_inside' });
  s = { ...s, sync: 'synced', card: 'char_other' }; for (const fn of [...listeners]) fn();
  await assert.rejects(wait, { code: 'PROFILE_CHANGED' });
  assert.throws(() => api.voice({ volume: 2 }), { code: 'BAD_INPUT' });
  assert.throws(() => api.operatorSettings({ ops: { char_498_inside: { potential: 7 } } }), { code: 'BAD_INPUT' }); api.dispose();
});
test('installer is inert until called, rejects unauthenticated context and leaves boot untouched', async () => {
  const { install } = await import('../public/js/ai/install.js');
  await assert.rejects(install(), /正常登录/);
  for (const file of ['../public/js/main.js', '../public/index.html']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8'); assert.equal(source.includes('/ai/install.js'), false);
  }
});
