import test from 'node:test';
import assert from 'node:assert/strict';
import { createMizukiBattlePresentation } from '../public/js/mizukiBattlePresentation.js';

function fixture(t) {
  const controller = createMizukiBattlePresentation();
  t.after(() => controller.reset());
  const field = { fieldId: 'field-1', battleId: 'battle-1', t: 4, units: [['enemy', 100]] };
  const props = { myId: 'p1', ownFieldId: field.fieldId, phase: 'COMBAT', spectator: false, readOnly: false, online: true,
    pub: { matchId: 'run-1' }, model: { currentNode: { id: 'node-1' }, fields: [field] },
    priv: { life: 8, maxLife: 10, shield: 1 }, act: async () => true };
  const outcome = { id: 'receipt-1', battleId: 'battle-1', nodeId: 'node-1', perfect: true, lpLoss: 0 };
  const env = (receipt = outcome, overrides = {}) => ({ me: { playerId: 'p1' }, spectator: false,
    match: { public: { matchId: 'run-1', mizuki: { fields: [{ ...field, t: 10, units: [['enemy', 0]], done: true }] } },
      private: { mizuki: { life: 7, maxLife: 10, shield: 0, ...(receipt ? { battleOutcome: receipt } : {}) } } }, ...overrides });
  return { controller, field, props, outcome, env };
}

test('a matching receipt retains the terminal battle frame and blocks actions until its result is released', async t => {
  const f = fixture(t), token = {};
  f.controller.present(token, f.props);
  f.controller.sync(f.env());
  const ending = f.controller.get();
  assert.equal(ending.ending.id, f.outcome.id); assert.equal(ending.waiting, false);
  assert.equal(ending.props.phase, 'COMBAT'); assert.equal(ending.props.finishing, true);
  assert.equal(ending.props.readOnly, true); assert.equal(ending.props.online, false);
  assert.equal(await ending.props.act('deploy', {}), false);
  assert.equal(ending.props.model.fields[0].t, 10);
  assert.deepEqual(ending.props.model.fields[0].units, [['enemy', 0]]);
  assert.equal(ending.props.priv.life, 7); assert.equal(ending.props.priv.shield, 0);
  assert.equal(f.props.model.fields[0].t, 4); assert.equal(f.props.priv.life, 8);
  const reward = { ...f.props, phase: 'MIZUKI_REWARD', model: { ...f.props.model, fields: [] } };
  f.controller.present({}, reward);
  f.controller.release('wrong-receipt'); assert.equal(f.controller.get().ending.id, f.outcome.id);
  f.controller.release(f.outcome.id);
  assert.equal(f.controller.get().props, reward); assert.equal(f.controller.get().ending, null);
  f.controller.present({}, f.props); f.controller.sync(f.env());
  assert.equal(f.controller.get().ending, null, 'the same receipt cannot replay when another frame arrives');
});

test('a public phase change waits for its matching private receipt without losing the field', t => {
  const f = fixture(t), token = {};
  f.controller.present(token, f.props);
  f.controller.depart(token, f.env(null));
  assert.equal(f.controller.get().waiting, true);
  assert.equal(f.controller.get().props.model.fields[0].fieldId, f.field.fieldId);
  assert.equal(f.controller.get().props.readOnly, true);
  f.controller.sync(f.env());
  assert.equal(f.controller.get().waiting, false);
  assert.equal(f.controller.get().ending.id, f.outcome.id);
  assert.equal(f.controller.get().props.model.fields[0].t, 10);
  const later = f.env({ ...f.outcome, id: 'future-receipt' });
  later.match.private.mizuki.life = 2;
  f.controller.sync(later);
  assert.equal(f.controller.get().props.priv.battleOutcome.id, f.outcome.id);
  assert.equal(f.controller.get().props.priv.life, 7, 'a later receipt cannot rewrite the result currently being shown');
});

test('split combat frames retain missing own fields and ignore departure from an obsolete mount', t => {
  const f = fixture(t), oldToken = {}, newToken = {};
  f.controller.present(oldToken, f.props);
  f.controller.present(newToken, { ...f.props, model: { ...f.props.model, fields: [] } });
  assert.deepEqual(f.controller.get().props.model.fields, [f.field]);
  f.controller.depart(oldToken, f.env(null));
  assert.equal(f.controller.get().waiting, false);
  assert.equal(f.controller.begin({ id: 'stale', battleId: 'other-battle', nodeId: 'other-node' }), false);
  f.controller.present(newToken, { ...f.props, model: { ...f.props.model, fields: [{ ...f.field, t: 5 }] } });
  assert.equal(f.controller.get().props.model.fields.length, 1);
  assert.equal(f.controller.get().props.model.fields[0].t, 5);
});

test('reload receipts and explicit spectators do not start a victory animation', t => {
  const f = fixture(t), token = {};
  f.controller.present(token, { ...f.props, priv: { ...f.props.priv, battleOutcome: f.outcome } });
  f.controller.sync(f.env()); assert.equal(f.controller.get().ending, null);
  f.controller.reset();
  f.controller.present(token, { ...f.props, spectator: true, readOnly: true });
  f.controller.sync(f.env(f.outcome, { spectator: true }));
  assert.equal(f.controller.get().ending, null);
  f.controller.depart(token, f.env(f.outcome, { spectator: true }));
  assert.equal(f.controller.get().props, null);
});

test('changing the run or player releases a pending presentation and clears the receipt wait', t => {
  const f = fixture(t), token = {};
  f.controller.present(token, f.props); f.controller.depart(token, f.env(null));
  assert.equal(f.controller.get().waiting, true);
  const nextRun = f.env(null); nextRun.match.public.matchId = 'run-2';
  f.controller.sync(nextRun);
  assert.deepEqual(f.controller.get(), { props: null, ending: null, waiting: false });
  f.controller.present(token, f.props); f.controller.depart(token, f.env(null));
  f.controller.sync(f.env(null, { me: { playerId: 'p2' } }));
  assert.deepEqual(f.controller.get(), { props: null, ending: null, waiting: false });
});
