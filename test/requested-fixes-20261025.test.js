import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RankedStore } from '../server/rankedStore.js';
import { RANK_INACTIVITY_MS as FIVE_DAYS } from '../shared/ranks.js';
import { PHASE } from '../shared/constants.js';
import { battleEmotes } from '../public/js/ui/gameLogic/watch.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { grantRelic, relicState, relicStackInfo, relicPrivateView, relicBountyIncome, finishRelicDrafts } from '../server/match/relics.js';
import { makeBattle, enemyRec } from './helpers/battleHarness.js';
import { getDefaultSource } from '../server/sim/simdata.js';

const aid = 'a1b2c3d4e5f60718', otherAid = '99aa88bb77cc66dd';
const base = 1_790_000_000_000;
function seeded(points = 2700, opts = {}) {
  const store = new RankedStore({ now: () => base + FIVE_DAYS, ...opts });
  const p = store.ensure(aid, '博士');
  Object.assign(p, { placementDone: true, placementPlayed: 3, points, lastActive: base, lastScoredAt: base });
  return { store, p };
}
const win = { difficulty: 'HARD', mode: 'coop', startingParticipantCount: 4, teamWin: true, hiddenCleared: false };
const row = { alive: true, roundsPassed: 20, survivalRounds: 20, layers: 999, assists: 10, rankedDamage: 20_000_000, bossDamage: 2_000_000, rankedPerfectRounds: 20 };

test('rank inactivity: exact five-day boundary hides tier/rank, retains points, removes inactive competitors', () => {
  let now = base + FIVE_DAYS - 1;
  const { store, p } = seeded(2700, { now: () => now });
  const q = store.ensure(otherAid, '乙');
  Object.assign(q, { placementDone: true, points: 2600, lastActive: now, lastScoredAt: now });
  assert.equal(store.summary(aid).rank.icon, 'radiant');
  now++;
  const summary = store.summary(aid);
  assert.equal(summary.rank.label, '神话一');
  assert.equal(summary.rank.icon, 'immortal_1');
  assert.equal(summary.globalRank, null);
  assert.equal(summary.points, 2700);
  assert.equal(summary.rank.points, 2700);
  assert.equal(p.points, 2700);
  assert.equal(store.leaderboard().length, 1);
  assert.equal(store.globalRank(otherAid), 1);
  assert.equal(store.summary(aid, '', false, new Map([[aid, 1]])).globalRank, null);
  p.points = 2099;
  assert.equal(store.summary(aid).inactive, false);
  assert.equal(store.summary(aid).rank.icon, 'ascendant_3');
});

test('rank inactivity: login, standard match, zero score and negative settlement do not restore; positive gain does', () => {
  const { store, p } = seeded();
  store.ensure(aid, '博士');
  assert.equal(store.summary(aid).inactive, true);
  assert.equal(store.settleMatch({ aid, name: '博士' }, { ...win, difficulty: 'FUNNY' }, row), null);
  assert.equal(p.lastScoredAt, base);
  const zero = store.settleMatch({ aid, name: '博士' }, win, { ...row, roundsPassed: 0, survivalRounds: 0, layers: 0, assists: 0, rankedDamage: 0, bossDamage: 0, rankedPerfectRounds: 0 });
  assert.ok(zero.totalDelta <= 0);
  assert.equal(zero.inactive, true);
  const lost = store.settleMatch({ aid, name: '博士' }, { ...win, teamWin: false }, { ...row, alive: false, roundsPassed: 1, survivalRounds: 1, rankedDamage: 0, layers: 0, assists: 0 });
  assert.ok(lost.totalDelta < 0);
  assert.equal(lost.tierAfter, '神话一');
  assert.equal(p.lastScoredAt, base);
  const gain = store.settleMatch({ aid, name: '博士' }, win, row);
  assert.ok(gain.totalDelta > 0);
  assert.equal(gain.inactive, false);
  assert.equal(store.summary(aid).globalRank, 1);
  assert.equal(p.lastScoredAt, base + FIVE_DAYS);
  const low = seeded(0);
  const noGain = low.store.settleMatch({ aid, name: '博士' }, { ...win, teamWin: false }, { ...row, alive: false, survivalRounds: 0, roundsPassed: 0, rankedDamage: 0 });
  assert.equal(noGain.totalDelta, 0);
  assert.equal(low.p.lastScoredAt, base);
});

test('rank inactivity: settlement replay is idempotent and cannot refresh activity', () => {
  let now = base + FIVE_DAYS;
  const { store, p } = seeded(2700, { now: () => now });
  const who = { aid, name: '博士', playerId: 'p0' };
  const match = { ...win, matchId: '0123456789abcdef0123456789abcdef' };
  const out = store.settleMatch(who, match, row), points = p.points;
  now += FIVE_DAYS;
  assert.deepEqual(store.settleMatch(who, match, row), out);
  assert.equal(p.points, points);
  assert.equal(p.lastScoredAt, base + FIVE_DAYS);
  assert.equal(store.summary(aid).inactive, true);
});

test('rank inactivity: legacy migration, serialization and replicated legacy fallback preserve timestamps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rank-inactive-'));
  try {
    const file = path.join(dir, 'rank.json');
    fs.writeFileSync(file, JSON.stringify({ profiles: [{ aid, name: '博士', placementDone: true, points: 2800, lastActive: base }] }));
    const store = new RankedStore({ file, now: () => base + FIVE_DAYS });
    assert.equal(store.profile(aid).lastScoredAt, base);
    assert.equal(store.summary(aid).inactive, true);
    store.settleMatch({ aid, name: '博士' }, win, row);
    await store.flush();
    const reloaded = new RankedStore({ file, now: () => base + FIVE_DAYS + 1 });
    assert.equal(reloaded.profile(aid).lastScoredAt, base + FIVE_DAYS);
    assert.equal(reloaded.summary(aid).inactive, false);
    delete reloaded.profile(aid).lastScoredAt;
    reloaded.profile(aid).lastActive = base;
    reloaded.settleMatch({ aid, name: '博士' }, win, { ...row, roundsPassed: 0, survivalRounds: 0, layers: 0, assists: 0, rankedDamage: 0, bossDamage: 0, rankedPerfectRounds: 0 });
    assert.equal(reloaded.profile(aid).lastScoredAt, base);
    assert.equal(reloaded.summary(aid).inactive, true);
    await reloaded.flush();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('battle emotes: four combat phases, same team/self, solo, expiry and unknown sender', () => {
  const players = [{ playerId: 'self', team: 0, name: '自己' }, { playerId: 'mate', team: 0, name: '队友' }, { playerId: 'other', team: 1, name: '对手' }];
  const events = ['self', 'mate', 'other', 'unknown'].map((playerId, seq) => ({ playerId, seq, id: 'test', at: base }));
  for (const phase of [PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]) {
    assert.deepEqual(battleEmotes(events, { phase, players }, 'self', base + 5999).map(e => e.playerId), ['self', 'mate']);
  }
  assert.deepEqual(battleEmotes(events, { phase: PHASE.PREP, players }, 'self', base + 1), []);
  assert.deepEqual(battleEmotes(events, { phase: PHASE.COMBAT, players }, 'self', base + 6000), []);
  assert.equal(battleEmotes(events, { phase: PHASE.COMBAT, players: players.map(({ team, ...p }) => p) }, 'self', base).length, 3);
  assert.deepEqual(battleEmotes(events, { phase: PHASE.COMBAT, players }, 'missing', base), []);
});

const data = getData({ log: { warn() {}, error() {} } });
function ann(erosion = 1) {
  const m = new Match({ roomCode: 'FIX', seed: 29, matchId: 'fix-20261025', mode: 'solo', variant: 'entertainment_annihilation', erosion, difficulty: 'ANNIHILATION', ranked: false, data,
    seats: [{ seat: 0, playerId: 'p0', name: '博士', connected: true, isBot: false }], scheduler: new VirtualScheduler(), botRehearsal: 0, send() { return true; }, broadcast() {}, onEnd() {}, log: { warn() {}, error() {}, info() {}, debug() {} } });
  m.startRound(1); m.setDeadline(0); m.enterPrep(); finishRelicDrafts(m);
  relicState(m.order[0]).owned = [];
  return m;
}

test('p28: one decision gives exactly eight, teammate effect does not; bounty eight waits for prep', () => {
  const m = ann();
  try {
    const ps = m.order[0]; grantRelic(m, ps, 'p28');
    const before = ps.funds;
    m.sp = { cards: [{ idx: 0, kind: 'tactic', id: 'test_noop' }], picks: {}, taken: {} };
    m.startSpTurn = () => {}; m._applyCard(ps, 0);
    assert.equal(ps.funds, before + 8);
    m._applyCard(ps, 0); assert.equal(ps.funds, before + 8);
    m.dispatch(ps, 'onChoicePick', { forTeammate: true }); assert.equal(ps.funds, before + 8);
    const pending = ps.pendingFunds;
    assert.equal(relicBountyIncome(ps, 0), 0);
    assert.equal(relicBountyIncome(ps, 3), 8);
    assert.equal(ps.pendingFunds, pending + 8);
    assert.equal(ps.funds, before + 8);
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('p43: personal-choice equipment refunds after removal, failed equip does not, cap resets per round', () => {
  const m = ann();
  try {
    const ps = m.order[0]; grantRelic(m, ps, 'p43');
    const pagerId = 'chess_item_4_01_e_a';
    const chess = ps.acquireChess(m.gd.visibleChess.find(id => !m.gd.isGolden(id)));
    for (let i = 0; i < 4; i++) {
      const it = ps.newPiece('item', pagerId); ps.stow(it);
      if (!i) { assert.ok(ps.equip(it.uid, -1).error); assert.equal(relicState(ps).counters.refundRound || 0, 0); }
      assert.equal(ps.equip(it.uid, chess.uid).error, undefined);
      assert.equal(ps.find(it.uid), null);
      assert.equal(relicState(ps).counters.refundRound, Math.min(3, i + 1));
      assert.ok(ps.offers.length);
    }
    ps.startRound(2); assert.equal(relicState(ps).counters.refundRound, 0);
    m.round = 2; m.enterPrep(); finishRelicDrafts(m);
    const beacon = ps.newPiece('item', 'chess_item_5_04_e_a'); ps.stow(beacon);
    const target = ps.acquireChess(m.gd.visibleChess.find(id => !m.gd.isGolden(id)));
    assert.equal(ps.equip(beacon.uid, target.uid).error, undefined);
    assert.equal(ps.find(beacon.uid), null);
    assert.equal(relicState(ps).counters.refundRound, 1);
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('n19: display counts match rounds rather than operation-counter objects', () => {
  const m = ann();
  try {
    const ps = m.order[0]; grantRelic(m, ps, 'n19'); const st = relicState(ps), def = m.gd.raw.relics.relics.n19;
    assert.equal(typeof ps.round, 'object');
    for (const [round, expected] of [[1, 1], [2, 2], [4, 4], [10, 4]]) {
      m.round = round; assert.equal(relicStackInfo(ps, def, st, m.gd.raw.relics).stacks, expected);
    }
    assert.ok(relicPrivateView(ps));
  } finally { m.dispose(); }
});

const ds = getDefaultSource();
test('annihilation terrain: infection base damage/no SP and per-source move floors; ordinary terrain stays unchanged', () => {
  const wait = pos => ({ motion: 'WALK', start: pos, end: [9, 2], checkpoints: [{ type: 'WAIT', time: 99 }] });
  const h = makeBattle({ stageId: 'act2autochess_m04', modeId: 'mode_single_annihilation', flags: { terrainLethal: 5 }, defs: { enemies: { enemy_fix: enemyRec({ key: 'enemy_fix', hp: 100000, speed: 1, atk: 0 }) } }, enemies: [{ key: 'enemy_fix', pos: [11, 6], route: wait([11, 6]) }], autoFinish: false });
  h.run(1.1); assert.equal(h.enemy('enemy_fix').s.moveSpeed, .5);
  const mire = makeBattle({ stageId: 'act2autochess_m02', modeId: 'mode_single_annihilation', flags: { terrainLethal: 5 }, defs: { enemies: { enemy_fix: enemyRec({ key: 'enemy_fix', hp: 100000, speed: 1, atk: 0 }) } }, enemies: [{ key: 'enemy_fix', pos: [10, 7], route: wait([10, 7]) }], autoFinish: false });
  mire.run(12); assert.equal(mire.enemy('enemy_fix').s.moveSpeed, .5);
  const ticks = [];
  const infection = makeBattle({ stageId: 'act1autochess_m04', modeId: 'mode_single_annihilation', flags: { terrainLethal: 5 }, defs: { enemies: { enemy_fix: enemyRec({ key: 'enemy_fix', hp: 100000, speed: 0, atk: 0 }) } }, enemies: [{ key: 'enemy_fix', pos: [10, 6] }], autoFinish: false,
    setup: b => b.on('hit', ({ dmg }) => ticks.push(dmg)) });
  infection.step(); infection.run(2);
  const damage = ds.getStage('act1autochess_m04').special.infection.bb.damage;
  assert.equal(damage, 70);
  assert.equal(100000 - infection.enemy('enemy_fix').hp, 2 * damage);
  assert.ok(ticks.length >= 2);
  assert.ok(ticks.every(d => d.sourceless && d.noSp));
  const ordinary = makeBattle({ stageId: 'act2autochess_m04', defs: { enemies: { enemy_fix: enemyRec({ key: 'enemy_fix', hp: 100000, speed: 1, atk: 0 }) } }, enemies: [{ key: 'enemy_fix', pos: [11, 6], route: wait([11, 6]) }], autoFinish: false });
  ordinary.run(1.1); assert.equal(ordinary.enemy('enemy_fix').s.moveSpeed, .6);
  const windStage = structuredClone(ds.getStage('act2autochess_m01'));
  windStage.rows[10] = windStage.rows[10].slice(0, 9) + 'm' + windStage.rows[10].slice(10);
  windStage.rows[11] = windStage.rows[11].slice(0, 9) + 'm' + windStage.rows[11].slice(10);
  windStage.special.mire = { intervalSec: .1, moveMulPerStack: -.15, maxStacks: 20 };
  const observed = [];
  const wind = makeBattle({ stage: windStage, modeId: 'mode_single_annihilation', flags: { terrainLethal: 5 }, defs: { enemies: { enemy_fix: enemyRec({ key: 'enemy_fix', hp: 100000, speed: 1, atk: 0 }) } }, enemies: [{ key: 'enemy_fix', route: { motion: 'WALK', start: [9, 9], end: [12, 9], checkpoints: [] } }], autoFinish: false, setup: b => b.on('tick', () => { const e = b.enemies[0]; if (e?.findBuff('terrain:mire') && e?.findBuff('terrain:airflow')) observed.push(e.s.moveSpeed); }) });
  wind.run(12);
  assert.ok(observed.includes(.25));
  assert.ok(observed.every(speed => speed >= .25));
});
