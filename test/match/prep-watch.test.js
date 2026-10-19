// GitHub #87: watching another board during prep follows its moves. A spectator uses the same prep scout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch, give, legalTileFor, chessOfTier } from './harness.js';

const MELEE = (c) => c.position === 'MELEE' && c.profession === 'TANK';

test('#87 prep watch: seat B moves during prep and seat A\'s view of B changes before combat; a spectator does too', () => {
  const S = 's_spec';
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 8701, fake: true, spectators: [S] }).start();
  h.toPrep(1);
  const m = h.m;
  assert.deepEqual(m.addObserver(S), { ok: true });
  assert.equal(m.phase, PHASE.PREP);
  const b = h.ps('p_1');
  assert.deepEqual(m.handle('p_1', { t: 'g.ready', ready: false }), { ok: true });
  for (const p of [...b.board.values(), ...b.hand.filter(Boolean), ...b.temp.filter(Boolean)]) {
    if (p.kind === 'chess') b.returnCopies(p);
  }
  b.board.clear();
  b.hand.fill(null);
  b.temp.fill(null);
  b.recompute();
  const id = chessOfTier(1, MELEE).find((x) => m.pool.has(x));
  const piece = give(m, b, id);
  assert.deepEqual(m.handle('p_0', { t: 'g.watch', fieldId: 'n:p_1' }), { ok: true });
  assert.deepEqual(m.watchObserver(S, 'n:p_1'), { ok: true });
  assert.ok(m.handle(S, { t: 'g.buy', slot: 0 }).error, '外部观众不能作为玩家操作');
  assert.equal(m.watchers.get('p_0'), 'n:p_1');
  assert.equal(m.watchers.get(S), 'n:p_1');
  for (const pid of ['p_0', S]) {
    const first = h.lastTo(pid, 'm.field');
    assert.equal(first.fieldId, 'n:p_1');
    assert.equal(first.prep, true);
    assert.equal(first.units.some((u) => u.uid === piece.uid), false, `${pid}: the piece is still in the hand`);
  }
  assert.equal(h.allTo(S, 'm.private').length, 0);
  const beforeA = h.allTo('p_0', 'm.field').length;
  const beforeS = h.allTo(S, 'm.field').length;
  const [r, c] = legalTileFor(m, b, id);
  assert.deepEqual(m.handle('p_1', { t: 'g.move', uid: piece.uid, to: { area: 'board', row: r, col: c }, dir: 'LEFT' }), { ok: true });
  assert.equal(m.phase, PHASE.PREP, 'still prep — the update did not wait for combat');
  for (const [pid, before] of [['p_0', beforeA], [S, beforeS]]) {
    const fields = h.allTo(pid, 'm.field');
    assert.equal(fields.length, before + 1, `${pid}: one new board`);
    const last = fields.at(-1);
    const u = last.units.find((x) => x.uid === piece.uid);
    assert.ok(u, `${pid}: the moved piece is on the watched board`);
    assert.deepEqual([u.x, u.y, u.dir], [c, r, 'LEFT']);
  }
  const n = h.allTo('p_0', 'm.field').length;
  assert.deepEqual(m.handle('p_1', { t: 'g.freeze' }), { ok: true });
  assert.equal(h.allTo('p_0', 'm.field').length, n, 'a shop toggle is not a board change');
  assert.equal(h.allTo(S, 'm.private').length, 0);
  const counts = ['p_0', S].map((pid) => h.allTo(pid, 'm.field').length);
  b.funds += 10; m.markPrivate(b); m.flush();
  for (const [i, pid] of ['p_0', S].entries()) assert.equal(h.allTo(pid, 'm.field').length, counts[i], '资金变化不推送棋盘');
  piece.dir = 'RIGHT'; m.markPrivate(b); m.flush();
  for (const [i, pid] of ['p_0', S].entries()) assert.equal(h.allTo(pid, 'm.field').length, counts[i] + 1, '朝向变化仅推送一次');
  b.board.clear(); m.markPrivate(b); m.flush();
  for (const pid of ['p_0', S]) assert.deepEqual(h.lastTo(pid, 'm.field').units, [], '清空棋盘也推送');
  m.removeObserver(S);
  assert.equal(m.watchers.has(S), false);
  assert.deepEqual(m.addObserver(S), { ok: true });
  assert.equal(m.watchers.has(S), true, '重连重新订阅');
  b.eliminate(1); m.markPublic(); m.flush(true);
  assert.notEqual(m.watchers.get(S), 'n:p_1', '淘汰后不残留无效目标');
  m.dispose();
  assert.equal(m.watchers.size, 0);
  assert.equal(m.observers.size, 0);
});

test('Emi 外部战斗副本裁剪资金而不污染 authority spec，换阶段和重发仍只读', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 8702, fake: true }).start();
  const m = h.m;
  m.addObserver('external');
  const original = { players: [{ playerId: 'p_0', contentInfo: { funds: 88, handUnits: 2, roundStats: { gainedChess: 3 } } }] };
  const f = { fieldId: 'n:p_0', battleId: 'test', kind: 'normal', players: ['p_0'], spec: original, cc: true, mode: 'client', authority: 'p_0', startAt: m.sched.now() };
  m.fields = [f]; m.phase = PHASE.COMBAT;
  m.refreshObserver('external', true);
  const msg = h.lastTo('external', 'b.start');
  assert.equal(msg.authoritative, false);
  assert.equal(msg.watch, true);
  assert.equal(Object.hasOwn(msg.spec.players[0].contentInfo, 'funds'), false);
  assert.equal(original.players[0].contentInfo.funds, 88);
  assert.equal(msg.spec.players[0].contentInfo.handUnits, 2);
  assert.deepEqual(msg.spec.players[0].contentInfo.roundStats, { gainedChess: 3 });
  assert.equal(m._startMsg(f, 'p_0').spec, original);
  f.kind = 'unite'; f.fieldId = 'u'; f.battleId = 'unite'; m.phase = PHASE.UNITE;
  m.refreshObserver('external');
  assert.equal(m.watchers.get('external'), 'u');
  assert.equal(m._sendStart('external', f, { watch: true }), true);
  assert.equal(h.lastTo('external', 'b.start').authoritative, false);
  m.finish({ victory: false, reason: 'defeat' });
  assert.equal(h.allTo('external', 'm.result').length, 0);
  assert.equal(m.observers.size, 0);
  m.dispose();
});
