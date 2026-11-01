import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { displayedWatch } from '../../public/js/battle/observe.js';

test('eliminated players follow the displayed server field after phase reset, reconnect and target switch', () => {
  for (const fieldId of ['n:teammate', 'unite:1', 'boss:2', 'hidden:1']) {
    assert.equal(displayedWatch({ fieldId }, { alive: false }), fieldId);
    assert.equal(displayedWatch({ fieldId }, { alive: false, watching: 'n:old' }), fieldId);
  }
  assert.equal(displayedWatch({ fieldId: 'n:teammate', prep: true }, { alive: false }), 'n:teammate');
  assert.equal(displayedWatch(null, { alive: false, watching: 'n:teammate' }), 'n:teammate');
});

test('living players preserve manual selection and external spectators keep their existing field-following behavior', () => {
  assert.equal(displayedWatch({ fieldId: 'n:teammate' }, { alive: true }), null);
  assert.equal(displayedWatch({ fieldId: 'n:old' }, { alive: true, watching: 'n:new' }), 'n:new');
  assert.equal(displayedWatch({ fieldId: 'n:teammate' }, { spectator: true }), 'n:teammate');
});

test('the match renderer uses the displayed watch and never restores the eliminated editable prep board', () => {
  const source = readFileSync(new URL('../../public/js/screens/game/match.js', import.meta.url), 'utf8');
  assert.ok(source.includes('const watching = displayedWatch(field, { alive, spectator: !!spectator, watching: localWatching })'));
  assert.ok(source.includes('const readOnlyPrep = !!spectator || !alive || watchingOther'));
});
