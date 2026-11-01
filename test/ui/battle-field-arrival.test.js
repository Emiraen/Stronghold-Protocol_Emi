import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentBattleField } from '../../public/js/screens/game/early.js';

for (const [phase, kind] of Object.entries({ COMBAT: 'normal', UNITE: 'unite', FINAL_ASSAULT: 'boss', HIDDEN_CORE: 'hidden' })) {
  test(`${phase}: a current field received during prep is entered without reconnecting`, () => {
    const field = { fieldId: 'field', battleId: 'battle', round: 3, kind };
    assert.equal(currentBattleField(field, { phase: 'PREP', round: 3 }, field), false);
    assert.equal(currentBattleField(field, { phase, round: 3 }, field), true);
    assert.equal(currentBattleField(field, { phase, round: 4 }, field), false);
    assert.equal(currentBattleField({ ...field, prep: true }, { phase, round: 3 }, field), false);
    const other = { ...field, kind: kind === 'normal' ? 'unite' : 'normal' };
    assert.equal(currentBattleField(other, { phase, round: 3 }, other), false);
  });
}
test('legacy metadata still requires a new field object; prep scouting is never a battle', () => {
  const old = { fieldId: 'n:p', kind: 'normal' };
  assert.equal(currentBattleField(old, { phase: 'COMBAT', round: 1 }, old), false);
  assert.equal(currentBattleField({ ...old }, { phase: 'COMBAT', round: 1 }, old), true);
  assert.equal(currentBattleField({ ...old, prep: true }, { phase: 'COMBAT', round: 1 }, old), false);
});
