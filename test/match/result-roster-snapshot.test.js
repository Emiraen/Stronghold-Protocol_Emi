import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, chessOfTier } from './harness.js';
import { buildResult } from '../../server/match/results.js';
import { skinKeyForRecord } from '../../shared/protocol.js';
import { resultSnapshot } from '../../server/match/resultSnapshot.js';
import { buildRecord, fitToBudget, FULL_KEEP, normalizeRecord, selfRowOf } from '../../public/js/ui/stats.js';

test('elimination retains a detached final lineup and skin for result/history while returning every pool copy', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true }).start();
  try {
    h.toPrep(1); const m = h.m, ps = h.ps('p_0');
    const id = chessOfTier(1).find(id => m.pool.has(id));
    const piece = give(m, ps, id);
    const i = ps.hand.indexOf(piece); ps.hand[i] = null; ps.board.set('9,3', piece);
    piece.items = [{ id: 'fixture_item' }];
    const key = skinKeyForRecord(ps.fieldRecord(m.gd.chess(id))); ps.skins = { [key]: 'fixture_skin' };
    const before = resultSnapshot(ps); assert.equal(before.lineup.length, 1);
    const left = m.pool.left(id);
    ps.eliminate(1);
    assert.equal(ps.board.size, 0); assert(ps.hand.every(p => p === null));
    assert.equal(m.pool.left(id), left + 1, 'pool return unchanged');
    piece.items.length = 0;
    assert.deepEqual(ps._resultSnapshot, before, 'snapshot owns its arrays');
    ps.eliminate(1); assert.equal(m.pool.left(id), left + 1, 'repeated elimination does not return twice');
    const result = buildResult(m, { victory: false, hiddenReached: false, hiddenCleared: false, reason: 'defeat' });
    const row = result.players.find(p => p.playerId === ps.playerId);
    assert.deepEqual(row.lineup, before.lineup);
    assert.equal(row.lineup[0].skin, 'fixture_skin');
    const record = buildRecord(result, { myId: ps.playerId, now: Date.now() });
    assert.deepEqual(selfRowOf(normalizeRecord(record)).lineup, before.lineup.map(({row,col,...u}) => u));
  } finally { h.m.dispose(); }
});

test('display snapshot keeps DIY picks, stand-ins and independently copied item IDs', () => {
  const ps = {gd:{ isGolden: () => true, tierOf: () => 6, standIn: () => ({standInFor:'replaced'}), bonds: () => null, bondIds:[] }, board:new Map([['9,3',{kind:'chess',id:'diy',items:[{id:'gear'}]}],['9,4',{kind:'chess',id:'backup',items:[]}]]), bonds:{}, diyPickOf:id => id === 'diy' ? {charId:'char_custom',skillIndex:2,uniEquipId:'mod'} : null, fieldsStandIn:id => id === 'backup', skinFor:()=>'skin'};
  const snap = resultSnapshot(ps);
  assert.deepEqual(snap.lineup[0].diy,{charId:'char_custom',skillIndex:2,uniEquipId:'mod'});
  assert.equal(snap.lineup[1].standInFor,'replaced');
  assert.deepEqual(snap.lineup[0].items,['gear']);
});

test('older best records retain each bond winner roster across compaction and repeat saves', () => {
  const record = (i,layers,bondId='visible') => normalizeRecord({id:'r'+i,t:1000-i,end:'settled',victory:true,selfId:'p',players:[{playerId:'p',alive:true,victory:true,lineup:[{id:'chess',skin:'skin',diy:{charId:'custom',skillIndex:1},standInFor:'base',items:['item']}],bonds:[{bondId,layers,active:true}]}]});
  const records = Array.from({length:FULL_KEEP+3},(_,i)=>record(i,i===FULL_KEEP?100:i===FULL_KEEP+1?999:1,i===FULL_KEEP+1?'hidden':'visible'));
  const kept = fitToBudget(records);
  for (const id of ['r'+FULL_KEEP,'r'+(FULL_KEEP+1)]) {
    const old = kept.find(r=>r.id===id); assert(old.compact); assert.equal(selfRowOf(old).lineup.length,1);
    const again = fitToBudget(kept.map(normalizeRecord)).find(r=>r.id===id);
    assert.deepEqual(selfRowOf(again).lineup,selfRowOf(old).lineup); assert.deepEqual(selfRowOf(again).bonds,selfRowOf(old).bonds);
  }
});
