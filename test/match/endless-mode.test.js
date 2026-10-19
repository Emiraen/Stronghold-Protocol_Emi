import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { getData } from '../../server/data.js';
import { Lobby } from '../../server/lobby.js';
import { SessionRegistry } from '../../server/net.js';
import { ENDLESS_MODE_ID, ENDLESS_VARIANT, ERR, PHASE } from '../../shared/constants.js';
import { buildNormalWave } from '../../server/match/waves.js';
import { buildBattleSpec, compactResult } from '../../server/sim/spec.js';
import { validateClientResult } from '../../server/match/fields.js';
import { isBattleResult, validateC2S } from '../../shared/protocol.js';
import { leaderHitCancelled } from '../../server/sim/damage.js';

function match(t, variant = ENDLESS_VARIANT, seed = 73) {
  const scheduler = new VirtualScheduler({ instantCombat: true });
  const m = new Match({
    mode: 'coop', variant, difficulty: 'NORMAL',
    seats: [{ seat: 0, playerId: 'p0', name: 'P0', isBot: false, connected: true }],
    data: getData(), seed, scheduler, clientCombat: false, botRehearsal: 0,
    send() {}, broadcast() {}, onEnd() {},
  });
  t.after(() => { m.dispose(); scheduler.dispose(); });
  return m;
}

test('built-in endless mode scales without a ceiling, repeats boss rounds, and continues after wins', (t) => {
  const m = match(t);
  const br = m.gd.bossRound;
  assert.equal(m.modeId, ENDLESS_MODE_ID);
  assert.equal(m.isEndless, true);
  assert.equal(m.gd.hiddenRound, null);
  assert.ok(m.gd.roundCfg(br + 1)?.template);
  assert.ok(m.gd.roundCfg(br + 5)?.bossTemplates);
  assert.equal(m.isBossRound(br + 4), false);
  assert.equal(m.isBossRound(br + 5), true);
  assert.equal(m.endlessMul(br + 1), 1.2);
  assert.ok(m.endlessMul(br + 1000) > 1e70);
  assert.deepEqual(m.endlessBossPlan(br + 5), match(t, ENDLESS_VARIANT, 73).endlessBossPlan(br + 5));

  const ps = m.players.get('p0');
  ps.funds = 12;
  ps.endPrep();
  assert.equal(ps.funds, 12);
  assert.equal(ps.addLayers('victoriaShip', 1000), 1000);
  assert.equal(ps.layers.victoriaShip, 1000);
  ps.pendingLayerGains = { victoriaShip: 1000 };
  assert.equal(ps.bondsView().victoriaShip.layers, 2000);

  m.round = br + 1;
  const sp = m._sanitizeSpawns([{ enemyKey: 'enemy_1000_gopro_2' }])[0];
  assert.ok(sp.mods.hpMul > 1);
  assert.ok(sp.mods.atkMul > 1);

  let delayed = null, continued = 0;
  m.round = br;
  m.phase = PHASE.FINAL_ASSAULT;
  m._finalEnding = 'cleared';
  m._finalStatsRound = null;
  m.fields = [];
  m.bossPool = { hp: 0 };
  m._stopClientCombat = () => {};
  m._syncTeamLp = () => {};
  m.markPublic = () => {};
  m.scaled = (value) => value;
  m.later = (_delay, fn) => { delayed = fn; };
  m.tickerText = () => {};
  m.startRound = (round) => { continued = round; };
  m._finishFinal(false, () => null);
  assert.equal(m.ended, false);
  delayed();
  assert.equal(continued, br + 1);
});

test('ordinary mode keeps its finite rounds and layer cap', (t) => {
  const m = match(t, null);
  const br = m.gd.bossRound;
  assert.equal(m.isEndless, false);
  assert.equal(m.isBossRound(br + 5), false);
  assert.equal(m.endlessMul(br + 1), 1);
  const ps = m.players.get('p0');
  assert.equal(ps.addLayers('victoriaShip', 1000), 999);
  assert.equal(ps.layers.victoriaShip, 999);
});

test('endless combat accepts finite values beyond ordinary protocol and result ceilings', (t) => {
  const m = match(t);
  const base = {
    reason: 'timeout', time: 1, killed: 0, total: 0, errors: 0,
    perPlayer: { p0: {
      killed: 0, total: 0, leaked: [], perfect: true, layerGains: { victoriaShip: 12000 }, coins: 0,
      damageDealt: 1e20, rankedDamage: 1e20, bossDamage: 1e20, healingDone: 0, deaths: 0, unitsEnd: [], unitStats: [],
    } },
  };
  const spec = buildBattleSpec({
    battleId: 'endless-large-values', fieldId: 'n:p0', kind: 'normal', round: 3000, timeLimit: 60,
    players: [{ playerId: 'p0', units: [], bonds: { victoriaShip: { count: 0, active: false, tier: 0, layers: 0 } } }],
    spawns: [], flags: { layerGainsEnabled: true, uncappedBondLayers: true, uncappedNumericValues: true },
  });
  assert.equal(validateC2S({ t: 'b.result', battleId: spec.battleId, result: base }), null);
  const endless = validateClientResult(spec, base, { gd: m.gd });
  assert.equal(endless.ok, true);
  assert.equal(endless.result.perPlayer.p0.damageDealt, 1e20);
  assert.equal(endless.result.perPlayer.p0.layerGains.victoriaShip, 12000);
  assert.equal(compactResult(base).perPlayer.p0.layerGains.victoriaShip, 12000);
  const leader = { isBoss: true, x: 0, y: 0, id: 'boss' };
  const noFx = { fx() {} };
  assert.equal(leaderHitCancelled({ ...noFx, kind: 'boss', flags: spec.flags }, leader, 300000), false);
  assert.equal(leaderHitCancelled({ ...noFx, kind: 'boss', flags: {} }, leader, 300000), true);

  const ordinarySpec = buildBattleSpec({ ...spec, flags: { layerGainsEnabled: true } });
  const ordinaryRaw = { ...base, perPlayer: { p0: { ...base.perPlayer.p0, layerGains: {} } } };
  const ordinary = validateClientResult(ordinarySpec, ordinaryRaw, { gd: m.gd });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.result.perPlayer.p0.damageDealt, 0);
  assert.equal(isBattleResult({ ...base, perPlayer: { p0: { ...base.perPlayer.p0, layerGains: { victoriaShip: 1e20 } } } }), true);
});

test('endless rooms use built-in content and never resolve default or selected plugins', (t) => {
  const calls = [];
  const plugins = {
    defaults() { calls.push('defaults'); return ['server-default']; },
    resolve() { calls.push('resolve'); return { ok: false, error: ERR.PLUGIN_BLOCKED }; },
  };
  const lobby = new Lobby({ registry: new SessionRegistry(), content: { cs: 'c'.repeat(64) }, plugins });
  t.after(() => lobby.shutdown());
  const host = { playerId: 'endless-host', name: 'Host', connected: true, ws: null };
  assert.deepEqual(lobby.create(host, {
    mode: 'coop', variant: ENDLESS_VARIANT, difficulty: 'HARD', capacity: 4, ranked: false,
  }), { ok: true });
  const room = lobby.roomOf(host);
  assert.equal(room.variant, ENDLESS_VARIANT);
  assert.equal(room.difficulty, 'NORMAL');
  assert.equal(room.capacity, 4);
  assert.equal(room.modded, false);
  assert.deepEqual(room.content.plugins, []);
  assert.deepEqual(calls, []);
  assert.equal(lobby.setPlugins(host, { plugins: [] }).error, ERR.PLUGIN_BLOCKED);
  assert.deepEqual(calls, []);
});
