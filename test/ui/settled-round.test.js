import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { rememberRoundLife, settledRoundOutcome } from '../../public/js/ui/settledRound.js';

const settle = (lp, extra = {}) => ({ phase: PHASE.SETTLE, round: 3, players: [{ playerId: 'me', lp }], ...extra });
const combat = (phase, lp) => ({ phase, round: 3, lp });

test('ordinary unite fully rescues leaks: authoritative unchanged LP shows no loss and no damage sound', () => {
  let baseline = rememberRoundLife(null, combat(PHASE.COMBAT, 30));
  baseline = rememberRoundLife(baseline, combat(PHASE.UNITE, 30));
  const outcome = settledRoundOutcome(baseline, settle(30), 'me');
  assert.deepEqual(outcome, { tone: 'mint', sub: '本回合未损失生命值', sound: 'battleOverNoReduce' });
});

test('partial rescue uses settled LP, not original leaks or cap; helper makes no team-wide claim', () => {
  const baseline = rememberRoundLife(null, combat(PHASE.UNITE, 30));
  assert.equal(settledRoundOutcome(baseline, settle(28), 'me').sub, '生命值减少 −2');
  assert.equal(settledRoundOutcome(baseline, settle(28), 'me').sound, 'battleOverReduce');
  assert.equal(settledRoundOutcome(baseline, settle(30), 'me').sub, '本回合未损失生命值');
});

test('public phase and LP stay coherent regardless of private settlement arrival order', () => {
  const baseline = rememberRoundLife(null, combat(PHASE.COMBAT, 30));
  // A settled private snapshot may trigger a rerender while public is still COMBAT.
  const rerendered = rememberRoundLife(baseline, combat(PHASE.COMBAT, 30));
  assert.equal(settledRoundOutcome(rerendered, settle(27), 'me').sub, '生命值减少 −3');
  // Public SETTLE may instead arrive while private still holds 30; private LP is not consulted.
  assert.equal(settledRoundOutcome(baseline, settle(27), 'me').sub, '生命值减少 −3');
});

test('direct settlement reconnect and stale prior-round baselines never guess a loss', () => {
  assert.equal(settledRoundOutcome(null, settle(27), 'me'), null);
  assert.equal(settledRoundOutcome({ round: 2, lp: 30 }, settle(27), 'me'), null);
  assert.equal(settledRoundOutcome({ round: 3, lp: 30 }, settle(undefined), 'me'), null);
});

test('entertainment authoritative losses and confirmed whole-team rescue remain supported', () => {
  const pub = settle(30, { uniteResult: { losses: { me: 0 }, through: 0 } });
  assert.equal(settledRoundOutcome(null, pub, 'me').sub, '全员无伤！');
  pub.uniteResult = { losses: { me: 2 }, through: 2 };
  assert.equal(settledRoundOutcome(null, pub, 'me').sub, '生命值减少 −2');
});
