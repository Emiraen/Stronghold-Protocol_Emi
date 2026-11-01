import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlayerStore } from '../server/playerStore.js';
import { Lobby } from '../server/lobby.js';
import { getData } from '../server/data.js';
import { getZhajingData } from '../server/modes/zhajing/Match.js';
import { checkZhajingLoadout, zhajingEditorChess } from '../shared/zhajing-loadout.js';
import { checkLoadout, validateC2S, loadoutOptions } from '../shared/protocol.js';
import { loadoutOptions as engineOptions } from '../server/modes/zhajing/engine/shared/protocol.js';
import { ZHAJING_VARIANT } from '../shared/zhajing-constants.js';
import { createStore } from '../public/js/store.js';
import { installLoadoutSync, setEntries } from '../public/js/ui/loadoutSync.js';

const aid = 'a'.repeat(32), zj = 'chess_zj_01_a', normal = 'chess_char_1_01_a';
const data = getZhajingData();

test('editor choices match private engine defaults for every 炸惊 operator; normal visibility is unchanged', () => {
  const chess = zhajingEditorChess(data.chess, data.zjDefaultLoadout);
  for (const c of Object.values(data.chess).filter(c => c.zhajing && !c.isGolden)) {
    assert.equal(c.visible, false);
    assert.deepEqual(loadoutOptions(chess[c.chessId], chess[c.goldenId]), engineOptions(c, data.chess[c.goldenId]));
  }
  assert.ok(checkLoadout({ [zj]: { skill: 1 } }, id => data.chess[id]).error);
  assert.ok(checkZhajingLoadout({ [zj]: { skill: 1, module: 'none' } }, {}, data).ok);
  assert.ok(checkZhajingLoadout({ [zj]: { skill: 15 } }, {}, data).error);
  assert.ok(checkZhajingLoadout({ [zj]: { module: 'foreign_module' } }, {}, data).error);
});

test('scoped profile persists independently across restart and rolls back failed writes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zj-loadout-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'players.json'), players = new PlayerStore({ file });
  players.record(aid, '博士');
  const regular = { v: 1, entries: { [normal]: { skill: 0 } }, ops: {} };
  const special = { v: 1, scope: 'zhajing', entries: { [zj]: { skill: 1, module: 'none' } }, ops: { char_103_angel: { potential: 2 } } };
  players.setLoadout(aid, special); assert.equal(players.getLoadout(aid), null, 'first 炸惊 save does not initialize an empty normal profile');
  await players.flush(); assert.equal(new PlayerStore({ file }).getLoadout(aid), null);
  players.setLoadout(aid, regular); players.setLoadout(aid, special); players.setLoadout(aid, regular);
  await players.flush();
  const restored = new PlayerStore({ file });
  assert.deepEqual(restored.getLoadout(aid).entries, regular.entries);
  assert.deepEqual(restored.getLoadout(aid, 'zhajing').entries, special.entries);
  assert.deepEqual(restored.getLoadout(aid, 'zhajing').ops, special.ops);
  const previous = restored.getLoadout(aid);
  restored.save = () => false;
  assert.throws(() => restored.setLoadout(aid, { v: 1, scope: 'zhajing', entries: {}, ops: {} }), /save failed/);
  assert.deepEqual(restored.getLoadout(aid), previous);
});

test('real lobby saves scoped choices, injects them into 炸惊, and keeps the live normal snapshot isolated', async t => {
  const players = new PlayerStore({ file: null }); players.record(aid, '博士');
  const sessions = new Map(), frames = [];
  const registry = { all: () => sessions.values(), byId: id => sessions.get(id), isExpired: () => false };
  const lobby = new Lobby({ registry, players, getData, now: () => 1800000000000, seedFn: () => 18345,
    ranked: {}, history: {}, log: { info() {}, warn() {}, debug() {}, error(...a) { throw Error(a.join(' ')); } } });
  t.after(() => lobby.shutdown());
  const peer = { playerId: 'p0', name: '博士', aid, profileBound: true, profileReady: true, connected: true,
    ws: { readyState: 1, bufferedAmount: 0, send(raw, cb) { frames.push(JSON.parse(raw)); cb?.(); } } };
  sessions.set(peer.playerId, peer);
  const profileId = players.profiles.get(aid).id;
  const request = { t: 'profile.loadout', v: 1, profileId, editId: 1, scope: 'zhajing',
    entries: { [zj]: { skill: 1, module: 'none' } }, ops: { char_103_angel: { potential: 2 } } };
  assert.equal(validateC2S(request), null);
  assert.ok((await lobby.profileLoadout(peer, request)).ok);
  assert.ok(frames.some(f => f.t === 'loadout.state' && f.scope === 'zhajing' && f.entries[zj]?.skill === 1));
  assert.ok(lobby.create(peer, { mode: 'solo', capacity: 1, variant: ZHAJING_VARIANT, difficulty: 'ZHAJING' }).ok);
  assert.ok((await lobby.start(peer)).ok);
  const match = lobby.roomOf(peer).match, ps = match.order[0];
  assert.equal(ps.loadout[zj].skill, 1);
  assert.equal(ps.loadout[zj].module, 'none');
  assert.equal(ps.ops.char_103_angel.potential, 2);
  const original = structuredClone(ps.loadout);
  assert.ok((await lobby.profileLoadout(peer, { v: 1, profileId, editId: 2, entries: { [normal]: { skill: 0 } }, ops: {} })).ok);
  assert.deepEqual(ps.loadout, original, 'normal-profile edit cannot reset the active 炸惊 setup');
  assert.ok((await lobby.profileLoadout(peer, { ...request, editId: 3, entries: { [zj]: { skill: 2 } } })).ok);
  assert.equal(ps.loadout[zj]?.skill ?? engineOptions(data.chess[zj], data.chess[data.chess[zj].goldenId]).defaultSkill, 2);
  assert.equal(players.getLoadout(aid).entries[normal].skill, 0);
});

test('scoped sync ignores other-mode messages and never overwrites another profile identity', async () => {
  const handlers = new Map(), sent = [];
  const net = { status: 'online', playerId: 'p0', on(t, fn) { const a = handlers.get(t) || []; a.push(fn); handlers.set(t, a); return () => {}; },
    request: async (t, fields) => { sent.push({ t, ...fields }); return {}; } };
  const emit = (t, msg) => { for (const fn of handlers.get(t) || []) fn(msg); };
  const target = createStore({ entries: {}, ops: {}, profileReady: false, identityEpoch: 0 });
  const chess = zhajingEditorChess(data.chess, data.zjDefaultLoadout);
  const source = { load: async n => n === 'chess' ? chess : data[n], get: n => n === 'chess' ? chess : data[n], lookup: (n, id) => chess[id] };
  const sync = installLoadoutSync({ net, target, scope: 'zhajing', dataSource: source });
  try {
    const state = { v: 1, profileId: 'b'.repeat(32), initialized: true, entries: {}, ops: {} };
    emit('loadout.state', state); assert.equal(target.get().profileReady, false);
    emit('loadout.state', { ...state, scope: 'zhajing' });
    assert.ok(setEntries({ [zj]: { skill: 1 } }, target.get().identityEpoch, target));
    await sync.flush(); assert.equal(sent[0].scope, 'zhajing'); assert.equal(sent[0].entries[zj].skill, 1);
    emit('welcome', {}); assert.equal(target.get().profileReady, false); assert.deepEqual(target.get().entries, {});
  } finally { sync.dispose(); }
});
