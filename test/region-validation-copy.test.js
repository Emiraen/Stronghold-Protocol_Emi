import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegionAuthority, validateHeartbeat, validateRuntime, validateSpectatorItems } from '../server/regions.js';

test('heartbeat checks avoid discarded clones while validators and stored runtime keep isolated copies', () => {
  const runtime = {
    online: [{ aid: 'a'.repeat(8), name: '玩家', roomCode: 'ABCD' }],
    matches: [{ code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', ranked: false,
      round: 3, phase: 'PREP', startedAt: 100,
      players: [{ name: '玩家', isBot: false, connected: true }] }],
  };
  const spectatorItems = [{ serverId: 'main', code: 'ABCD', matchId: 'a'.repeat(32), mode: 'coop',
    variant: null, difficulty: 'NORMAL', ranked: false, startedAt: 100, round: 3, phase: 'PREP',
    spectators: 0, players: [{ playerId: 'p_host', name: '玩家', isBot: false, alive: true, lp: 100 }] }];
  const heartbeat = { serverId: 'main', leases: [], sample: { bandwidthMbps: 5, bytesPerSecond: 0 },
    runtime, spectatorItems };
  const clone = globalThis.structuredClone;
  let copies = 0;
  globalThis.structuredClone = (...args) => { copies++; return clone(...args); };
  try {
    validateHeartbeat(heartbeat);
    assert.equal(copies, 0, 'checking runtime and spectator fields allocates no discarded copies');

    const copiedRuntime = validateRuntime(runtime, 'main');
    const copiedSpectators = validateSpectatorItems(spectatorItems, 'main');
    assert.equal(copies, 2, 'public validator defaults still make one copy each');
    assert.deepEqual(copiedRuntime, runtime);
    assert.deepEqual(copiedSpectators, spectatorItems);
    copiedRuntime.matches[0].players[0].name = '独立副本';
    copiedSpectators[0].players[0].lp = 1;
    assert.equal(runtime.matches[0].players[0].name, '玩家');
    assert.equal(spectatorItems[0].players[0].lp, 100);

    assert.throws(() => validateHeartbeat({ ...heartbeat, runtime: { ...runtime,
      online: [{ ...runtime.online[0], aid: 'invalid' }] } }), /在线快照无效/);
    assert.throws(() => validateHeartbeat({ ...heartbeat, spectatorItems: [{ ...spectatorItems[0],
      players: [{ ...spectatorItems[0].players[0], lp: -1 }] }] }), /观战玩家无效/);

    const authority = createRegionAuthority({ now: () => 1000 });
    copies = 0;
    authority.heartbeat({ serverId: 'main', leases: [], sample: heartbeat.sample, runtime });
    assert.equal(copies, 1, 'runtime storage still retains exactly one isolated copy');
    runtime.online[0].name = '请求已改变';
    assert.equal(authority.adminRuntimes().main.runtime.online[0].name, '玩家');
  } finally {
    globalThis.structuredClone = clone;
  }
});
