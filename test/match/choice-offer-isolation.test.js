import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCard } from '../../server/match/choices.js';
import { MatchOffers } from '../../server/match/match/offers.js';
import { REWARD_FAILURE_TEXT } from '../../server/match/rewardRecovery.js';

function player(id) {
  return { playerId: id, alive: true, left: false, layers: {}, effects: [], funds: 0, shop: { freeRefreshes: 0 },
    dirty() {}, recompute() {}, addFunds(n) { this.funds += n; },
    addLayers(id, n, { receipt }) { receipt.stage = 'committed'; this.layers[id] = (this.layers[id] ?? 0) + n; } };
}
const layerBuff = (bonds, count = 12) => ({ key: 'global_special_choice_bond_addlayer', bb: { count }, bbStr: { bond_list: bonds } });
function choice(buffs, team = false) {
  const errors = [], sent = [], a = player('a'), b = player('b');
  const m = { round: 8, isCyclops: false, gd: { effect: () => ({ buffs }) },
    alivePlayers: () => [a, b], nextUid: () => 1, dispatch() {}, sendTo(id, msg) { sent.push([id, msg]); },
    dispatcher: { runKey: () => false, _report(...args) { errors.push(args); } } };
  a.m = b.m = m;
  return { a, b, m, errors, sent, run: () => applyCard(m, a, { kind: 'tactic', id: 'fallback', team }) };
}

test('fallback choice: two unreceived failures skip only the failed bond, then apply healthy bonds and buffs', () => {
  const f = choice([layerBuff('bad,healthy'), { key: 'global_special_choice_gain_coin', bb: { count: 5 } }]);
  const add = f.a.addLayers.bind(f.a); let calls = 0;
  f.a.addLayers = (id, n, opts) => { if (id === 'bad') { calls++; opts.receipt.stage = 'preflight'; throw Error('bad bond'); } return add(id, n, opts); };
  f.run();
  assert.equal(calls, 2); assert.equal(f.a.layers.healthy, 12); assert.equal(f.a.funds, 5);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0][1].text, REWARD_FAILURE_TEXT);
  assert.equal(f.a.effects.length, 0);
});

test('fallback choice: actual partial commit is not replayed and the next bond still runs', () => {
  const f = choice([layerBuff('partial,healthy')]);
  const add = f.a.addLayers.bind(f.a); let calls = 0;
  f.a.addLayers = (id, n, opts) => { if (id === 'partial') { calls++; f.a.layers[id] = 3; throw Error('post commit'); } return add(id, n, opts); };
  f.run();
  assert.equal(calls, 1); assert.equal(f.a.layers.partial, 3); assert.equal(f.a.layers.healthy, 12);
  assert.equal(f.sent.length, 0);
});

test('fallback choice: throwing economic buff is not replayed and does not suppress the next independent buff', () => {
  const f = choice([{ key: 'global_special_choice_gain_coin', bb: { count: 5 } }, layerBuff('healthy')]);
  let calls = 0; f.a.addFunds = () => { calls++; throw Error('unknown funds'); };
  f.run();
  assert.equal(calls, 1); assert.equal(f.a.layers.healthy, 12); assert.equal(f.a.effects.length, 0);
  assert.equal(f.errors.length, 1);
});

test('fallback choice: failed known buff alone is not reinterpreted as a battle effect', () => {
  const f = choice([{ key: 'global_special_choice_gain_coin', bb: { count: 5 } }]);
  f.a.addFunds = () => { throw Error('funds'); }; f.run();
  assert.equal(f.a.effects.length, 0);
});

test('team choice: first player recompute failure cannot suppress a healthy teammate', () => {
  const f = choice([layerBuff('healthy')], true);
  f.a.recompute = () => { throw Error('recompute'); }; f.run();
  assert.equal(f.a.layers.healthy, 12); assert.equal(f.b.layers.healthy, 12);
  assert.equal(f.errors.length, 1);
});

test('fallback choice: diagnostic throw cannot suppress later rewards or teammates', () => {
  const f = choice([{ key: 'global_special_choice_gain_coin', bb: { count: 5 } }, layerBuff('healthy')], true);
  f.a.addFunds = () => { throw Error('funds'); };
  f.m.dispatcher._report = () => { throw Error('reporter'); }; f.run();
  assert.equal(f.a.layers.healthy, 12); assert.equal(f.b.layers.healthy, 12); assert.equal(f.b.funds, 5);
});

function offerFixture(cards) {
  const a = player('a'), b = player('b'), sent = [], errors = [], scheduled = [];
  const m = new MatchOffers();
  const w = { id: 'test', pluginId: 'local', seq: 0, round: 8, slots: cards.length, offer: { cards },
    onTimeout: 'first', quorum: 'all', deadline: 100, closed: false,
    options: new Map([[a.playerId, cards], [b.playerId, cards]]), picks: new Map() };
  Object.assign(m, { round: 8, isCyclops: false, offerWin: [w], _offerTimers: new Map([[w, 1]]),
    sched: { now: () => 0 }, alivePlayers: () => [a, b], markPublic() {}, cancel() {},
    later(delay, fn) { scheduled.push(fn); return scheduled.length; },
    sendTo(id, msg) { sent.push([id, msg]); }, reportError(...args) { errors.push(args); },
    dispatcher: { _report(...args) { errors.push(args); } } });
  return { a, b, m, w, sent, errors, scheduled };
}
const layerCard = { id: 'layers', effect: { layers: { bond: 'healthy', count: 12 } } };
const coinCard = { id: 'coins', effect: { funds: 10 } };

test('offer close: failed player does not block healthy player or window closure, and never tries another card', () => {
  const f = offerFixture([layerCard, coinCard]);
  let calls = 0; f.a.addLayers = (_id, _n, opts) => { calls++; opts.receipt.stage = 'preflight'; throw Error('layers'); };
  let resumed = 0; f.m._offerResume = () => resumed++;
  f.m._offerDeadline(f.w); for (const fn of f.scheduled) fn();
  assert.equal(calls, 2); assert.equal(f.a.funds, 0); assert.equal(f.b.layers.healthy, 12);
  assert.equal(f.w.closed, true); assert.equal(f.m.offerWin.length, 0); assert.equal(resumed, 1);
  assert.equal(f.w.picks.get('a').idx, 0); assert.equal(f.sent[0][1].text, REWARD_FAILURE_TEXT);
});

test('offer default: ambiguous item grant is consumed once without trying another card or later replay', () => {
  const f = offerFixture([{ id: 'item', effect: { item: 'item1' } }, coinCard]);
  let calls = 0; f.a.gd = { item: () => ({}) }; f.m.itemPool = { canGain: () => true };
  f.a.acquireItem = () => { calls++; throw Error('unknown item commit'); };
  f.m._offerDefault(f.a, f.w); f.m._offerDefault(f.a, f.w);
  assert.equal(calls, 1); assert.equal(f.a.funds, 0); assert.equal(f.w.picks.get('a').failed, true);
  assert.equal(f.sent[0][1].diagnostic.code, 'OFFER_GRANT_FAILED');
});

test('offersChanged: one faulty bot grant cannot block a healthy bot or completion', () => {
  const f = offerFixture([coinCard]); f.a.botControlled = f.b.botControlled = true;
  f.a.addFunds = () => { throw Error('unknown funds'); }; f.m.offersChanged();
  assert.equal(f.b.funds, 10); assert.equal(f.w.closed, true); assert.equal(f.m.offerWin.length, 0);
  assert.equal(f.w.picks.get('a').failed, true);
});

test('manual offer: ambiguous grant records failed consumed pick and refuses a duplicate request', () => {
  const f = offerFixture([coinCard]); let calls = 0;
  f.a.addFunds = () => { calls++; throw Error('unknown funds'); };
  const first = f.m.requestOffer(f.a, 'test', 0); const second = f.m.requestOffer(f.a, 'test', 0);
  assert.equal(first.error, 'BAD_TARGET'); assert.equal(second.error, 'ALREADY'); assert.equal(calls, 1);
  assert.equal(f.w.picks.get('a').failed, true);
});

test('offer fallback: definitely unavailable card can still select the next eligible card', () => {
  const f = offerFixture([{ id: 'item', effect: { item: 'missing' } }, coinCard]);
  f.a.gd = { item: () => null }; f.m._offerDefault(f.a, f.w);
  assert.equal(f.a.funds, 10); assert.equal(f.w.picks.get('a').idx, 1);
});

test('offer close: broken error reporters cannot block healthy recipients', () => {
  const f = offerFixture([coinCard]);
  f.a.addFunds = () => { throw Error('grant'); };
  f.m.reportError = f.m.sendTo = () => { throw Error('reporter'); };
  f.m._closeOffer(f.w);
  assert.equal(f.b.funds, 10); assert.equal(f.w.closed, true); assert.equal(f.w.picks.get('a').failed, true);
});

test('offer layers: a partial actual grant is not retried or exchanged for another card', () => {
  const f = offerFixture([layerCard, coinCard]); let calls = 0;
  f.a.addLayers = id => { calls++; f.a.layers[id] = 3; throw Error('post commit'); };
  f.m._offerDefault(f.a, f.w);
  assert.equal(calls, 1); assert.equal(f.a.layers.healthy, 3); assert.equal(f.a.funds, 0);
  assert.equal(f.w.picks.get('a').idx, 0); assert.equal(f.sent.length, 0);
});

test('manual offer: normal layer grant keeps the original success and once-only pick semantics', () => {
  const f = offerFixture([layerCard]);
  assert.deepEqual(f.m.requestOffer(f.a, 'test', 0), { ok: true });
  assert.deepEqual(f.m.requestOffer(f.a, 'test', 0), { error: 'ALREADY' });
  assert.equal(f.a.layers.healthy, 12); assert.equal(f.sent.length, 0);
});

test('offer timeout skip still grants nothing', () => {
  const f = offerFixture([coinCard]); f.w.onTimeout = 'skip';
  f.m._closeOffer(f.w);
  assert.equal(f.a.funds, 0); assert.equal(f.b.funds, 0);
  assert.equal(f.w.picks.get('a').idx, null); assert.equal(f.w.closed, true);
});
