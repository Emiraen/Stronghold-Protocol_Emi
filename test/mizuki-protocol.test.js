import test from 'node:test';
import assert from 'node:assert/strict';
import { validateC2S } from '../shared/protocol.js';

test('water roguelike automatic party commands have explicit wire schemas', () => {
  for (const message of [
    { t: 'g.mizuki.routeStart' },
    { t: 'g.mizuki.difficulty', grade: 0 },
    { t: 'g.mizuki.difficulty', grade: 18 },
    { t: 'g.mizuki.recallPropose', targetIds: ['p1','p2'] },
    { t: 'g.mizuki.recallVote', requestId: 'recall-1', agree: true },
    { t: 'g.mizuki.recallRespond', requestId: 'recall-1', accept: false },
    { t: 'g.mizuki.splitRequest', nodeId: 'mzgraph:0:1:2' },
    { t: 'g.mizuki.splitDecide', requestId: 'split-1', approve: true },
    { t: 'g.mizuki.splitDecide', requestId: 'split-1', approve: false },
    { t: 'g.mizuki.move', uid: 10001, to: { area: 'board', row: 7, col: 8 }, dir: 'UP' },
    { t: 'g.mizuki.move', uid: 10001, to: { area: 'hand', idx: 9 } },
    { t: 'g.mizuki.move', uid: 10001, to: { area: 'hand' } },
    { t: 'g.mizuki.dismiss', uid: 10001 },
    { t: 'g.mizuki.useItem', itemId: 'rogue_2_pill' },
    { t: 'g.mizuki.useItem', itemId: 'rogue_2_bigpill' },
    { t: 'g.mizuki.bank', action: 'deposit', count: 1 },
    { t: 'g.mizuki.bank', action: 'withdraw', count: 8 },
    { t: 'g.mizuki.bank', action: 'deposit' },
    { t: 'g.mizuki.dismiss', uid: 10001, requestId: 'dismiss-1' },
    { t: 'g.mizuki.equip', itemUid: 100000001, targetUid: 10001, requestId: 'equip-1' },
    { t: 'g.mizuki.equip', itemUid: 100000002, targetUid: 10001, replaceUid: 100000001 },
    { t: 'g.mizuki.equipmentPick', offerId: 'mzeo:0:1', operatorId: 'chess_char_1_02_a' },
    { t: 'g.mizuki.equipmentPick', offerId: 'mzeo:0:2', itemId: 'chess_item_1_01_e_a', requestId: 'pick-1' },
  ]) assert.equal(validateC2S(message), null, JSON.stringify(message));
});

test('water roguelike wire schemas reject malformed approval identifiers and placement payloads', () => {
  for (const message of [
    { t: 'g.mizuki.difficulty', grade: -1 },
    { t: 'g.mizuki.difficulty', grade: 19 },
    { t: 'g.mizuki.difficulty', grade: 1.5 },
    { t: 'g.mizuki.recallPropose', targetIds: [] },
    { t: 'g.mizuki.recallPropose', targetIds: ['p1','p1'] },
    { t: 'g.mizuki.recallPropose', targetIds: ['p0','p1','p2','p3'] },
    { t: 'g.mizuki.recallVote', requestId: 'recall-1', agree: 'yes' },
    { t: 'g.mizuki.recallRespond', requestId: 'recall-1' },
    { t: 'g.mizuki.splitRequest', nodeId: '' },
    { t: 'g.mizuki.splitDecide', requestId: 'split-1', approve: 'yes' },
    { t: 'g.mizuki.splitDecide', approve: true },
    { t: 'g.mizuki.move', uid: 0, to: { area: 'hand' } },
    { t: 'g.mizuki.move', uid: 10001, to: { area: 'board', row: -1, col: 0 } },
    { t: 'g.mizuki.move', uid: 10001, to: { area: 'board', row: 1, col: 99 } },
    { t: 'g.mizuki.move', uid: 10001, to: { area: 'hand', idx: 10 } },
    { t: 'g.mizuki.move', uid: 10001, to: { area: 'temp', idx: 0 } },
    { t: 'g.mizuki.dismiss', uid: '10001' },
    { t: 'g.mizuki.equip', itemUid: '100000001', targetUid: 10001 },
    { t: 'g.mizuki.equip', itemUid: 100000001, targetUid: 0 },
    { t: 'g.mizuki.equip', itemUid: 100000001, targetUid: 10001, replaceUid: -1 },
    { t: 'g.mizuki.equipmentPick', offerId: '', operatorId: 'chess_char_1_02_a' },
    { t: 'g.mizuki.useItem', itemId: 'rogue_2_relic_fight_159' },
    { t: 'g.mizuki.useItem', itemId: null },
    { t: 'g.mizuki.useItem' },
    { t: 'g.mizuki.bank', action: 'put', count: 1 },
    { t: 'g.mizuki.bank', action: 'withdraw', count: 9 },
    { t: 'g.mizuki.bank', action: 'deposit', count: 0 },
  ]) assert.notEqual(validateC2S(message), null, JSON.stringify(message));
});
