import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MatchSpDraft } from '../../server/match/match/spDraft.js';
import { weightedPick } from '../../server/match/waves.js';
import { makeMatch, DATA } from './harness.js';

function fixture(seed = 17) {
  let value = seed >>> 0, draws = 0;
  const rng = () => { draws++; value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
  const recs = { a: { tier: 1, bonds: ['bond'] }, b: { tier: 2, bonds: ['bond'] }, c: { tier: 3, bonds: [] }, ga: { tier: 1, bonds: ['bond'] }, gb: { tier: 2, bonds: ['bond'] } };
  const pools = { weighted: { kind: 'equip', weighted: [['a', 1], ['b', 3], ['c', 2]] }, listed: { kind: 'equip', items: ['a', 'b', 'c'] }, tiers: { kind: 'equip', tiers: [1, 2] }, level: { kind: 'equip', maxTier: 'shopLevel' }, chess: { kind: 'chess', items: ['a', 'b', 'c'] }, chessWeighted: { kind: 'chess', weighted: [['a', 1], ['b', 3], ['c', 2]] }, chessStock: { kind: 'chess', maxTier: 3 }, gold: { kind: 'chess', items: ['a', 'b'], golden: true }, bad: { kind: 'unknown' }, empty: { kind: 'equip', tiers: [6] } };
  const seen = [];
  const f = { gd: { choices: { pools }, shopItemsByTier: { 1: ['a'], 2: ['b'], 3: ['c'] }, item: id => recs[id], chess: id => recs[id], baseIdOf: id => id, goldenIdOf: id => ({ a: 'ga', b: 'gb' })[id] }, rngMeta: rng, bannedChess: [], itemPool: { canGain: id => !!recs[id], pick(r, ids, weights) { const good = ids.filter(id => recs[id]); seen.push({ ids: [...good], weights: weights ? [...weights] : null }); if (!good.length) return null; return weights ? weightedPick(r, good.map(id => [id, weights.get(id)])) : good[Math.floor(r() * good.length)]; } }, poolFor() { return { has: () => false, left: () => 20, roll(r, { filter, maxTier }) { const ids = ['a', 'b', 'c'].filter(id => recs[id].tier <= maxTier && filter(id, recs[id])); return ids.length ? ids[Math.floor(r() * ids.length)] : null; } }; }, rollItemId: MatchSpDraft.prototype.rollItemId, rollPool: MatchSpDraft.prototype.rollPool };
  return { f, seen, draws: () => draws };
}

test('pool exclusions: forwarded through rollPool for every equipment schema and fallback', () => {
  for (const pool of ['weighted', 'listed', 'tiers', 'level']) {
    const { f, seen } = fixture();
    for (let i = 0; i < 50; i++) assert.notEqual(f.rollPool(pool, { shopLevel: 3, exclude: ['b'] })?.id, 'b');
    assert.ok(seen.every(x => !x.ids.includes('b')));
  }
  for (const options of [{ tier: 2 }, { maxTier: 3 }]) {
    const { f, seen } = fixture(); f.rollItemId({ ...options, exclude: ['b'] }); assert.ok(seen.every(x => !x.ids.includes('b')));
  }
});

test('pool exclusions: weighted, listed and stock chess reject base and resulting golden ids', () => {
  for (const pool of ['chess', 'chessWeighted', 'chessStock']) { const { f } = fixture(); for (let i = 0; i < 50; i++) assert.notEqual(f.rollPool(pool, { exclude: ['b'] })?.id, 'b'); }
  const { f } = fixture(); assert.deepEqual(f.rollPool('gold', { exclude: ['ga'] }), { kind: 'chess', id: 'gb', golden: true });
  assert.equal(f.rollPool('gold', { exclude: ['a', 'gb'] }), null);
});

test('pool exclusions: fully excluded, bad and empty pools return null without extra retries', () => {
  for (const pool of ['weighted', 'listed', 'tiers', 'level', 'chess', 'chessWeighted', 'chessStock']) { const { f, draws } = fixture(); assert.equal(f.rollPool(pool, { exclude: ['a', 'b', 'c'] }), null, pool); assert.equal(draws(), 0, pool); }
  const { f } = fixture(); for (const id of ['missing', 'bad', 'empty', '__proto__']) assert.equal(f.rollPool(id), null);
});

test('pool exclusions: absent, empty and malformed exclusions preserve sequences and RNG counts', () => {
  for (const pool of ['weighted', 'listed', 'tiers', 'level', 'chess', 'chessWeighted', 'chessStock', 'gold']) {
    const a=fixture(), expected=Array.from({length:40},()=>a.f.rollPool(pool,{shopLevel:3}));
    for (const exclude of [[], null, 'b', {}, [null, 42]]) { const b=fixture(); assert.deepEqual(Array.from({length:40},()=>b.f.rollPool(pool,{shopLevel:3,exclude})),expected,pool); assert.equal(b.draws(),a.draws(),pool); assert.deepEqual(b.seen,a.seen,pool); }
  }
});

test('pool exclusions: no-exclude behavior matches the pre-change implementation', () => {
  const source=readFileSync(new URL('../../server/match/match/spDraft.js',import.meta.url),'utf8');
  assert.ok(source.includes('exclude = []'));
  const a=fixture(), b=fixture();
  for(const pool of ['weighted','listed','tiers','level']){
    const p=b.f.gd.choices.pools[pool];
    for(let i=0;i<20;i++){let expected;if(p.weighted){const pairs=p.weighted.filter(x=>Array.isArray(x)&&b.f.gd.item(x[0])&&b.f.itemPool.canGain(x[0]));expected=b.f.itemPool.pick(b.f.rngMeta,pairs.map(x=>x[0]),new Map(pairs));}else if(p.items)expected=b.f.itemPool.pick(b.f.rngMeta,p.items.filter(id=>b.f.gd.item(id)));else{const ids=p.tiers?p.tiers.flatMap(t=>b.f.gd.shopItemsByTier[t]||[]):['a','b','c'];expected=b.f.itemPool.pick(b.f.rngMeta,ids);}assert.equal(a.f.rollItemId({pool,shopLevel:3}),expected);}
  }
  assert.equal(a.draws(),b.draws());assert.deepEqual(a.seen,b.seen);
});

test('pool exclusions: Cathy never reoffers an already taken cell and keeps three distinct choices', () => {
  const h=makeMatch({mode:'solo',humans:1,seed:12,fake:true}).start();
  try{h.toPrep(1);const ps=h.ps('p_0');ps.bandId='band_cathy';ps.counters['band:cathy:cellTaken']=1;ps.offers.length=0;ps.shop.level=5;const cell='chess_item_5_08_e_a',others=Object.values(DATA.items).filter(x=>!x.isGolden&&x.itemType==='EQUIP'&&x.id!==cell).map(x=>x.chessId||x.id).filter(Boolean).slice(0,3);assert.equal(others.length,3);const original=h.m.gd.choices;Object.defineProperty(h.m.gd,'choices',{configurable:true,value:{...original,pools:{...original.pools,pool_equip_kathe:{kind:'equip',items:[cell,...others]}}}});h.m.dispatch(ps,'onLevelUp',{level:6});const ids=ps.offers[0].slots.map(x=>x.id);assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);assert.ok(!ids.includes(cell));delete h.m.gd.choices;}finally{h.m.dispose();h.sched.dispose();}
});
