import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, getZhajingData } from '../server/modes/zhajing/Match.js';
import { VirtualScheduler } from '../server/modes/zhajing/engine/server/match/scheduler.js';
import { applyCard, jibianCard } from '../server/modes/zhajing/engine/server/match/choices.js';
import { jibianBonds } from '../server/modes/zhajing/engine/server/sim/content/jibianBonds.js';
import { applyElement } from '../server/modes/zhajing/engine/server/sim/damage.js';
import { performAttack } from '../server/modes/zhajing/engine/server/sim/ai.js';
import { buildBattleSpec } from '../server/modes/zhajing/engine/server/sim/spec.js';
import { validateClientResult } from '../server/modes/zhajing/engine/server/match/fields.js';
import { isBattleResult } from '../server/modes/zhajing/engine/shared/protocol.js';
import { matchJibianPlan, heavenTimeLimit, applyHiddenMatchCards } from '../server/modes/zhajing/engine/server/sim/content/ejibian.js';
import { makeBattle, chessRec, enemyRec } from './helpers/zhajingBattleHarness.js';

const data = getZhajingData();
const pool = data.config.modes.mode_single_zhajing.jibian.pool;
function fixture(t, humans = 1) {
  const m = new Match({ scheduler: new VirtualScheduler(), seed: 18345,
    mode: humans === 1 ? 'solo' : 'coop',
    seats: Array.from({ length: humans }, (_, seat) => ({ seat, playerId: 'p' + seat, name: '博士' + seat, connected: true })),
    send: () => true, broadcast() {}, onEnd() {}, botRehearsal: 0 });
  t.after(() => m.dispose());
  m.round = 1; m.phase = 'PREP';
  return { m, ps: m.order[0] };
}
function pick(m, ps, id) {
  const spec = pool.find(c => c.effectId === id);
  assert.ok(spec, id);
  applyCard(m, ps, jibianCard(m.gd, spec));
  assert.equal(m.dispatcher.errors, 0, id);
}
const refs = ids => ids.map(id => ({ key: 'jibian:' + id, battle: true }));
const rec = chessRec({ id: 'audit_a', stats: { maxHp: 10000, atk: 100, def: 100, res: 10 }, rangeGrid: [[0, 0], [0, 1]],
  skill: { spCost: 100, initSp: 0 } });
const foe = enemyRec({ key: 'audit_enemy', hp: 1e9, atk: 100, def: 100, res: 50, speed: 0 });
function fight(ids = [], extra = {}) {
  const h = makeBattle({ defs: { chess: { audit_a: rec }, enemies: { audit_enemy: foe } },
    units: [{ chessId: 'audit_a', row: 10, col: 5 }],
    playerEffects: refs(ids), enemies: [{ key: 'audit_enemy', time: 0, pos: [10, 6] }],
    modeId: 'mode_single_zhajing', autoFinish: false, ...extra });
  h.step();
  return h;
}

test('真·投资人凑齐立即返还真实累计支出，后续选择不重复退款', t => {
  const { m, ps } = fixture(t);
  ps.funds = 100; assert.equal(ps.spend(37), true);
  for (const id of ['jibian_touziren', 'jibian_touziweilai', 'jibian_banteng']) pick(m, ps, id);
  const funds = ps.funds;
  pick(m, ps, 'jibian_rencaishichang');
  assert.equal(ps.funds, funds + 37);
  assert.equal(m.dispatcher.investRepeat(ps), 4);
  pick(m, ps, 'jibian_juanzeng');
  assert.equal(ps.funds, funds + 37 + 15);
});

test('维多利亚的秘密通过实际协议刷新全槽，首名干员减1且每回合恢复一次', t => {
  const { m, ps } = fixture(t);
  ps.funds = 100; ps.rollShop();
  pick(m, ps, 'jibian_weiduoliyademimi');
  assert.equal(ps.privateView().spRefresh, 1);
  const before = ps.funds;
  assert.deepEqual(m.handle(ps.playerId, { t: 'g.zhajing', intent: { t: 'g.specialRefresh' } }), { ok: true });
  assert.equal(ps.funds, before);
  const slots = ps.shop.slots.filter(s => s?.kind === 'chess');
  assert.ok(slots.length);
  assert.ok(slots.every(s => ps.gd.chess(s.id).bonds.includes('victoriaShip')), JSON.stringify(slots));
  const first = slots[0], second = slots[1];
  assert.equal(ps.priceOf(first), Math.max(0, first.basePrice - 1));
  assert.deepEqual(ps.buy(ps.shop.slots.indexOf(first)), { ok: true });
  assert.equal(ps.priceOf(second), second.basePrice);
  assert.equal(ps.privateView().spRefresh, 0);
  m.round = 2; m.dispatch(ps, 'onRoundStart', { round: 2 });
  assert.equal(ps.privateView().spRefresh, 1);
});

for (const [id, property, expected] of [
  ['jibian_jibengong', 'atk', 1100], ['jibian_liuyan', 'spCost', 10],
  ['jibian_shuwanzhenyan', 'spCost', 200], ['jibian_wuxiaxian', 'dodgePhys', 0.999],
  ['jibian_zheshe', 'res', 80], ['jibian_lumang', 'atk', 300],
]) test(`${id}只作用于持有者，双人同场不会串给队友`, () => {
  const h = fight([], { kind: 'boss', players: [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, units: [{ uid: 1, chessId: 'audit_a', row: 2, col: 5 }], playerEffects: refs([id]) },
    { playerId: 'p2', seat: 1, side: 'R', colOffset: 8, units: [{ uid: 2, chessId: 'audit_a', row: 2, col: 13 }], playerEffects: [] },
  ] });
  const own = h.allies().find(u => u.ownerId === 'p1'), mate = h.allies().find(u => u.ownerId === 'p2');
  assert.ok(own && mate);
  const value = u => property === 'spCost' ? u.skill.spCost : u.s[property];
  assert.ok(Math.abs(value(own) - expected) < 1e-6, String(value(own)));
  const base = property === 'spCost' ? 100 : ({ atk: 100, res: 10, dodgePhys: 0 })[property];
  assert.equal(value(mate), base);
});

test('腐蚀每秒按当前数值连续降低，离开持有者阻挡后停止', () => {
  const h = fight(['jibian_fushi']); const u = h.allies()[0], e = h.enemies()[0];
  e.blockedBy = u;
  h.run(3.7);
  assert.ok(e.s.def < 90, '三次腐蚀后应低于90，实际' + e.s.def);
  assert.ok(e.s.res < 45);
  e.blockedBy = null; const def = e.s.def; h.run(2);
  assert.equal(e.s.def, def);
});

for (const [el, key, field, expected] of [
  ['burn', 'burnBurst', 'resFlat', -40],
  ['erosion', 'erosionDown', 'defFlat', -240],
  ['apoptosis', 'apoptosisBurst', 'atkMul', 0],
]) test(`元素大师将${el}爆发的减益效果翻倍`, () => {
  const h = fight(['jibian_yuansudashi']); const u = h.allies()[0], e = h.enemies()[0];
  applyElement(h.b, u, e, { type: 'element', element: el, amount: 1e8, mul: 1 });
  const buff = e.findBuff(key);
  assert.ok(buff, el);
  assert.equal(buff.mods[field], expected);
});

for (const [id, mult] of [['ejibian_qiangqiang', 1.2], ['ejibian_gaodingtouer', 1.3]])
test(`${id}敌方数值倍率与卡面一致`, () => {
  const h = fight([], { flags: { enemyJibian: [id] } });
  const e = h.enemies()[0]; assert.equal(e.s.atk, foe.stats.atk * mult);
  assert.equal(e.s.maxHp, foe.stats.maxHp * mult);
});

test('羁绊之力可代替总攻击激活伟大封印，结城理击倒后锁定再部署', () => {
  const makoto = chessRec({ ...rec, id: 'chess_zj_60_5_b' });
  const h = fight(['jibian_sanyuewuri', 'jibian_jibangzhili'], {
    defs: { chess: { chess_zj_60_5_b: makoto }, enemies: { audit_enemy: foe } },
    units: [{ chessId: 'chess_zj_60_5_b', row: 10, col: 5 }],
  });
  const u = h.allies()[0], e = h.enemies()[0];
  h.b.dealDamage(e, u, { amount: 1e9, type: 'true', canDodge: false });
  assert.equal(e.alive, false);
  assert.equal(u.redeployLocked, true);
});

test('骑士竞技从首次近战攻击起按本次目标数加伤，切换群攻立即停止加伤', () => {
  const h = fight(['jibian_qishijingji'], {
    defs: { chess: { audit_a: { ...rec, bonds: ['kazimierzShip'] } }, enemies: { audit_enemy: enemyRec({ key: 'audit_enemy', hp: 1e9, def: 0, speed: 0 }) } },
    enemies: [{ key: 'audit_enemy', time: 0 }, { key: 'audit_enemy', time: 0 }],
  });
  const u = h.allies()[0], es = h.enemies();
  h.b.addBuff(u, { key: 'audit:noCrit', mods: { critRate: -1 } });
  const hp = es[0].hp;
  performAttack(h.b, u, { dmgType: 'phys' }, [es[0]]);
  assert.equal(hp - es[0].hp, 500);
  const before = es.map(e => e.hp);
  performAttack(h.b, u, { dmgType: 'phys' }, es);
  for (let i = 0; i < es.length; i++) assert.equal(before[i] - es[i].hp, 100);
});

test('假想敌的范围外真伤同样降至30%', () => {
  const h = fight(['jibian_jiaxiangdi'], { enemies: [{ key: 'audit_enemy', pos: [10, 9] }] }); const u = h.allies()[0], e = h.enemies()[0];
  h.b.addBuff(u, { key: 'audit:noCrit', mods: { critRate: -1 } });
  assert.equal(u.baseRangeKeys.includes(e.tileR * 21 + e.tileC), false);
  assert.equal(h.b.dealDamage(u, e, { amount: 100, type: 'true', canDodge: false }), 30);
});

test('六眼与数万真言同时持有时技力消耗共同生效', () => {
  const h = fight(['jibian_liuyan', 'jibian_shuwanzhenyan']);
  assert.equal(h.allies()[0].skill.spCost, 20);
});

const pieces = ps => [...ps.board.values(), ...ps.hand, ...ps.temp].filter(Boolean);
for (const [id, ids] of [
  ['jibian_sanyuewuri', ['chess_zj_60_5_b']],
  ['jibian_yiwangnvshen', ['chess_zj_oblvns_b']],
  ['jibian_duoshouyeshou', ['chess_zj_mortis_b']],
  ['jibian_shuihaiyoumengxiang', ['chess_zj_ironmn_b']],
  ['jibian_yinhezhanjian', ['chess_zj_amoris_b', 'chess_zj_dolris_b', 'chess_zj_tmoris_b', 'chess_item_mujica_mask_a']],
]) test(`${id}在手牌已满时发放实际精锐棋子且只属于选择者`, t => {
  const { m, ps } = fixture(t, 2); const mate = m.order[1];
  const old = pieces(ps).map(p => p.uid), other = pieces(mate).map(p => p.uid);
  pick(m, ps, id);
  const added = pieces(ps).filter(p => !old.includes(p.uid));
  assert.deepEqual(added.map(p => p.id).sort(), ids.slice().sort());
  assert.deepEqual(pieces(mate).map(p => p.uid), other);
});

for (const [id, props] of [
  ['jibian_qiangqiang', { maxHp: 11500, atk: 115, def: 115 }],
  ['jibian_daoqiangburu', { def: 150 }], ['jibian_moshubiaoyan', { aspd: 170 }],
  ['jibian_xunhuanwangfu', { spRecovery: 2.2 }], ['jibian_bolidapao', { maxHp: 4000, atk: 200 }],
  ['jibian_xingjieshenti', { maxHp: 25000 }],
]) test(`${id}战斗属性确实改变`, () => {
  const h = fight([id]), u = h.allies()[0];
  for (const [k, v] of Object.entries(props)) assert.ok(Math.abs(u.s[k] - v) < 1e-5, `${k}: ${u.s[k]} != ${v}`);
});

test('维多利亚特殊刷新可在1级商店抽到全部1至6阶；普通刷新清除首购折扣', t => {
  const { m, ps } = fixture(t); pick(m, ps, 'jibian_weiduoliyademimi');
  const tiers = new Set(); ps.funds = 10000;
  for (let round = 1; round <= 80; round++) {
    m.round = round; m.dispatch(ps, 'onRoundStart', { round });
    assert.deepEqual(ps.specialRefresh(), { ok: true });
    for (const s of ps.shop.slots.filter(s => s?.kind === 'chess')) tiers.add(m.gd.chess(s.id).tier);
  }
  assert.equal(ps.shop.level, 1); assert.deepEqual([...tiers].sort(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ps.refresh(), { ok: true });
  for (const s of ps.shop.slots.filter(s => s?.kind === 'chess')) assert.equal(ps.priceOf(s), s.basePrice);
});

test('维多利亚卡池耗尽时不残留其它盟约干员', t => {
  const { m, ps } = fixture(t); pick(m, ps, 'jibian_weiduoliyademimi');
  for (const [id, e] of ps.pool().entries) if (m.gd.chess(id)?.bonds?.includes('victoriaShip')) e.left = 0;
  assert.deepEqual(ps.specialRefresh(), { ok: true });
  assert.equal(ps.shop.slots.filter(s => s?.kind === 'chess').length, 0);
});

test('维多利亚与神秘商店可分别使用，特殊刷新次数不互相消耗', t => {
  const { m, ps } = fixture(t); pick(m, ps, 'jibian_weiduoliyademimi'); pick(m, ps, 'jibian_shenmishangdian');
  assert.deepEqual(ps.specialRefresh(), { ok: true });
  assert.equal(ps.jibianMysticRefreshLeft(), 1);
  assert.deepEqual(ps.mysticRefresh(), { ok: true });
  for (const s of ps.shop.slots.filter(s => s?.kind === 'chess')) assert.ok(s.basePrice >= 1 && s.basePrice <= 6);
  assert.equal(ps.jibianSpecialRefreshLeft(), 0); assert.equal(ps.jibianMysticRefreshLeft(), 0);
});

test('恶魔契约实际开战前加3生命，资金不足可扣生命且不能扣至0', t => {
  const { m, ps } = fixture(t); pick(m, ps, 'jibian_emoxieyue'); ps.lp = 5; ps.funds = 0;
  m.dispatch(ps, 'onPrepEnd', {}); assert.equal(ps.lp, 8);
  assert.equal(ps.spend(7), true); assert.equal(ps.lp, 1);
  assert.equal(ps.spend(1), false); assert.equal(ps.lp, 1);
});

test('时光之末可救同队非持有者，只消费一次；Boss战不能触发', t => {
  const { m, ps } = fixture(t, 2), mate = m.order[1];
  pick(m, ps, 'jibian_shiguangzhimo');
  assert.equal(m.dispatch(ps, 'onWouldEliminate', { kind: 'boss', lp: 0 }).saved, undefined);
  m.round = 2; m.phase = 'COMBAT'; ps.lp = 10; mate.lp = 1;
  m.lastResults.set(ps.playerId, { leaked: [], perfect: true });
  m.lastResults.set(mate.playerId, { leaked: [{ counted: true }], perfect: false });
  m.settle();
  assert.equal(mate.alive, true); assert.equal(mate.lp, 1);
  assert.equal(ps.jibianHas('jibian_shiguangzhimo'), false);
});

test('潘多拉移除文件夹和影分身的持续加成，并实际发放三张不重复的新惊变', t => {
  const { m, ps } = fixture(t); const cap = ps.deployCap;
  pick(m, ps, 'jibian_renshibuwenjianjia'); pick(m, ps, 'jibian_yingfenshen');
  assert.equal(ps.deployCap, cap + 2);
  // 固定新卡池以验证旧卡副作用的撤销，不依赖随机是否重抽文件夹。
  const original = m.gd.raw;
  const limited = pool.filter(c => ['jibian_juanzeng', 'jibian_malubian', 'jibian_qiangqiang'].includes(c.effectId));
  const modes = original.config.modes, mode = modes[m.gd.modeId];
  m.gd.raw = { ...original, config: { ...original.config, modes: { ...modes,
    [m.gd.modeId]: { ...mode, jibian: { ...mode.jibian, pool: limited } },
  } } };
  try { pick(m, ps, 'jibian_panduolamohe'); }
  finally { m.gd.raw = original; }
  assert.equal(ps.deployCap, cap);
  const cards = ps.effects.filter(e => e.key.startsWith('jibian:')).map(e => e.key);
  assert.equal(new Set(cards).size, 3); assert.equal(cards.length, 3);
});

test('敌方羁绊仅在恰有两只同名怪时生效，第三只进场撤销、一只死亡后恢复', () => {
  const h = fight([], { flags: { enemyJibian: ['ejibian_jiban'] }, enemies: [
    { key: 'audit_enemy', time: 0 }, { key: 'audit_enemy', time: 0 }, { key: 'audit_enemy', time: 2 },
  ] });
  assert.equal(h.enemies().length, 2); assert.ok(h.enemies().every(e => e.s.atk === 150));
  h.run(2); assert.equal(h.enemies().length, 3); assert.ok(h.enemies().every(e => e.s.atk === 100));
  h.b.kill(h.enemies()[2]); assert.ok(h.enemies().every(e => e.s.atk === 150));
});

function uploaded(h) {
  h.b.forceEnd(); const raw = h.result();
  assert.equal(isBattleResult(raw), true);
  const checked = validateClientResult(buildBattleSpec(h.b.opts), raw);
  assert.equal(checked.ok, true, checked.reason);
  return checked.result;
}

function growingFight(ps, ids, extra = {}) {
  return fight([], { players: [{ playerId: ps.playerId, seat: 0, side: 'L', colOffset: 0,
    units: [{ uid: 101, chessId: 'audit_a', row: 10, col: 5 }], playerEffects: ps.effects.filter(e => ids.includes(e.key.slice(7))) }], ...extra });
}

test('仇名录实际击杀增益经过客户端战报和结算后，带入下一场战斗', t => {
  const { m, ps } = fixture(t); pick(m, ps, 'jibian_chouminglu');
  const h = growingFight(ps, ['jibian_chouminglu']); const u = h.allies()[0];
  assert.equal(u.s.atk, 102); h.b.kill(h.enemies()[0], u); assert.equal(u.s.atk, 102.2);
  const res = uploaded(h);
  assert.equal(res.perPlayer[ps.playerId].jibianGrowth.jibian_chouminglu.kills, 1);
  m.dispatch(ps, 'onBattleResult', { result: res.perPlayer[ps.playerId] });
  assert.equal(growingFight(ps, ['jibian_chouminglu']).allies()[0].s.atk, 102.2);
});

test('心之钢按每位攻击者独立冷却，生命成长通过战报保存到下场且不串棋子', t => {
  const { m, ps } = fixture(t); pick(m, ps, 'jibian_xinzhigang');
  const player = { playerId: ps.playerId, seat: 0, side: 'L', colOffset: 0,
    units: [{ uid: 101, chessId: 'audit_a', row: 10, col: 5 }, { uid: 102, chessId: 'audit_a', row: 11, col: 5 }], playerEffects: ps.effects };
  const h = fight([], { players: [player] }); const [a, b] = h.allies(), e = h.enemies()[0];
  h.b.dealDamage(a, e, { amount: 10, type: 'phys', isAttack: true });
  h.b.dealDamage(b, e, { amount: 10, type: 'phys', isAttack: true });
  assert.equal(a.s.maxHp, 10100); assert.equal(b.s.maxHp, 10100);
  h.b.dealDamage(a, e, { amount: 10, type: 'phys', isAttack: true }); assert.equal(a.s.maxHp, 10100);
  const res = uploaded(h); m.dispatch(ps, 'onBattleResult', { result: res.perPlayer[ps.playerId] });
  const next = growingFight(ps, ['jibian_xinzhigang'], { enemies: [] }); assert.equal(next.allies()[0].s.maxHp, 10100);
  assert.equal(next.allies()[0].uid, 101);
});

test('吸血习性只回复普通攻击造成的伤害，不误吸技能伤害和持续伤害', () => {
  const h = fight(['jibian_xixuexixing']), u = h.allies()[0], e = h.enemies()[0];
  h.b.addBuff(u, { key: 'audit:noCrit', mods: { critRate: -1 } }); u.hp = 1000;
  h.b.dealDamage(u, e, { amount: 100, type: 'true', isAttack: true }); assert.equal(u.hp, 1015);
  h.b.dealDamage(u, e, { amount: 100, type: 'true', isAttack: true, isSkill: true }); assert.equal(u.hp, 1015);
  h.b.dealDamage(u, e, { amount: 100, type: 'true', tags: ['dot'] }); assert.equal(u.hp, 1015);
});

test('多人伟大封印两位玩家各触发一次，经客户端战报校验后均保存使用记录', t => {
  const { m } = fixture(t, 2); const makoto = chessRec({ ...rec, id: 'chess_zj_60_5_b' });
  const players = m.order.map((ps, i) => ({ playerId: ps.playerId, seat: i, side: i ? 'R' : 'L', colOffset: i * 8,
    units: [{ uid: 100 + i, chessId: 'chess_zj_60_5_b', row: 2, col: 5 + i * 8 }],
    playerEffects: refs(['jibian_sanyuewuri', 'jibian_jibangzhili']),
  }));
  const h = fight([], { kind: 'boss', players,
    defs: { chess: { chess_zj_60_5_b: makoto }, enemies: { audit_enemy: foe } },
    enemies: [{ key: 'audit_enemy' }, { key: 'audit_enemy' }],
  });
  for (const u of h.allies()) h.b.kill(u);
  const res = uploaded(h); assert.equal(res.greatSealBans.length, 2);
  m.phase = 'COMBAT'; m.fields = [{ id: 'audit', players: m.order.map(p => p.playerId), live: true }];
  m._finishCombat(() => res);
  assert.ok(m.order.every(ps => ps.greatSealUsed === true));
});

test('重振荣光二档将攻击距离和攻击力一起翻倍，现代最强仍优先免技力', () => {
  const h = fight(['jibian_hongsongqishituan', 'jibian_qishijingji', 'jibian_laobadao'], {
    defs: { chess: { audit_a: { ...rec, bonds: ['kazimierzShip'] } }, enemies: { audit_enemy: foe } }, enemies: [],
  });
  assert.equal(h.allies()[0].s.atk, 300); assert.equal(h.allies()[0].s.rangeExtend, 2);
  const modern = fight(['jibian_liuyan', 'jibian_wuxiaxian', 'jibian_qingpaibeibu', 'jibian_shuwanzhenyan']);
  assert.equal(modern.allies()[0].skill.spCostMul, 0);
  assert.equal(modern.allies()[0].skill.spCost, 1); // 主版本既有最低1点、技能结束返还1点的约定。
});

for (const [id, props] of [
  ['ejibian_liangbianzhibian', { atk: 40, def: 40, maxHp: 4e8 }],
  ['ejibian_zhibianliangbian', { atk: 130, def: 130, maxHp: 1.3e9 }],
  ['ejibian_xianfazhiren', { aspd: 190 }],
  ['ejibian_shenweinancanglei', { dodgePhys: 0.1, dodgeArts: 0.1 }],
]) test(`${id}进场实际属性符合牌面`, () => {
  const h = fight([], { flags: { enemyJibian: [id] } }), e = h.enemies()[0];
  for (const [k, v] of Object.entries(props)) assert.ok(Math.abs(e.s[k] - v) < 1e-6, `${k}: ${e.s[k]}`);
});

test('通行证两层盾只抵消两次，第三次实际扣血', () => {
  const h = fight([], { units: [], flags: { enemyJibian: ['ejibian_tongxingzheng'] } }), e = h.enemies()[0];
  for (let i = 0; i < 2; i++) assert.equal(h.b.dealDamage(null, e, { amount: 100, type: 'true' }), 0);
  assert.equal(h.b.dealDamage(null, e, { amount: 100, type: 'true' }), 100);
});

test('敌方出怪数量惊变可叠乘，强行顶吗改变出怪计划、天堂制造缩短时限', () => {
  const plan = matchJibianPlan(null, 2, ['ejibian_liangbianzhibian', 'ejibian_zhibianliangbian', 'ejibian_jiangshiweicheng', 'ejibian_qiangxingdingma']);
  assert.ok(Math.abs(plan.countMul - 1.68) < 1e-9); assert.equal(plan.sameTime, true);
  assert.equal(heavenTimeLimit({ flags: { enemyJibian: ['ejibian_tiantangzhizao'] } }, 200), 120);
});

for (const [id, props] of [
  ['ejibian_hidden_absolute', { maxHp: 11e9, atk: 200 }],
  ['ejibian_hidden_cannon', { def: 400, atk: 300, res: 70 }],
  ['ejibian_gaodingtouer', { maxHp: 5e8 }],
]) test(`${id}实际影响Boss`, () => {
  const h = fight([], { flags: { enemyJibian: [id] },
    defs: { chess: { audit_a: rec }, enemies: { audit_enemy: enemyRec({ key: 'audit_enemy', rank: 'BOSS', hp: 1e9, atk: 100, def: 100, res: 10, speed: 0 }) } },
  });
  const e = h.enemies()[0]; for (const [k, v] of Object.entries(props)) assert.equal(e.s[k], v);
});

test('隐藏打响指和诛伏赐死实际减少层数，清零的是全队同一个盟约', t => {
  const { m } = fixture(t, 2);
  for (const ps of m.order) { ps.layers.swiftShip = 100; ps.layers.preciShip = 60; }
  applyHiddenMatchCards(m, ['ejibian_hidden_snap']);
  for (const ps of m.order) { assert.equal(ps.layers.swiftShip, 50); assert.equal(ps.layers.preciShip, 30); }
  applyHiddenMatchCards(m, ['ejibian_hidden_purge']);
  const cleared = ['swiftShip', 'preciShip'].filter(id => m.order.every(ps => ps.layers[id] === 0));
  assert.equal(cleared.length, 1);
});

test('集成战略爱好者每次达到新档位发新卡，后续无关选择不重复发奖', t => {
  const { m, ps } = fixture(t);
  const ids = jibianBonds().find(b => b.id === 'roguelike_fan').members;
  for (const id of ids.slice(0, 3)) pick(m, ps, id);
  const owns = () => ps.effects.filter(e => ids.includes(e.key.slice(7))).length;
  assert.equal(owns(), 4);
  while (owns() < 6) pick(m, ps, ids.find(id => !ps.jibianHas(id)));
  assert.equal(owns(), 7);
  pick(m, ps, 'jibian_moshubiaoyan'); assert.equal(owns(), 7);
});

test('文明的存续在双人联合战场只增强持有者的真实伤害', () => {
  const h = fight([], { kind: 'boss', players: [
    { playerId: 'p1', seat: 0, side: 'L', units: [{ uid: 1, chessId: 'audit_a', row: 2, col: 5 }], playerEffects: refs(['jibian_wenmingdecunxu']) },
    { playerId: 'p2', seat: 1, side: 'R', units: [{ uid: 2, chessId: 'audit_a', row: 2, col: 13 }], playerEffects: [] },
  ] });
  const e = h.enemies()[0];
  for (const u of h.allies()) h.b.addBuff(u, { key: 'audit:noCrit', mods: { critRate: -1 } });
  assert.equal(h.b.dealDamage(h.allies()[0], e, { amount: 100, type: 'true' }), 300);
  assert.equal(h.b.dealDamage(h.allies()[1], e, { amount: 100, type: 'true' }), 100);
});

test('鲁莽的同一次群攻统一命中或打空，每次攻击各抽一次', () => {
  const h = fight(['jibian_lumang'], {
    defs: { chess: { audit_a: rec }, enemies: { audit_enemy: enemyRec({ key: 'audit_enemy', hp: 1e9, def: 0, speed: 0 }) } },
    enemies: [{ key: 'audit_enemy' }, { key: 'audit_enemy' }],
  });
  const u = h.allies()[0], es = h.enemies(); h.b.addBuff(u, { key: 'audit:noCrit', mods: { critRate: -1 } });
  const outcomes = new Set();
  for (let i = 0; i < 100; i++) {
    const before = es.map(e => e.hp); performAttack(h.b, u, { dmgType: 'phys' }, es);
    assert.equal(before[0] - es[0].hp, before[1] - es[1].hp);
    outcomes.add(before[0] - es[0].hp);
  }
  assert.deepEqual([...outcomes].sort((a,b) => a-b), [0, 300]);
});
