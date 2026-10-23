import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankingPending } from '../../public/js/ui/rankStatus.js';

test('rank status: confirmed and missing summaries do not imply uncertainty', () => {
  for (const value of [null, undefined, {}, { rank: { label: '神话' } }, { rankingPending: false }]) {
    assert.equal(rankingPending(value), false);
  }
});
test('rank status: either uncertainty marker blocks only ranking-dependent controls', () => {
  assert.equal(rankingPending({ rankUnavailable: true, rank: { label: '神话' } }), true);
  assert.equal(rankingPending({ rankingPending: true }), true);
});
