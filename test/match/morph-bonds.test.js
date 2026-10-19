// 变形同构体 and the bond member count on the real match paths (player report after 0.1.0: "缪尔赛思的变形同构体配上对应
// 职业转职的装备能使装备的干员吃到对应盟约的加成，但是那个盟约的人口数量没有把转职之后的干员算进去").
// Official rule: band 变形者集群 "与特定装备一同装备时装备者将视为特定盟约成员"; the item's talent (character_table
// trap_1073_acarm073) lists the 14 pairings ("“维式重锤”系列装备→【维多利亚】盟约" …); 缪尔赛思's 特质 garrison_76
// "<获得时>获得1个“变形同构体”". The wearer is a member: it counts for the bond's activation like any member — on the
// board only for these BOARD bonds, once per operator (distinct members, normal and elite alike).
// The server already counted it (prep, battle input, views, the battle); what the player saw was the client's bond
// popup and card (test/ui/morph-bonds.test.js). This suite pins the count on every path, and the item ids the
// client now gets with a teammate's units (prep scouting UnitInfo, the battle's UnitInfo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, giveItem, DATA, legalTileFor } from './harness.js';
import { unitBonds, isMember, bondActive } from '../../server/sim/content/support/index.js';
import { unitInfo } from '../../server/sim/snapshot.js';
import { generateDraft, applyCard } from '../../server/match/choices.js';
import { createRng } from '../../server/sim/rng.js';

const ISO = 'chess_item_6_09_e_a';
const ISO_B = 'chess_item_6_09_e_b';
const HAMMER = 'chess_item_1_01_e_a';
const GRANTS = Object.values(DATA.items).filter((r) => r.giveBondId).map((r) => r.id).sort();

/** A target chess outside `bond` (and not 调和: its +1 would blur the count). */
const outsider = (bond) => Object.values(DATA.chess).find((c) => c.visible && !c.isGolden && c.tier <= 2 && !c.bonds.includes(bond) && !c.bonds.includes('maniShip')).chessId;
const members = (bond) => Object.values(DATA.chess).filter((c) => c.visible && !c.isGolden && c.bonds.includes(bond) && !c.bonds.includes('maniShip')).map((c) => c.chessId).sort();

/** PREP R1 of a real match (all 23 bonds: 绝境), the player's pieces cleared. */
function prep({ mode = 'solo', difficulty = 'HARD', humans = 1, fake = false, seed = 21 } = {}) {
  const h = makeMatch({ mode, difficulty, humans, seed, fake }).start();
  h.toPrep(1);
  for (const ps of h.m.players.values()) {
    for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
    ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); ps.offers.length = 0;
    ps.funds = 50; ps.bandId = null;
    ps.recompute();
  }
  return h;
}
const ok = (r) => assert.deepEqual(r, { ok: true });
/** A chess with `items` (equipped through g.equip, in this order), from the hand, then onto the board when `board`. */
function wearer(h, pid, chessId, itemIds, { board = true } = {}) {
  const { m } = h; const ps = h.ps(pid);
  const p = give(m, ps, chessId, 'hand');
  for (const id of itemIds) ok(m.handle(pid, { t: 'g.equip', itemUid: giveItem(m, ps, id).uid, targetUid: p.uid }));
  if (board) {
    const at = legalTileFor(m, ps, chessId);
    ok(m.handle(pid, { t: 'g.move', uid: p.uid, to: { area: 'board', row: at[0], col: at[1] } }));
  }
  return p;
}
const place = (h, pid, chessId) => {
  const { m } = h; const ps = h.ps(pid);
  const p = give(m, ps, chessId, 'hand');
  const at = legalTileFor(m, ps, chessId);
  ok(m.handle(pid, { t: 'g.move', uid: p.uid, to: { area: 'board', row: at[0], col: at[1] } }));
  return p;
};
const count = (ps, bond) => ps.bonds[bond]?.count ?? 0;

test('缪尔赛思 hands out 变形同构体 on purchase (garrison_76), the bought copy pairs with any bond item', () => {
  const h = prep();
  const { m } = h; const ps = h.ps('p_0');
  ps.shop.slots[0] = { kind: 'chess', id: 'chess_char_6_11_a', price: 6, basePrice: 6, sold: false, frozen: false };
  ok(m.handle('p_0', { t: 'g.buy', slot: 0 }));
  const iso = ps.hand.find((p) => p && p.id === ISO);
  assert.ok(iso, 'the 变形同构体 is in the hand');
  const t = give(m, ps, outsider('victoriaShip'), 'hand');
  ok(m.handle('p_0', { t: 'g.equip', itemUid: iso.uid, targetUid: t.uid }));
  ok(m.handle('p_0', { t: 'g.equip', itemUid: giveItem(m, ps, HAMMER).uid, targetUid: t.uid }));
  assert.equal(count(ps, 'victoriaShip'), 0, 'on the bench: BOARD bonds count the board only');
  const at = legalTileFor(m, ps, t.id);
  ok(m.handle('p_0', { t: 'g.move', uid: t.uid, to: { area: 'board', row: at[0], col: at[1] } }));
  assert.equal(count(ps, 'victoriaShip'), 1);
  h.invariants();
});

test('every pairing (18 bond items × normal / golden, both 变形同构体): the wearer counts in prep, in the views, in the battle input and in the real battle', () => {
  const grants = Object.values(DATA.items).filter((r) => r.giveBondId);
  assert.equal(grants.length, 36);
  assert.equal(new Set(grants.map((r) => r.giveBondId)).size, 14, '14 bonds have a bond item (the official talent\'s list)');
  for (const r of grants) {
    const bond = r.giveBondId;
    const iso = r.isGolden ? ISO_B : ISO; // golden bond items with the golden 变形同构体, normal with normal
    const h = prep({ seed: 31 });
    const { m } = h; const ps = h.ps('p_0');
    const [a, b] = members(bond);
    place(h, 'p_0', a); place(h, 'p_0', b);
    assert.equal(count(ps, bond), 2, `${bond}: two members`);
    // the bond item first, then the 变形同构体 (the other order: the next test)
    const w = wearer(h, 'p_0', outsider(bond), [r.id, iso]);
    assert.equal(count(ps, bond), 3, `${r.id}: the wearer is the third member`);
    assert.equal(ps.bonds[bond].active, true, `${r.id}: the threshold of 3 (2 for add-on bonds) is reached with it`);
    assert.equal(ps.battleInput().bonds[bond].count, 3, `${r.id}: battle input`);
    assert.equal(ps.privateView().bonds.find((x) => x.bondId === bond).count, 3, `${r.id}: m.private`);
    let battle = null;
    const orig = m.newBattle.bind(m);
    m.newBattle = (o) => { const bt = orig(o); battle ??= bt; return bt; };
    assert.ok(h.drive(() => battle != null), 'combat starts');
    assert.equal(battle.getPlayer('p_0').bonds[bond].count, 3, `${r.id}: the battle's count`);
    const u = battle.allyUnits.find((x) => x.kind === 'op' && x.uid === w.uid);
    assert.ok(unitBonds(u).includes(bond) && isMember(battle, u, bond), `${r.id}: the battle's member`);
  }
});

test('bench vs board, half pairs, two 变形同构体, the equip order, distinct members', () => {
  const h = prep({ fake: true });
  const { m } = h; const ps = h.ps('p_0');
  const bond = 'victoriaShip';
  const target = outsider(bond);
  // half pairs grant nothing
  wearer(h, 'p_0', target, [HAMMER]);
  assert.equal(count(ps, bond), 0, 'the bond item alone');
  const h2 = prep({ fake: true });
  wearer(h2, 'p_0', target, [ISO]);
  const other = Object.values(DATA.chess).find((c) => c.visible && !c.isGolden && c.tier <= 2 && !c.bonds.includes(bond) && c.chessId !== target).chessId;
  wearer(h2, 'p_0', other, [ISO, ISO_B]);
  assert.equal(count(h2.ps('p_0'), bond), 0, '变形同构体 alone / two of them');
  // order: 变形同构体 first
  const h3 = prep({ fake: true });
  const w = wearer(h3, 'p_0', target, [ISO, HAMMER], { board: false });
  assert.equal(count(h3.ps('p_0'), bond), 0, 'the pair on the bench');
  const at = legalTileFor(h3.m, h3.ps('p_0'), target);
  ok(h3.m.handle('p_0', { t: 'g.move', uid: w.uid, to: { area: 'board', row: at[0], col: at[1] } }));
  assert.equal(count(h3.ps('p_0'), bond), 1, 'deployed');
  ok(h3.m.handle('p_0', { t: 'g.move', uid: w.uid, to: { area: 'hand', idx: 9 } }));
  assert.equal(count(h3.ps('p_0'), bond), 0, 'back to the bench');
  // distinct members: two converted copies of one operator, or a converted copy beside a plain one, are one member
  const h4 = prep({ fake: true });
  const ps4 = h4.ps('p_0');
  wearer(h4, 'p_0', target, [ISO, HAMMER]);
  const plain = place(h4, 'p_0', target); // (a third copy would merge into the elite, the items back to the hand)
  assert.equal(count(ps4, bond), 1, 'converted + plain copy: one member');
  // (another 维式重锤 would merge with the equipped one into the golden hammer: the 战栗 one of the series)
  for (const id of [ISO_B, 'chess_item_2_03_e_a']) ok(h4.m.handle('p_0', { t: 'g.equip', itemUid: giveItem(h4.m, ps4, id).uid, targetUid: plain.uid }));
  assert.equal(plain.items.length, 2);
  assert.equal(count(ps4, bond), 1, 'two converted copies: one member');
  // and it never doubles a real member: a member wearing the pair still counts once
  const h5 = prep({ fake: true });
  wearer(h5, 'p_0', members(bond)[0], [ISO, HAMMER]);
  assert.equal(count(h5.ps('p_0'), bond), 1);
  for (const x of [h, h2, h3, h4, h5]) x.invariants();
});

test('随机 ban 的维多利亚仍通过合法原生干员和真实装备转职激活，档位、层数与实战效果正确', () => {
  for (const n of [3, 6]) {
    const h = prep({ seed: 1 });
    const { m } = h; const ps = h.ps('p_0');
    try {
      const bond = 'victoriaShip';
      assert.ok(m.disabledBonds.includes(bond), '真实随机 ban 命中维多利亚');
      const native = members(bond).filter((id) => m.pool.has(id));
      const outsiders = [...m.pool.entries.keys()].filter((id) => !m.gd.chess(id).bonds.includes(bond) && !m.gd.chess(id).bonds.includes('maniShip'));
      const k = n === 3 ? 2 : 4;
      assert.ok(native.length >= k && outsiders.length >= 2);
      for (const id of native.slice(0, k)) place(h, 'p_0', id);
      assert.equal(ps.bonds[bond].count, k);
      const w = wearer(h, 'p_0', outsiders[0], [ISO, HAMMER]);
      if (n === 6) wearer(h, 'p_0', outsiders[1], [ISO_B, 'chess_item_1_01_e_b']);
      ps.addLayers(bond, 30);
      assert.deepEqual(ps.bonds[bond], { count: n, active: true, tier: n === 3 ? 1 : 2, layers: 30 });
      assert.deepEqual(ps.battleInput().bonds[bond], ps.bonds[bond]);
      for (const view of [ps.privateView(), m.publicView().players.find((p) => p.playerId === ps.playerId)]) {
        const b = view.bonds.find((x) => x.bondId === bond);
        assert.equal(b.count, n); assert.equal(b.active, true); assert.equal(b.layers, 30);
      }
      const battle = m._normalBattle(ps);
      battle.start(); battle.step();
      const u = battle.allyUnits.find((x) => x.uid === w.uid && x.kind === 'op');
      assert.ok(unitBonds(u).includes(bond) && isMember(battle, u, bond));
      const buff = () => u.buffs.find((b) => b.key === 'bond:victoria');
      assert.ok(Math.abs(buff().mods.dmgDealtMul - (1.25 + 0.008 * 30)) < 1e-9, '转职干员获得正确伤害倍率');
      assert.equal(u.buffs.find((b) => b.key === 'bond:victoria:atk')?.mods.atkPct ?? 0, n === 6 ? 1 : 0, '6人口时两件普通装备增加100%攻击力');
      battle.addLayers(ps.playerId, bond, 10, 'test');
      battle.step(); battle.step();
      assert.equal(battle.getPlayer(ps.playerId).bonds[bond].layers, 40);
      assert.ok(Math.abs(buff().mods.dmgDealtMul - (1.25 + 0.008 * 40)) < 1e-9, '实战叠层刷新伤害倍率');
      assert.deepEqual(battle.errors, []);
      h.invariants();
    } finally { m.dispose(); }
  }
});

test('随机 ban 盟约没有任何原生干员入池时，仅靠真实装备转职仍激活并产生效果', () => {
  const h = prep({ seed: 1 });
  const { m } = h; const ps = h.ps('p_0');
  try {
    const bond = 'victoriaShip';
    assert.ok(m.disabledBonds.includes(bond));
    for (const id of [...m.pool.entries.keys()]) if (m.gd.chess(id).bonds.includes(bond)) m.pool.entries.delete(id);
    assert.equal(m.bondInPool(bond), false);
    assert.equal(m.bondLive(bond), true);
    const outsiders = [...m.pool.entries.keys()].filter((id) => !m.gd.chess(id).bonds.includes('maniShip')).slice(0, 3);
    assert.equal(outsiders.length, 3);
    const pairs = [[ISO, HAMMER], [ISO_B, 'chess_item_1_01_e_b'], [ISO_B, 'chess_item_2_03_e_a']];
    const ws = outsiders.map((id, i) => wearer(h, 'p_0', id, pairs[i]));
    const oath = DATA.choices.cards.tactic.find((c) => DATA.effects[c.effectId].buffs.some((b) => b.key === 'global_special_choice_bond_addlayer' && String(b.bbStr?.bond_list).split(',').includes(bond)));
    assert.ok(oath, '真实数据存在维多利亚盟誓卡');
    const gain = DATA.effects[oath.effectId].buffs.find((b) => b.key === 'global_special_choice_bond_addlayer').bb.count;
    applyCard(m, ps, { kind: 'tactic', id: oath.effectId });
    assert.equal(ps.bonds[bond].layers, gain, '没有原生干员入池，实际盟誓选卡处理仍向转职盟约叠层');
    ps.addLayers(bond, 30 - gain);
    assert.deepEqual(ps.bonds[bond], { count: 3, active: true, tier: 1, layers: 30 });
    const battle = m._normalBattle(ps);
    battle.start(); battle.step();
    for (const w of ws) {
      const u = battle.allyUnits.find((x) => x.uid === w.uid && x.kind === 'op');
      assert.ok(isMember(battle, u, bond));
      assert.equal(u.buffs.find((b) => b.key === 'bond:victoria')?.mods.dmgDealtMul, 1.49);
    }
    assert.deepEqual(battle.errors, []);
    h.invariants();
  } finally { m.dispose(); }
});

test('随机 ban 不过滤盟约装备商店、选卡与奖励池；转职不绕过模式静态关闭', () => {
  const h = prep({ seed: 1 });
  try {
    const { m } = h;
    assert.ok(m.disabledBonds.includes('victoriaShip'));
    assert.ok(m.gd.shopItemsByTier[1].includes(HAMMER));
    const seen = new Set(); const shopSeen = new Set(); const cardSeen = new Set();
    for (let n = 0; n < 500; n++) {
      seen.add(m.rollItemId({ tier: 1 }));
      shopSeen.add(m.pool.rollItem(m.rngShop, 1));
      const r = m.rollPool('pool_equip_vict');
      assert.ok(r && DATA.items[r.id].giveBondId === 'victoriaShip');
      for (const round of [3, 11]) {
        const d = generateDraft(m.gd, createRng(n + round * 1000), round, { bondAvailable: (b) => m.bondLive(b) });
        for (const c of d?.cards || []) if (c.kind === 'item') cardSeen.add(c.id);
      }
    }
    assert.ok(seen.has(HAMMER) && shopSeen.has(HAMMER), '被 ban 盟约的转职装备仍能从随机奖励和普通商店抽取');
    assert.ok(cardSeen.has(ISO), '机密商店仍能选到变形同构体');
    assert.ok([...cardSeen].some((id) => m.disabledBonds.includes(DATA.items[id]?.giveBondId)), '机变装备卡仍包含随机 ban 盟约的转职装备');
  } finally { h.m.dispose(); }
  const funny = prep({ difficulty: 'FUNNY', seed: 1 });
  try {
    const bond = 'arcaneShip';
    const targets = [...funny.m.pool.entries.keys()].filter((id) => !DATA.chess[id].bonds.includes(bond) && !DATA.chess[id].bonds.includes('maniShip')).slice(0, 3);
    assert.equal(targets.length, 3, '转职人数足以达到奥术最高档，不能仅因人数不足而未激活');
    const ws = targets.map((id, i) => wearer(funny, 'p_0', id, [i ? ISO_B : ISO, `chess_item_3_08_e_${i ? 'b' : 'a'}`]));
    const w = ws[0];
    const ps = funny.ps('p_0');
    ps.addLayers(bond, 30);
    assert.ok(funny.m.gd.modeInactiveBonds.has(bond));
    assert.equal(funny.m.bondLive(bond), false);
    assert.equal(ps.bonds[bond], undefined);
    assert.equal(ps.battleInput().bonds[bond], undefined);
    const battle = funny.m._normalBattle(ps);
    battle.start(); battle.step();
    assert.equal(battle.getPlayer(ps.playerId).bonds[bond], undefined);
    const u = battle.allyUnits.find((x) => x.uid === w.uid && x.kind === 'op');
    assert.ok(unitBonds(u).includes(bond), '转职成员身份保留');
    assert.equal(bondActive(battle, ps.playerId, bond), false, '成员身份不代表静态关闭的盟约能激活');
    assert.ok(!u.buffs.some((b) => b.key === 'bond:arcaneShip'), '静态关闭盟约不产生奥术加成');
    assert.deepEqual(battle.errors, []);
    funny.invariants();
  } finally { funny.m.dispose(); }
});

test('a teammate\'s views: m.public counts the wearer; the scouting UnitInfo and the battle\'s UnitInfo carry the items', () => {
  const h = prep({ mode: 'coop', humans: 2, seed: 41 });
  const { m } = h;
  const ps = h.ps('p_0');
  const bond = 'victoriaShip';
  const [a, b] = members(bond);
  place(h, 'p_0', a); place(h, 'p_0', b);
  const w = wearer(h, 'p_0', outsider(bond), [ISO, HAMMER]);
  const pub = m.publicView().players.find((p) => p.playerId === 'p_0');
  assert.equal(pub.bonds.find((x) => x.bondId === bond).count, 3, 'm.public players[].bonds');
  const meta = m.prepFieldMeta(ps);
  const u = meta.units.find((x) => x.uid === w.uid);
  assert.deepEqual(u.items, [ISO, HAMMER], 'prep scouting UnitInfo');
  assert.equal(meta.units.find((x) => x.defId === a).items, undefined, 'no items: no field');
  let battle = null;
  const orig = m.newBattle.bind(m);
  m.newBattle = (o) => { const bt = orig(o); if (o.players?.some((p) => p.playerId === 'p_0')) battle ??= bt; return bt; };
  assert.ok(h.drive(() => battle != null), 'combat starts');
  const su = battle.allyUnits.find((x) => x.kind === 'op' && x.uid === w.uid);
  assert.deepEqual(unitInfo(su).items, [ISO, HAMMER], 'the battle\'s UnitInfo (m.field / spawn events)');
  const plain = battle.allyUnits.find((x) => x.kind === 'op' && x.defId === a);
  assert.equal(unitInfo(plain).items, undefined, 'no items: no field');
  assert.equal(battle.enemies.every((e) => unitInfo(e).items === undefined), true, 'enemies: never');
});
