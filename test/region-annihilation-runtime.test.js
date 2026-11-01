import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminRuntime } from '../server/admin.js';
import { createRegionAuthority, validateHeartbeat, validateRuntime } from '../server/regions.js';
import { ANNIHILATION_DIFFICULTY } from '../shared/annihilation-constants.js';

function runtime(serverId, mode = 'coop') {
  const code = serverId === 'main' ? 'ABCD' : 'NPQR';
  return adminRuntime({
    registry: { byPlayerId: new Map() },
    lobby: { rooms: new Map([[code, { code, mode, difficulty: ANNIHILATION_DIFFICULTY,
      ranked: false, createdAt: 100, match: { round: 3, phase: 'COMBAT' },
      seats: [{ name: '玩家', isBot: false, connected: true }] }]]) },
  });
}

test('annihilation runtime reaches the console for both servers and supported modes', () => {
  const authority = createRegionAuthority({ now: () => 1000 });
  for (const serverId of ['main', 'secondary']) {
    for (const mode of ['solo', 'coop']) {
      const value = runtime(serverId, mode);
      const heartbeat = { serverId, leases: [], sample: { bandwidthMbps: 5, bytesPerSecond: 0 }, runtime: value };
      assert.doesNotThrow(() => validateHeartbeat(heartbeat));
      authority.heartbeat(heartbeat);
      assert.deepEqual(authority.adminRuntimes()[serverId].runtime, value);
    }
  }
});

test('annihilation runtime does not admit ranked or unknown difficulties and retains strict validation', () => {
  const value = runtime('main');
  for (const patch of [{ ranked: true }, { difficulty: 'UNKNOWN' }, { code: 'NPQR' },
    { players: new Array(100).fill(value.matches[0].players[0]) }, { extra: true }]) {
    assert.throws(() => validateRuntime({ ...value, matches: [{ ...value.matches[0], ...patch }] }, 'main'), /对局快照无效/);
  }
});
