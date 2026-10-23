import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordRewardFailure, REWARD_FAILURE_TEXT } from '../../public/js/ui/rewardErrors.js';
import { clearErrorLog, errorLog, buildDiagnostics } from '../../public/js/diag.js';

test('reward error: exact prompt and receipt are copyable through existing diagnostics', () => {
  clearErrorLog();
  assert.equal(recordRewardFailure({ diagnostic: { code: 'LAYER_GRANT_FAILED', round: 8, source: 'band:band_yu',
    hook: 'onRoundStart', bondId: 'visiShip', attempt: 2, receipt: 'not-received', before: 0, after: 0 } }), true);
  const text = buildDiagnostics({ state: {}, env: {}, entries: errorLog(), total: 1 });
  assert.ok(text.includes(REWARD_FAILURE_TEXT)); assert.ok(text.includes('visiShip'));
  assert.ok(text.includes('not-received')); assert.ok(text.includes('"attempt":2'));
});
test('reward error: settlement facts are recorded but arbitrary server secrets are excluded', () => {
  clearErrorLog();
  assert.equal(recordRewardFailure({ text: 'untrusted text', diagnostic: { code: 'RESULT_SETTLEMENT_FAILED',
    source: 'result', hook: 'settlement', matchId: 'match-local', receipt: 'unverified',
    password: 'SECRET', token: 'SECRET', stack: 'SERVER_PRIVATE_STACK', before: Infinity } }), true);
  const text = buildDiagnostics({ entries: errorLog(), total: 1 });
  assert.ok(text.includes('match-local')); assert.ok(!text.includes('SECRET'));
  assert.ok(!text.includes('SERVER_PRIVATE_STACK')); assert.ok(!text.includes('untrusted text'));
});
test('reward error: ordinary toasts are not misclassified as economic failures', () => {
  clearErrorLog();
  assert.equal(recordRewardFailure({ text: 'hello' }), false);
  assert.equal(recordRewardFailure({ diagnostic: { code: 'unknown' } }), false);
  assert.equal(errorLog().length, 0);
});
