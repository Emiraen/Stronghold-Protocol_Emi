import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { HistoryStore } from '../server/historyStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { PlayerStore } from '../server/playerStore.js';
import { HEAVY_TYPES } from '../server/net.js';
import { TestClient } from './helpers/wsClient.js';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccc';
const result = (seats, ranked = false) => ({
  victory: true, roundsPassed: 9, difficulty: 'HARD', modeId: 'MULTI_HARD',
  players: seats.map((s) => ({ playerId: s.playerId, name: s.name, isBot: s.isBot,
    left: !!s.left, victory: !s.isBot, roundsPassed: s.isBot ? 0 : 9,
    ...(ranked && !s.isBot ? { rank: { before: 100, after: 125, delta: 25 } } : {}),
    lineup: [{ id: 'chess_sample', items: ['item_sample'] }] })),
});
class StubMatch {
  constructor(opts) { this.opts = opts; this.seats = opts.seats; this.left = new Set(); }
  start() {}
  onLeave(id) { this.left.add(id); }
  finish() {
    this.opts.onEnd(result(this.seats.map((s) => ({ ...s, left: this.left.has(s.playerId) })), this.opts.ranked));
  }
  dispose() {}
}

const tmp = mkdtempSync(join(tmpdir(), 'stronghold-history-'));
const file = join(tmp, 'history.json');
after(() => rmSync(tmp, { recursive: true, force: true }));

async function run() {
  const history = new HistoryStore({ file });
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true,
    MatchClass: StubMatch, ranked: new RankedStore({ file: null }), history });
  const clients = [];
  return {
    srv, history,
    async join(name, aid) {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      clients.push(c);
      const welcome = await c.hello(name, null, aid ? { aid } : {});
      c.id = welcome.playerId;
      return c;
    },
    async close() { for (const c of clients) await c.close(); await srv.close(); },
  };
}

async function historyList(c) {
  const reply = await c.request({ t: 'history.list' });
  assert.equal(reply.t, 'ok');
  const frame = await c.waitFor('history.list');
  assert.equal(frame.rid, reply.rid);
  assert.equal(frame.viewerId, c.id);
  return frame.items;
}

describe('private aid match history', () => {
  test('真实大厅→Match→历史服务：标准不计分，三个排位难度仍完成定级，意愿跨对局保留', async () => {
    const ranked = new RankedStore({ file: null });
    const history = new HistoryStore({ file: null });
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, ranked, history,
      players: new PlayerStore({ file: null }) });
    let c;
    try {
      c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      c.id = (await c.hello('标准回归', null, { aid: A })).playerId;
      await c.waitFor('rank.me');
      assert.equal((await c.request({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY', ranked: true })).t, 'ok');
      const initial = await c.waitFor('room.state');
      const room = srv.lobby.getRoom(initial.code);
      let placementPlayed = 0;
      const matchIds = new Set();
      for (const difficulty of ['FUNNY', 'NORMAL', 'HARD', 'ABYSS', 'FUNNY']) {
        assert.equal((await c.request({ t: 'room.setDifficulty', difficulty })).t, 'ok');
        const before = structuredClone([...ranked.profiles]);
        assert.equal((await c.request({ t: 'room.start' })).t, 'ok');
        const match = room.match;
        const eligible = difficulty !== 'FUNNY';
        assert.equal(room.ranked, true);
        assert.equal(match.ranked, eligible);
        assert.equal(room.matchCtx.ranked, eligible);
        match.round = 14;
        const victory = eligible || placementPlayed === 0;
        match.finish({ victory, reason: victory ? 'victory' : 'defeat' });
        const resultFrame = await c.waitFor('m.result');
        assert.equal(resultFrame.difficulty, difficulty);
        assert.equal(Object.hasOwn(resultFrame.players[0], 'rank'), eligible);
        assert.equal(match.errorCount, 0);
        const items = await historyList(c);
        const item = items[0];
        assert.equal(item.difficulty, difficulty);
        assert.equal(item.ranked, eligible, '历史保存实际计分资格而非 room.ranked 意愿');
        assert.equal(Object.hasOwn(item, 'rank'), eligible);
        assert.equal(matchIds.has(item.matchId), false);
        matchIds.add(item.matchId);
        assert.equal((await c.request({ t: 'history.detail', matchId: item.matchId })).t, 'ok');
        const detail = await c.waitFor('history.detail');
        assert.equal(detail.result.difficulty, difficulty);
        assert.equal(Object.hasOwn(detail.result.players[0], 'rank'), eligible);
        if (eligible) {
          placementPlayed++;
          const p = ranked.profile(A);
          assert.equal(p.placementPlayed, placementPlayed);
          assert.equal(p.matches, placementPlayed);
          assert.equal(p.placementDone, placementPlayed === 3);
          assert.ok(p.mmr > 1000);
          await c.waitFor('rank.me');
        } else {
          assert.deepEqual([...ranked.profiles], before, '标准胜负均不改积分/定级/MMR/统计');
          await c.expectNone('rank.me', () => true, 30);
        }
        assert.equal(room.ranked, true);
        assert.equal(room.match, null);
      }
      assert.equal(history.list(A).length, 5);
      assert.equal(ranked.profile(A).placementDone, true);
      assert.ok(ranked.profile(A).points > 0);
    } finally { await c?.close(); await srv.close(); }
  });

  test('normal and ranked results persist with owner-only details, including departed and offline humans', async () => {
    const env = await run();
    try {
      const host = await env.join('Host', A);
      const guest = await env.join('Guest', B);
      const noAid = await env.join('NoAid');
      await host.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
      const room = await host.waitFor('room.state');
      await guest.request({ t: 'room.join', code: room.code });
      await noAid.request({ t: 'room.join', code: room.code });
      await guest.request({ t: 'room.ready', ready: true });
      await noAid.request({ t: 'room.ready', ready: true });
      await host.request({ t: 'room.addBot' });
      await host.request({ t: 'room.start' });
      const match = env.srv.lobby.getRoom(room.code).match;
      await guest.request({ t: 'room.leave' });
      await noAid.terminate();
      match.finish();
      match.finish();
      const own = await historyList(host);
      assert.equal(own.length, 1);
      assert.match(own[0].matchId, /^[0-9a-f]{32}$/);
      assert.equal(own[0].victory, true);
      assert.equal(own[0].roundsPassed, 9);
      assert.equal(own[0].ranked, false);
      assert.equal(own[0].playerId, host.id);
      assert.equal(Object.hasOwn(own[0], 'result'), false);
      assert.equal((await historyList(guest)).length, 1);
      const stranger = await env.join('Other', C);
      assert.equal((await historyList(stranger)).length, 0);
      const denied = await guest.request({ t: 'history.detail', matchId: 'f'.repeat(32) });
      assert.equal(denied.t, 'error');
      assert.equal(denied.code, 'BAD_TARGET');
      const detailReply = await guest.request({ t: 'history.detail', matchId: own[0].matchId });
      assert.equal(detailReply.t, 'ok');
      const detail = await guest.waitFor('history.detail');
      assert.equal(detail.rid, detailReply.rid);
      assert.equal(detail.playerId, guest.id);
      assert.equal(detail.viewerId, guest.id);
      assert.equal(detail.result.players.length, 4);
      assert.deepEqual(detail.result.players[0].lineup[0].items, ['item_sample']);
      assert.equal(env.history.detail(null, own[0].matchId), null);
      assert.equal(readFileSync(file, 'utf8').includes('chess_sample'), true);
      assert.equal(new HistoryStore({ file }).list(A).length, 1);
      assert.equal(env.history.profiles.size, 2, 'bot and no-aid player create no profiles');
      assert.equal((await fetch(`${env.srv.url}/match-history.json`)).status, 404, 'history is not statically served');
      const adopted = await env.join('hOst', C);
      const adoptedItems = await historyList(adopted);
      assert.equal(adoptedItems.length, 1);
      assert.equal(adoptedItems[0].playerId, host.id, 'old match keeps the original player id');
      const adoptedReply = await adopted.request({ t: 'history.detail', matchId: own[0].matchId });
      assert.equal(adoptedReply.t, 'ok');
      const adoptedDetail = await adopted.waitFor('history.detail');
      assert.equal(adoptedDetail.viewerId, adopted.id);
      assert.equal(adoptedDetail.playerId, host.id);
      assert.equal(env.history.list(A).length, 0);
      assert.equal(new HistoryStore({ file }).list(C).length, 1);
      assert.equal(env.history.detail(A, own[0].matchId), null);
    } finally { await env.close(); }
  });

  test('rank flag, per-player rank and 10-item cap survive reload; no aid creates no history', async () => {
    const memory = new HistoryStore({ file: null });
    for (let i = 0; i < 12; i++) {
      const matchId = i.toString(16).padStart(32, '0');
      const seats = [{ playerId: 'p_1', name: 'A', aid: A, isBot: false },
        { playerId: 'p_2', name: 'NoAid', aid: null, isBot: false },
        { playerId: 'ai_1', name: 'Bot', aid: B, isBot: true }];
      memory.record({ matchId, at: 1000 + i, ranked: true, seats, summary: result(seats, true) });
      memory.record({ matchId, at: 1000 + i, ranked: true, seats, summary: result(seats, true) });
    }
    const items = memory.list(A);
    assert.equal(items.length, 10);
    assert.equal(items[0].matchId, 'b'.padStart(32, '0'));
    assert.equal(items.at(-1).matchId, '2'.padStart(32, '0'));
    assert.equal(items[0].rank.delta, 25);
    assert.equal(memory.list(B).length, 0);
    assert.equal(memory.detail(A, '0'.repeat(32)), null);
    assert.equal(memory.detail(B, items[0].matchId), null);
    assert.equal(memory.detail(A, items[0].matchId).result.players[0].rank.after, 125);
  });

  test('oversized results are rejected rather than saved without their stats and lineup', () => {
    const warnings = [];
    const memory = new HistoryStore({ file: null, log: { warn: (message) => warnings.push(message) } });
    const seats = [{ playerId: 'p_1', name: 'A', aid: A, isBot: false }];
    const summary = result(seats);
    summary.players[0].stats = { dmgDealt: 25, notes: 'x'.repeat(50_000) };
    memory.record({ matchId: '1'.repeat(32), seats, summary });
    assert.deepEqual(memory.list(A), []);
    assert.match(warnings[0], /skipped invalid or oversized result/);
    const ordinary = result(seats);
    ordinary.players[0].stats = { dmgDealt: 25 };
    memory.record({ matchId: '2'.repeat(32), seats, summary: ordinary });
    assert.deepEqual(memory.detail(A, '2'.repeat(32)).result.players[0].stats, { dmgDealt: 25 });
    assert.deepEqual(memory.detail(A, '2'.repeat(32)).result.players[0].lineup[0].items, ['item_sample']);
  });

  test('detail uses the heavy-request limiter while list does not', async () => {
    assert.equal(HEAVY_TYPES.has('history.detail'), true);
    assert.equal(HEAVY_TYPES.has('history.list'), false);
    const env = await run();
    try {
      const c = await env.join('RateCheck', 'eeeeeeeeeeeeeeee');
      const id = 'f'.repeat(32);
      for (let i = 0; i < 6; i++) assert.equal((await c.request({ t: 'history.detail', matchId: id })).code, 'BAD_TARGET');
      assert.equal((await c.request({ t: 'history.detail', matchId: id })).code, 'RATE');
      assert.equal((await c.request({ t: 'history.list' })).t, 'ok');
      assert.deepEqual((await c.waitFor('history.list')).items, []);
    } finally { await env.close(); }
  });

  test('reject malformed detail id and ignore untrusted aid field on list', async () => {
    const env = await run();
    try {
      const c = await env.join('Unknown', 'dddddddddddddddd');
      const bad = await c.request({ t: 'history.detail', matchId: '../history.json' });
      assert.equal(bad.code, 'BAD_MSG');
      const ok = await c.request({ t: 'history.list', aid: A });
      assert.equal(ok.t, 'ok');
      assert.deepEqual((await c.waitFor('history.list')).items, []);
    } finally { await env.close(); }
  });
});
