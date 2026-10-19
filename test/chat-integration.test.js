// Real socket integration: chat is a shared channel for lobby and waiting rooms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { PlayerStore } from '../server/playerStore.js';

function unique(text) { return `${text}${Math.random().toString(36).slice(2, 8)}`; }

function fixture() {
  return startServer({ port: 0, host: '127.0.0.1', quiet: true,
    ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }),
    players: new PlayerStore({ file: null }) });
}

async function player(url, name) {
  const c = await TestClient.connect(url);
  const w = await c.hello(name);
  c.id = w.playerId;
  return c;
}

test('global chat reaches lobby and room; invite is server-issued and join uses the regular room rules', async () => {
  const srv = await fixture();
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const clients = [];
  try {
    const host = await player(url, '发起者'); clients.push(host);
    const viewer = await player(url, '旁观者'); clients.push(viewer);
    const message = unique('大家好');
    const sent = await host.request({ t: 'chat.send', text: message });
    assert.equal(sent.t, 'ok', JSON.stringify(sent));
    const a = await host.waitFor('chat.message', (m) => m.text === message);
    const b = await viewer.waitFor('chat.message', (m) => m.text === message);
    assert.equal(a.name, '发起者');
    assert.equal(b.playerId, host.id);
    assert.equal(b.kind, 'text');
    assert.equal(typeof b.at, 'number');
    assert.ok(!JSON.stringify(b).includes('token'));

    const create = await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    assert.equal(create.t, 'ok');
    const room = await host.waitFor('room.state', (m) => m.hostId === host.id);
    assert.equal((await viewer.request({ t: 'chat.invite' })).t, 'error', 'lobby spectator cannot forge an invitation');
    assert.equal((await host.request({ t: 'chat.invite', code: 'FAKE' })).t, 'ok', 'server ignores client-supplied room code');
    const invite = await viewer.waitFor('chat.message', (m) => m.kind === 'invite' && m.code === room.code);
    assert.equal(invite.playerId, host.id);
    assert.equal(invite.name, '发起者');
    assert.equal((await viewer.request({ t: 'room.join', code: invite.code })).t, 'ok');
    await viewer.waitFor('room.state', (m) => m.code === room.code && m.seats.some((s) => s?.playerId === viewer.id));
    const roomText = unique('房间内也能说话');
    assert.equal((await viewer.request({ t: 'chat.send', text: roomText })).t, 'ok');
    assert.equal((await host.waitFor('chat.message', (m) => m.text === roomText)).name, '旁观者');
    const newcomer = await player(url, '后来者'); clients.push(newcomer);
    const history = await newcomer.waitFor('chat.history');
    assert.ok(history.items.some((m) => m.text === message));
    assert.ok(history.items.some((m) => m.kind === 'invite' && m.code === room.code));
    assert.ok(history.items.every((m) => !('token' in m)));
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});

test('chat refuses invalid and unsolicited input; cannot invite from solo or running rooms', async () => {
  const srv = await fixture();
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const clients = [];
  try {
    const a = await player(url, '甲'); clients.push(a);
    const b = await player(url, '乙'); clients.push(b);
    assert.equal((await a.request({ t: 'chat.send', text: '   ' })).t, 'error');
    assert.equal((await a.request({ t: 'chat.send', text: 'x'.repeat(201) })).t, 'error');
    assert.equal((await a.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
    await a.waitFor('room.state', (m) => m.hostId === a.id);
    assert.equal((await a.request({ t: 'chat.invite' })).t, 'error');
    await b.expectNone('chat.message', (m) => m.kind === 'invite', 80);
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});
