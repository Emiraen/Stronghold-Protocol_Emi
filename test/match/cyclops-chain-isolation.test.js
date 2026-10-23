import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCyclopsGiftHooks, cyclopsLayerGain, cyclopsPaidRefreshRewards, cyclopsVictoriaRewards, settleCyclopsHexes } from '../../server/match/cyclops.js';

const gift = (id, params = {}, quality = 'gold') => ({ data: { tacticKind: 'cyclops', effectId: id, quality }, params: { giftRules: 3, quality, ...params } });
function fixture() {
  const reports = [], notices = [], funds = [], items = [], chess = [];
  const rng = () => 0; rng.shuffle = list => list;
  const recs = { it: { id: 'it', itemType: 'EQUIP', tier: 2, isGolden: false }, exclusive: { id: 'exclusive', itemType: 'EQUIP', tier: 6, isGolden: false } };
  const m = { isCyclops: true, round: 6, rngMeta: rng, itemPool: { canGain: () => true },
    dispatcher: { _report(source, label, error) { reports.push({ source, label, error }); } },
    sendTo(id, message) { notices.push({ id, message }); } };
  const ps = { m, playerId: 'p1', effects: [], layers: { yanShip: 0, victoriaShip: 200 }, bonds: { yanShip: { active: true } }, bondCountBonus: {},
    funds: 10, lp: 20, cyclopsStreak: 0, hand: [], temp: [], board: new Map(), pool: { roll: () => 'op' },
    gd: { raw: { items: recs }, bondIds: ['yanShip'], chess: () => ({ tier: 2, bonds: ['yanShip'] }), item: id => recs[id], shopItemsByTier: { 2: ['it'], 3: ['it'], 5: ['it'] } },
    dirty() {}, recompute() {}, checkItemMerges() {},
    addFunds(n) { funds.push(n); this.funds += n; },
    acquireItem(id) { items.push(id); return true; }, acquireChess(id) { chess.push(id); return true; },
    addLayers(id, n, opts) { opts.receipt.stage = 'preflight'; this.layers[id] = (this.layers[id] || 0) + n; return n; } };
  return { m, ps, reports, notices, funds, items, chess };
}
const hasError = (h, message) => assert.ok(h.reports.some(r => r.error.message === message), message);

test('cyclops chains: failed effect normalization is excluded and later effects normalize despite reporting/dirty faults', () => {
  const h = fixture(), bad = { data: { tacticKind: 'cyclops', quality: 'gold', effectId: 'cyc_economy' } };
  Object.defineProperty(bad, 'params', { get() { throw Error('bad normalize'); } });
  const good = gift('cyc_economy', {}, 'silver'); good.params = {};
  h.ps.effects = [bad, good]; h.ps.dirty = () => { throw Error('dirty fault'); };
  const report = h.m.dispatcher._report; h.m.dispatcher._report = (...args) => { report(...args); throw Error('report fault'); };
  const out = normalizeCyclopsGiftHooks(h.ps);
  assert.deepEqual(out, [good]); assert.equal(good.params.roundIncome, 1); assert.equal(good.params.giftRules, 3);
  hasError(h, 'bad normalize'); hasError(h, 'dirty fault');
});

test('cyclops chains: presentation construction failure does not publish migrated parameters', () => {
  const h = fixture(), bad = gift('cyc_economy'); bad.params = {};
  h.ps.gd.raw.cyclops = { hexes: [{ id: 'cyc_economy', levels: { gold: { get name() { throw Error('bad card name'); } } } }] };
  h.ps.effects = [bad]; assert.deepEqual(normalizeCyclopsGiftHooks(h.ps), []);
  assert.equal(bad.params.giftRules, undefined); hasError(h, 'bad card name');
});

test('cyclops chains: one layer modifier fault cannot block later modifiers or return poisoned gain', () => {
  const h = fixture(), bad = gift('cyc_universal', { bondId: 'yanShip' });
  Object.defineProperty(bad.params, 'layerMultiplier', { get() { throw Error('bad modifier'); } });
  const a = gift('cyc_universal', { bondId: 'yanShip', layerMultiplier: 1.2 }), b = gift('cyc_universal', { bondId: 'yanShip', layerMultiplier: 1.3 });
  h.ps.effects = [bad, a, b];
  assert.equal(cyclopsLayerGain(h.ps, 'yanShip', 10), 15);
  assert.ok(Math.abs(a.params['remainder:yanShip']) < 1e-8); hasError(h, 'bad modifier');
});

test('cyclops chains: paid refresh post-commit rebate error does not block another gift or replay funds', () => {
  const h = fixture(), a = gift('cyc_refresh', { rebateEvery: 1 }), b = gift('cyc_refresh', { rebateEvery: 1 });
  const add = h.ps.addFunds; h.ps.addFunds = function(n) { add.call(this, n); if (h.funds.length === 1) throw Error('rebate committed'); };
  cyclopsPaidRefreshRewards(h.m, h.ps, 2, [a, b]);
  assert.deepEqual(h.funds, [1, 1]); assert.equal(a.params.rebated, true);
  cyclopsPaidRefreshRewards(h.m, h.ps, 2, [a, b]); assert.deepEqual(h.funds, [1, 1]); hasError(h, 'rebate committed');
});

test('cyclops chains: ambiguous paid refresh recruitment is consumed once and later gifts still execute', () => {
  const h = fixture(), a = gift('cyc_refresh', { recruitEvery: 5, recruitLimit: 2, paidRefreshes: 4 }), b = gift('cyc_refresh', { rebateEvery: 1 });
  h.ps.acquireChess = id => { h.chess.push(id); throw Error('recruit committed'); };
  cyclopsPaidRefreshRewards(h.m, h.ps, 2, [a, b]);
  assert.equal(h.chess.length, 1); assert.equal(a.params.paidRefreshes, 0); assert.equal(a.params.roundRecruits, 1); assert.deepEqual(h.funds, [1]);
  cyclopsPaidRefreshRewards(h.m, h.ps, 2, [a, b]); assert.equal(h.chess.length, 1); hasError(h, 'recruit committed');
});

test('cyclops chains: Victoria post-commit item error cannot block later gift or reoffer the same reward', () => {
  const h = fixture(), a = gift('cyc_victoria', { rewardStartLayers: 0, rewardPaid: 0 }), b = gift('cyc_victoria', { rewardStartLayers: 0, rewardPaid: 0 });
  h.ps.effects = [a, b];
  const acquire = h.ps.acquireItem; h.ps.acquireItem = function(id) { const got = acquire.call(this, id); if (h.items.length === 1) throw Error('victoria committed'); return got; };
  cyclopsVictoriaRewards(h.m, h.ps); assert.equal(h.items.length, 2); assert.equal(a.params.rewardPaid, 1); assert.equal(b.params.rewardPaid, 1);
  cyclopsVictoriaRewards(h.m, h.ps); assert.equal(h.items.length, 2); hasError(h, 'victoria committed');
});

test('cyclops chains: failed reward with explicit false preserves entitlement without marking success', () => {
  const h = fixture(), a = gift('cyc_victoria', { rewardStartLayers: 0, rewardPaid: 0 }); h.ps.effects = [a];
  h.ps.acquireItem = () => false; cyclopsVictoriaRewards(h.m, h.ps);
  assert.equal(a.params.rewardPaid, 0); assert.equal(a.params.rewardRound, undefined);
});

test('cyclops chains: settlement income failure cannot suppress later layers, kill growth, merge or dirty', () => {
  const h = fixture(); let dirty = 0, layers = 0;
  const universal = gift('cyc_universal', { bondId: 'yanShip', perRoundLayers: 2, layerMultiplier: 1.5 });
  const kills = gift('cyc_egir', { kills: 0 });
  h.ps.effects = [gift('cyc_economy', { roundIncome: 3 }), universal, kills];
  h.ps.addFunds = n => { h.funds.push(n); throw Error('income committed'); };
  const add = h.ps.addLayers; h.ps.addLayers = function(...args) { layers++; return add.apply(this, args); };
  h.ps.checkItemMerges = () => { throw Error('merge fault'); }; h.ps.dirty = () => { dirty++; };
  settleCyclopsHexes(h.m, h.ps, { cyclopsKills: { cyc_egir: 2 } }, true);
  assert.equal(layers, 1); assert.equal(h.ps.layers.yanShip, 2); assert.equal(kills.params.kills, 2); assert.equal(dirty, 1);
  assert.deepEqual(h.funds, [3]); hasError(h, 'income committed'); hasError(h, 'merge fault');
});

test('cyclops chains: verified preflight layer retry is bounded and failure yields to the next gift', () => {
  const h = fixture(); let attempts = 0;
  h.ps.effects = [gift('cyc_universal', { bondId: 'yanShip', perRoundLayers: 2 }), gift('cyc_economy', { roundIncome: 3 })];
  h.ps.addLayers = (_id, _n, opts) => { attempts++; opts.receipt.stage = 'preflight'; throw Error('layer preflight'); };
  settleCyclopsHexes(h.m, h.ps, {}, true);
  assert.equal(attempts, 2); assert.deepEqual(h.funds, [3]); assert.equal(h.notices.length, 1); assert.equal(h.ps.layers.yanShip, 0);
  hasError(h, 'layer preflight');
});

test('cyclops chains: reforge eligibility and one item update fault cannot block later items or gifts', () => {
  const h = fixture(), bad = { kind: 'item' }, good = { kind: 'item', id: 'it' }, invalid = { kind: 'item', id: 'invalid' };
  Object.defineProperty(bad, 'id', { get() { return 'it'; }, set() { throw Error('reforge update'); } });
  const item = h.ps.gd.item; h.ps.gd.item = id => { if (id === 'invalid') throw Error('reforge record'); return item(id); };
  h.ps.hand = [invalid, bad, good]; h.ps.gd.shopItemsByTier[2] = ['exclusive'];
  h.ps.effects = [gift('cyc_morph', { reforge: true, reforgeLimit: 3, maxTier: 7, upgradeChance: 0 }), gift('cyc_economy', { roundIncome: 2 })];
  settleCyclopsHexes(h.m, h.ps, {}, false);
  assert.equal(good.id, 'exclusive'); assert.deepEqual(h.funds, [2]); hasError(h, 'reforge update'); hasError(h, 'reforge record');
});

test('cyclops chains: copy ignores broken units and reserves an ambiguous item grant without replay', () => {
  const h = fixture(), bad = { kind: 'chess' }; Object.defineProperty(bad, 'items', { get() { throw Error('copy unit'); } });
  h.ps.board.set(1, bad); h.ps.board.set(2, { kind: 'chess', items: [{ id: 'it' }] });
  const copy = gift('cyc_morph', { copyEquipped: true, copyEvery: 1, copyMax: 1, copyGiven: 0, copyRounds: 0, maxTier: 5 });
  h.ps.effects = [copy, gift('cyc_economy', { roundIncome: 2 })];
  h.ps.acquireItem = id => { h.items.push(id); throw Error('copy committed'); };
  settleCyclopsHexes(h.m, h.ps, {}, true); assert.equal(h.items.length, 1); assert.equal(copy.params.copyGiven, 1); assert.deepEqual(h.funds, [2]);
  h.m.round++; settleCyclopsHexes(h.m, h.ps, {}, true); assert.equal(h.items.length, 1); hasError(h, 'copy unit'); hasError(h, 'copy committed');
});
