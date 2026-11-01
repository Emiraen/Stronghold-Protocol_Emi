// server/sim/content/jibian.js — 炸惊模拟 惊变 (jibian) card content.
//
// WHAT THIS FILE OWNS. 炸惊模拟 规则5/6 gives two SP rounds a phase kind of their own: 惊变阶段 (spPhaseKinds, rounds
// 1 and 7) deals `jibian.cards` cards from `mode_*_zhajing.jibian.pool` (data/config.json) and 企鹅物流的快递 deals
// equips. The DRAFT lives in server/match/choices.js (family 'jibian', `generateDraft` + the rarity roll); a picked
// 惊变 card is applied by that file's `applyDefault` branch as an EffectRef with the key `jibian:<effectId>`
// (`battle: true`, so the battle side reads it off `ps.playerEffects`). THIS module is what those refs actually DO —
// without it a 惊变 card is a name, a rarity and a flavour line that changes nothing:
//   * prep side — registerMeta(registry) registers one `jibian:<effectId>` handler per card. The dispatcher resolves a
//     ref by `registry.get(ref.key)` on every prep hook, and `applyCard` re-dispatches `onChoicePick` to the player's
//     refs right after the ref is added, so `onChoicePick` is the once-only "when this card is picked" hook
//     (its ctx.source.kind is 'effect' there, never 'choice' — the 'choice:<id>' key is what was missing).
//   * battle side — install(battle) reads every `jibian:` ref of every player and applies the card's battle part.
// Unlike a 机变 card a 惊变 card has NO data/effects.json record: its numbers are authored here, next to its face text
// in _garrison-list/jibian-data.mjs (the single source of the 30 + 15 card faces, mirrored into data/config.json).
//
// CARD LIST (30 友方惊变) — ✱ = battle side (install), ✎ = prep side (registerMeta):
//   ✱ jibian_qiangqiang       ？！强强？！      所有干员基础数值 +15%（生命/攻击/防御，直接乘算）
//   ✱ jibian_daoqiangburu     刀枪不入          所有干员防御 +50%
//   ✱ jibian_moshubiaoyan     魔术表演          所有干员攻击速度 +70
//   ✎ jibian_zhebeiwuqing     这杯我请          每回合购买的首个干员和装备售价为 0
//   ✱ jibian_yuansudashi      元素大师          元素损伤爆发的伤害翻倍（含持续伤害；爆发的状态部分未翻倍）
//   ✱ jibian_nimobudao        你摸不到          所有干员开启技能后无敌 1s
//   ✱ jibian_wananjiaoguan    晚安教官          战斗开始时生命最高的干员：生命 +100%、防御 +400、阻挡数 +2
//   ✱ jibian_meiguozidan      美国子弹          每次攻击对攻击范围内随机一名敌人造成 40% 攻击力的物理伤害
//   ✱ jibian_xunhuanwangfu    循环往复          所有干员技力自动恢复速度 +1.2/s
//   ✱ jibian_tankeyinqing     坦克引擎          所有干员：每击倒一名敌人永久提升生命 1%
//   ✱ jibian_suoxiaoyinqing   缩小引擎          所有干员：每击倒一名敌人永久增加技力恢复 0.05/s
//   ✎ jibian_chaodabei        超大杯            获得一件装备（奖杯）：装备干员攻击力 +200%、技力恢复 +2/s
//   ✎ jibian_chaoqianxiaofei  超前消费          立刻获得 3x+30 资金（x=选择时的回合），后三个回合资金固定为 0（不受悬赏怪影响）
//   ✎ jibian_juanzeng         捐赠              获得 15 资金
//   ✱ jibian_wenmingdecunxu   文明的存续        对敌方造成的真实伤害 +200%
//   ✎ jibian_banteng          板藤              卖价 4 起、每回合 +4；商店栏的「出售板藤」键位套现（★ 见下）
//   ✎ jibian_rencaishichang   人才市场          从干员池中随机获得一个干员（无视等级）
//   ✱ jibian_xingjieshenti    星界躯体          我方每个干员：生命 +150%
//   ✎ jibian_panduolamohe     潘多拉魔盒        失去所有惊变，获得三个随机惊变
//   ✎ jibian_malubian         我在马路边捡到一分钱  获得 5 资金
//   ✱ jibian_titawu           踢踏舞            所有干员：每次普通攻击后攻速 +2 持续 2s，可叠加并刷新
//   ✱ jibian_xixuexixing      吸血习性          所有干员：普通攻击后恢复该次伤害 15% 的生命
//   ✱ jibian_shixue           嗜血              同上但 25%，且干员不再成为友方单位的治疗目标
//   ✱ jibian_bing             ？！冰？！        寒冷/冻结持续时间翻倍；对寒冷或冻结中的敌人伤害 +50%
//   ✱ jibian_zuiegankuai      罪恶快感          击杀敌方单位后获得 20 技力
//   ✎ jibian_wocongshanzhonglai 我从山中来      立刻获得一个精锐蕾缪安（chess_zj_78_b）
//   ✎ jibian_325799           ？！325799？！    任务：存活至 7.99 回合结束 → 随机一个已激活盟约层数 +325
//   ✎ jibian_daozhuanqu       倒转区            任务：任一盟约到达 999 层 → 20 资金
//   ✎ jibian_diecengshou      “叠层手”          接下来五回合通过特质提高的层数翻倍
//   ✎ jibian_laozishiguanjun  老子是冠军他是什么  获得一个「奖杯」，装备后攻击力 +100%
//
// 30 张全部实装（✱ battle 19 + ✎ prep 11）。实现口径上要说明的几处：
//   * 板藤 — 用户 2026-10-12：引擎里 sell() 只接受 kind==='chess' 的棋子（server/match/player/economy.js，
//     道具与 token 都卖不了），所以**不再发那件卖不掉的装备**；这张卡只维护一个卖价计数器
//     （`jibian:banteng:value`，起价 4、每回合 +4），套现走商店栏的「出售板藤」键位 —— C2S `g.sellBanteng`
//     → economy.js 的 sellBanteng（与「维多利亚的秘密」的特殊刷新同一套：协议 → intents → PlayerState）。
//     按钮里的图案仍取数据记录 chess_item_jibian_banteng 的 iconId（记录保留，但不再作为道具发放）。
//   * 奖杯 — 完全由数据记录实现：chess_item_jibian_trophy 的 buff 走引擎既有的 attr_common_global_buff（ATK% += 1），
//     本模块不需要插手；两张道具记录随本次改动一起加进 data/items.json。
//   * 元素大师 — 爆发的伤害全翻倍（含凋亡/侵蚀的持续伤害）；爆发附带的「状态部分」（palsy 层数 / lock 时长）在
//     resolveBurst 内部，没有 burst 标记，没有翻倍。
//   * 超前消费 — 「后三个回合资金固定为 0」只清零 ev.income（基础收入与利息），ev.pending（悬赏怪赏金/结算挂账）照发。
//   * ？！325799？！ — 到第 8 回合开始时结算；那一刻若一个已激活盟约都没有，就留到下回合再试（卡不消失）。
//   * “叠层手” — 只翻倍 reason 以 `garrison:` 开头的层数（「通过特质提高」），盟约自身/战斗结算的层数不动；自己补的
//     那一份用不同的 reason，所以不会递归。
//
// CARD LIST, 第二批 20 张（用户 2026-10-12《盟约惊变.md》= `ALLY` 的后 20 条；12 张盟约惊变 + 8 张通用惊变）：
//   ✱ jibian_dengdaixue        等待雪，埋葬这一切  谢拉格干员造成伤害时 30% 概率 3s 寒冷 + 20% 脆弱
//   ✱ jibian_chunyinzidan      银质子弹            拉特兰干员造成伤害时挂可叠加流血（1% 最大生命/s，单跳 ≤20 万，3s）
//   ✱ jibian_qishijingji       骑士竞技            卡西米尔干员"仅对一名敌人造成伤害"时 +400%
//   ✱ jibian_laobadao          “老霸道了”          卡西米尔干员攻击范围 > 7 格时，同时对多名敌人造成的伤害 +325%
//   ✎ jibian_jiarudaqun        加入大群            阿戈尔干员通过特质提升的层数 +100%；有浊心斯卡蒂时再翻倍（×3）
//   ✎ jibian_gaojizishen       高级资深干员        预约：下一次刷新商店槽位全变随机六阶（跨文件：无；本模块 onRefresh）
//   ✎ jibian_zishen            资深干员            同上，五阶
//   ✎ jibian_weiduoliyademimi  “维多利亚的秘密”    每回合 1 次特殊刷新（客户端按钮 g.specialRefresh → onRefresh；
//                                                 只出维多利亚、无视等级、该次刷新后首个干员 -1 资金）
//   ✱ jibian_lala              ？！拉拉？！        叙拉古干员击倒敌人时，已激活的【叙拉古】层数 +10
//   ✎ jibian_geigei            ？！给给？！        立刻获得一个精锐"贝洛内"（chess_zj_76_b）
//   ✎ jibian_xunjie            迅捷                【迅捷】+80 层（无需激活）
//   ✎ jibian_jingzhun          精准                【精准】+80 层（无需激活）
//   ✎ jibian_lingqiao          灵巧                【灵巧】+80 层（无需激活）
//   ✎ jibian_jianshou          坚守                【坚守】+80 层（无需激活，稀有）
//   ✱ jibian_huolibuzu         火力不足恐惧症      我方干员开技能后子弹数翻倍（稀有，拉特兰图标）
//   ✎ jibian_liuyan            六眼                我方干员技力消耗 -90%（传说，卡面用 owner 给的图）
//   ✎ jibian_zonggongji        总攻击              获得虎狼丸 / 岳羽由加莉 / 埃癸斯（史诗，S.E.E.S 图标）
//   ✱ 羁绊·伟大封印           三月五日 + 总攻击    结城理死亡 → 处决血量最高敌人（一局一次）
//   ✱ jibian_jiaxiangdi        假想敌              额外目标格铺满全场（可打范围外的敌人），范围外的伤害 ×0.3
//   ✱ jibian_zibaokache        自爆卡车            干员被击倒时对半径 1.5 格的敌人造成 4000% 攻击力的法术伤害
//   ✱ jibian_mofazhuanwuli     魔法转物理          法术伤害 → 物理，且该伤害 +30%
//   ✱ jibian_wulizhuanmofa     物理转魔法          物理伤害 → 法术（拿了魔法转物理时它不生效，见下）
//   （用户 2026-10-12：两张同时在手**不互抵** —— 一律输出增强后的物理伤害、保留 +30%，魔法转物理优先）
//   ✎ jibian_yingfenshen       “影分身”            每个已部署干员给它自己每个盟约的人数 +1（bondCountBonus，覆盖式）
//   ✎ jibian_jinjidiaopai      紧急调派            完美作战时回合结束给一个"≤商店等级、层数最高盟约"的干员
//   ✎ jibian_yanguoyouji       炎国游记            立刻随机一个无视商店等级的【炎】干员，之后每 2 回合再给一个
//   ✱/✎（卡 7）jibian_touziren  “投资人”            每个【获得时】触发两次（跨文件：match/effectsMeta.js investRepeat）
//
// 第二批的实现口径：
//   * 骑士竞技 — hit/damaged 的 ctx 都没有"目标数"，只能借 ai.js `attack` 钩子的 targets 记一笔（见 install 里的
//     attackTargets）；"同时对多名敌人造成伤害"用 `isSplash || targetCount > 1`（溅射受害者不在 targets 里）。
//   * 银质子弹 — 引擎没有 bleed 状态，这里用 duration+interval+onTick 的 buff 自建（periodicDamage 模板）；
//     流血自己造成的伤害带 dot/periodic tag，helper 里跳过，避免每跳再叠一层。
//   * 加入大群 / 叠层手 — 同一个口径：「通过特质提高的层数」= reason 以 `garrison:` 开头；盟约自身（reason 'bond'）
//     与战斗结算的层数不翻倍。
//   * 假想敌 — 用 queries.js 的 setExtraRange 把全场格子并进攻击范围（索敌仍走引擎既有优先级）；"范围外"= 目标
//     不在 unit.baseRangeKeys 里，伤害 ×0.3。
//   * 影分身 — bondCountBonus 是覆盖式玩家级整数，所以每次重算前清掉上一次写过的盟约；重建时机挂在
//     回合开始 / 买 / 卖 / 合并 / 获得 / 休整期结束（最后一个正好在战斗快照之前）。
//   * 紧急调派 — 层数最高盟约优先在"已激活"里找，都没有再退回"有层数但未激活"的。
//
// CARD LIST, 第三批 3 张（5 条卡池条目；用户 2026-10-13《3 个新惊变》）：
//   ✎ jibian_gaoluzhipiao     高卢银行支票  整备阶段开始时掷出本次提现金额（+10 / 0 / -10 / +100），商店栏的「提现」键位
//                                             （C2S `g.cashCheque` → economy.cashCheque）一次性兑现并把这张卡用掉
//   ✱ jibian_jinjiuzhibei     金酒之杯      整备阶段结束时按当时资金结算：每 5 资金 → 全队攻速 +7；
//                                             资金 > 50 时每 5 资金再加 +10% 攻击力与生命（作用于紧接的那场战斗）
//   ✎ jibian_jisusongda_normal / _rare / _epic 极速送达！ 抽到时发一个企鹅物流包裹（EQUIP，**装备即消耗**，item 记录
//                                             kind = consume_on_equip）；装上后销毁包裹、随机一名干员进整备区
//                                             （普通 1–4 阶 / 稀有 5 阶 / 史诗 6 阶；纯按阶随机，不看商店等级与池子余量）
//
// 第三批的实现口径：
//   * 高卢银行支票 — 引擎里没有"临时进度"的地方可放，所以概率本身就是一组玩家级计数器
//     （`jibian:gaoluzhipiao:w10` / `:w0` / `:wm10`，单位=百分点）。onBattleResult 把这一场战斗的击杀 / 漏怪 / 被兜住
//     增量按"给某项加 Δ、从另外两项按当前比例扣"的规则并进去（扣到 0 为止、不出负数 —— 所以三项之和在极端情况下会
//     略高于 99，这是用户口径「扣到 0 为止」优先于「和不变」的结果）；onPrepStart（= 整备阶段开始）掷出一次金额、
//     写入 `jibian:gaoluzhipiao:value`，随后概率回归初始、增量清零。`+100` 的 0.1% 不参与任何按比例扣。
//     掷法：先看 0.1% 的 +100，再在 +10 / 0 / -10 三项里按各自权重归一化抽取（初始权重 33/33/33 → 每项 1/3）——
//     四项初始权 33+33+33+0.1 = 99.1 ≠ 100，归一化是唯一能把「+100 恰为 0.1%」和「三项之和不被 0.9 的余量带偏」
//     同时说圆的做法。金额 = max(0, 状态)，所以 -10 钳到 0。
//   * 「漏掉一个敌方单位」只数**自己那一场战斗**进红门的怪（`ev.result.leaked` 里 counted !== false 的）；「被队友
//     兜住」只可能是联防（unite.js）里的事：自己那些**能重新入场**的漏怪数，减去联防结束后仍然活着（perPlayer 的
//     leaked）与没来得及进场（unspawned）的那些，剩下的就是队友替你拦下的。
//   * 金酒之杯 — 结算在 onPrepEnd（整备阶段结束时，紧接就是本回合的战斗），数值写进这张卡自己的 ref `params`
//     （battleInput 会把 params 带进战斗），战斗侧在 battleStart / deploy 上给**该玩家场上全部我方单位**上 passiveBuff。
//     「所有我方单位」按用户 2026-10-13 的口径取最宽的一种：**干员 + 召唤物 + 装置/道具单位**，所以不用 playerOps()
//     （它只给 kind === 'op'）也不用 battle.allies()（它排除 kind === 'device'），而是直接扫 battle.allyUnits。
//   * 极速送达！ — 包裹的 item 记录由数据层提供（items.json，kind = `consume_on_equip`），本模块只注册
//     `item:chess_item_jibian_jisusongda_*` 的 onEquip：引擎的消耗分支（player/items.js：kind 以 consume_on_equip
//     开头 + 注册表里有这个 key）会把装备交给处理器、之后自动销毁它，所以处理器里不再自己 destroyPiece（若记录被写回
//     `passive`，onEquip 仍会跑、只是要自己销毁 —— 两条路都兜住了，见 openPackage）。
//
// 敌方惊变 (15, `enemyJibian`, drawn once per match before round 1 — 规则14) is match-wide, not per player, and is
// applied by the match/wave layer (server/match/*), never by a player EffectRef: nothing here reads `ejibian_*`.

import { directMods, passiveBuff, playerOps, isMember, gainLayers, itemsOf, itemKeyOf } from './support/index.js';
import { bondLayers, activeBondIds } from './support/index.js';
import { spawnYanyou } from './tokens.js';
import { activeBonds, ownedJibianIdsOf } from './jibianBonds.js';
import { periodicDamage } from '../damage.js';
import { weaknessRetype, addShieldLayer } from './items/battle.js';
import { GEO } from '../../../shared/constants.js';
import { mergeGrowth } from '../../../shared/jibianGrowth.js';

/** EffectRef key prefix of a 惊变 card (server/match/choices.js applyDefault). */
const P = 'jibian:';

/** Effect id of a `jibian:<id>` ref key (null for anything else). */
const idOf = (key) => (typeof key === 'string' && key.startsWith(P) ? key.slice(P.length) || null : null);

/**
 * Every player's picked 惊变 cards: pid → Map(effectId → times picked). Re-picking the same card stacks (each pick is
 * its own ref with its own uid, choices.js addRef), so the counts drive how many times a card's effect applies.
 */
function picksOf(battle) {
  const out = new Map();
  for (const ps of (battle && battle.players) || []) {
    const m = new Map();
    for (const ref of ps.playerEffects || []) {
      const id = idOf(ref && ref.key);
      if (id) m.set(id, (m.get(id) ?? 0) + 1);
    }
    if (m.size) out.set(ps.playerId, m);
  }
  return out;
}

/** 寒冷 or 冻结 (the engine's own status flags, sim/buffs.js status catalogue). */
const chilled = (u) => !!u && !!(u.s && u.s.flags && (u.s.flags.cold || u.s.flags.freeze));

/** 目标是不是站在 `u` 自己的攻击范围格子里（不含技能/内容额外加的那些格）—— 假想敌的"范围外"判定. */
function inBaseRange(u, t) {
  if (!u || !t || !Number.isInteger(t.tileR) || !Number.isInteger(t.tileC)) return false;
  const keys = u.baseRangeKeys;
  if (!Array.isArray(keys)) return false;
  return keys.includes(t.tileR * GEO.COLS + t.tileC);
}

/** Persistent buff that grows by one stack per call (additive mod keys scale with stacks, sim/buffs.js). */
function stackBuff(battle, u, key, mods) {
  return battle.addBuff(u, { key, mods, persist: true, allowDead: true, refresh: 'stack', maxStacks: 1e6 });
}

/** The player a spawned enemy belongs to (co-op halves carry ownerId; a solo field has one player), else null. */
function enemyOwner(battle, e) {
  if (!e) return null;
  if (e.ownerId != null) return e.ownerId;
  const players = (battle && battle.players) || [];
  return players.length === 1 ? players[0].playerId : null;
}

/**
 * Refs that target ONE named piece instead of the whole side — key `effect:jibian:<id>`, `params.uid` = the piece's uid
 * (超大杯). The prep side adds them with ctx.addEffect; `ps.playerEffects` carries params into the battle spec, and an
 * ally unit keeps its piece uid (`players.js` `_makeAlly(..., { uid: inp.uid })`), so the battle side can find it.
 */
function scopedRefs(battle) {
  const out = [];
  for (const ps of (battle && battle.players) || []) {
    for (const ref of ps.playerEffects || []) {
      if (ref && typeof ref.key === 'string' && ref.key.startsWith('effect:' + P)) out.push({ id: ref.key.slice(('effect:' + P).length), params: ref.params || {} });
    }
  }
  return out;
}

/**
 * Refs of ONE 惊变 id whose numbers live in the ref's own `params` (金酒之杯 writes them at the prep end):
 * pid → params[] (one entry per pick of that card).
 */
function refParamsOf(battle, id) {
  const out = new Map();
  for (const ps of (battle && battle.players) || []) {
    const list = [];
    for (const ref of ps.playerEffects || []) {
      if (idOf(ref && ref.key) !== id) continue;
      list.push(ref && ref.params && typeof ref.params === 'object' ? ref.params : {});
    }
    if (list.length) out.set(ps.playerId, list);
  }
  return out;
}

function battleGrowth(battle, pid, id) {
  const pp = battle._pp(pid);
  const growth = pp.jibianGrowth || (pp.jibianGrowth = {});
  return growth[id] || (growth[id] = { kills: 0, hp: {} });
}

function saveGrowth(ctx, ev, id) {
  const ref = ctx.source?.ref;
  if (!ref) return;
  const primary = ev?.result?.jibianGrowth?.[id];
  const unite = ev?.unite?.perPlayer?.[ctx.playerId]?.jibianGrowth?.[id];
  if (!primary && !unite) return;
  ctx.addEffect({ ...ref, params: { ...ref.params, growth: mergeGrowth(ref.params?.growth, primary, unite) } });
}

/**
 * 金酒之杯的「所有我方单位」：该玩家**场上存活**的全部我方单位 —— 干员、召唤物（token）**与装置/道具单位（device）**
 * （用户 2026-10-13 的口径）。不能用 `playerOps()`（只收 kind === 'op'）也不能用 `battle.allies()`（它排除 device），
 * 所以直接扫 battle.allyUnits；`side` 一定要判，敌人单位的 ownerId 是它的场地主人（units.js）。
 */
function ownUnits(battle, pid) {
  const out = [];
  for (const u of (battle && battle.allyUnits) || []) {
    if (!u || u.side !== 'ally' || u.ownerId !== pid) continue;
    if (u.removed || !u.alive || !u.deployed) continue;
    out.push(u);
  }
  return out;
}

/** Operator mods a card puts on EVERY own operator, as a function of how many times it was picked. */
const OP_PASSIVES = [
  ['jibian_qiangqiang', (n) => directMods({ atk: 0.15 * n, def: 0.15 * n, hp: 0.15 * n })],
  ['jibian_daoqiangburu', (n) => directMods({ def: 0.5 * n })],
  ['jibian_moshubiaoyan', (n) => ({ aspd: 70 * n })],
  ['jibian_xunhuanwangfu', (n) => ({ spRecoveryFlat: 1.2 * n })],
  // 玻璃大炮（owner 2026-10-16）: 攻击力 +100%、最高生命 −60%
  // （hp: -0.6 → hpPct −0.6；与「强强」的 hpPct +0.15 同属加算，不会把生命打成负数）
  ['jibian_bolidapao', (n) => directMods({ atk: 1 * n, hp: -0.6 * n })],
];

// =====================================================================================================================
// battle side

/**
 * 火力不足恐惧症（稀有）：你的所有干员**开启技能后子弹数翻倍**。
 *   只作用于 `skill.kind === 'ammo'` 的技能（拉特兰那类"按发数打完"的技能）。
 *   优先级 -20：比拉特兰盟约的 +N%（-10）更晚结算，所以是"先算盟约加成、再整体翻倍"。
 * @param {any} _battle @param {any} unit @param {any} skill
 * @returns {number} 翻倍后的子弹数（没变则原值）
 */
export function doubleAmmoForJibian(_battle, unit, skill) {
  if (!unit || unit.side !== 'ally') return 0;
  if (!skill || skill.kind !== 'ammo' || !(skill.ammoLeft > 0)) return skill ? skill.ammoLeft || 0 : 0;
  // 同一次技能开启只翻一次（防止重复挂到同一场 skillStart 上翻四倍）；skillEnd 时复位。
  if (skill.jibianHuoliDone) return skill.ammoLeft;
  skill.jibianHuoliDone = true;
  const n = skill.ammoLeft * 2;
  if (!Number.isFinite(n) || n <= skill.ammoLeft) return skill.ammoLeft;
  skill.ammoLeft = n;
  if (Number.isFinite(skill.ammoMax) && skill.ammoMax > 0) skill.ammoMax = Math.max(skill.ammoMax, n);
  return n;
}

/** 「总攻击」发的三个 S.E.E.S 干员：[精锐, 本体]（取第一个存在的）。 */
const SEES_TRIO = Object.freeze([
  ['chess_zj_60_2_b', 'chess_zj_60_2_a'],   // 虎狼丸
  ['chess_zj_60_4_b', 'chess_zj_60_4_a'],   // 岳羽由加莉
  ['chess_zj_60_3_b', 'chess_zj_60_3_a'],   // 埃癸斯
]);

/** 「银河战舰」发的三名颂乐人偶干员：[精锐, 本体]（取第一个存在的）。 */
const GALAXY_TRIO = Object.freeze([
  ['chess_zj_tmoris_b', 'chess_zj_tmoris_a'],   // 八幡海铃
  ['chess_zj_amoris_b', 'chess_zj_amoris_a'],   // 祐天寺若麦
  ['chess_zj_dolris_b', 'chess_zj_dolris_a'],   // 三角初华
]);


// =====================================================================================
// 惊变羁绊（owner 2026-10-19）：凑齐固定惊变后生效的战斗侧效果。
//   数据见 data/jibianBonds.json；判定见 ./jibianBonds.js。prep 侧的效果在
//   server/match/effectsMeta.js（层数加成 / 免单 / 发卡）里按同一个 activeBonds() 结果实现。
// =====================================================================================
/** 纯视觉体型：多个效果各写一份乘区（1 = 不变），相加后落到 u.visualScale。 */
const setVisScalePart = (u, key, k) => {
  try {
    if (!u) return;
    const mem = (u.mem = u.mem || {});
    const parts = (mem.visScaleParts = mem.visScaleParts || {});
    parts[key] = Number(k) || 1;
    let v = 1;
    for (const p of Object.values(parts)) v += (Number(p) || 1) - 1;
    // 体型范围 0.325 – 7.99（owner 2026-10-26）
    u.visualScale = Math.max(0.325, Math.min(7.99, Math.round(v * 1000) / 1000));
  } catch { /* 视觉失败不影响对局 */ }
};

const BOND_ATTR = (battle, unit, key, mods) => {
  try { battle.addBuff(unit, { key: `jibianbond:${key}`, mods }); } catch { /* 出错不影响对局 */ }
};

/** 把 14 个羁绊里「战斗侧」的部分装上。@param {any} battle @param {Set<string>} owned 已拥有的惊变 effectId */
export function installJibianBonds(battle, owned, playerId = null) {
  try { battle.__jibianBondCalls = (battle.__jibianBondCalls || 0) + 1; battle.__jibianOwned = [...(owned || [])]; } catch { /* dbg */ }
  let act = [];
  try { act = activeBonds(owned); } catch { act = []; }
  if (!act.length) return;
  const has = (id) => act.some((a) => a.def.id === id);

  // 工匠精神（owner 2026-10-25）：每装备 1 个维式战锤系列武器 → 攻击力 +5%（最终乘算，走 atkMul）
  if (has('craftsman')) {
    const HAMMERS = new Set(['chess_item_1_01_e', 'chess_item_2_03_e', 'chess_item_3_09_e', 'chess_item_3_10_e', 'chess_item_4_09_e']);
    const apply = (u) => {
      if (!mine(u)) return;
      let cnt = 0;
      for (const id of itemsOf(u)) if (HAMMERS.has(itemKeyOf(id))) cnt++;
      if (cnt > 0) BOND_ATTR(battle, u, 'craftsman', { atkMul: 1 + 0.05 * cnt });
    };
    battle.on('battleStart', () => { for (const u of allies()) apply(u); }, { priority: 20 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
  }
  const tierOf = (id) => { const a = act.find((x) => x.def.id === id); return a ? a.tier : 0; };
  // ★ 2026-10-21（owner）：战场侧的惊变羁绊**只看自己的卡、只作用于自己的单位**。
  //   之前把全队 picks 并成一个集合调用本函数 —— 队友的卡能替你把羁绊凑齐，加成还发给全场。
  //   现在按玩家分别调用（playerId 非空），allies() 与每个 apply() 都按 ownerId 过滤。
  const mine = (u) => !!u && u.side === 'ally' && (playerId == null || u.ownerId === playerId);
  const allies = () => {
    try {
      const list = battle.allies();
      return playerId == null ? list : list.filter((u) => mine(u));
    } catch { return []; }
  };

  // 钢化你心（owner 2026-10-26）：我方所有干员生命值 +100%（最终乘算 hpMul ×2）
  if (has('steel_heart')) {
    const apply = (u) => { if (mine(u)) BOND_ATTR(battle, u, 'steel_heart', { hpMul: 2 }); };
    battle.on('battleStart', () => { for (const u of allies()) apply(u); }, { priority: 20 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
  }

  // 现代最强：技能不需要技力、攻击力 +1000%、攻速 +360、攻击距离 +2
  if (has('modern_strongest')) {
    const apply = (u) => {
      if (!mine(u)) return;
      if (u.skill && !u.skill.noSkill) u.skill.spCostMul = 0;
      // ★ 2026-10-28：键名必须是 buffs 的 `aspd` / `rangeExtend`（原来写成 attackSpeed / range，
      //   聚合时被静默忽略 —— 玩家反馈「攻速、攻击距离没生效」）。优先级 -100：晚于六眼（10）执行，
      //   否则六眼的 spCostMul=0.1 会把「不再需要技力」覆盖回去。
      BOND_ATTR(battle, u, 'modern', { atkPct: 10, aspd: 360, rangeExtend: 2 });
    };
    battle.on('battleStart', () => { for (const u of allies()) apply(u); }, { priority: -100 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit), { priority: -100 });
    // ★ 2026-10-28（owner）：「需求技力 1，技能结束返还 1 点」—— 引擎把 0 倍率钳到最低 1 点，
    //   技能结束时补回这 1 点，效果就是下一次技能依旧立刻可用，技力条保留但永远回满。
    //   只对真正吃到 modern（spCostMul=0）的单位生效，避免和六眼的 0.1 混在一起。
    battle.on('skillEnd', (ctx) => {
      const u = ctx && ctx.unit;
      if (!u || !mine(u)) return;
      const sk = u.skill;
      if (!sk || sk.noSkill || sk.kind === 'passive') return;
      if (Number(sk.spCostMul) !== 0) return; // 没吃到「不再需要技力」的单位不返
      sk.gainSp(1, 'bond');
    });
  }

  // 重振荣光：卡西米尔干员 攻击力 +100%（二档翻倍）、攻击距离 +1
  const gloryTier = tierOf('glory');
  if (gloryTier > 0) {
    const mul = gloryTier >= 3 ? 2 : 1;
    const apply = (u) => {
      if (!mine(u)) return;
      const bonds = (u.def && u.def.bonds) || [];
      if (!bonds.includes('kazimierzShip')) return;
      BOND_ATTR(battle, u, 'glory', { atkPct: mul, rangeExtend: mul });
    };
    battle.on('battleStart', () => { for (const u of allies()) apply(u); }, { priority: 20 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
  }

  // 共感：开战时把所有我方干员的攻击力拉到「场上最高攻击力」那一档
  if (has('empathy')) {
    battle.on('battleStart', () => {
      const list = allies().filter((u) => u && u.alive !== false);
      if (!list.length) return;
      let top = 0;
      for (const u of list) top = Math.max(top, Number(u.s && u.s.atk) || 0);
      if (!(top > 0)) return;
      for (const u of list) {
        const cur = Number(u.s && u.s.atk) || 0;
        if (cur > 0 && top > cur) BOND_ATTR(battle, u, 'empathy', { atkMul: top / cur });
      }
    }, { priority: 30 });
  }

  // 光荣进化：【阿戈尔】干员基础数值 +300%
  if (has('glorious_evo')) {
    const apply = (u) => {
      if (!mine(u)) return;
      const bonds = (u.def && u.def.bonds) || [];
      if (!bonds.includes('egirShip')) return;
      BOND_ATTR(battle, u, 'evo', { hpMul: 4, atkMul: 4, defMul: 4 });
    };
    battle.on('battleStart', () => { for (const u of allies()) apply(u); }, { priority: 20 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
  }

  // 伤害转伤害：所有伤害变真实伤害（近似：无视目标防御与法术抗性）+ 攻击力 +50%
  try { battle.__dmg2dmgSeen = has('dmg2dmg'); } catch { /* dbg */ }
  if (has('dmg2dmg')) {
    try { battle.__dmg2dmgHook = true; } catch { /* dbg */ }
    // ★ 2026-10-25 修（玩家反馈「触发了伤害转伤害但不是真伤」）：原来只写了 `defIgnore/resIgnore` 两个**不存在的 mod 键**
    //   （引擎是 defIgnoreFlat / resIgnoreFlat，而且忽略防御也不等于真伤 —— 5% 保底和法抗仍在）。现在：
    //   · 在 `hit`（mitigate 之前，damage.js 里 type 在 hit 之后读取）把本玩家干员造成的物理/法术伤害改成 `type:'true'`；
    //   · 元素伤害保持元素结算（元素爆发有自己的通道，强转真伤会绕过元素抗性与爆发逻辑）；
    //   · 攻击力 +50% 仍然用 atkPct（正常加算区）。
    const apply = (u) => {
      if (!mine(u)) return;
      BOND_ATTR(battle, u, 'truedmg', { atkPct: 0.5 });
    };
    battle.on('battleStart', () => { for (const u of allies()) apply(u); }, { priority: 20 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
    battle.on('hit', (ctx) => {
      const dmg = ctx && ctx.dmg;
      const src = (ctx && (ctx.credit ?? ctx.source)) || null;
      const t = ctx && ctx.target;
      try { battle.__dmg2dmgEnter = (battle.__dmg2dmgEnter || 0) + 1; battle.__dmg2dmgCtx = { src: src && src.side, t: t && t.side, type: dmg && dmg.type, mine: src ? mine(src) : null }; } catch { /* dbg */ }
      if (!dmg || !src || !t || src.side !== 'ally' || t.side !== 'enemy' || !mine(src)) return;
      if (dmg.type === 'element' || dmg.type === 'elemental' || dmg.type === 'true') return;
      try { battle.__dmg2dmgRan = (battle.__dmg2dmgRan || 0) + 1; } catch { /* dbg */ }
      dmg.type = 'true';
    });
  }

  // 因为太怕痛就全点防御力了（owner 2026-10-19）
  // ★ 2026-10-21 修：tierOf() 返回的是**阈值**（tiers [2,3] → 2 或 3），不是档位序号。
  //   原来二档写的是 `>= 2`，于是刚凑够 2 个成员（一档）就把「阻挡的敌人每秒 10% 真实伤害」也放出去了。
  const painTier = tierOf('toopainful');
  if (painTier >= 1) {
    const apply = (u) => {
      if (!mine(u)) return;
      BOND_ATTR(battle, u, 'toopainful', { defMul: 1.7, resMul: 1.7 });
    };
    battle.on('battleStart', () => { for (const u of allies()) apply(u); }, { priority: 20 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
  }
  if (painTier >= 3) {
    let acc = 0;
    battle.on('tick', (c) => {
      acc += Number(c && c.dt) || 0;
      if (acc < 1) return;
      acc -= 1;
      for (const u of allies()) {
        if (!mine(u) || !Array.isArray(u.blocking)) continue;
        for (const e of u.blocking) {
          if (!e || !e.alive || !e.s) continue;
          const hp = Number(e.s.maxHp) || 0;
          if (!(hp > 0)) continue;
          try {
            battle.dealDamage(u, e, battle.makeDamage({ amount: hp * 0.1, type: 'true', canDodge: false, tags: ['jibian', 'toopainful'] }));
          } catch { /* 已死亡等：忽略 */ }
        }
      }
    }, { priority: -20 });
  }

}

/**
 * 出老千（羁绊）在**战斗内**是否激活：仅看效果持有者自己的卡。
 * （卡面不写这条 —— owner 要求「不用写明」。）
 */
function cheatPicks(battle, playerId) {
  try {
    const picks = picksOf(battle);
    const owned = new Set();
    for (const id of (picks.get(playerId) || new Map()).keys()) owned.add(id);
    return activeBonds(owned).some((a) => a.def.id === 'cheat');
  } catch { return false; }
}

/** 心之钢的体型倍率：每 10000 最大生命 +3%，上限 +30%（纯视觉）。 */
export function heartsteelScale(maxHp) {
  const hp = Number(maxHp) || 0;
  if (!(hp > 0)) return 1;
  return 1 + Math.min(0.3, Math.floor(hp / 10000) * 0.03);
}

export function install(battle) {
  const picks = picksOf(battle);
  const scoped = scopedRefs(battle);
  // 金酒之杯的数值不在 picks 里（它是 params：整备阶段结束时由 prep 侧写进 ref），所以单独取一份
  const cup = refParamsOf(battle, 'jibian_jinjiuzhibei');
  if (!picks.size && !scoped.length && !cup.size) return;
  const count = (pid, id) => (pid == null ? 0 : picks.get(pid)?.get(id) ?? 0);
  const has = (id) => { for (const m of picks.values()) if (m.has(id)) return true; return false; };
  const owns = (u, id) => !!u && u.side === 'ally' && count(u.ownerId, id) > 0;

  /**
   * 六眼（传说）：「你的所有干员技力消耗-90%」。
   *   技力公式 `Math.floor(baseSpCost * spCostMul + spCostFlat)` → `spCostMul = 0.1` 就是恰好 -90%。
   *   在 battleStart / deploy 上给每个我方单位设一次（幂等：直接赋值），和数万真言的 +100% 同一套写法。
   */
  /**
   * 回归基本功（传说，owner 2026-10-20）：「你的干员不再自动回复技力，但攻击力提升 1000%。」
   *   · 自动回复 = spType 'time' 的自然回能（读 `spRecovery`），用 `spRecoveryMul: 0` 直接乘没；
   *     攻击回复 / 受击回复（'attack' / 'hurt'）不受影响 —— 牌面只写「自动回复」。
   *   · 攻击力 +1000%：`atkPct` 是**比例**（units.js 里 `1 + atkPct`），所以 10 = ×11。
   */
  // 龙的传人（传说，owner 2026-10-24）：「炎」盟约不再生成炎佑（bonds/core.js 里已跳过），
  //   改为每 1000 层任意盟约召唤一只炎佑 —— 攻击力 / 生命值 = 场上该玩家所有干员总和的 30%，上限 9 只。
  const LONGDE = 'jibian_longdechuanren';
  if (has(LONGDE)) {
    battle.on('battleStart', () => {
      for (const ps of battle.players || []) {
        const pid = ps.playerId;
        if (!count(pid, LONGDE)) continue;
        let layers = 0;
        for (const id of activeBondIds(battle, pid) || []) layers += bondLayers(battle, pid, id);
        const n = Math.min(9, Math.floor(layers / 1000));
        if (n <= 0) continue;
        const ops = (battle.allyUnits || []).filter((u) => u && u.alive && u.side === 'ally' && u.kind === 'op' && u.ownerId === pid);
        if (!ops.length) continue;
        let atk = 0, hp = 0;
        for (const u of ops) { atk += Number(u.s && u.s.atk) || 0; hp += Number(u.s && u.s.maxHp) || 0; }
        if (!(atk > 0) || !(hp > 0)) continue;
        const share = 0.3;
        const out = spawnYanyou(battle, pid, { atk: atk * share, hp: hp * share, count: n, atkMul: 1, dmgTakenMul: 1, limit: 9, spread: true });
        for (const y of out) y.mem.bondYan = true;
      }
    }, { priority: 6 });
  }
  if (has('jibian_jibengong')) {
    const KEY = 'jibian:jibengong';
    const apply = (u) => {
      if (!owns(u, 'jibian_jibengong')) return;
      try { battle.addBuff(u, { key: KEY, mods: { atkPct: 10, spRecoveryMul: 0 } }); } catch { /* 不影响对局 */ }
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) apply(u); }, { priority: 10 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
  }

  if (has('jibian_liuyan')) {
    const cheap = (u) => {
      if (!owns(u, 'jibian_liuyan')) return;
      if (u.skill && !u.skill.noSkill) u.skill.spCostMul = owns(u, 'jibian_shuwanzhenyan') ? 0.2 : 0.1;
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) cheap(u); }, { priority: 10 });
    battle.on('deploy', (ctx) => cheap(ctx && ctx.unit));
  }

  // 惊变羁绊（战斗侧）：把已激活羁绊的效果装上
  try {
    // 每个玩家各自一份（自己的卡 → 自己的单位），不再并成全队一份
    for (const [pid, ids] of picks) installJibianBonds(battle, new Set(ids.keys()), pid);
  } catch { /* 不能因为羁绊把对局搞崩 */ }

  // 仇名录（稀有，owner 2026-10-25）：我方干员攻击力 +2%，每击倒一名敌人永久额外 +0.2%
  if (has('jibian_chouminglu')) {
    const KEY = 'jibian:chouminglu';
    const kills = new Map([...refParamsOf(battle, 'jibian_chouminglu')].map(([pid, refs]) => [pid, mergeGrowth(...refs.map(r => r.growth)).kills]));
    const nOf = (pid) => count(pid, 'jibian_chouminglu');
    const apply = (u) => {
      if (!u || u.side !== 'ally' || u.kind !== 'op' || u.ownerId == null) return;
      const n = nOf(u.ownerId);
      if (!(n > 0)) return;
      const atkPct = 0.02 * n + 0.002 * (kills.get(u.ownerId) || 0) * n;
      try { battle.addBuff(u, { key: KEY, mods: { atkPct }, refresh: 'replace', persist: true, allowDead: true }); } catch { /* 不影响对局 */ }
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) apply(u); }, { priority: 10 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
    battle.on('kill', (ctx) => {
      const k = ctx && ctx.killer;
      if (!k || k.side !== 'ally' || k.ownerId == null || !(nOf(k.ownerId) > 0)) return;
      kills.set(k.ownerId, (kills.get(k.ownerId) || 0) + 1);
      battleGrowth(battle, k.ownerId, 'jibian_chouminglu').kills++;
      for (const u of battle.allies()) if (u && u.ownerId === k.ownerId) apply(u);
    });
  }

  // 霸王血铠（稀有，owner 2026-10-26）：我方干员获得相当于自身生命值 20% 的额外攻击力
  if (has('jibian_bawangxuekai')) {
    const KEY = 'jibian:bawangxuekai';
    const apply = (u) => {
      if (!u || u.side !== 'ally' || u.kind !== 'op' || u.ownerId == null) return;
      if (!(count(u.ownerId, 'jibian_bawangxuekai') > 0)) return;
      const hp = Number(u.s && u.s.maxHp) || 0;
      const atk = Math.max(0, Math.floor(hp * 0.2));
      if (!(atk > 0)) return;
      try { battle.addBuff(u, { key: KEY, mods: { atkFlat: atk }, refresh: 'replace', persist: true, allowDead: true }); } catch { /* 不影响对局 */ }
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) apply(u); }, { priority: 11 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
    battle.on('layerGain', () => { for (const u of battle.allies()) apply(u); });
    battle.on('jibianHpGrowth', ({ unit }) => apply(unit));
  }

  // 心之钢（传说，owner 2026-10-26）：攻击额外造成 700(+3% 最大生命) 物理伤害，并永久 +10% 该伤害的最大生命
  //   （每个目标 30s 冷却）；每 10000 最大生命 +3% 体型（最多 +30%，纯视觉）。
  if (has('jibian_xinzhigang')) {
    const KEY = 'jibian:xinzhigang';
    const CD = 30, BASE = 700, HP_RATIO = 0.03, GAIN_RATIO = 0.1;
    const last = new Map();   // 攻击者 / 目标 → 上次触发时间
    const grow = new Map();   // 玩家 / 棋子 uid → 累计永久最大生命
    const keyOf = u => `${u.ownerId}:${u.uid ?? u.id}`;
    for (const [pid, refs] of refParamsOf(battle, 'jibian_xinzhigang')) {
      for (const [uid, hp] of Object.entries(mergeGrowth(...refs.map(r => r.growth)).hp)) grow.set(`${pid}:${uid}`, hp);
    }
    const refreshScale = (u) => {
      if (!u) return;
      const hp = Number(u.s && u.s.maxHp) || 0;
      setVisScalePart(u, 'heartsteel', heartsteelScale(hp));
    };
    const applyHp = (u) => {
      const n = grow.get(keyOf(u)) || 0;
      if (!(n > 0)) return;
      try { battle.addBuff(u, { key: KEY, mods: { hpFlat: n }, refresh: 'replace', persist: true, allowDead: true }); } catch { /* 不影响对局 */ }
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) { applyHp(u); refreshScale(u); } }, { priority: 12 });
    battle.on('deploy', (ctx) => { const u = ctx && ctx.unit; if (u) { applyHp(u); refreshScale(u); } });
    battle.on('hit', (ctx) => {
      const dmg = ctx && ctx.dmg;
      const src = (ctx && (ctx.credit ?? ctx.source)) || null;
      const t = ctx && ctx.target;
      if (!dmg || !src || !t || src.side !== 'ally' || src.kind !== 'op' || t.side !== 'enemy' || !src.alive) return;   // 仅干员（召唤物不触发）
      if (!(count(src.ownerId, 'jibian_xinzhigang') > 0) || !dmg.isAttack) return;
      // 附加伤害自己触发的 hit 不再连锁（双保险：mem 标记 + 伤害 tag）
      if (Array.isArray(dmg.tags) && dmg.tags.includes('jibian:xinzhigang')) return;
      if (battle.mem && battle.mem.hsBusy) return;      // 附加伤害自己触发的 hit 不再连锁
      const tid = `${src.id}:${t.id}`;
      const now = Number(battle.time) || 0;
      const prev = last.get(tid);
      if (prev != null && now - prev < CD) return;
      last.set(tid, now);
      const hp = Number(src.s && src.s.maxHp) || 0;
      const amount = BASE + hp * HP_RATIO;
      if (battle.mem) battle.mem.hsBusy = true;
      try { battle.dealDamage(src, t, { amount, type: 'phys', canDodge: false, tags: ['jibian:xinzhigang'] }); }
      catch { /* 目标已离场等 */ }
      finally { if (battle.mem) battle.mem.hsBusy = false; }
      try { battle.fx('heartsteel', { x: src.x, y: src.y, id: src.id, src: src.id }); } catch { /* 音效事件失败不影响伤害 */ }
      const gain = amount * GAIN_RATIO;
      const k = keyOf(src);
      grow.set(k, (grow.get(k) || 0) + gain);
      if (Number.isInteger(src.uid)) {
        const hp = battleGrowth(battle, src.ownerId, 'jibian_xinzhigang').hp;
        hp[src.uid] = (hp[src.uid] || 0) + gain;
      }
      applyHp(src);
      battle.emit('jibianHpGrowth', { unit: src });
      try { battle.heal(src, src, gain, { self: true }); } catch { /* ignore */ }
      for (const u of battle.allies()) if (u.ownerId === src.ownerId) refreshScale(u);
    });
  }

  // 火力不足恐惧症：我方干员开技能 → 子弹数翻倍（见 doubleAmmoForJibian 的注释）
  if (has('jibian_huolibuzu')) {
    battle.on('skillStart', ({ unit, skill }) => { if (owns(unit, 'jibian_huolibuzu')) doubleAmmoForJibian(battle, unit, skill); }, { priority: -20 });
    battle.on('skillEnd', ({ skill }) => { if (skill) skill.jibianHuoliDone = false; });
  }

  // ---- 2026-10-17（S.E.E.S 版本新增，用户 S.E.E.S.txt）----------------------------------------------
  /**
   * 数万真言（史诗）：「你的干员开启技能所需的技力增加100%，但技能持续期间攻击力+300%」。
   *   · 技力需求：`server/sim/skills.js:215` 的公式是
   *       `Math.floor(this.baseSpCost * this.spCostMul + unit.s.spCostFlat)`
   *     所以把 `skill.spCostMul` 置 2 就是**恰好 +100%**（不用 spCostFlat，那会把别的加成也翻倍）。
   *     在 battleStart / deploy 上给每个我方单位设一次（幂等：直接赋值）。
   *   · 技能期间攻击力：`skillStart` 上 `atkPct: 3`（= +300%，ADD_KEYS 加算），`skillEnd` 撤掉。
   *     只认我方单位（全局事件，敌人开技不能吃到）。
   */
  if (has('jibian_shuwanzhenyan')) {
    const ATK_KEY = P + 'shuwanzhenyan:atk';
    const bump = (u) => {
      if (!owns(u, 'jibian_shuwanzhenyan')) return;
      if (u.skill && !u.skill.noSkill) u.skill.spCostMul = owns(u, 'jibian_liuyan') ? 0.2 : 2;
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) bump(u); }, { priority: 10 });
    battle.on('deploy', (ctx) => bump(ctx && ctx.unit));
    battle.on('skillStart', (ctx) => {
      const u = ctx && ctx.unit;
      if (!owns(u, 'jibian_shuwanzhenyan') || !u.alive) return;
      battle.addBuff(u, { key: ATK_KEY, mods: { atkPct: 3 } });
    });
    battle.on('skillEnd', (ctx) => {
      const u = ctx && ctx.unit;
      if (u) battle.removeBuff(u, ATK_KEY);
    });
  }

  /**
   * 无下限术式（传说）：「你的所有干员获得99.9%的闪避」。
   *   `dodgePhys` / `dodgeArts` 是 ADD_KEYS 里的两个独立来源（server/sim/buffs.js:22），
   *   多次来源按 `1 − Π(1 − p)^stacks` 合成 ⇒ 0.999 就是 99.9%。
   *   只有 phys/arts 能被闪避（true 伤害不吃 dodge，damage.js:82 的既有规则）。
   *   与「金酒之杯」同一手法：battleStart 覆盖已在场的，deploy 覆盖中途登场的（召唤物也算）。
   */
  if (has('jibian_wuxiaxian')) {
    const DODGE_KEY = P + 'wuxiaxian';
    const apply = (u) => {
      if (!owns(u, 'jibian_wuxiaxian')) return;
      passiveBuff(battle, u, `${DODGE_KEY}:${u.uid ?? ''}`, { dodgePhys: 0.999, dodgeArts: 0.999 });
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) apply(u); }, { priority: 10 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
  }

  // ---- 0. per-piece refs (超大杯): only the operator the card named, wherever it stands. `deploy` covers a piece
  // deployed later; battleStart covers the ones already on the field.
  if (scoped.length) {
    const apply = (u) => {
      if (!u || u.side !== 'ally' || u.uid == null) return;
      for (const s of scoped) {
        if (String(s.params.uid) !== String(u.uid)) continue;
        if (s.id === 'chaodabei') {
          passiveBuff(battle, u, `${P}chaodabei:${u.uid}`, { ...directMods({ atk: Number(s.params.atkPct) || 2 }), spRecoveryFlat: Number(s.params.spRecoveryFlat) || 2 });
        }
      }
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) apply(u); }, { priority: 10 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
  }

  // ---- 0b. 金酒之杯: one buff per operator per pick, from the numbers the prep side wrote into the ref's `params` at
  // the last 整备阶段结束 (cupSettle). The range is the WIDEST reading of 「所有我方单位」 (用户 2026-10-13): every live
  // friendly unit of that player — 干员、召唤物（token）与装置/道具单位（device）— so ownUnits() instead of playerOps().
  // `deploy` covers a summon / device that only appears mid-battle (battle/summons.js emits it); passiveBuff is
  // idempotent (same key ⇒ refresh 'replace'), so re-applying on a reposition is free.
  if (cup.size) {
    const apply = (u) => {
      if (!u) return;
      const list = cup.get(u.ownerId);
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        const p = list[i] || {};
        const aspd = Number.isFinite(p.aspd) ? p.aspd : 0;
        const atk = Number.isFinite(p.atkPct) ? p.atkPct : 0;
        const hp = Number.isFinite(p.hpPct) ? p.hpPct : 0;
        if (!aspd && !atk && !hp) continue;
        passiveBuff(battle, u, `${P}jinjiuzhibei:${i}`, { ...directMods({ atk, hp }), ...(aspd ? { aspd } : {}) });
      }
    };
    battle.on('battleStart', () => {
      for (const pid of cup.keys()) for (const u of ownUnits(battle, pid)) apply(u);
    }, { priority: 10 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
  }

  // ---- 1. passives on every own operator, from battle start on.
  // priority 10: 晚安教官 / 星界躯体 pick 场上生命最高的干员 by the operator's OWN max HP, so this runs before the
  // battleStart handlers that add HP (choices.js uses -10).
  battle.on('battleStart', () => {
    for (const [pid, ids] of picks) {
      const ops = playerOps(battle, pid);
      for (const u of ops) {
        for (const [id, modsOf] of OP_PASSIVES) {
          const n = ids.get(id) ?? 0;
          if (n > 0) passiveBuff(battle, u, P + id, modsOf(n));
        }
        // 嗜血: "你的干员不再成为友方单位的治疗目标" — the engine's own 禁疗 flag (`noHeal` stops a heal from ANOTHER
        // unit; the card's own lifesteal is a self-heal and still lands).
        if (ids.has('jibian_shixue')) {
          battle.addBuff(u, { key: P + 'jibian_shixue', flags: { noHeal: true }, persist: true, allowDead: true, refresh: 'replace' });
        }
      }
      // 晚安教官 / 星界躯体: ONE operator — the field's highest max HP at battle start (the official text names 场上,
      // so an undeployed hand piece never takes it; ties go to the first in board order).
      const field = playerOps(battle, pid, { fieldOnly: true });
      if (field.length) {
        let top = field[0];
        for (const u of field) if (u.s.maxHp > top.s.maxHp) top = u;
        const nW = ids.get('jibian_wananjiaoguan') ?? 0;
        const nX = ids.get('jibian_xingjieshenti') ?? 0;
        if (nW > 0) passiveBuff(battle, top, P + 'jibian_wananjiaoguan', { hpPct: 1 * nW, defFlat: 400 * nW, blockCnt: 2 * nW });
        // ★ 2026-10-26（owner）：星界躯体改成「我方每个干员生命值 +150%」——不再只给血最高的那一个。
        if (nX > 0) for (const u of field) passiveBuff(battle, u, P + 'jibian_xingjieshenti', { hpPct: 1.5 * nX });
      }
    }
  }, { priority: 10 });

  // 再部署同样保留常驻惊变；初次部署时尚未执行 battleStart，由上面的开场逻辑结算。
  battle.on('deploy', ({ unit: u, initial }) => {
    if (initial || !u || u.side !== 'ally' || u.kind !== 'op') return;
    for (const [id, modsOf] of OP_PASSIVES) {
      const n = count(u.ownerId, id);
      if (n > 0) passiveBuff(battle, u, P + id, modsOf(n));
    }
    const x = count(u.ownerId, 'jibian_xingjieshenti');
    if (x > 0) passiveBuff(battle, u, P + 'jibian_xingjieshenti', { hpPct: 1.5 * x });
    if (owns(u, 'jibian_shixue')) battle.addBuff(u, { key: P + 'jibian_shixue', flags: { noHeal: true }, persist: true, allowDead: true, refresh: 'replace' });
  });

  // ---- 1b. 腐蚀（owner 2026-10-16）: 被阻挡的敌方单位每秒失去 4% 当前防御/法抗。
  //   "当前"且按比例 ⇒ 每跳读当前值再乘 0.96 地减（写成减固定值会穿到负数）。`blockedBy` 是**单个**阻挡者
  //   （battle/blocking.js: e.blockedBy = u），所以判定就是 !!e.blockedBy。一个敌人一个 buff（key 固定，
  //   refresh 'replace' 幂等）；不再被阻挡时直接把减益撤掉（"被阻挡的"是条件，条件没了效果也该停）。
  if (has('jibian_fushi')) {
    const seen = new WeakSet();
    battle.every(0.5, () => {
      for (const e of battle.enemies) {
        if (!e || !e.alive) continue;
        if (!owns(e.blockedBy, 'jibian_fushi')) continue;
        if (seen.has(e)) continue;
        seen.add(e);
        battle.addBuff(e, {
          key: P + 'jibian_fushi', duration: Infinity, interval: 1, refresh: 'replace', visible: true,
          onTick: () => {
            if (!e.alive || !owns(e.blockedBy, 'jibian_fushi')) return;
            const def = Number(e.s && e.s.def), res = Number(e.s && e.s.res);
            if (!(def > 0) && !(res > 0)) return;
            const old = e.findBuff(P + 'jibian_fushi:mod')?.mods || {};
            battle.addBuff(e, {
              key: P + 'jibian_fushi:mod', duration: Infinity, refresh: 'replace', visible: false,
              mods: { defFlat: (old.defFlat || 0) - def * 0.04, resFlat: (old.resFlat || 0) - res * 0.04 },
            });
          },
        });
      }
    });
  }

  // ---- 1c. 冰霜光环（owner 2026-10-16）: 每 10 秒，你的干员对周围敌人施加寒冷 2s。
  //   "周围" = 半径 1.5 格（引擎既有的环/溅射口径）；首次立即触发，之后每 10/n 秒一次（多次拿按次数缩短间隔）。
  if (has('jibian_shuangguanghuan')) {
    battle.on('battleStart', () => {
      for (const [pid, ids] of picks) {
        const n = ids.get('jibian_shuangguanghuan') ?? 0;
        if (n <= 0) continue;
        const pulse = () => {
          for (const u of playerOps(battle, pid)) {
            if (!u || !u.alive) continue;
            for (const e of battle.foesInRadius(u.x, u.y, 1.5)) battle.applyStatus(e, 'cold', { duration: 2, source: u });
          }
        };
        pulse();
        battle.every(10 / n, pulse);
      }
    }, { priority: 5 });
  }

  // ---- 1d. 大乱斗（owner 2026-10-16）: 战斗开始时，你的所有干员部署位置随机改变（owner 选 B）。
  //   安全性: 只在自己的合法可部署格里洗牌 —— 近战/远程 分开（grid.canStand 是引擎对"这类单位能不能站这格"
  //   的权威判定），再用 battle.relocate() 落位（自带 存活/已部署/在范围内/无人占用/无倒地干员 检查，失败返回
  //   false 且什么都不改）。用 battle.rng 洗牌 ⇒ 同种子可复现（回放一致）。
  //   只改位置、不改朝向: 卡面写的是"位置/方向"，但随机朝向会把近战干员的攻击范围整个翻面，手感是另一张卡；
  //   owner 若要朝向也随机，这里加一行 unit.dir = ... 即可。
  if (has('jibian_daluandou')) {
    const isRanged = (u) => u?.def?.position === 'RANGED' || u?.profile?.attack === 'RANGED';
    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) { const j = battle.rng.int(i + 1); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
      return arr;
    };
    battle.on('battleStart', () => {
      for (const [pid, ids] of picks) {
        if (!(ids.get('jibian_daluandou') ?? 0)) continue;
        // 出老千：不改部署位置，攻击力加成保留（下面 shuffle 段跳过）
        const noShuffle = cheatPicks(battle, pid);
        if (noShuffle) { for (const u of playerOps(battle, pid)) { if (u && u.alive) passiveBuff(battle, u, P + 'daluandou:atk', { atkMul: 2 }); } continue; }
        const ps = (battle.players || []).find((p) => p && p.playerId === pid);
        if (!ps) continue;
        const melee = [], ranged = [];
        for (let r = 0; r < GEO.ROWS; r++) {
          for (let c = 0; c < GEO.COLS; c++) {
            if (!battle.grid.inRect(r, c) || !battle.onOwnBoard(ps, r, c)) continue;
            if (battle.grid.canStand(r, c, { ranged: false })) melee.push([r, c]);
            else if (battle.grid.canStand(r, c, { ranged: true })) ranged.push([r, c]);
          }
        }
        const ops = playerOps(battle, pid).filter((u) => u && u.alive && !u.removed && u.kind === 'op');
        const mUnits = shuffle(ops.filter((u) => !isRanged(u)));
        const rUnits = shuffle(ops.filter(isRanged));
        const freeM = shuffle(melee.filter(([r, c]) => !battle.isReservedTile(r, c)));
        const freeR = shuffle(ranged.filter(([r, c]) => !battle.isReservedTile(r, c)));
        for (const u of mUnits) { const t = freeM.pop(); if (t) battle.relocate(u, t[0], t[1]); }
        for (const u of rUnits) { const t = freeR.pop(); if (t) battle.relocate(u, t[0], t[1]); }
        // ★ 2026-10-17（用户：「给大乱斗加个效果 你的干员攻击力+100%」）：
        //   牌面加了一条补偿 —— 位置被打乱，但攻击力翻倍。用 passiveBuff 的 atkMul（和 enemy 侧
        //   triple() 同一套乘法），persist 到整场，战斗结束随单位一起消失。
        for (const u of ops) passiveBuff(battle, u, P + 'daluandou:atk', { atkMul: 2 });
      }
    }, { priority: 5 });
  }

  // ---- 1e. 薛定谔的猫（owner 2026-10-16）: 战斗阶段开始时，你的干员各随机获得
  //   「无法被击倒」或「立刻被击倒，并且无法再部署」；战斗阶段结束时清空效果。
  //   实现：开场给每个干员抽签（1 = 不死 / 0 = 处决）。不死的用引擎的致命拦截点 `fatal` 钩子把伤害按回去
  //   （`ctx.prevented = true`，同 professions.js 的傀儡师切换写法，并留 1 点生命）；
  //   处决的走引擎正常的 dealDamage（巨额真实伤害），所以「自爆卡车」这类死亡钩子照常触发、也照常消耗再部署名额。
  if (has('jibian_xuedingedemao')) {
    const fatalKey = P + 'xuedingedemao:fatal';
    battle.on('battleStart', () => {
      for (const [pid, ids] of picks) {
        if (!(ids.get('jibian_xuedingedemao') ?? 0)) continue;
        for (const u of playerOps(battle, pid)) {
          if (!u || !u.alive) continue;
          // 出老千：只获得「无法被击倒」
          const lucky = cheatPicks(battle, pid) ? true : battle.rng() < 0.5;
          u.mem.catLucky = lucky;
          if (!lucky) {
            // ★ 2026-10-21 修（玩家反馈：抽到「立刻被击倒，并且无法再部署」的干员，计时转完照样复活）：
            //   dealDamage 走的是正常击倒流程，_remove 会排 respawnAt、_checkRedeploys 到点就把它放回来。
            //   这里用引擎已有的 redeployLocked 锁（_checkRedeploys 会跳过；砾的「每回合最多再部署 20 次」同一把锁）。
            u.redeployLocked = true;
            try {
              battle.dealDamage(null, u, { amount: 1e9, type: 'true', canDodge: false, sourceless: true, tags: ['cat'] });
            } catch { /* 已倒地/不可选中：跳过 */ }
          }
        }
      }
    }, { priority: 5 });
    // 不死：任何致命一击都被按回去（只对抽到"无法被击倒"的自己人）
    battle.on('fatal', (ctx) => {
      const u = ctx && ctx.unit;
      if (!u || u.side !== 'ally' || !u.mem || !u.mem.catLucky) return;
      ctx.prevented = true;
      if (u.hp < 1) u.hp = 1;
    }, { priority: -999 });
  }

  // ---- 黑闪（jibian_heishan，传说，现代最强）：暴击率 +50 个百分点；每次暴击回 3 技力 ----
  //   ★ 2026-10-22（owner）。暴击本身由炸惊的「锻造器」(content/forge.js) 实现：它在 hit 钩子里读
  //   `s.critRate` 掷骰，命中时 `dmg.crit = true`。这里只做两件事：
  //     ① 给该玩家的干员挂常驻 `critRate +0.5`（和锻造器的 5% 基础是加算）；
  //        召唤物默认不吃（"不包括"），但**本来就能暴击的**单位（s.critRate > 0）照样给。
  //     ② 注册一个 priority -10 的 hit 钩子（排在 forge 之后），看到 `dmg.crit` 就给出手者 +3 技力，
  //        每次暴击都回、没有上限。
  for (const [pid, ids] of picks) {
    if (!(ids.get('jibian_heishan') ?? 0)) continue;
    const HEISHAN_CRIT = P + 'heishan:crit';
    const applyOne = (u) => {
      if (!u || u.side !== 'ally' || u.removed || u.ownerId !== pid) return;
      const canCrit = u.kind === 'op' || Number(u.s && u.s.critRate) > 0;
      if (!canCrit) return;
      if (typeof u.findBuff === 'function' && u.findBuff(HEISHAN_CRIT)) return;
      battle.addBuff(u, { key: HEISHAN_CRIT, mods: { critRate: 0.5 }, persist: true });
    };
    for (const u of battle.allyUnits) applyOne(u);
    battle.on('deploy', (ctx) => applyOne(ctx && ctx.unit));
    battle.on('hit', (ctx) => {
      const dmg = ctx && ctx.dmg;
      const s = ctx && (ctx.credit ?? ctx.source);
      if (!dmg || !dmg.crit || !s || s.side !== 'ally' || s.ownerId !== pid) return;
      if (s.skill && typeof s.skill.gainSp === 'function') s.skill.gainSp(3, 'jibian');
    }, { priority: -10 });
  }

  // ---- 1e-2. 加入大群 / 叠层手（owner 2026-10-21 修）
  //   两张卡的 prep 侧 handler 挂在 onLayers 上、按 reason 判「是不是卫戍特质加的层」，但**永远收不到**：
  //   特质加层发生在 sim 里（support.gainLayers → battle.addLayers，reason='garrison'），
  //   结算时 match/settle 只拿到按盟约聚合后的 layerGains，并以 reason='battle' 重新派发 onLayers。
  //   所以在加层发生的那一刻处理 —— battle 的 layerGain 钩子（魔王 +1 用的同一条）。
  //   需要的两个事实（是否拥有浊心斯卡蒂、叠层手是否还在生效期）由匹配赛写进 battleInput.jibianFlags。
  {
    const jiaru = has('jibian_jiarudaqun');
    const diec = has('jibian_diecengshou');
    if (jiaru || diec) {
      battle.on('layerGain', (ctx) => {
        const pid = ctx && ctx.playerId;
        if (!pid || !(ctx.n > 0)) return;
        if (!/^garrison(:|$)/.test(String(ctx.reason || ''))) return;
        const ps = (battle.players || []).find((p) => p && p.playerId === pid);
        // battle 的 player 对象只挑字段复制（sim/battle/players.js），jibianFlags 留在原始 input 上
        const flags = (ps && (ps.jibianFlags || (ps.input && ps.input.jibianFlags))) || {};
        const extra = jibianGarrisonExtra(ctx.n, {
          bondId: ctx.bondId,
          jiaru: jiaru && count(pid, 'jibian_jiarudaqun') > 0,
          skadi: !!flags.skadi,
          diecengshou: diec && count(pid, 'jibian_diecengshou') > 0,
          doubler: !!flags.doubler,
        });
        if (extra > 0) ctx.n += extra;
      });
    }
  }

  // ---- 1f. 赤霄剑法（owner 2026-10-16）: 你的所有干员造成的伤害改为弱点伤害
  //   （物理/法术里选目标抗性更低的那一种，同 双模机械臂 / 陈 的 band 以己之长）。
  if (has('jibian_chixiaojianfa')) {
    // 打开赤刃明霄陈三技能剑气波的每击上限（她的 kit 常量默认 150000 是主人的平衡值；owner 2026-10-18 把卡面限伤改成 2 亿）
    battle.jibianChen3WaveCap = 200000000;   // ★ 2026-10-18（owner）：卡面限伤 50w → 2 亿
    battle.on('hit', (ctx) => {
      const dmg = ctx && ctx.dmg;
      const src = (ctx && (ctx.credit ?? ctx.source)) || null;
      const t = ctx && ctx.target;
      if (!dmg || !owns(src, 'jibian_chixiaojianfa') || !t || t.side !== 'enemy') return;
      try { weaknessRetype(dmg, src, t); } catch { /* 目标已离场：跳过 */ }
    });
  }

  // ---- 2. 击杀: 坦克引擎 / 缩小引擎 (permanent stacks) and 罪恶快感 (20 SP)
  if (has('jibian_suoxiaoyinqing') || has('jibian_zuiegankuai')) {
    battle.on('kill', (ctx) => {
      const killer = ctx && ctx.killer;
      const victim = ctx && ctx.victim;
      if (!killer || !victim || victim.side !== 'enemy' || killer.side !== 'ally') return;
      const pid = killer.ownerId;
      const nZ = count(pid, 'jibian_zuiegankuai');
      // "每击倒一名敌人永久提升血量1%" / "…技力恢复速度0.05/s": one stack per kill, on the KILLER (a summon's kill
      // is credited to the summon, which is what the card's 你的干员 covers — 召唤物 are the operator's own pieces).
      if (nZ > 0 && killer.skill) for (let i = 0; i < nZ; i++) killer.skill.gainSp(20, 'jibian');
    });
  }

  // 坦克引擎（owner 2026-10-26 改版）：我方干员获得特质「击杀 +1 层：体型 +5%、最大生命 +5%，可无限叠加；阵亡损失 65% 层数」。
  //   层数按**单位**记（谁击杀谁叠），因此用 uid 作为 key；死亡时留 floor(层数×35%)。
  if (has('jibian_tankeyinqing')) {
    const KEY = P + 'jibian_tankeyinqing:layers';
    const layers = new Map();     // uid → 层数
    const keyOf = (u) => u.uid ?? u.id;
    const owned = (u) => !!u && u.side === 'ally' && u.kind === 'op' && count(u.ownerId, 'jibian_tankeyinqing') > 0;
    const apply = (u) => {
      if (!owned(u)) return;
      const n = layers.get(keyOf(u)) || 0;
      try { battle.addBuff(u, { key: KEY, mods: { hpPct: 0.05 * n }, refresh: 'replace', persist: true, allowDead: true }); } catch { /* 不影响对局 */ }
      setVisScalePart(u, 'tank', 1 + 0.05 * n);
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) apply(u); }, { priority: 12 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
    battle.on('kill', (ctx) => {
      const k = ctx && ctx.killer;
      if (!k || !owned(k)) return;
      const id = keyOf(k);
      layers.set(id, (layers.get(id) || 0) + 1);
      apply(k);
    });
    battle.on('death', (ctx) => {
      const u = ctx && ctx.unit;
      if (!u || !owned(u)) return;
      const id = keyOf(u);
      const n = layers.get(id) || 0;
      if (!(n > 0)) return;
      layers.set(id, Math.floor(n * 0.35));   // 阵亡损失 65%
      apply(u);
    });
  }

  // 缩小引擎（owner 2026-10-26 改版）：击杀 +1 层：体型 -4%、技力恢复 +0.05/s，无限叠加；阵亡损失 65% 层数。
  if (has('jibian_suoxiaoyinqing')) {
    const KEY = P + 'jibian_suoxiaoyinqing:layers';
    const layers = new Map();
    const keyOf = (u) => u.uid ?? u.id;
    const owned = (u) => !!u && u.side === 'ally' && u.kind === 'op' && count(u.ownerId, 'jibian_suoxiaoyinqing') > 0;
    const apply = (u) => {
      if (!owned(u)) return;
      const n = layers.get(keyOf(u)) || 0;
      try { battle.addBuff(u, { key: KEY, mods: { spRecoveryFlat: 0.05 * n }, refresh: 'replace', persist: true, allowDead: true }); } catch { /* 不影响对局 */ }
      setVisScalePart(u, 'shrink', 1 - 0.04 * n);
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) apply(u); }, { priority: 12 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
    battle.on('kill', (ctx) => {
      const k = ctx && ctx.killer;
      if (!k || !owned(k)) return;
      const id = keyOf(k);
      layers.set(id, (layers.get(id) || 0) + 1);
      apply(k);
    });
    battle.on('death', (ctx) => {
      const u = ctx && ctx.unit;
      if (!u || !owned(u)) return;
      const id = keyOf(u);
      const n = layers.get(id) || 0;
      if (!(n > 0)) return;
      layers.set(id, Math.floor(n * 0.35));
      apply(u);
    });
  }

  // ---- 3. 攻击后: 踢踏舞 (ASPD stacks) and 美国子弹 (an extra 40%-ATK physical bullet at a random enemy in range)
  if (has('jibian_titawu') || has('jibian_meiguozidan')) {
    battle.on('attack', (ctx) => {
      const a = ctx && ctx.attacker;
      if (!a || a.side !== 'ally') return;
      const pid = a.ownerId;
      // 踢踏舞: "每次普通攻击后获得持续2s的攻击速度+2，可叠加，叠加后刷新持续时间" — normal attacks only (a skill's
      // own hits are not 普通攻击), one stack per attack, 'stack' refresh resets the 2 s timer.
      const nT = count(pid, 'jibian_titawu');
      if (nT > 0 && !ctx.isSkill) {
        for (let i = 0; i < nT; i++) battle.addBuff(a, { key: P + 'jibian_titawu', mods: { aspd: 2 }, duration: 2, refresh: 'stack', maxStacks: 1e6 });
      }
      // 美国子弹: "每次攻击对攻击范围内随机一名敌人发射子弹，造成 40% 攻击力的物理伤害" — every attack (skill attacks
      // included: the text says 每次攻击), one bullet per pick, at a random enemy inside the attacker's live range.
      const nB = count(pid, 'jibian_meiguozidan');
      if (nB > 0) {
        const foes = battle.enemiesInKeys(a.rangeKeys, a, a.profile);
        if (foes.length) {
          for (let i = 0; i < nB; i++) {
            const t = foes[Math.floor(battle.rng() * foes.length) % foes.length];
            if (!t || !t.alive) continue;
            battle.dealDamage(a, t, battle.makeDamage({ amount: a.s.atk * 0.4, type: 'phys', isAttack: true, isProjectile: true, tags: ['jibian'] }));
          }
        }
      }
    });
  }

  // ---- 4. 普通攻击吸血: 吸血习性 (15%) / 嗜血 (25%). The heal rides the damage instance, so the in-flight attack's
  // kind is remembered on `beforeAttack` (it fires immediately before the hit; the damage pipeline is synchronous).
  if (has('jibian_xixuexixing') || has('jibian_shixue')) {
    battle.on('damaged', (ctx) => {
      const s = ctx && ctx.source;
      const t = ctx && ctx.target;
      if (!s || !t || s.side !== 'ally' || t.side !== 'enemy') return;
      if (!ctx.dmg?.isAttack || ctx.dmg.isSkill) return;
      if (!(ctx.amount > 0) || !s.alive) return;
      const nS = count(s.ownerId, 'jibian_shixue');
      const nX = count(s.ownerId, 'jibian_xixuexixing');
      const pct = 0.25 * nS + 0.15 * nX;
      if (pct > 0) battle.heal(s, s, ctx.amount * pct, { self: true });
    });
  }

  // ---- 5. 你摸不到: 开启技能后无敌 1s
  if (has('jibian_nimobudao')) {
    battle.on('skillStart', (ctx) => {
      const u = ctx && ctx.unit;
      if (!u || u.side !== 'ally') return;
      const n = count(u.ownerId, 'jibian_nimobudao');
      if (n > 0) battle.addBuff(u, { key: P + 'jibian_nimobudao', flags: { invulnerable: true }, duration: 1 * n, refresh: 'replace', visible: true });
    });
  }

  // ---- 6. ？！冰？！: doubled 寒冷 / 冻结 durations (+ the card's 「冰冰冰」 cue)
  if (has('jibian_bing')) {
    // beforeStatus is emitted by Battle.applyStatus before the status lands and its `duration` is read back from the
    // (mutable) ctx — doubling it here is the whole "持续时间翻倍" of the card. Only the player's OWN 施加 counts.
    battle.on('beforeStatus', (ctx) => {
      if (!ctx || (ctx.status !== 'cold' && ctx.status !== 'freeze')) return;
      const src = ctx.source;
      if (!src || src.side !== 'ally') return;
      const n = count(src.ownerId, 'jibian_bing');
      if (n <= 0) return;
      if (Number.isFinite(ctx.duration)) ctx.duration *= 1 + n;
      // 卡池 hidden 备注（写给开发者的）:「选择此惊变后，此玩家每次触发寒冷或冻结时播放冰冰冰音效」。
      // 走 fx 通道只是为了让客户端知道"谁触发了"——多带 ownerId，客户端只给卡主自己响
      // (ui/gameLogic/bingCue.js)；不带动画，render 侧对未知 fx kind 什么也不做 (shared/protocol.js fxForm)。
      battle.fx('jibianBing', { x: src.x ?? 0, y: src.y ?? 0, id: src.id, owner: src.ownerId, status: ctx.status });
    });
  }

  // ---- 7. per-instance damage multipliers — ？！冰？！ (+50% vs a chilled/frozen target) and 元素大师 (a burst's damage
  // ×2). The `hit` hook (damage.js) runs once per damage instance with the MUTABLE DamageInfo, before mitigation, and
  // knows the target: the only place a "对处于X状态的敌人造成的伤害+N%" card can be applied per target. A stat buff on
  // the attacker would leak onto every target of the same attack (and onto non-chilled ones).
  // `credit` names the unit that still owns a 无来源 (sourceless) instance — an element burst's hits carry it while
  // `source` is null (damage.js dealDamage).
  if (has('jibian_bing') || has('jibian_yuansudashi')) {
    battle.on('elementBurst', (ctx) => {
      if (ctx.source?.side === 'ally' && ctx.target?.side === 'enemy') ctx.effectMul *= 1 + count(ctx.source.ownerId, 'jibian_yuansudashi');
    });
    battle.on('hit', (ctx) => {
      const dmg = ctx && ctx.dmg;
      const s = (ctx && (ctx.credit ?? ctx.source)) || null;
      const t = ctx && ctx.target;
      if (!dmg || !s || !t || s.side !== 'ally' || t.side !== 'enemy') return;
      const nB = count(s.ownerId, 'jibian_bing');
      if (nB > 0 && chilled(t)) dmg.mul *= 1 + 0.5 * nB;
      // 元素大师: "元素损伤爆发的伤害和效果翻倍" — every hit of a burst carries the 'burst' tag (damage.js resolveBurst:
      // the immediate hit, the 凋亡 per-second ticks and the 侵蚀 per-second true damage), so all of a burst's damage is
      // doubled. (The burst's STATUS part — palsy stacks / lock duration — is engine-owned inside resolveBurst with no
      // burst marker of its own, and is NOT doubled; documented as the remaining half of this card.)
      const nE = count(s.ownerId, 'jibian_yuansudashi');
      if (nE > 0 && Array.isArray(dmg.tags) && dmg.tags.includes('burst')) dmg.mul *= 1 + nE;
    });
  }

  // 文明的存续：按伤害来源归属结算，联合战场也不会给队友加伤。
  if (has('jibian_wenmingdecunxu')) {
    battle.on('hit', ({ source, credit, target, dmg }) => {
      const src = credit ?? source;
      if (src?.side !== 'ally' || target?.side !== 'enemy' || dmg?.type !== 'true') return;
      dmg.mul *= 1 + 2 * count(src.ownerId, 'jibian_wenmingdecunxu');
    }, { priority: -50 });
  }

  // ===================================================================================================================
  // 第二批（用户 2026-10-12《盟约惊变.md》，12 张盟约惊变 + 8 张通用惊变）—— 战斗侧
  //
  // ② 等待雪 / ③ 银质子弹 / ④ 骑士竞技 / ⑤ 老霸道了 / ⑬ 假想敌 / ⑰⑱ 类型转换 都挂在 `hit`（每个伤害实例、
  //    dmg 可变）；⑨ ？！拉拉？！挂 `kill` + gainLayers；⑯ 自爆卡车挂 `death`；⑬ 假想敌另外在 battleStart /
  //    deploy 上把"额外目标格"铺满全场。

  const NEW_HIT = ['jibian_dengdaixue', 'jibian_chunyinzidan', 'jibian_qishijingji', 'jibian_laobadao',
    'jibian_mofazhuanwuli', 'jibian_wulizhuanmofa', 'jibian_jiaxiangdi'];
  if (NEW_HIT.some((id) => has(id))) {
    // 本次攻击的目标数随伤害实例携带，近战首击和延迟弹道均不依赖上一次攻击。
    battle.on('hit', (ctx) => {
      const dmg = ctx && ctx.dmg;
      const s = (ctx && (ctx.credit ?? ctx.source)) || null;
      const t = ctx && ctx.target;
      if (!dmg || !s || !t || s.side !== 'ally' || t.side !== 'enemy') return;
      const pid = s.ownerId;
      const n = (id) => count(pid, id);
      const isDot = Array.isArray(dmg.tags) && (dmg.tags.includes('dot') || dmg.tags.includes('periodic'));

      // ② 等待雪，埋葬这一切 —— 谢拉格干员造成伤害时 30% 概率 3s 寒冷 + 20% 脆弱
      const nSnow = n('jibian_dengdaixue');
      if (nSnow > 0 && isMember(battle, s, 'kjeragShip') && battle.rng() < 0.3) {
        battle.applyStatus(t, 'cold', { duration: 3, source: s });
        battle.applyStatus(t, 'fragile', { duration: 3, value: 0.2, source: s });
      }
      // ③ 银质子弹 —— 拉特兰干员造成伤害时给目标挂"可叠加的流血"：每秒扣 1% 最大生命（单次 ≤ 20 万），持续 3s。
      //    流血自己的 tick 也是伤害（tags 带 dot/periodic），这里跳过，否则每跳都会再挂一层。
      const nSilver = n('jibian_chunyinzidan');
      if (nSilver > 0 && !isDot && isMember(battle, s, 'lateranoShip')) {
        for (let i = 0; i < nSilver; i++) {
          battle.addBuff(t, {
            key: P + 'chunyinzidan', duration: 3, interval: 1, refresh: 'stack', maxStacks: 1e6, visible: false,
            onTick: ({ battle: b, unit }) => {
              const per = Math.min(200000, (unit.s.maxHp || 0) * 0.01);   // ★ 2026-10-19 owner：单跳上限 2w → 20w
              b.dealDamage(s.alive ? s : null, unit, periodicDamage(per));
            },
          });
        }
      }
      // ④ 骑士竞技 —— 仅对一名敌方单位造成伤害时 +400%（×5/张）
      const nJoust = n('jibian_qishijingji');
      if (nJoust > 0 && !isDot && dmg.attackTargetCount === 1 && isMember(battle, s, 'kazimierzShip')) {
        dmg.mul *= 1 + 4 * nJoust;
      }
      // ⑤ “老霸道了” —— 攻击范围总格数 > 7 时，**同时对多名敌人造成伤害**的伤害 +325%。
      //   用户 2026-10-14：「把群体伤害改成同时对多名敌人造成伤害」——原来的判定只有 `dmg.isSplash`
      //   （溅射实例），而 `allInRange`（群体术师那种一次打范围内全部）**没有 isSplash**，吃不到加成。
      //   现在两条都算：
      //     · dmg.isSplash            —— 溅射受害者（它们不在 ai.js attack 钩子的 `targets` 里，必须单独算）
      //     · dmg.attackTargetCount > 1 —— 这一次攻击索敌锁定了多个主目标
      const nBoss = n('jibian_laobadao');
      if (nBoss > 0 && (dmg.isSplash || dmg.attackTargetCount > 1) && isMember(battle, s, 'kazimierzShip')) {
        const cells = Array.isArray(s.baseRangeKeys) ? s.baseRangeKeys.length : (Array.isArray(s.rangeKeys) ? s.rangeKeys.length : 0);
        if (cells > 7) dmg.mul *= 1 + 3.25 * nBoss;
      }
      // ⑰⑱ 魔法转物理（+30%）/ 物理转魔法 —— 按"原始类型"判。用户 2026-10-12：两张同时在手时**不互抵** ——
      // 一律输出「增强后的物理伤害」并保留 +30%（魔法转物理优先），物理转魔法只在没拿魔法转物理时才生效。
      // ★ 2026-10-25：羁绊「伤害转伤害」已把这次伤害改成真伤时，这两张卡不要再把它转回物理/法术。
      const origType = dmg.type;
      const nA2P = n('jibian_mofazhuanwuli');
      const nP2A = n('jibian_wulizhuanmofa');
      if (origType !== 'true' && nA2P > 0 && (origType === 'arts' || nP2A > 0)) { dmg.type = 'phys'; dmg.mul *= 1 + 0.3 * nA2P; }
      else if (origType === 'phys' && nP2A > 0) { dmg.type = 'arts'; }
      // ⑬ 假想敌 —— 打的是"攻击范围之外"的敌人，伤害 ×0.3
      const nAir = n('jibian_jiaxiangdi');
      if (nAir > 0 && !isDot && !inBaseRange(s, t)) dmg.mul *= 0.3;
    });
  }

  // ⑬ 假想敌 —— 把每个己方干员的额外目标格铺满全场：范围内没有敌人时就能打范围外的敌人
  //    （索敌本身按引擎的优先级排序，即"更靠近蓝门的先打"）。伤害惩罚在上面的 hit 里。
  if (has('jibian_jiaxiangdi')) {
    const allKeys = [];
    for (let k = 0; k < GEO.ROWS * GEO.COLS; k++) allKeys.push(k);
    const spread = (u) => { if (owns(u, 'jibian_jiaxiangdi') && u.kind === 'op') battle.setExtraRange(u, allKeys); };
    battle.on('battleStart', () => { for (const u of battle.allies()) spread(u); }, { priority: 10 });
    battle.on('deploy', (ctx) => spread(ctx && ctx.unit));
  }

  // ⑨ ？！拉拉？！ —— 【叙拉古】干员击倒敌人时，使已激活的【叙拉古】层数 +10（战斗内层数；用户 2026-10-14 从 +3 上调）
  if (has('jibian_lala')) {
    battle.on('kill', (ctx) => {
      const killer = ctx && ctx.killer;
      const victim = ctx && ctx.victim;
      if (!killer || !victim || victim.side !== 'enemy' || killer.side !== 'ally') return;
      const n = count(killer.ownerId, 'jibian_lala');
      if (n <= 0 || !isMember(battle, killer, 'siracusaShip')) return;
      for (let i = 0; i < n; i++) {
        gainLayers(battle, { playerId: killer.ownerId, bonds: 'siracusaShip', n: 10, requireActive: true, source: killer, reason: P + 'lala' });
      }
    });
  }

  // ⑱ 轻拍背部（稀有，现代最强羁绊）：因阻挡数不足而穿过干员的敌人，每只给该干员 +1 层次数盾
  if (has('jibian_qingpaibeibu')) {
    battle.on('blockFull', (c) => {
      const u = c && c.blocker;
      if (!u || u.kind !== 'op' || !u.s) return;
      if (count(u.ownerId, 'jibian_qingpaibeibu') <= 0) return;
      try { addShieldLayer(battle, u, 'jibian:qingpaibeibu', 999); } catch { /* 盾层出错不影响战斗 */ }
    }, { priority: -10 });
  }

  // ⑲ 折射（史诗，owner 2026-10-19）：你的所有干员法术抗性 +70
  if (has('jibian_zheshe')) {
    const apply = (u) => {
      if (!owns(u, 'jibian_zheshe')) return;
      BOND_ATTR(battle, u, 'zheshe', { resFlat: 70 });
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) apply(u); }, { priority: 20 });
    battle.on('deploy', (ctx) => apply(ctx && ctx.unit));
  }

  // 鲁莽（普通）：持有者的干员攻击力 +200%、攻速 +60；每次攻击 30% 概率打空（本次伤害归零）
  if (has('jibian_lumang')) {
    const LUMANG_KEY = P + 'lumang';
    const missed = new Map();
    const applyLumang = (u) => {
      if (!owns(u, 'jibian_lumang')) return;
      passiveBuff(battle, u, `${LUMANG_KEY}:${u.uid ?? ''}`, directMods({ atk: 2 }, { aspd: 60 }));
    };
    battle.on('battleStart', () => { for (const u of battle.allies()) applyLumang(u); }, { priority: 10 });
    battle.on('deploy', (ctx) => applyLumang(ctx && ctx.unit));
    battle.on('hit', (ctx) => {
      const dmg = ctx && ctx.dmg;
      const src = ctx && (ctx.credit ?? ctx.source);
      if (!dmg || !owns(src, 'jibian_lumang') || !dmg.isAttack) return;
      const key = dmg.attackId > 0 ? `${src.id}:${dmg.attackId}` : null;
      let miss = key == null ? undefined : missed.get(key);
      if (miss === undefined) {
        miss = battle.rng() < 0.3;
        if (key != null) {
          missed.set(key, miss);
          if (missed.size > 512) missed.delete(missed.keys().next().value);
        }
      }
      if (miss) dmg.mul = 0;
    }, { priority: -50 });
  }

  // ⑰ 伟大封印（传说羁绊：三月五日 + 总攻击）—— 结城理死亡时处决血量最高的敌人，一局一次
  const sealOwners = new Set([...picks].filter(([, ids]) => activeBonds(new Set(ids.keys())).some(a => a.def.id === 'great_seal')).map(([pid]) => pid));
  if (sealOwners.size) {
    battle.on('death', (ctx) => {
      const u = ctx && ctx.unit;
      if (!u || u.side !== 'ally' || u.kind !== 'op' || !u.s) return;
      // 只认结城理（炸惊棋库里 chess_zj_60_5_a/_b）
      const cid = String(u.chessId || u.baseId || u.defId || '');
      if (!cid.startsWith('chess_zj_60_5')) return;
      // ★ 2026-10-28：按 owner 检查两张卡（原来用全局 has，队友的卡也能替自己触发）
      if (!sealOwners.has(u.ownerId)) return;
      // ★ 2026-10-28：整局（整场比赛）只触发一次 —— 上一次战斗的标记随 battleInput 带进来
      const simP = typeof battle.getPlayer === 'function' ? battle.getPlayer(u.ownerId) : null;
      if (simP && simP.input && simP.input.greatSealUsed) return;
      // 一局一次：Battle 上没有 mem（旧代码读 battle.mem 永远 undefined），用 Battle 自带字段
      const used = battle.__greatSealUsed || (battle.__greatSealUsed = new Set());
      if (used.has(u.ownerId)) return;
      // ★ 2026-10-28：battle.enemies 是数组，不是函数；旧写法恒返回 []，所以从来没处决过
      const foes = (battle.enemies || []).filter((e) => e && e.alive !== false && e.s);
      if (!foes.length) return;
      used.add(u.ownerId);
      u.redeployLocked = true;
      const ban = { playerId: u.ownerId, round: Number(battle.round) || 0 };
      battle.__greatSealBan = ban;
      (battle.__greatSealBans || (battle.__greatSealBans = [])).push(ban);
      let top = foes[0];
      for (const e of foes) if ((Number(e.s.maxHp) || 0) > (Number(top.s.maxHp) || 0)) top = e;
      try {
        battle.kill(top, u);
      } catch { /* 目标已死：忽略 */ }
      // 处决表现：客户端收到后循环播放伟大封印音乐，直到下一个整备阶段
      try { battle.fx('greatseal', { x: top.x, y: top.y, id: top.id, playerId: u.ownerId }); } catch { /* 不影响处决 */ }
      // 本整备期不能再部署结城理：把标记写到玩家状态上（整备期部署时读它）
      try {
        const ps = (battle.players || []).find((p) => p && p.playerId === u.ownerId);
        const round = Number(battle.round) || 0; // ★ 原来读 battle.m.round（Battle 没有 m），永远是 0
        if (ps) {
          ps.mem = ps.mem || {};
          ps.mem.greatSealBanRound = round;
          if (ps.input && typeof ps.input === 'object') ps.input.greatSealBanRound = round;
          for (const piece of [...(ps.board || []), ...(ps.hand || [])]) {
            const pid = String((piece && (piece.chessId || piece.id)) || '');
            if (pid.startsWith('chess_zj_60_5')) piece.greatSealBanRound = round;
          }
        }
      } catch { /* 标记失败不影响处决 */ }
    }, { priority: 20 });
  }

  // ⑯ 自爆卡车 —— 干员被击倒时对周围的敌人造成 4000% 攻击力的法术伤害
  if (has('jibian_zibaokache')) {
    battle.on('death', (ctx) => {
      const u = ctx && ctx.unit;
      if (!u || u.side !== 'ally' || u.kind !== 'op' || !u.s) return;
      const n = count(u.ownerId, 'jibian_zibaokache');
      if (n <= 0) return;
      const foes = battle.foesInRadius(u.x ?? 0, u.y ?? 0, 1.5, true);
      for (const e of foes) {
        for (let i = 0; i < n; i++) {
          battle.dealDamage(u, e, battle.makeDamage({ amount: (u.s.atk || 0) * 40, type: 'arts', tags: ['jibian'] }));
        }
      }
    });
  }
}

// =====================================================================================================================
// prep side
//
// A `jibian:<id>` ref's onChoicePick fires exactly once, right after the ref is added (choices.js applyCard runs
// `choice:<id>` first — nothing is registered there — then re-dispatches the hook to the refs; ctx.source.kind is
// 'effect' on that second run and 'choice' on the first, which is how the two are told apart).

/** 立刻获得 N 资金 (捐赠 / 我在马路边捡到一分钱). */
const FUNDS = { jibian_juanzeng: 15, jibian_malubian: 5 };

/** 惊变卡要用到的数据记录 (data/items.json, added together with this module):
 *  奖杯 — 攻击力 +100% 写在记录自己的 buff 里, 引擎按 `attr_common_global_buff` 结算, 本模块不用管;
 *  板藤 — 只是一个卖价计数器（起价 4、每回合 +4），记录本身不再作为道具发放，只提供按钮里的图案。 */
const ITEM_TROPHY = 'chess_item_jibian_trophy';
/** ★ 2026-10-13（用户）超大杯改版后的道具（奖杯造型，图标 assets/local/items/jibian/jibian_chaodabei.png）。
 *  攻击力+200% / 技力恢复+2/s 写在记录自己的 buff 里（attr_common_global_buff），本模块不用插手。 */
const ITEM_CUP = 'chess_item_jibian_chaodabei';
/** 板藤的卖价：起价 / 每回合涨幅（客户端按钮与 economy.sellBanteng 读的是同一个计数器）。 */
const BANTENG_START = 4;
const BANTENG_STEP = 4;

// ---- 第三批（用户 2026-10-13）-----------------------------------------------------------------------------------

/** 高卢银行支票：三项初始权重（百分点，和 = 99）与固定的 +100 概率（百分点）。 */
const CHEQUE_START = Object.freeze({ up: 33, zero: 33, down: 33 });
const CHEQUE_JACKPOT = 0.1;
/** 每个事件给对应结果加的百分点：击杀 → +10 / 漏怪 → -10 / 被队友兜住 → 0。 */
const CHEQUE_KILL_GAIN = 2;
const CHEQUE_LEAK_GAIN = 0.5;
const CHEQUE_SAVE_GAIN = 0.5;

/** 金酒之杯：每 5 资金 → 攻速 +7；资金 > 该阈值时每 5 资金再加 10% 攻击 / 生命。 */
const CUP_FUNDS_PER = 5;
const CUP_ASPD_PER = 7;
const CUP_BONUS_FUNDS = 50;
const CUP_ATKHP_PER = 0.1;

/** 极速送达！三档包裹（items.json 的 EQUIP 记录，kind = consume_on_equip）→ 开启后随机的干员**阶**列表。 */
const JISUSONGDA_TIERS = Object.freeze({
  chess_item_jibian_jisusongda_normal: Object.freeze([1, 2, 3, 4]),
  chess_item_jibian_jisusongda_rare: Object.freeze([5]),
  chess_item_jibian_jisusongda_epic: Object.freeze([6]),
});
/** 惊变「极速送达！」的三个道具 id 前缀（ON_PICK 由卡 id 推道具 id：jibian_jisusongda_normal → chess_item_...）。 */
const JISUSONGDA_ITEM = 'chess_item_jibian_jisusongda_';

/** 精锐蕾缪安: 炸惊模拟自己那张 (visible:false 的 zj 变体) 优先, 取不到退回普通精英. */
const LEMUEN_ELITE = ['chess_zj_78_b', 'chess_char_6_01_b'];
/** 耀骑士临光（卡西米尔）的精锐：炸惊表优先，普通表兜底。 */
const NEARL_ELITE = ['chess_zj_89_b', 'chess_char_6_17_b'];

/** 精锐贝洛内 (？！给给？！): 炸惊棋子优先, 取不到退回本体. */
const BELONE_ELITE = ['chess_zj_76_b', 'chess_zj_76_a'];

/** 精锐克莱门莎（魔鬼鱼，2026-10-18 用户新增）：炸惊棋子优先，取不到退回本体. */
const CLEMENTIA_ELITE = ['chess_zj_51_b', 'chess_zj_51_a'];

/** 精锐玛恩纳 (“老霸道了”): 炸惊棋子优先, 取不到退回本体. */
const MLYNAR_ELITE = ['chess_zj_75_b', 'chess_zj_75_a', 'chess_char_5_19_b', 'chess_char_5_19_a'];
/**
 * 红松骑士团（★ 用户 2026-10-15 新增，史诗）——「立刻随机获得一个野鬃 / 灰毫 / 远牙 / 焰尾」的候选表。
 * 每名干员给【炸惊棋库 → 普通棋库】两档，取第一个存在的（和上面 LEMUEN_ELITE 等同一手法：
 * 炸惊专属的卡在普通模式不存在，反之亦然）。四名成员按用户 2026-10-15 确认的名单。
 * 注意：这和 `bonds.json` 的 `powerIdList` / `pool_char_pinus` 无关 —— 数据里根本没有「红松骑士团」
 * 这个势力标记（全库 nationId 一律是 kazimierz），名单只能写死在这里。
 */
const PINUS_GRANT = Object.freeze([
  ['chess_zj_15_a', 'chess_char_1_19_a'],   // 野鬃
  ['chess_zj_29_a', 'chess_char_2_18_a'],   // 灰毫
  ['chess_zj_61_a', 'chess_char_4_20_a'],   // 远牙
  ['chess_zj_60_a', 'chess_char_4_19_a'],   // 焰尾
]);

/** 浊心斯卡蒂 (加入大群: "当你获得了浊心斯卡蒂时此惊变效果翻倍"): 本体/精锐 + 炸惊变体. */
export const SKADI_CORRUPTED = ['chess_char_6_04_a', 'chess_char_6_04_b', 'chess_zj_81_a', 'chess_zj_81_b'];

/**
 * 「加入大群」/「叠层手」对**卫戍特质**（reason = garrison）加层的额外层数；0 = 不加。
 *   加入大群（仅【阿戈尔】egirShip）：+100%；拥有浊心斯卡蒂时效果翻倍 → 合计 ×3（额外 +2 份）。
 *   叠层手（所有盟约，仅生效期内）：再补一份 → ×2。
 * 两张卡各自再加自己那一份（与原来两个 handler 的加法口径一致，不是互相乘）。
 * @param {number} n 这次特质加的层数
 * @param {{bondId?: string, jiaru?: boolean, skadi?: boolean, diecengshou?: boolean, doubler?: boolean}} o
 */
export function jibianGarrisonExtra(n, o = {}) {
  const base = Number(n) || 0;
  if (!(base > 0)) return 0;
  let extra = 0;
  if (o.jiaru && o.bondId === 'egirShip') extra += base * (o.skadi ? 2 : 1);
  if (o.diecengshou && o.doubler) extra += base;
  return extra;
}

/** ctx.counter 的键 (玩家级、跨回合持久). 全部带 `jibian:` 前缀, 不和别的内容撞. */
const K = {
  freeChess: P + 'zhebeiwuqing:chess',
  freeItem: P + 'zhebeiwuqing:item',
  debtFrom: P + 'chaoqianxiaofei:from',
  debtTo: P + 'chaoqianxiaofei:to',
  banteng: P + 'banteng:value',
  layersUntil: P + 'diecengshou:until',
  // ---- 第二批（用户 2026-10-12）----
  specialTier: P + 'zishen:tier',        // 高级/资深干员：预约的下一次刷新的目标阶数（0 = 没有预约）
  vicCharge: P + 'weiduoliyademimi:charge',   // 维多利亚的秘密：本回合剩余的特殊刷新次数
  vicRefresh: P + 'weiduoliyademimi:pending', // 特殊刷新已排入：下一次 onRefresh 走维多利亚规则
  vicDiscount: P + 'weiduoliyademimi:discount', // 特殊刷新之后，首个购买的干员 -1 资金
  seq: P + 'seq',                       // 自己加 ref 时的序号, 保证 ref.id 唯一
  // ---- 第三批（用户 2026-10-13）----
  chequeW10: P + 'gaoluzhipiao:w10',      // 高卢银行支票：提现 +10 的权重（**百分点**，初始 33）
  chequeW0: P + 'gaoluzhipiao:w0',        // 同上：提现 0 的权重（初始 33）
  chequeWm10: P + 'gaoluzhipiao:wm10',    // 同上：提现 -10 的权重（初始 33）；+100 的 0.1% 不是计数器，是常量
  chequeValue: P + 'gaoluzhipiao:value',  // 本次提现金额（商店栏「提现」键位显示的金额，0 = 这次什么都没抽到）
  // ---- 第四批（用户 2026-10-14）----
  touziPending: P + 'touziweilai:pending',  // 投资未来：下个惊变阶段的牌库只出史诗/传说（生成时消费并清零）
  jizhongyidian: P + 'jizhongyidian:until', // 集中一点：到这个回合数之前，所有叠层只给层数最高的已激活盟约
  pinusNoSell: P + 'hongsongqishituan:nosell',  // ★ 红松骑士团：本回合不能出售干员（值 = 禁用发生在第几回合）
  // ---- 炎国游记（owner 2026-10-18 改版）----
  yanguoLast: P + 'yanguoyouji:last',   // 上一次发【炎】干员的回合号
  // ---- 第五批（owner 2026-10-16）----
  devPay: P + 'emoxieyue:pay',            // 恶魔契约：1 = 允许用目标生命抵扣（economy.spend / canAfford 读它）
  mysCharge: P + 'shenmishangdian:charge',  // 神秘商店：可用次数
  mysNext: P + 'shenmishangdian:next',      // 神秘商店：下一次充能的回合号
  mysPending: P + 'shenmishangdian:pending',// 神秘商店：特殊刷新已排入（下一次 onRefresh 消费）
  cengFirst: P + 'cengshudaluan:first',   // 层数打乱：抽到这张卡的回合号（那一回合不洗）
};

/** 这一次 onChoicePick 是不是「刚抽到这张卡」(choices.js 先跑 choice:<id>、再跑 ref 上的钩子). */
const justPicked = (ctx) => !!(ctx && ctx.source && ctx.source.kind === 'effect');

/** 惊变卡池 (config modes[*].jibian.pool), 排除只会在「第二次抽取」出现的卡 (潘多拉魔盒自己). */
function cardPool(ctx) {
  const modes = (ctx.data && ctx.data.config && ctx.data.config.modes) || {};
  const md = modes[ctx.modeId] || {};
  const pool = md.jibian && Array.isArray(md.jibian.pool) ? md.jibian.pool : [];
  // ★ 2026-10-25：快手 只在「惊变三选一」里有意义（要同批的另外两张），潘多拉随机开出它等于空白卡，排除。
  return pool.filter((c) => c && c.effectId && !c.secondDrawOnly && c.effectId !== 'jibian_kuaishou');
}

/** 玩家的干员 (整备区 / 临时区 / 场上) —— 「随机一名干员」的样本. */
function ownPieces(ctx) {
  const out = [];
  for (const list of [ctx.board(), ctx.hand(), ctx.temp()]) for (const p of list || []) if (p && p.kind === 'chess') out.push(p);
  return out;
}

/** 随机取一个 (ctx.rng 是 meta 专用流, 和商店/战斗的随机互不干扰). */
const pick1 = (ctx, arr) => (arr && arr.length ? arr[Math.min(arr.length - 1, Math.floor(ctx.rng() * arr.length))] : null);

// =====================================================================================================================
// 第三批 prep-side helpers（用户 2026-10-13）

const finite = (v, d = 0) => (Number.isFinite(v) ? v : d);

/** 高卢银行支票的三项当前权重（写不出有效的一组时退回初始 33/33/33）。 */
function chequeWeights(ctx) {
  const up = finite(ctx.counter(K.chequeW10), 0);
  const zero = finite(ctx.counter(K.chequeW0), 0);
  const down = finite(ctx.counter(K.chequeWm10), 0);
  if (!(up + zero + down > 0)) return { up: CHEQUE_START.up, zero: CHEQUE_START.zero, down: CHEQUE_START.down };
  return { up: Math.max(0, up), zero: Math.max(0, zero), down: Math.max(0, down) };
}

/** 把三项权重写回计数器。 */
function chequeStore(ctx, w) {
  ctx.setCounter(K.chequeW10, w.up);
  ctx.setCounter(K.chequeW0, w.zero);
  ctx.setCounter(K.chequeWm10, w.down);
}

/**
 * 掷出本次提现的状态：先看固定的 0.1% (+100)，再在 +10 / 0 / -10 三项里按各自权重归一化抽。
 * 四项初始权重 33/33/33/0.1 之和是 99.1，归一化让「+100 恰为 0.1%」与「三项之和不被那 0.9 的余量带偏」同时成立。
 */
function chequeRoll(ctx, w) {
  const r = ctx.rng() * 100;
  if (r < CHEQUE_JACKPOT) return 100;
  const total = w.up + w.zero + w.down;
  if (!(total > 0)) return 0;
  let x = ((r - CHEQUE_JACKPOT) / (100 - CHEQUE_JACKPOT)) * total;
  if (x < w.up) return 10;
  x -= w.up;
  if (x < w.zero) return 0;
  return -10;
}

/**
 * 给 `key` 加 Δ，并从**另外两项**（+10 / 0 / -10 里除自己外的那两项，不含 +100）按当前比例扣掉同样多 ——
 * 保证三项之和不变；某一项已经扣到 0 就停止（剩余部分由还 > 0 的那一项补，都不够就保留 —— 用户口径
 * 「扣到 0 为止、不出现负数」优先）。按比例扣在极端情况下会因钳位而少吃一点，此时三项之和会略大于 99。
 *
 * 口径：**每个事件各扣一次**（5 次击杀 = 连着做 5 次 Δ=2），不是把 10 个百分点一次性扣掉 —— 后者会得到
 * 43/28/28，前者得到 42.4/27.6/29（另两项各按"当时的"比例衰减）。用户写的是「每击杀一个敌方单位 → +10 概率
 * +2%」+「给某项加 Δ 时…按当前比例扣掉」，所以这里取"逐事件"的字面口径；两者都满足"三项之和不变"。
 */
function chequeAdd(w, key, delta) {
  const out = { up: w.up, zero: w.zero, down: w.down };
  if (!(delta > 0)) return out;
  out[key] = Math.max(0, out[key] + delta);
  const others = key === 'up' ? ['zero', 'down'] : key === 'zero' ? ['up', 'down'] : ['up', 'zero'];
  let left = delta;
  // 一轮按比例扣；被钳位（某项见底）时剩下的在下一轮里按剩余比例再分，几轮内一定收敛（每轮至少有一项归零）
  for (let pass = 0; pass < 4 && left > 1e-9; pass++) {
    const avail = others.reduce((s, k) => s + Math.max(0, out[k]), 0);
    if (!(avail > 1e-9)) break;
    let taken = 0;
    for (const k of others) {
      if (!(out[k] > 0)) continue;
      const take = Math.min(out[k], left * (out[k] / avail));
      if (!(take > 0)) continue;
      out[k] -= take;
      taken += take;
    }
    if (!(taken > 0)) break;
    left -= taken;
  }
  for (const k of ['up', 'zero', 'down']) if (out[k] < 1e-9) out[k] = 0;
  return out;
}

/**
 * 高卢银行支票：**每个整备阶段开始时**掷一次，把这一掷的增减量**累加**到当前提现金额上。
 *
 * 用户口径（2026-10-17）：
 *   · 第一句「其实是在原有的基础上增加或减少 不是变成10或-10」⇒ **累加**，不是覆盖
 *     （两次 +10 就是 20；原来每次都被重设成这一掷的绝对值，永远攒不到 20）。
 *   · 第二句「之前是不是不能叠加到20」⇒ 确认要能叠到 20 以上。
 *   · 第三句「基础为0吧还是 然后扣不到负数」⇒ 起点 0，且**下限 0**：
 *     `-10` 只从已攒的金额里扣，扣到 0 就停在 0（不会出现负数提现、也不会倒扣资金）。
 *
 * 修正记录：2026-10-17 之前这里是 `Math.max(0, state)` 并且**覆盖**计数器 ——
 *   既把 -10 钳成 0（负档整档消失，实测 20000 次掷点负金额 0 次），又让金额永远等于"这一掷的结果"。
 * 权重（+10 / 0 / -10 三档）掷完立刻归回初始 —— 战斗里攒的加成只影响**下一次**结算，
 *   与卡面「都会让对应结果的概率在下次结算时提高」一致。
 */
/**
 * 出老千（jibian_cheat 羁绊）是否已激活 —— 卡面改写的总开关（不写进描述）。
 * ctx 上取玩家：ctx.ps / ctx.player 都试一下；取不到就当没激活。
 */
function cheatOn(ctx) {
  try {
    const ps = ctx && (ctx.ps || ctx.player);
    return activeBonds(ownedJibianIdsOf(ps)).some((a) => a.def.id === 'cheat');
  } catch { return false; }
}

function chequeSettle(ctx) {
  const w = chequeWeights(ctx);
  // ★ 出老千：+10 的概率变成 99.9%，保留 0.1% 的 +100
  const roll = cheatOn(ctx) ? (ctx.rng() < 0.999 ? 10 : 100) : chequeRoll(ctx, w);
  const prev = Math.max(0, finite(ctx.counter(K.chequeValue), 0));   // 基础 0，历史脏值也归 0
  ctx.setCounter(K.chequeValue, Math.max(0, prev + roll));           // 累加，但扣不到负数
  chequeStore(ctx, CHEQUE_START);
}

/** 高卢银行支票的进度：这一场战斗的击杀 / 漏怪 / 被队友兜住分别把对应结果的概率往上推。 */
function chequeAccrue(ctx, ev) {
  const r = ev && ev.result ? ev.result : null;
  if (!r) return;
  let w = chequeWeights(ctx);
  const kills = Math.max(0, Math.trunc(finite(r.killed, 0)));
  for (let i = 0; i < kills; i++) w = chequeAdd(w, 'up', CHEQUE_KILL_GAIN);
  const leaked = (Array.isArray(r.leaked) ? r.leaked : []).filter((l) => l && l.counted !== false);
  for (let i = 0; i < leaked.length; i++) w = chequeAdd(w, 'down', CHEQUE_LEAK_GAIN);
  const saved = chequeSavedByMates(ctx, ev, leaked);
  for (let i = 0; i < saved; i++) w = chequeAdd(w, 'zero', CHEQUE_SAVE_GAIN);
  chequeStore(ctx, w);
}

/**
 * 「被队友兜住一只怪」——只有联防（unite）里才有这件事：自己**能重新进场**的漏怪数，减去联防打完后仍然活着
 * （helpers 的 perPlayer.leaked 里 sourcePlayerId 是自己——leaked 在结算阶段已经变成"活下来"的意思，见
 * unite.uniteSurvivors）和没来得及进场（unspawned）的那些，剩下的就是队友替你拦下的。
 * 单人不成立（ev.unite 为 null）→ 0。unite.js 的 plan 只把"能进场的漏怪"放进 leaked，所以这里用 gd.enemy 复刻同一条判据。
 */
function chequeSavedByMates(ctx, ev, leaked) {
  const unite = ev && ev.unite;
  if (!unite || typeof unite !== 'object') return 0;
  const pid = ctx.playerId;
  const fielded = leaked.filter((l) => ctx.gd.enemy(l.enemyKey)).length;
  if (!(fielded > 0)) return 0;
  let survived = 0;
  for (const pp of Object.values(unite.perPlayer || {})) {
    for (const l of (pp && pp.leaked) || []) if (l && l.counted !== false && l.sourcePlayerId === pid) survived++;
  }
  for (const u of unite.unspawned || []) if (u && u.sourcePlayerId === pid) survived++;
  return Math.max(0, fielded - survived);
}

/**
 * 金酒之杯：**整备阶段结束时**结算一次，把结果写进这张卡自己的 ref `params`
 * （`battleInput` 会把 params 带进战斗；battle 侧 install() 读它给全队上 buff）——所以效果只作用于紧接的那场战斗。
 * 反复结算：每个整备阶段结束时都重算一次，覆盖上一次的数值。
 */
function cupSettle(ctx) {
  // 一次抽取 = 一个 ref；同一张卡被抽到多次时每一份都要各自的数值（战斗侧按 ref 逐个上 buff）
  const refs = ctx.effects().filter((e) => e.key === P + 'jibian_jinjiuzhibei');
  if (!refs.length) return;
  const funds = Math.max(0, Math.trunc(finite(ctx.funds(), 0)));
  const n = Math.floor(funds / CUP_FUNDS_PER);
  const aspd = CUP_ASPD_PER * n;
  const pct = funds > CUP_BONUS_FUNDS ? CUP_ATKHP_PER * n : 0;
  for (const ref of refs) ctx.addEffect({ id: ref.id, params: { funds, n, aspd, atkPct: pct, hpPct: pct } });
  if (n > 0) ctx.toast(`金酒之杯：${funds} 资金 → 全体攻速 +${aspd}${pct > 0 ? `，攻击力与生命 +${Math.round(pct * 100)}%` : ''}`, 'info');
}

/**
 * 极速送达！的随机干员：**纯按阶随机**（用户 2026-10-13：不受商店等级 / 池子余量 / 拥有情况限制）。
 * 取数表里本模式的棋库 `gd.visibleChess`（已排除精锐 golden、隐藏的炸惊专属变体与自选），按阶均匀抽一个；
 * 先抽阶（normal 是 1–4 里随机一个阶），该阶空了就往低阶退；发的时候 requirePool: false，所以"份数被拿光"也不拦。
 */
function openPackage(ctx, tiers) {
  const list = (ctx.gd && Array.isArray(ctx.gd.visibleChess) ? ctx.gd.visibleChess : [])
    .filter((id) => {
      const c = ctx.gd.chess(id);
      return !!(c && Number.isInteger(c.tier) && !c.isGolden && !c.isDiy && !c.isHidden);
    });
  if (!list.length) return null;
  const byTier = new Map();
  for (const id of list) {
    const t = ctx.gd.tierOf(id);
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t).push(id);
  }
  const wanted = pick1(ctx, tiers);
  // 抽中的那一阶优先，其余阶从高到低退（和 信标 / 突变细胞 的口径一致）
  const chain = [];
  if (wanted != null) chain.push(wanted);
  for (const t of [...new Set(Array.isArray(tiers) ? tiers : [])].sort((a, b) => b - a)) if (t !== wanted) chain.push(t);
  for (const t of chain) {
    const pool = byTier.get(t);
    if (!pool || !pool.length) continue;
    const id = pick1(ctx, pool);
    if (id) return ctx.grantChess(id, { requirePool: false });
  }
  return null;
}

/**
 * `item:chess_item_jibian_jisusongda_*` 的 onEquip（装备即消耗）：
 *   * 记录是 `kind = consume_on_equip`（items.json）时引擎在派发后自己把包裹摘掉（player/items.js），`ev.consumed`
 *     为 true，这里不要再销毁；
 *   * 记录被写回 `passive` 时引擎只派发不放行，这里自己 destroyPiece —— 两条路都能用。
 * 顺序：先销毁包裹（用户口径「销毁该装备 → 随机获得一名干员」），再按阶发人；发不出（棋库空）就提示一句。
 */
function openPackageOnEquip(ctx, ev) {
  const item = (ev && ev.item) || (ctx.source && ctx.source.piece) || null;
  const tiers = (item && JISUSONGDA_TIERS[item.id]) || null;
  if (!item || !tiers) return;
  if (ev && ev.consumed !== true) ctx.destroyPiece(item.uid);
  const got = openPackage(ctx, tiers);
  if (!got) ctx.toast('极速送达！：包裹里没有可获得的干员', 'warn');
}

/** 倒转区: 任务目标是「任一盟约到达 999 层」. 炸惊模拟的盟约上限是 9999 (mode.bondLayerCap), 所以 999 是一个能到的
 *  里程碑而不是封顶值; 奖励 20 资金. */
const QUEST_LAYERS = 999;
const QUEST_FUNDS = 20;

/** 所有盟约 id —— 读数据表 (layer 只写在 ps.layers 上, 一个盟约可以「有层数但当前没激活/不在 ps.bonds 里」). */
function bondIds(ctx) {
  const ids = Object.keys((ctx.data && ctx.data.bonds) || {});
  const seen = new Set(ids);
  for (const id of Object.keys(ctx.bonds() || {})) if (!seen.has(id)) { seen.add(id); ids.push(id); }
  return ids;
}

/** 倒转区的任务结算: 有盟约到 999 层就发 20 资金并撤掉这张卡. 返回是否结算. */
function questDaozhuanqu(ctx) {
  const hit = bondIds(ctx).find((id) => (Number(ctx.layers(id)) || 0) >= QUEST_LAYERS);
  if (!hit) return false;
  ctx.addFunds(QUEST_FUNDS, 'jibian');
  const self = ctx.effects().find((e) => e.key === P + 'jibian_daozhuanqu');
  if (self) ctx.removeEffect(self.id);
  const name = (ctx.gd.bond(hit) || {}).name || hit;
  ctx.toast(`倒转区：${name} 到达 ${QUEST_LAYERS} 层，奖励 ${QUEST_FUNDS} 资金`, 'info');
  return true;
}

/** 按 choices.js addRef 的形状给玩家加一张惊变卡 ref (潘多拉魔盒用). */
function addCardRef(ctx, card) {
  const id = card.effectId;
  ctx.addEffect({
    id: `${P}${id}#${ctx.incCounter(K.seq, 1)}`,
    key: P + id,
    name: card.name || id,
    desc: card.desc || '',
    iconKind: 'choice',
    iconId: id,
    counter: null,
    battle: true,
    params: {},
    data: { effectId: id },
    jibian: true,
    rarity: card.rarity ?? null,
    flavor: card.flavor ?? null,
  });
}

/**
 * 抽到一张惊变卡时要立刻做的事, 按 effectId. registerMeta 把它接到该 ref 的 onChoicePick 上; 潘多拉魔盒也直接调它
 * —— 魔盒开出来的卡必须和正常抽到一样立刻结算, 而那些 ref 是魔盒自己加的, 不会再走一遍 choices.js 的 dispatch.
 */
const ON_PICK = {
  jibian_chouminglu: () => {},
  jibian_xinzhigang: () => {},
  /** 银河战舰 — 三名颂乐人偶干员（**精锐优先**，取不到退回本体），走正常获得流程，不消耗商店池。 */
  jibian_yinhezhanjian: (ctx) => {
    for (const [elite, base] of GALAXY_TRIO) {
      const id = [elite, base].find((x) => ctx.chessRecord(x));
      if (id) ctx.grantChess(id, { requirePool: false, fromPool: false });
    }
  },
  /** 遗忘女神 — 指定精锐祥子；其余处理与普通的干员奖励一致。 */
  jibian_yiwangnvshen: (ctx) => {
    if (ctx.chessRecord('chess_zj_oblvns_b')) ctx.grantChess('chess_zj_oblvns_b', { requirePool: false, fromPool: false });
  },
  /** 谁还有梦想（史诗，owner 2026-10-25）：发一名精锐白铁（维多利亚盟约）。 */
  jibian_shuihaiyoumengxiang: (ctx) => {
    if (ctx.chessRecord('chess_zj_ironmn_b')) ctx.grantChess('chess_zj_ironmn_b', { requirePool: false, fromPool: false });
  },
  /** 多首野兽 — 发一名精锐若叶睦；特质替换与【调和】盟约由 mujicaBond.js / 数据侧处理。 */
  jibian_duoshouyeshou: (ctx) => {
    if (ctx.chessRecord('chess_zj_mortis_b')) ctx.grantChess('chess_zj_mortis_b', { requirePool: false, fromPool: false });
  },
  ...Object.fromEntries(Object.entries(FUNDS).map(([id, n]) => [id, (ctx) => ctx.addFunds(n, 'jibian')])),

  /** 这杯我请 — 计数器归零; 真正的免费在 onPrice/onBuy 里. */
  jibian_zhebeiwuqing: (ctx) => { ctx.setCounter(K.freeChess, 0); ctx.setCounter(K.freeItem, 0); },

  /**
   * 超大杯 — ★ 2026-10-13（用户）改版：不再给「整备区或场上随机一名干员」加 buff，而是
   * 【获得一件装备】（奖杯造型 chess_item_jibian_chaodabei），装备的那名干员获得
   * 攻击力 +200% 与 技力恢复速度 +2/s（写在道具记录自己的 buff 里，引擎按
   * attr_common_global_buff 结算，本模块不插手 —— 与「奖杯」同一套做法）。
   */
  jibian_chaodabei: (ctx) => { ctx.grantItem(ITEM_CUP, { toast: false }); },

  /**
   * 超前消费 — 用户 2026-10-11 定稿的规则：选完**立刻**获得 `3x + 30` 资金（x = 选择时所在回合），
   * 之后三个回合（x+1 ~ x+3）整备结算的**资金收入固定为 0**（基础收入与利息都没了）；挂账 pending（悬赏怪等）照发
   * —— 卡片文案里那句「不受悬赏怪影响」就是这个意思。
   */
  jibian_chaoqianxiaofei: (ctx) => {
    const r = Math.max(1, Number(ctx.round) || 1);
    const sum = 3 * r + 30;   // ★ 2026-10-14（用户）：每回合收入 8→10，补偿 3×8=24 跟着变 3×10=30
    ctx.setCounter(K.debtFrom, r + 1);
    ctx.setCounter(K.debtTo, r + 3);
    ctx.addFunds(sum, 'jibian');
    ctx.toast(`超前消费：立刻获得 ${sum} 资金，接下来三回合资金收入固定为 0`, 'info');
  },

  /** 板藤 — 只记一个卖价计数器（起价 4、每回合 +4）；卖走商店栏的「出售板藤」键位，不再发道具. */
  jibian_banteng: (ctx) => { ctx.setCounter(K.banteng, BANTENG_START); },

  /** 人才市场 — 从干员池随机一个, 无视等级 (maxTier 6). */
  jibian_rencaishichang: (ctx) => { const id = ctx.rollChess({ maxTier: 6 }); if (id) ctx.grantChess(id); },

  /**
   * 红松骑士团 — 立刻随机一个野鬃 / 灰毫 / 远牙 / 焰尾（★ 用户 2026-10-15 新增，史诗）。
   * · 四选一（不是从整个干员池抽），用现成的 `pick1` + `ctx.rng()`；
   * · `requirePool: false` —— 直接发放，不占商店池的份数（同「我从山中来」「？！给给？！」）；
   * · 候选表 `PINUS_GRANT` 先取炸惊记录、取不到退回普通记录（两个难度都能用）。
   */
  jibian_hongsongqishituan: (ctx) => {
    // ★ 用户 2026-10-15：「我要的是各获得一个」—— 四名成员各发一个（不是四选一）。
    //   逐个 grantChess：整备区满时由 grantChess 自己处理（server/match/effectsMeta.js:575 起），
    //   后面几个发不出去也不会打断前几个。
    for (const pair of PINUS_GRANT) {
      const id = pair.find((x) => ctx.chessRecord(x));
      if (id) ctx.grantChess(id, { requirePool: false });
    }
    // ★ 用户 2026-10-15：再加一条「若你选择此惊变，本回合你不能出售干员」。
    //   存【当前回合号】而不是布尔值 —— 下一回合 `ctx.round` 变了，条件自然失效，
    //   所以不需要在 onRoundStart 里清理（和 jibian_diecengshou 的 K.layersUntil 同一个手法）。
    ctx.setCounter(K.pinusNoSell, ctx.round);
  },

  /** 我从山中来 — 立刻一个精锐蕾缪安. */
  jibian_wocongshanzhonglai: (ctx) => {
    const id = LEMUEN_ELITE.find((x) => ctx.chessRecord(x));
    if (id) ctx.grantChess(id, { requirePool: false });
  },

  // ---- S.E.E.S 版本新增（用户 2026-10-17 的 S.E.E.S.txt）--------------------------------------------
  /**
   * 数万真言（史诗）——「你的干员开启技能所需的技力增加100%，但技能持续期间攻击力+300%」。
   * 抽到时无事：两个效果都在战斗侧 `install(battle)` 里（spCostMul×2 + 技能期间 atkPct+3）。
   * 这里只登记 key，`registerMeta` 才会注册 —— 与 `jibian_jinjiuzhibei` 同一手法。
   */
  jibian_shuwanzhenyan: () => {},

  /** 无下限术式（传说）——「你的所有干员获得99.9%的闪避」。同样只登记 key，效果在战斗侧。 */
  jibian_wuxiaxian: () => {},

  /** 龙的传人（传说，owner 2026-10-24）：抽到时无事 —— 效果全在战斗侧 install()。 */
  jibian_longdechuanren: () => {},

  /** 龙的传人（传说，owner 2026-10-24）：抽到时无事 —— 效果全在战斗侧 install()。 */

  /**
   * 三月五日（传说）——「你获得一个精锐结城理」。
   * 与「我从山中来」完全同一手法：炸惊记录优先（chess_zj_60_5_b = 精锐结城理），
   * 取不到就退回本体；`requirePool: false` 直接发放、不占商店池份数。
   */
  jibian_sanyuewuri: (ctx) => {
    const id = ['chess_zj_60_5_b', 'chess_zj_60_5_a'].find((x) => ctx.chessRecord(x));
    if (id) ctx.grantChess(id, { requirePool: false });
  },

  /** 潘多拉魔盒 — 失去所有惊变 (含自己), 换三个随机惊变, 新卡立刻按正常抽到结算.
   *  用户 2026-10-12: 三张**互不重复** (以前是 with replacement, 可能开出一模一样的两张)。 */
  jibian_panduolamohe: (ctx) => {
    const pool = cardPool(ctx);
    const previous = ctx.effects();
    const folders = previous.filter(e => e.key === P + 'jibian_renshibuwenjianjia').length;
    if (folders) ctx.addDeployCap(-2 * folders);
    if (previous.some(e => e.key === P + 'jibian_yingfenshen')) for (const id of bondIds(ctx)) ctx.setBondCountBonus(id, 0);
    for (const ref of ctx.effects()) if (typeof ref.key === 'string' && ref.key.startsWith(P)) ctx.removeEffect(ref.id);
    if (!pool.length) return;
    const drawn = new Set();
    for (let i = 0; i < 3; i++) {
      const left = pool.filter((c) => c && !drawn.has(c.effectId));
      const card = pick1(ctx, left);
      if (!card) break;
      drawn.add(card.effectId);
      addCardRef(ctx, card);
      const on = ON_PICK[card.effectId];
      if (on) on(ctx);
    }
  },

  /** 快手（隐秘，2026-10-25）：选中时由 spDraft 把同批另外两张一起发下；本卡自身无额外效果. */
  jibian_kuaishou: () => {},

  /** ？！325799？！ — 任务卡, 奖励在 onRoundStart 发. */
  jibian_325799: () => {},

  /** 倒转区 — 任务卡, 奖励在 onLayers / onRoundStart 里查. */
  jibian_daozhuanqu: () => {},

  /** “叠层手” — 记下五回合的窗口, 翻倍在 onLayers 做. */
  jibian_diecengshou: (ctx) => { ctx.setCounter(K.layersUntil, ctx.round + 4); },

  /** 老子是冠军他是什么 — 一个奖杯 (+100% 攻击力写在道具记录里, 装备即生效). */
  jibian_laozishiguanjun: (ctx) => { ctx.grantItem(ITEM_TROPHY, { toast: false }); },

  // ---- 第二批（用户 2026-10-12）--------------------------------------------------------------------
  /** 总攻击（史诗，S.E.E.S 图标，2026-10-19 用户新增）— 获得虎狼丸、岳羽由加莉、埃癸斯（精锐优先，取不到退回本体）. */
  jibian_zonggongji: (ctx) => {
    for (const [elite, base] of SEES_TRIO) {
      const id = [elite, base].find((x) => ctx.chessRecord(x));
      if (id) ctx.grantChess(id, { requirePool: false });
    }
  },

  /** ？！给给？！ — 立刻一个精锐"贝洛内"（炸惊棋子 chess_zj_76_b，取不到退回本体）. */
  jibian_geigei: (ctx) => {
    const id = BELONE_ELITE.find((x) => ctx.chessRecord(x));
    if (id) ctx.grantChess(id, { requirePool: false });
  },

  /** 魔鬼鱼（稀有，阿戈尔图标，2026-10-18 用户新增）— 立刻获得一个精锐克莱门莎. */
  jibian_moguiyu: (ctx) => {
    const id = CLEMENTIA_ELITE.find((x) => ctx.chessRecord(x));
    if (id) ctx.grantChess(id, { requirePool: false });
  },

  /** “老霸道了” — 群体伤害 +325% 在 hit 钩子里（见上面的 NEW_HIT），这里补上文案承诺的
   *  「获得一个精锐玛恩纳」（用户 2026-10-13 核实：desc 写了但从来没发过；写法与「我从山中来」/「？！给给？！」一致）. */
  jibian_laobadao: (ctx) => {
    const id = MLYNAR_ELITE.find((x) => ctx.chessRecord(x));
    if (id) ctx.grantChess(id, { requirePool: false });
  },

  /** 迅捷 / 精准 — 盟约 +80 层（"无需激活盟约" = 不传 requireActive，见 support/index.js 的语义注释）. */
  jibian_xunjie: (ctx) => ctx.addLayers('swiftShip', 80, { reason: P + 'xunjie' }),
  jibian_jingzhun: (ctx) => ctx.addLayers('preciShip', 80, { reason: P + 'jingzhun' }),
  /** 灵巧 — 同上，【灵巧】+80 层（无需激活）。2026-10-19 owner 新增。 */
  jibian_lingqiao: (ctx) => ctx.addLayers('skillfulShip', 80, { reason: P + 'lingqiao' }),
  /** 坚守（稀有，owner 2026-10-19）：【坚守】盟约 +80 层（无需激活）。 */
  jibian_jianshou: (ctx) => ctx.addLayers('steadShip', 80, { reason: P + 'jianshou' }),

  /** 高级资深干员 / 资深干员 — 预约："下一次刷新"那次商店槽位全变成随机六/五阶（HOOKS.onRefresh 消费）. */
  jibian_gaojizishen: (ctx) => ctx.setCounter(K.specialTier, 6),
  jibian_zishen: (ctx) => ctx.setCounter(K.specialTier, 5),

  /**
   * 纯粹的强大 — 立刻获得特殊的精锐斯卡蒂（chess_zj_pure_b：基础攻击/生命已在记录里 ×2，
   * 并由 players.js / units.js 的 pureStrong 开关负责「盟约贡献 ×2」与「阻挡数不可变」）。
   */
  /**
   * 骑士竞技 (jibian_qishijingji, 用户 2026-10-14 追加)：「获得一个精锐耀骑士临光」。
   * 原来只有 +400% 那一条（hit 钩子，见下面 install 里的 ④）；这里是**新增**的一项，
   * 不替换它。抽到多张就多次获得（和「纯粹的强大」等获得类惊变一致）。
   */
  jibian_qishijingji: (ctx) => {
    const id = NEARL_ELITE.find((x) => ctx.chessRecord(x));
    if (id) ctx.grantChess(id, { requirePool: false });
  },
  jibian_chuncuideqiangda: (ctx) => {
    if (ctx.chessRecord('chess_zj_pure_b')) ctx.grantChess('chess_zj_pure_b', { requirePool: false });
  },

  /**
   * 投资未来 — 抽到只种一个「下个惊变阶段只出史诗/传说」的标记（用户 2026-10-14）。
   * 惊变阶段是 round 1 / 7：在 round 1 抽到本卡时，这一阶段的牌库**已经生成完毕**，
   * 所以标记会自然留到 round 7 —— 正好就是文案里的「下一轮惊变阶段」。
   * 消费在 MatchPhases.spDraft 的 perPlayer 分支（choices.js 的 jibianDraftCards 过滤池子）。
   */
  jibian_touziweilai: (ctx) => ctx.setCounter(K.touziPending, 1),

  /** 集中一点（稀有，层数厨，owner 2026-10-23）：接下来三个回合，所有叠层只给层数最高的已激活盟约。 */
  jibian_jizhongyidian: (ctx) => ctx.setCounter(K.jizhongyidian, ctx.round + 3),

  /** “维多利亚的秘密” — 抽到时先给本回合的 1 次特殊刷新（真正执行走客户端按钮 g.specialRefresh → onRefresh）. */
  jibian_weiduoliyademimi: (ctx) => ctx.setCounter(K.vicCharge, 1),

  /** 加入大群 / 影分身 / 紧急调派 / 炎国游记 — 常驻钩子（onLayers / 备战区人数 / onBattleResult / 精锐奖励权重），
   *  抽到时不用做什么，但必须在这里登记：registerMeta 是按 ON_PICK 的键注册的（见文件末尾）。 */
  jibian_jiarudaqun: () => {},
  jibian_yingfenshen: () => {},
  jibian_jinjidiaopai: () => {},

  /**
   * 炎国游记（owner 2026-10-18 改版）—「你立刻随机获得一个无视商店等级的【炎】盟约干员，
   * 之后每过两回合再次随机获得一个」。
   * · `rollChess({ bond: 'yanShip', maxTier: 6 })` —— maxTier 6 = 无视商店等级（同“维多利亚的秘密”）；
   * · `requirePool: false` —— 直接发放，不占商店池份数（同「？！给给？！」）；
   * · 发完把**当前回合号**写进 K.yanguoLast，HOOKS 里的 onRoundStart 每满 2 回合再补一个。
   */
  jibian_yanguoyouji: (ctx) => { grantYanOperator(ctx); },
  jibian_touziren: () => {},   // 实现在 match/effectsMeta.js 的 investRepeat（"获得时 ×2"的唯一乘法点）

  // ---- 第三批（用户 2026-10-13）--------------------------------------------------------------------
  /**
   * 高卢银行支票 — 抽到时只把概率归到初始值、金额清 0；**第一次掷出在拿到后的第一个整备阶段**
   * （HOOKS.jibian_gaoluzhipiao.onPrepStart），所以这里不掷，免得第一次整备再掷一遍成了"掷两次"。
   */
  jibian_gaoluzhipiao: (ctx) => { chequeStore(ctx, CHEQUE_START); ctx.setCounter(K.chequeValue, 0); },

  /** 金酒之杯 — 抽到时不用做什么（结算在 HOOKS.onPrepEnd），但要在 ON_PICK 里登记，registerMeta 才注册 key。 */
  jibian_jinjiuzhibei: () => {},

  /** 极速送达！ — 抽到一个企鹅物流包裹（EQUIP，装备即消耗；开启逻辑在 item:chess_item_jibian_jisusongda_* 处理器）。 */
  jibian_jisusongda_normal: (ctx) => { ctx.grantItem(JISUSONGDA_ITEM + 'normal', { toast: false }); },
  jibian_jisusongda_rare: (ctx) => { ctx.grantItem(JISUSONGDA_ITEM + 'rare', { toast: false }); },
  jibian_jisusongda_epic: (ctx) => { ctx.grantItem(JISUSONGDA_ITEM + 'epic', { toast: false }); },

  /**
   * 「时光之末」(稀有, owner 2026-10-16) — 抽到时不用做什么（效果全在下面的 HOOKS.onWouldEliminate）。
   * ★ 但必须在这里登记：registerMeta 是按 **ON_PICK 的键**注册的，只在 HOOKS 里写条目的卡**不会被注册**
   *   （同「金酒之杯」的注释，见本文件 ON_PICK 上方的说明）。
   */
  jibian_shiguangzhimo: () => {},

  /**
   * 「111真复活吗哥」(普通, owner 2026-10-16) — 抽到不用做什么（效果在下面的 HOOKS.onGain）。
   * 必须在这里登记：registerMeta 按 ON_PICK 的键注册（同「时光之末」「金酒之杯」）。
   */
  jibian_111fuhuoma: () => {},

  /**
   * 追忆 (传说, owner 2026-10-16) — 第 13 回合结束时不进第 14 回合，改为进入**第 10 回合整合阶段**，
   * 之后本卡失效。效果在 HOOKS.onRoundWouldStart（phases.js startRound 最前面派发）。
   */
  jibian_zhuiji: () => {},

  /**
   * ？* /）层数/¥）dgxu (普通, owner 2026-10-16；2026-10-26 池子扩到全部盟约) —「每回合开始时，你的所有盟约层数会被随机打乱」。
   * 效果在 HOOKS.onRoundStart；抽到的那一回合不洗（抽卡发生在本回合的惊变阶段，"每回合开始"已过）。
   */
  jibian_cengshudaluan: () => {},

  /**
   * 死亡回归 (普通, owner 2026-10-16) —「仅一次，若你在某回合战斗阶段结束后因为目标生命降为0淘汰，
   * 你和你的小队回到此回合整备阶段」。
   * 全部逻辑在服务端：商店栏的按键 → C2S `g.deathReturn` → PlayerState.deathReturn()
   * （标记假淘汰 + 播报 + 3 秒后 Match._deathReturnRewind 回到该回合整备阶段）。
   * ★ 必须在 ON_PICK 里登记，否则 registerMeta 不会注册这张卡。
   */
  jibian_siwanghuigui: () => {},

  /**
   * 薛定谔的猫 (史诗, owner 2026-10-16) — 战斗阶段开始时每个干员随机获得「无法被击倒」或「立刻被击倒且无法再部署」。
   * 战斗侧实现在 install() 里（fatal 钩子 + 开场处决）。
   */
  jibian_xuedingedemao: () => {},

  /**
   * 赤霄剑法 (传说, owner 2026-10-16) —「你的所有干员造成的伤害改为弱点伤害；获得一个精锐赤刃明霄陈
   * （炎盟约，三技能的百分比伤害最高只会造成 2 亿）」。
   *
   * 战斗侧在 install()：挂 hit 改写（弱点伤害）+ 打开 chen3 剑气波的每击上限（15w → 2 亿）。
   *
   * 发放侧（owner 2026-10-16 二次修正）：「**发一个自选编队中已精锐的赤刃明霄陈**」——
   * 陈的 charId 是 `char_1050_chen3`，它**不是**炸惊棋库里的固定记录，而是一个
   * **自选（DIY）干员**（server/sim/content/kits/ops/op-chen3.js，backups.json units.char_1050_chen3）。
   * 自选编队有 4 个固定槽位（5 阶 ×2、6 阶 ×2，data/backups.json `diy.slots`），
   * 每个槽位一对 `_a`（普通）/ `_b`（精锐）；玩家把陈放进哪个槽是**运行时**决定的，
   * 所以这里必须**遍历槽位记录按 charId 找**，不能写死槽位 id。
   *
   * ★ 第一版写死了 5 个候选 id，实测全错：`chess_zj_79_b` 其实是**圣聆初雪**，
   *   其余四个是 `甄选干员` 占位符（charId 为 null）—— 抽到这张卡会白送一个冰系干员。
   *   教训：发放类效果必须按 charId/槽位语义查，不能凭记忆写 id。
   *
   * `grantChess` 对本路径是安全的：`chessInRoster` 只改写**炸惊棋库**里的记录，
   * 而 DIY 记录没有 `zhajing` 标记，会原样返回（gamedata.js chessInRoster 第 480 行）。
   * @param {any} ctx
   */
  jibian_chixiaojianfa: (ctx) => {
    // ★ 2026-10-16（owner 定案）：赤刃明霄陈是 data/chess.json 里的**永久记录**
    //   （`chess_chen3_a` / `chess_chen3_b`，`isDiy: true` + `visible: false` ⇒ **买不到、不进干员调配**，
    //   但可以被内容显式发放），所以这里就是最朴素的一次发放，`golden: true` 取精锐形态。
    //   曾试过"从玩家自选编队现场组装"（diyRecordOf + 往 ps._diyRecords 注入），那条链路脆弱且
    //   在 diyDisabled 的炸惊模式下反复出问题 —— 数据里本来就有这条记录，直接发即可。
    ctx.grantChess('chess_chen3_a', { golden: true, requirePool: false });
  },

  /**
   * 恶魔契约 (传说, owner 2026-10-16) —「可以把目标生命值当成资金来使用（无法消耗至 0）」。
   * 打开 PlayerEconomy.lpPayment（见 server/match/player/economy.js 的 spend）：
   * 资金不足时用目标生命补，**保底 1 点**。每回合战斗阶段开始 +3 目标生命（HOOKS.onPrepEnd）。
   */
  jibian_emoxieyue: (ctx) => ctx.setCounter(K.devPay, 1),   // 打开 lp 抵扣（economy.spend / canAfford 读这个计数器）

  /**
   * 「神秘」商店 (史诗, owner 2026-10-16) —「你立刻获得一次特殊刷新，此后，你每过3回合获得一次特殊刷新，
   * 此次刷新到的干员无视当前商店等级，但价格会变为1-6中的随机整数」。
   * 立刻给的这次：charge=1、下次充能在 3 回合后（onRoundStart 按回合号补）。
   * 商店改写在 HOOKS.onRefresh（客户端商店栏的「特殊刷新」按钮 → C2S g.specialRefresh → economy.specialRefresh）。
   */
  jibian_shenmishangdian: (ctx) => {
    ctx.setCounter(K.mysCharge, Math.max(1, ctx.counter(K.mysCharge) || 0));
    if (!(ctx.counter(K.mysNext) > 0)) ctx.setCounter(K.mysNext, (Number(ctx.round) || 1) + 3);
  },

  /**
   * 人事部文件夹（owner 2026-10-16，史诗）— 可部署人数 +2。
   * 用引擎的 `addDeployCap` 往 `ps.deployCapBonus` 累加，而
   * `get deployCap() = Math.max(1, gd.deployCap + deployCapBonus + deployCapMin)`
   * （server/match/player/basics.js:31，**三项相加**）。
   *
   * ★ 2026-10-16 修 bug（玩家反馈「无法与人事部文档叠加生效，叠加后应该能部署 11 个人」）：
   *   这段注释原先写的是「setDeployCapAtLeast(9) → max(8+2, 9) = 10，所以叠加成立」——
   *   **算错了，而且 10 也不是卡面承诺的 11**。当时 `deployCap` 用 `Math.max(base+bonus, min)`，
   *   那个 max 会把加法吃掉：文档把下限设成 9，`max(8+2, 9) = 10` —— 文件夹的 +2 实际只生效 1 点。
   *   已把 `deployCap` 改成三项相加、`setDeployCapAtLeast` 改成写「相对基础的差额」，
   *   于是 **文档 9 + 文件夹 2 = 11** ✓，单独吃文档仍是 9 ✓。
   */
  jibian_renshibuwenjianjia: (ctx) => { ctx.addDeployCap(2); },
};

/** 除「抽到时」以外的 prep 钩子, 按 effectId. */
/**
 * 炎国游记的实际发放（ON_PICK 立刻用一次，之后每个它自己的回合再调）。
 * @returns {boolean} 有没有发出去
 */
function grantYanOperator(ctx) {
  const id = typeof ctx.rollChess === 'function' ? ctx.rollChess({ bond: 'yanShip', maxTier: 6 }) : null;
  if (!id) return false;
  ctx.grantChess(id, { requirePool: false });
  ctx.setCounter(K.yanguoLast, Number(ctx.round) || 1);
  if (typeof ctx.toast === 'function') ctx.toast('【炎国游记】获得一名【炎】盟约干员', 'reward');
  return true;
}

const HOOKS = {
  jibian_chouminglu: { onBattleResult(ctx, ev) { saveGrowth(ctx, ev, 'jibian_chouminglu'); } },
  jibian_xinzhigang: { onBattleResult(ctx, ev) { saveGrowth(ctx, ev, 'jibian_xinzhigang'); } },
  /**
   * 「时光之末」(稀有, owner 2026-10-16) — 仅一次，你和你的小队在**非 boss 战**中目标生命降为 0 时不淘汰该玩家，
   * 使其目标生命 +1 并进入下一回合。挂点在 MatchPhases.settle 的淘汰判定前（server/match/match/settle.js）：
   * 那里 `dispatch(ps,'onWouldEliminate',…)` 后看 `ev.saved`，为真就 `continue`（不淘汰）。
   * ★ boss/hidden 战不触发（卡面写的是"非boss战"）；触发即消耗（removeEffect）。
   */
  /**
   * 「111真复活吗哥」(普通, owner 2026-10-16) — 卡面故意保持神秘（"你的某个干员特质发生了改变"），
   * 实际效果（owner 亲述）：**把地灵的卫戍特质翻倍**。
   *
   * 地灵 = char_183_skgoat，她的卫戍特质是「<获得时>自身所属盟约层数 +N（无需激活盟约）」：
   *   garrison_25_a (+2, 普通) / garrison_25_b (+4, 精锐) / garrison_zj_10_a (+2, 炸惊普通) / garrison_zj_10_b (+8, 炸惊精锐)。
   * ★ 那个卫戍是 6 个干员**共用**的（garrison_25_* 的 owners 里有 chess_char_1_02_a / 1_12_a / 1_16_a …），
   *   所以**不能改数据文件**（会连带改掉别人）—— 这里改成「获得地灵时，把她的卫戍效果再追加一次」，
   *   等价于翻倍，且只作用于地灵本人。层数走 ctx.addLayers（她自己 garrison 用的同一通道）。
   */
  /**
   * 「神秘」商店 — 每 3 回合充能一次；onRefresh 把这次商店换成"无视商店等级、价格 1~6 随机"。
   * 不改客户端：商店栏的按钮条件是 `priv.spRefresh > 0`，而 priv.spRefresh 读的就是 charge 计数器
   * （server/match/player/views.js），economy.specialRefresh 也认这张卡。
   */
  /** 炎国游记 — 拿到卡之后的每 2 回合补发一个【炎】干员（回合号记在 K.yanguoLast）。 */
  jibian_yanguoyouji: {
    onRoundStart(ctx) {
      const last = Number(ctx.counter(K.yanguoLast)) || 0;
      if (!(last > 0)) return;                       // 还没发过（理论上拿卡时已经发过）
      if ((Number(ctx.round) || 1) - last < 2) return;
      grantYanOperator(ctx);
    },
  },

  jibian_shenmishangdian: {
    onRoundStart(ctx) {
      const r = Number(ctx.round) || 1;
      const next = ctx.counter(K.mysNext);
      if (!(next > 0)) { ctx.setCounter(K.mysNext, r + 3); return; }
      if (r >= next) {
        ctx.setCounter(K.mysCharge, Math.max(1, (ctx.counter(K.mysCharge) || 0) + 1));
        ctx.setCounter(K.mysNext, r + 3);
      }
    },
    onRefresh(ctx) {
      const pend = ctx.counter(K.mysPending);
      if (pend !== 1) return;                       // 普通刷新：什么都不做
      ctx.setCounter(K.mysPending, 0);
      for (const [i, s] of (ctx.shopSlots() || []).entries()) {
        if (!s || s.kind !== 'chess') continue;
        // ★ 无视当前商店等级（owner 2026-10-16 修正）：必须用 rollChessAnyTier —— 它先在可用阶层里
        //   **均匀**选一个再抽。原先用 rollChess({maxTier:6}) 是错的：pool.roll 按**剩余份数**加权，
        //   低阶份数远多于高阶，实测刷出来三格全是 1 阶。价格 1~6 随机整数。
        // ★ 出老千：只出 5 / 6 阶干员，价格固定 1
        const cheat = cheatOn(ctx);
        const id = cheat
          ? ((typeof ctx.rollChess === 'function' ? ctx.rollChess({ minTier: 5, maxTier: 6 }) : null)
             || (typeof ctx.rollChessAnyTier === 'function' ? ctx.rollChessAnyTier({ maxTier: 6 }) : ctx.rollChess({ maxTier: 6 })))
          : (typeof ctx.rollChessAnyTier === 'function' ? ctx.rollChessAnyTier({ maxTier: 6 }) : ctx.rollChess({ maxTier: 6 }));
        if (id) ctx.setShopSlot(i, { kind: 'chess', id, price: cheat ? 1 : 1 + ctx.rng.int(6) });
      }
      ctx.toast(cheatOn(ctx) ? '“神秘”商店：只出5/6阶，价格1' : '“神秘”商店：本次刷新无视等级，价格随机', 'info');
    },
  },

  /** ？* /）层数/¥）dgxu — 每回合开始时把本模式全部盟约的层数值随机重排（总和不变，分配被打乱；未激活/隐藏的也进池）。 */
  jibian_cengshudaluan: {
    onRoundStart(ctx, ev) {
      const r = Number(ev && ev.round) || 1;
      if (ctx.counter(K.cengFirst) === r) return;     // 抽到这张卡的当回合不洗
      ctx.setCounter(K.cengFirst, 0);
      // ★ 2026-10-17（用户：「不要让他可以把可叠加的盟约跟不可叠加的盟约替换」）：
      //   **洗牌池只含"可叠加"的盟约**（`bonds.json` 的 `noStack === false`）。
      //   理由（数据实证）：不可叠加的 4 个盟约（调和 / 协防干员 / 独行 / 绝技）的
      //   `perStackParams` 与 `layerMilestones` **都是空数组** —— 层数对它们没有任何效果
      //   （前端 `bondStrip.js:186` 对它们直接显示「层数不显示」）。
      //   原来的无差别洗牌会把可叠加盟约辛苦攒的层数塞给这些盟约 ⇒ 那些层数**白扔**，
      //   而可叠加盟约本该拿到的层数被摊薄。现在不可叠加的保持原值（0）不参与交换，
      //   层数只在真正吃层数的盟约之间重排。
      // ★ 2026-10-26（owner）：池子改成「本模式**可用**的全部盟约」——已激活的、还没激活的（0 层）都进池，
      //   但「本局禁用」(mode.inactiveBondIds，卡面显示「本局禁用」) 不进池：它们永远无法激活/叠层，塞过去就是白扔。
      //   例：炎 999 + 奥术 888 已激活，场上 1 名精准、未激活的远见 0 层 → 洗牌后可能是精准 999、远见 888。
      //   不可叠加盟约（调和/协防/独行/绝技）依旧排除（层数对它们无效果）。
      let allowed = null;
      try {
        // gd.mode 是**对象**（GameData 构造时 getMode(...) 的结果），不是函数 —— 曾按函数写导致 allowed 永远为 null（池子退回全部）
        const mode = ctx.gd && ctx.gd.mode && typeof ctx.gd.mode === 'object' ? ctx.gd.mode : null;
        if (mode && Array.isArray(mode.activeBondIds)) allowed = new Set(mode.activeBondIds);
      } catch { /* 无 mode 信息时退回全部 */ }
      const ids = bondIds(ctx).filter((id) => (!allowed || allowed.has(id)) && !ctx.bondNoStack(id));
      if (ids.length < 2) return;
      const vals = ids.map((id) => Number(ctx.layers(id)) || 0);
      // ★ ctx.rng 本身就是 rng（可调用，同时带 .int/.range/.pick/.shuffle 方法），**不是**返回 rng 的函数。
      //   原来写 ctx.rng().int(...) → 对浮点数取 .int → TypeError，被 dispatch 的 _safe 吞掉后整张卡静默失效
      //   （和「神秘商店」同一个坑，owner 2026-10-16）。
      const rng = ctx.rng;
      for (let i = vals.length - 1; i > 0; i--) { const k = rng.int(i + 1); const t = vals[i]; vals[i] = vals[k]; vals[k] = t; }
      for (let i = 0; i < ids.length; i++) ctx.setLayers(ids[i], vals[i], { reason: P + 'cengshudaluan' });
      ctx.toast('层数被打乱了……', 'info');
    },
  },

  /**
   * 追忆 (传说, owner 2026-10-16) —「你和你的队伍在第十三回合结束时不进入第十四回合，变为进入第十回合
   * 整备阶段，之后该惊变失效」。第 13 回合结束 → 下一次 startRound(14)：把回合号改写成 10 并**消耗本卡**。
   * ★ 因为 round 被改回 10，第 13 → 10 → 11 → 12 → 13 会再走一遍；第二次到 13 时**卡已不在**，所以只会发生一次
   *   （owner 2026-10-16 确认：「我不是加了‘之后该惊变失效’吗」）。
   */
  jibian_zhuiji: {
    onRoundWouldStart(ctx, ev) {
      if (!ev || Number(ev.round) !== 14) return;      // 卡面写的"第十三回合结束"= 即将进入第 14 回合
      // ★ 2026-10-26（owner）：一次性但**不销毁** —— 卡保留在手上的惊变列表里，只是失效、不能再触发第二次。
      if (ctx.jibianConsumed?.().has('jibian_zhuiji')) return;
      ev.round = 10;                                    // 改为进入第 10 回合整备阶段
      ctx.markJibianConsumed?.('jibian_zhuiji');        // 记入本局已消耗（也保证不会再抽出第二张）
      ctx.toast('追忆：回到第 10 回合', 'info');
    },
  },

  /** 恶魔契约 — 整备结束、实际战斗开始前 +3 目标生命。 */
  jibian_emoxieyue: {
    onPrepEnd(ctx) {
      ctx.setCounter(K.devPay, 1);                 // 兜底：跨回合/重连后仍然生效
      // +3 目标生命：ev 上没有 PlayerState，用 ctx 暴露的 lp 能力 —— 这里只能"借"回来：
      // economy 侧读 K.devPay 计数器决定是否允许 lp 抵扣；+3 走 ps.lp，由下面 economy 的小工具做。
      ctx.addLp?.(3);
      ctx.toast('恶魔契约：目标生命 +3', 'info');
    },
  },

  jibian_111fuhuoma: {
    onGain(ctx, ev) {
      if (!ev || ev.kind !== 'chess' || !ev.piece) return;
      const p = ev.piece;
      const rec = ctx.chessRecord?.(p.id || p.baseId) || null;
      const cid = p.charId || rec?.charId || null;
      if (cid !== 'char_183_skgoat') return;              // 只有地灵
      if ((p.area || '') === 'board') { /* 获得即钩，位置无关 */ }
      // 她的卫戍层数：普通/炸惊记录都是 +2 / +4 / +8，按记录自己的卫戍 bb 取
      // ★ 用 ctx.garrisonsOf(uid) 取她的卫戍 bb（ctx.data 是 gd.raw，**不含** garrisons.json）
      const gs = ctx.garrisonsOf ? (ctx.garrisonsOf(p.uid) || []) : [];
      const n = gs.reduce((a, g) => a + (Number(g && g.bb && g.bb.count) || 0), 0);
      if (!(n > 0)) return;
      for (const b of (ctx.pieceBonds?.(p.uid) || rec?.bonds || ['miraShip', 'visiShip'])) {
        ctx.addLayers(b, n, { requireActive: false });    // 她的卫戍是「无需激活盟约」
      }
      ctx.toast('某个干员的特质改变了……', 'info');
    },
  },

  jibian_shiguangzhimo: {
    onWouldEliminate(ctx, ev) {
      if (ev && (ev.kind === 'boss' || ev.kind === 'hidden')) return;   // 非 boss 战才算
      ev.saved = true;
      // 触发即消耗：照 倒转区/潘多拉魔盒 的写法找自己这张 ref（ctx 上没有 self/ref）
      const self = ctx.effects().find((e) => e.key === P + 'jibian_shiguangzhimo');
      if (self) ctx.removeEffect(self.id);
    },
  },

  /** 这杯我请: 每回合首个购买的干员和装备售价为 0. */
  jibian_zhebeiwuqing: {
    onRoundStart(ctx) { ctx.setCounter(K.freeChess, 0); ctx.setCounter(K.freeItem, 0); },
    // onPrice 只是「问价」(商店刷新、界面显示都会问), 所以这里不能记「已用掉」—— 只有 onBuy 才置 1.
    onPrice(ctx, ev) {
      const slot = ev && ev.slot;
      if (!slot || slot.sold) return;
      const item = slot.kind === 'item';
      if (ctx.counter(item ? K.freeItem : K.freeChess) === 0) ctx.setPrice(0);
    },
    onBuy(ctx, ev) {
      const item = ev && ev.kind === 'item';
      ctx.setCounter(item ? K.freeItem : K.freeChess, 1);
    },
  },

  /** 板藤: 卖价 4 起、每回合 +4；套现走商店栏的「出售板藤」键位（C2S `g.sellBanteng` →
   * server/match/player/economy.js 的 sellBanteng，与「维多利亚的秘密」的特殊刷新同一套）。 */
  jibian_banteng: {
    onRoundStart(ctx) {
      ctx.setCounter(K.banteng, (ctx.counter(K.banteng) || BANTENG_START) + BANTENG_STEP);
    },
  },

  /**
   * 超前消费: x+1 ~ x+3 三个回合的**资金收入**固定为 0（基础收入与利息一起没了）。
   * `ev.pending` 故意保持不动 —— 那是悬赏怪的赏金 / 结算奖励等挂账资金，卡片文案写明了「不受悬赏怪影响」。
   */
  jibian_chaoqianxiaofei: {
    onIncome(ctx, ev) {
      if (!ev) return;
      const r = Number.isFinite(ev.round) ? ev.round : ctx.round;
      const from = ctx.counter(K.debtFrom);
      const to = ctx.counter(K.debtTo);
      if (to <= 0 || r < from || r > to) return;
      ev.income = 0;
    },
  },

  /** ？！325799？！: 活过 7 回合 (第 8 回合开始) → 随机一个已激活盟约 +325 层, 然后这张卡消失. */
  jibian_325799: {
    onRoundStart(ctx, ev) {
      const r = ev && Number.isFinite(ev.round) ? ev.round : ctx.round;
      if (r < 8) return;
      const b = pick1(ctx, Object.keys(ctx.bonds()).filter((id) => ctx.bondActive(id)));
      if (!b) return;                                  // 还没有已激活盟约: 留到下回合再结算
      ctx.addLayers(b, 325, { requireActive: true, reason: P + '325799' });
      const self = ctx.effects().find((e) => e.key === P + 'jibian_325799');
      if (self) ctx.removeEffect(self.id);
      ctx.toast(`325799：${b} 层数 +325`, 'info');
    },
  },

  /** 倒转区: 任一盟约到达 999 层 → 20 资金, 然后这张卡消失 (层数只在 onLayers 变, onRoundStart 兜底). */
  jibian_daozhuanqu: {
    onLayers(ctx) { questDaozhuanqu(ctx); },
    onRoundStart(ctx) { questDaozhuanqu(ctx); },
  },

  /** “叠层手”: 五回合内, 通过特质 (garrison) 提高的层数再补一份 —— 只有 reason 是 garrison: 的才算「通过特质」. */
  jibian_diecengshou: {
    onLayers(ctx, ev) {
      const until = ctx.counter(K.layersUntil);
      if (!until || ctx.round > until) return;
      if (!ev || !ev.bondId || !(ev.to > ev.from)) return;
      // ★ 2026-10-17（用户：「加入大群这个惊变好像没生效」）：卫戍特质加层时传的 reason 是
      //   **`'garrison'`（无冒号）** —— 见 garrisons/battle.js:252 `reason: 'garrison'`；
      //   而这里原来查的是 `startsWith('garrison:')`（那是**钩子注册键**的格式，
      //   effectsMeta.js 的 `garrison:<effectKey>`），所以永远不成立，惊变从未生效。
      //   现在两种写法都认。
      if (!/^garrison(:|$)/.test(String(ev.reason || ''))) return;
      ctx.addLayers(ev.bondId, ev.to - ev.from, { reason: P + 'diecengshou' });   // 自己补的这份 reason 不同, 不会递归
    },
  },

  // ---- 第二批（用户 2026-10-12）--------------------------------------------------------------------
  /**
   * 加入大群 — 【阿戈尔】干员通过特质提升的层数 +100%；拥有浊心斯卡蒂时再翻倍（总共 ×3）。
   * 口径与「叠层手」一致：「通过特质提高的层数」= reason 以 `garrison:` 开头的那一份（盟约自身/战斗结算的层数不算）。
   */
  jibian_jiarudaqun: {
    onLayers(ctx, ev) {
      if (!ev || !ev.bondId || !(ev.to > ev.from)) return;
      if (ev.bondId !== 'egirShip') return;
      // ★ 2026-10-17（用户：「加入大群这个惊变好像没生效」）：卫戍特质加层时传的 reason 是
      //   **`'garrison'`（无冒号）** —— 见 garrisons/battle.js:252 `reason: 'garrison'`；
      //   而这里原来查的是 `startsWith('garrison:')`（那是**钩子注册键**的格式，
      //   effectsMeta.js 的 `garrison:<effectKey>`），所以永远不成立，惊变从未生效。
      //   现在两种写法都认。
      if (!/^garrison(:|$)/.test(String(ev.reason || ''))) return;
      const hasSkadi = ownPieces(ctx).some((p) => p && (SKADI_CORRUPTED.includes(p.id) || SKADI_CORRUPTED.includes(p.baseId)));
      ctx.addLayers(ev.bondId, (ev.to - ev.from) * (hasSkadi ? 2 : 1), { reason: P + 'jiarudaqun' });
    },
  },

  /** 高级资深干员 / 资深干员 — "下一次刷新变为特殊刷新"：消费预约，把该次刷出的干员槽位全换成随机六/五阶. */
  jibian_gaojizishen: {
    onRefresh(ctx) {
      const tier = ctx.counter(K.specialTier);
      if (!(tier > 0)) return;
      ctx.setCounter(K.specialTier, 0);
      for (const [i, s] of (ctx.shopSlots() || []).entries()) {
        if (!s || s.kind !== 'chess') continue;
        const id = ctx.rollChess({ tier });
        if (id) ctx.setShopSlot(i, { kind: 'chess', id });
      }
      ctx.toast(`特殊刷新：本次商店全是 ${tier} 阶干员`, 'info');
    },
  },

  /** 资深干员 — 与 高级资深干员 共用同一段实现（预约的阶数在 K.specialTier 计数器里）。 */
  jibian_zishen: {
    onRefresh(ctx) {
      const tier = ctx.counter(K.specialTier);
      if (!(tier > 0)) return;
      ctx.setCounter(K.specialTier, 0);
      for (const [i, s] of (ctx.shopSlots() || []).entries()) {
        if (!s || s.kind !== 'chess') continue;
        const id = ctx.rollChess({ tier });
        if (id) ctx.setShopSlot(i, { kind: 'chess', id });
      }
      ctx.toast(`特殊刷新：本次商店全是 ${tier} 阶干员`, 'info');
    },
  },

  /**
   * “维多利亚的秘密” — 每回合 1 次特殊刷新（客户端商店栏的按钮 → C2S `g.specialRefresh`）：
   * 无视商店等级、只出【维多利亚】干员，且这次刷新后购买的首个干员 -1 资金。
   * 引擎里没有"特殊刷新"状态对象，口径 = 计数器 + 下一次 onRefresh 消费（同 佩佩 的 up_shop_next_refresh）。
   */
  jibian_weiduoliyademimi: {
    onRoundStart(ctx) { ctx.setCounter(K.vicCharge, 1); },
    onRefresh(ctx) {
      ctx.setCounter(K.vicDiscount, 0);
      if (ctx.counter(K.vicRefresh) !== 1) return;
      ctx.setCounter(K.vicRefresh, 0);
      ctx.setCounter(K.vicDiscount, 1);
      for (const [i, s] of (ctx.shopSlots() || []).entries()) {
        if (!s || s.kind !== 'chess') continue;
        const id = ctx.rollChessAnyTier({ bond: 'victoriaShip', maxTier: 6 });
        ctx.setShopSlot(i, id ? { kind: 'chess', id } : null);
      }
      ctx.toast('维多利亚的秘密：本次刷新只会出现【维多利亚】干员', 'info');
    },
    onPrice(ctx, ev) {
      if (ctx.counter(K.vicDiscount) !== 1) return;
      const slot = ev && ev.slot;
      if (!slot || slot.sold || slot.kind !== 'chess') return;
      ctx.modifyPrice(-1);
    },
    onBuy(ctx, ev) { if (!ev || ev.kind !== 'item') ctx.setCounter(K.vicDiscount, 0); },
  },

  /**
   * “影分身” — 每个已部署干员，对它自己所属的每个盟约，盟约人数 +1。
   * bondCountBonus 是**覆盖式的玩家级整数**，所以每次重算前先把上一次写过的清 0。
   * 备注：备战期没有"落子"钩子，重建挂在 回合开始 / 买 / 卖 / 合并 / 获得 / 休整期结束（最后一个正好在战斗快照之前）。
   */
  jibian_yingfenshen: {
    onRoundStart(ctx) { fenshenApply(ctx); },
    onPrepEnd(ctx) { fenshenApply(ctx); },
    onBuy(ctx) { fenshenApply(ctx); },
    onSold(ctx) { fenshenApply(ctx); },
    // ★ 2026-10-13（用户报的 bug）：干员【摆位/移动】后也要立刻重算影分身 —— 原来只挂
    //   onRoundStart/onPrepEnd/onBuy/onSold，摆位时的人数加成不刷新。
    onLayout(ctx) { fenshenApply(ctx); },
    onMerge(ctx) { fenshenApply(ctx); },
    onGain(ctx) { fenshenApply(ctx); },
  },

  /**
   * 紧急调派 — 这回合是完美作战的话，回合结束给一个"不超过当前商店等级、来自盟约层数最高盟约"的干员。
   * 完美作战直接读 ev.perfect（settle.js dispatch 的 onBattleResult）；结算期发的干员下个整备期可用。
   */
  jibian_jinjidiaopai: {
    onBattleResult(ctx, ev) {
      if (!ev || ev.perfect !== true) return;
      const layersOf = (id) => Number(ctx.layers(id)) || 0;
      const active = bondIds(ctx).filter((id) => ctx.bondActive(id) && layersOf(id) > 0);
      const pool = active.length ? active : bondIds(ctx).filter((id) => layersOf(id) > 0);
      let top = null;
      let topN = 0;
      for (const id of pool) if (layersOf(id) > topN) { topN = layersOf(id); top = id; }
      if (!top) return;
      const id = ctx.rollChess({ bond: top, maxTier: Math.max(1, ctx.shopLevel() || 1) });
      if (!id) return;
      ctx.grantChess(id);
      const name = (ctx.gd.bond(top) || {}).name || top;
      ctx.toast(`紧急调派：完美作战 → ${name}（${topN} 层）的干员`, 'info');
    },
  },

  // ---- 第三批（用户 2026-10-13）--------------------------------------------------------------------
  /**
   * 高卢银行支票 — **每个整备阶段开始时**掷一次提现金额（第一次 = 拿到后的第一个整备阶段），把上一场战斗的增量
   * 结算进去，随后概率回归初始（counter 与商店栏的「提现」键位读同一个值）。
   */
  jibian_gaoluzhipiao: {
    onPrepStart(ctx) { chequeSettle(ctx); },
    // 增量：击杀 / 漏怪 / 被队友兜住（只有战斗结算这一步同时拿得到这三样）
    onBattleResult(ctx, ev) { chequeAccrue(ctx, ev); },
  },

  /** 金酒之杯 — 整备阶段结束时按当时资金结算，结果写进 ref params，供紧接的那场战斗读取。 */
  jibian_jinjiuzhibei: {
    onPrepEnd(ctx) { cupSettle(ctx); },
  },
};

/**
 * “影分身”: 备战区的干员数 → bondCountBonus。它是**覆盖式的玩家级整数**（ps.bondCountBonus[bond] = 人数加成），
 * 而这张卡是这份数值的唯一写入者，所以每次重算都直接整表刷新：没有干员的盟约写 0，带 N 个的写 N。
 * （以前想用"记下上次写过的键再清"的办法，但 ctx.setCounter 只接受有限数字，存不了盟约列表。）
 */
function fenshenApply(ctx) {
  const bonus = new Map();
  for (const p of ctx.board() || []) {
    if (!p || p.kind !== 'chess') continue;
    for (const b of ctx.pieceBonds(p.uid) || []) bonus.set(b, (bonus.get(b) || 0) + 1);
  }
  for (const id of bondIds(ctx)) ctx.setBondCountBonus(id, bonus.get(id) || 0);
}

export function registerMeta(registry) {
  if (!registry || typeof registry.register !== 'function') return;
  for (const [id, onPick] of Object.entries(ON_PICK)) {
    registry.register(P + id, {
      onChoicePick(ctx, ev) {
        if (!justPicked(ctx)) return;   // the 'choice:<id>' run happened before the ref existed
        // 还要确认「这次抽的就是自己」：choices.js 抽完一张卡会把 onChoicePick 再派发给该玩家的**所有** refs
        // （choices.js applyCard 最后那行 m.dispatch），所以第 1 回合选的惊变原先会在第 3 回合选装备、以及之后
        // 任何一次抽取时**再触发一遍**（用户反馈 2026-10-11：「第一回合选的惊变会在第三回合选装备时重新触发」）。
        // 潘多拉魔盒直接调 onPick（传自己的 ctx，不带 ev.card），那条路不受影响。
        if (ev && ev.card) {
          const picked = ev.card.id || ev.card.effectId || null;
          if (picked && picked !== id) return;
        }
        onPick(ctx);
      },
      ...(HOOKS[id] || {}),
    });
  }
  /**
   * 极速送达！的三个包裹：注册 `item:chess_item_jibian_jisusongda_*`（装备即消耗）。
   * 引擎的消耗分支（server/match/player/items.js）在装备这类道具前会先查 `registry.has('item:'+itemKey(id))`，
   * 没有就直接 fail(ERR.BAD_TARGET,'effect not available') —— 所以这三个 key 必须在这里注册。
   */
  for (const itemId of Object.keys(JISUSONGDA_TIERS)) {
    registry.register(`item:${itemId}`, {
      onEquip(ctx, ev) { openPackageOnEquip(ctx, ev); },
    });
  }
}
