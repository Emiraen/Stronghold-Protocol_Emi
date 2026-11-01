import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { MatchBoss } from '../../server/match/match/bossRounds.js';
import { makeMatch } from './harness.js';

function fixture({ hidden = false, victory = true, endless = false, eligible = false } = {}) {
  const m = Object.create(MatchBoss.prototype), finished = [], waits = [], rounds = [];
  Object.assign(m, {
    phase: hidden ? PHASE.HIDDEN_CORE : PHASE.FINAL_ASSAULT, round: hidden ? 15 : 14,
    fields: [], players: new Map(), teamLp: 100, bossPool: { hp: victory ? 0 : 1 },
    isEndless: endless, hiddenBossId: eligible ? 'hidden' : null, hiddenLayerSum: 99999,
    gd: { isSolo: false, hiddenRound: 15, difficulty: 'NORMAL',
      hiddenCore: { difficulties: ['NORMAL'], multi: 1200, minTeamLpExclusive: 1 } },
    _stopClientCombat() {}, _syncTeamLp() {}, markPublic() {}, tickerText() {},
    alivePlayers: () => [{}, {}], scaled: ms => ms,
    later: (ms, fn) => { waits.push({ ms, fn }); },
    finish: result => finished.push(result), startRound: round => rounds.push(round),
  });
  return { m, finished, waits, rounds, hidden };
}

for (const hidden of [false, true]) for (const victory of [false, true]) {
  test(`terminal settlement starts immediately: hidden=${hidden}, victory=${victory}`, () => {
    const f = fixture({ hidden, victory });
    f.m._finishFinal(hidden, () => { throw new Error('no field'); });
    assert.equal(f.waits.length, 0);
    assert.equal(f.finished.length, 1);
    assert.equal(f.finished[0].victory, victory);
    if (hidden) assert.equal(f.finished[0].hiddenCleared, victory);
    f.m._finishFinal(hidden, () => null);
    assert.equal(f.finished.length, 1, 'duplicate final callback cannot settle twice');
  });
}

test('endless victory still waits before starting the next boss-cycle round', () => {
  const f = fixture({ endless: true });
  f.m._finishFinal(false, () => null);
  assert.equal(f.finished.length, 0); assert.equal(f.waits.length, 1);
  assert.equal(f.waits[0].ms, 3000); assert.equal(f.m.bossPool, null);
  f.waits[0].fn(); assert.deepEqual(f.rounds, [15]);
});

test('hidden-core unlock still waits before starting the next round', () => {
  const f = fixture({ eligible: true });
  f.m._finishFinal(false, () => null);
  assert.equal(f.finished.length, 0); assert.equal(f.waits.length, 1);
  assert.equal(f.waits[0].ms, 3000); assert.equal(f.m.hiddenReached, undefined);
  f.waits[0].fn();
  assert.equal(f.m.hiddenReached, true); assert.equal(f.m.bossPool, null);
  assert.deepEqual(f.rounds, [15]);
});

test('final result preview arrives without the inter-round pause, then one real receipt completes it', async t => {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 2, fake: true, instant: false }).start();
  t.after(() => h.m.dispose());
  h.drive(() => h.m.phase === PHASE.FINAL_ASSAULT);
  const m = h.m, at = h.sched.now(); let calls = 0;
  m.completeMatch = async job => { calls++; return { result: job.result }; };
  m.bossPool.hp = 0; m._finalEnding = 'cleared';
  m._finishFinal(false, () => ({ perPlayer: {} }));
  assert.equal(h.sched.now(), at); assert.equal(m.phase, PHASE.RESULT);
  assert.equal(h.lastTo('p_0', 'm.result').settlementPending, true);
  await m.finishPromise;
  assert.equal(calls, 1); assert.equal(h.endedCount, 1);
  assert.equal(h.lastTo('p_0', 'm.result').settlementPending, undefined);
});
