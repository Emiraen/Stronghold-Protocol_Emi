import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../../shared/constants.js';
import { DATA, makeMatch, give, giveItem, checkInvariants } from './harness.js';
import { placementContext, equipMerges, dropIntent } from '../../public/js/ui/gameLogic/placement.js';
import { completesMerge } from '../../public/js/ui/gameLogic/shop.js';

const WHITE = 'chess_item_1_02_e_a';
const GOLD = 'chess_item_1_02_e_b';
const OTHER = 'chess_item_1_01_e_a';
const BLOCKED = ['chess_item_5_08_e_a', 'chess_item_6_09_e_a', GOLD];
const PROJECTION = 'chess_item_5_06_e_a';
const GOLD_PROJECTION = 'chess_item_5_06_e_b';

function setup(t, data = DATA) {
  const h = makeMatch({ mode: 'solo', fake: true, data }).start();
  t.after(() => h.m.dispose());
  h.toPrep(1);
  const m = h.m, ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand, ...ps.temp]) if (p?.kind === 'chess') ps.returnCopies(p);
  ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); ps.recompute();
  const carrier = give(m, ps, 'chess_char_1_17_a');
  return { m, ps, carrier };
}
function ctxOf(m, ps) {
  return placementContext({ priv: ps.privateView(), stage: m.stage, editable: true,
    getChess: id => m.gd.chess(id), getItem: id => m.gd.item(id), getToken: id => m.gd.token(id) });
}
function owned(ps) { return JSON.stringify([ps.hand, ps.temp, [...ps.board.values()], ps.stats.itemMerges]); }

test('two normal Doctor projections merge on a full carrier without consuming the other equipment or promoting the carrier', t => {
  const { m, ps, carrier } = setup(t);
  const first = giveItem(m, ps, PROJECTION);
  assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: first.uid, targetUid: carrier.uid }), { ok: true });
  const other = giveItem(m, ps, OTHER);
  m.handle('p_0', { t: 'g.equip', itemUid: other.uid, targetUid: carrier.uid });
  const incoming = giveItem(m, ps, PROJECTION, 'temp');
  const ctx = ctxOf(m, ps);
  assert.equal(equipMerges(ctx, incoming.uid, 2, carrier), true);
  assert.equal(dropIntent(ctx, incoming.uid, { area: 'hand', idx: ps.find(carrier.uid).idx }).confirmReplace, false);
  assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: incoming.uid, targetUid: carrier.uid }), { ok: true });
  assert.equal(m.gd.isGolden(carrier.id), false);
  assert.deepEqual(carrier.items.map(p => p.uid), [other.uid]);
  assert.equal([...ps.hand, ...ps.temp].filter(p => p?.id === GOLD_PROJECTION).length, 1);
  assert.equal(ps.find(first.uid), null);
  assert.equal(ps.find(incoming.uid), null);
  assert.equal(ps.stats.itemMerges, 1);
  checkInvariants(m);
});

test('a normal Doctor projection still refuses an elite carrier and keeps its inventory slot', t => {
  const { m, ps } = setup(t);
  const elite = give(m, ps, m.gd.goldenIdOf('chess_char_1_17_a'));
  const incoming = giveItem(m, ps, PROJECTION);
  const before = owned(ps);
  assert.equal(m.handle('p_0', { t: 'g.equip', itemUid: incoming.uid, targetUid: elite.uid }).error, ERR.BAD_TARGET);
  assert.equal(owned(ps), before);
  checkInvariants(m);
});

test('non-mergeable equipment and golden equipment keep both copies when equipped on the same carrier', t => {
  for (const id of BLOCKED) {
    const { m, ps, carrier } = setup(t);
    const first = giveItem(m, ps, id);
    assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: first.uid, targetUid: carrier.uid }), { ok: true });
    const incoming = giveItem(m, ps, id);
    const ctx = ctxOf(m, ps);
    assert.equal(equipMerges(ctx, incoming.uid, 2, carrier), false, `${id}: client must not announce a merge`);
    assert.equal(completesMerge(ps.privateView(), { kind: 'item', id }, { getItem: ctx.getItem }), false);
    const before = owned(ps);
    assert.equal(ps._mergeItem(id, incoming, { piece: first, area: 'equipped', holder: carrier }), null, `${id}: merge entry must reject it`);
    assert.equal(owned(ps), before, `${id}: rejected merge consumes nothing`);
    assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: incoming.uid, targetUid: carrier.uid }), { ok: true });
    assert.deepEqual(carrier.items.map(p => p.uid), [first.uid, incoming.uid], `${id}: both instances survive`);
    assert.equal(ps.stats.itemMerges, 0);
    checkInvariants(m);
  }
});

test('a full carrier requires replacement confirmation for prohibited or golden pairs, and replaces only the selected item', t => {
  for (const id of BLOCKED) {
    const { m, ps, carrier } = setup(t);
    const first = giveItem(m, ps, id);
    m.handle('p_0', { t: 'g.equip', itemUid: first.uid, targetUid: carrier.uid });
    const other = giveItem(m, ps, OTHER);
    m.handle('p_0', { t: 'g.equip', itemUid: other.uid, targetUid: carrier.uid });
    const incoming = giveItem(m, ps, id), loc = ps.find(carrier.uid), before = owned(ps);
    const intent = dropIntent(ctxOf(m, ps), incoming.uid, { area: 'hand', idx: loc.idx });
    assert.equal(intent.confirmReplace, true, `${id}: must show the replacement choice`);
    assert.equal(owned(ps), before, 'opening/cancelling the client choice does not mutate inventory');
    assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: incoming.uid, targetUid: carrier.uid, replaceUid: other.uid }), { ok: true });
    assert.deepEqual(carrier.items.map(p => p.uid), [first.uid, incoming.uid]);
    assert.equal(ps.find(other.uid), null);
    assert.equal(ps.stats.itemMerges, 0);
    checkInvariants(m);
  }
});

test('eligible normal pair on the target still merges into one advanced item without destroying the other equipped item', t => {
  const { m, ps, carrier } = setup(t);
  const first = giveItem(m, ps, WHITE);
  m.handle('p_0', { t: 'g.equip', itemUid: first.uid, targetUid: carrier.uid });
  const other = giveItem(m, ps, OTHER);
  m.handle('p_0', { t: 'g.equip', itemUid: other.uid, targetUid: carrier.uid });
  const incoming = giveItem(m, ps, WHITE), ctx = ctxOf(m, ps);
  assert.equal(equipMerges(ctx, incoming.uid, 2, carrier), true);
  assert.equal(dropIntent(ctx, incoming.uid, { area: 'hand', idx: ps.find(carrier.uid).idx }).confirmReplace, false);
  assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: incoming.uid, targetUid: carrier.uid }), { ok: true });
  assert.deepEqual(carrier.items.map(p => p.uid), [other.uid]);
  assert.equal([...ps.hand, ...ps.temp].filter(p => p?.id === GOLD).length, 1);
  assert.equal(ps.find(first.uid), null); assert.equal(ps.find(incoming.uid), null);
  assert.equal(ps.stats.itemMerges, 1);
  checkInvariants(m);
});

test('loose eligible copies still auto-merge, but buying does not count an item equipped on another carrier', t => {
  const { m, ps, carrier } = setup(t);
  const equipped = giveItem(m, ps, WHITE);
  m.handle('p_0', { t: 'g.equip', itemUid: equipped.uid, targetUid: carrier.uid });
  const getItem = id => m.gd.item(id);
  assert.equal(completesMerge(ps.privateView(), { kind: 'item', id: WHITE }, { getItem }), false, 'East shop merges only loose copies');
  const loose = ps.acquireItem(WHITE);
  assert.equal(loose.id, WHITE); assert.ok(ps.find(equipped.uid));
  assert.equal(completesMerge(ps.privateView(), { kind: 'item', id: WHITE }, { getItem }), true);
  const result = ps.acquireItem(WHITE);
  assert.equal(result.id, GOLD); assert.equal(ps.find(loose.uid), null);
  assert.equal(carrier.items[0].uid, equipped.uid, 'other equipped copy stays on its carrier');
  assert.equal(ps.stats.itemMerges, 1);
  ps.acquireItem(WHITE);
  const before = owned(ps);
  m.itemPool.canGain = id => id !== GOLD;
  assert.equal(ps.acquireItem(WHITE), null, 'a refused upgrade grant does not consume the owned loose copy');
  assert.equal(owned(ps), before);
  checkInvariants(m);
});

test('the target pair does not override a recipe requiring three copies', t => {
  const data = { ...DATA, items: { ...DATA.items, [WHITE]: { ...DATA.items[WHITE], upgradeNum: 3 } } };
  const { m, ps, carrier } = setup(t, data);
  const first = giveItem(m, ps, WHITE);
  m.handle('p_0', { t: 'g.equip', itemUid: first.uid, targetUid: carrier.uid });
  const incoming = giveItem(m, ps, WHITE);
  assert.equal(equipMerges(ctxOf(m, ps), incoming.uid, 2, carrier), false);
  assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: incoming.uid, targetUid: carrier.uid }), { ok: true });
  assert.deepEqual(carrier.items.map(p => p.uid), [first.uid, incoming.uid]);
  assert.equal(ps.stats.itemMerges, 0);
});

test('a failed target merge restores both original instances and reports failure without consuming or replacing equipment', t => {
  for (const area of ['target', 'loose']) for (const cause of ['pool', 'storage']) for (const incomingArea of ['hand', 'temp']) {
    const { m, ps, carrier } = setup(t);
    const first = giveItem(m, ps, WHITE);
    if (area === 'target') {
      m.handle('p_0', { t: 'g.equip', itemUid: first.uid, targetUid: carrier.uid });
      const other = giveItem(m, ps, OTHER);
      m.handle('p_0', { t: 'g.equip', itemUid: other.uid, targetUid: carrier.uid });
    }
    const incoming = giveItem(m, ps, WHITE, incomingArea), before = owned(ps);
    if (cause === 'pool') m.itemPool.canGain = () => false;
    else ps.stow = () => false;
    const result = m.handle('p_0', { t: 'g.equip', itemUid: incoming.uid, targetUid: carrier.uid });
    assert.equal(result.error, ERR.BAD_TARGET, `${area}/${cause}/${incomingArea}`);
    assert.equal(owned(ps), before, `${area}/${cause}/${incomingArea}: original inventory slots, equipped order, and counts preserved`);
    assert.equal(ps.stats.itemMerges, 0);
  }
});
