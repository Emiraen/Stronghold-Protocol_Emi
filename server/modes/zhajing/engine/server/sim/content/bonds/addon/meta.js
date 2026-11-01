// server/sim/content/bonds/addon/meta.js — prep side of the add-on bonds (research 02 §3.14–§3.17, §3.20).
//
//   助力 deputShip  onPrepEnd: every currently active bond +`layer` (tier 2 = 3 助力 by name or elite state:
//                  +`more_layer`) — buff bond_activated_add_layer
//   远见 visiShip   every `layer` layers +`count` funds (bond_layer_gain_coin); first time at `layer1`: 远见 chess cost
//                  −`discount`; first time at `layer2`: every chess costs −`discount` instead (latched, permanent)
//                  (炸惊的奇迹曾共用这条，2026-10-13 用户 #4 要求删除 —— 见 miraSettle)
//   奇迹 miraShip   manual refresh with no free refresh pending → p = min(1, baseprob + prob·L) the next refresh is free;
//                  every 100 layers +20 funds (bond_layer_gain_coin). `probk` has no known meaning and is unused.
//   投资人          ×2 / ×3 "获得时" garrisons: EffectDispatcher.investRepeat (server/match/effectsMeta.js).
//   调和            +1 member count for core bonds: server/match/bondsMeta.js.
//
// Milestones read the persistent layers and pay only while the bond is active; payouts owed for layers gained while it
// was inactive ("无需激活" sources) are caught up the next time a hook sees it active (research 02 §8 Q7 [ASSUMED]).
// Funds earned after the prep phase ended (助力 / 寒檀 / 号角 … prep-end layers — the match wipes leftover funds right
// after onPrepEnd) are paid as pending funds, credited at the next round start, so "获得…资金" is never silently lost
// [ASSUMED]; `global:bondaddon_prepend` (first in every dispatch) marks the round whose prep has ended.
// 远见's −1 (「购买价格永久-1资金」) has no floor but 0: a price of 1 (至简 / 红豆's 购买价格为1 特质, run first on onPrice;
// 休露丝's first 谢拉格) becomes 0 — the text names none (owner's decision 2026-10-04; before 0.1.3 research 02 §3.15
// assumed 1).
// Latched state lives in player counters (prefix `bondaddon:`); onPrice only reads them (pure).

import { msg, dn } from '../../../../../shared/i18n.js';

const C_VISI_PAID = 'bondaddon:visi:paid';
const C_VISI_DISC = 'bondaddon:visi:disc';
const C_MIRA_PAID = 'bondaddon:mira:paid';
/** 炸惊模拟下「奇迹」的每层概率增量（p = baseprob + 本值·层数；用户 2026-10-17 给定 0.0075）。 */
const MIRA_PROB_ZJ = 0.00075;
// C_MIRA_DISC（'bondaddon:mira:disc'）随奇迹折扣一起删除（2026-10-13 用户 #4）
const C_PREP_ENDED = 'bondaddon:prepEndedRound';
/** Hooks on which owed milestones are caught up (besides the bond's own onLayers). */
const SETTLE_HOOKS = Object.freeze(['onRoundStart', 'onPrepStart', 'onPrepEnd', 'onBuy', 'onGain', 'onSold', 'onMerge']);

const n = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** `{ ...bb, ...bbStr }` of a bond buff from the match data (ctx.data), or {}. */
function buff(ctx, bondId, key) {
  const rec = ctx.data && ctx.data.bonds ? ctx.data.bonds[bondId] : null;
  for (const b of (rec && Array.isArray(rec.buffs) ? rec.buffs : [])) {
    if (b && b.key === key) return { ...(b.bb || {}), ...(b.bbStr || {}) };
  }
  return {};
}

/**
 * ★ 2026-10-21（owner：「助力生不生效」）：`buff()` 读的是**原始** bonds 数据，看不到炸惊的 `zj` 覆盖块，
 *   于是助力在炸惊下拿到的是普通模式的 +2 / +4，而不是数据里写的 +10 / +30。
 *   这里在炸惊模式下用 `zj.bb` 的同名字段覆盖 buff 参数，与 gd.bond() 的合并视图一致。
 */
function buffZj(ctx, bondId, key) {
  const p = buff(ctx, bondId, key);
  const zn = /zhajing/i.test(String((ctx && ctx.modeId) || ''));
  if (!zn) return p;
  const rec = ctx.data && ctx.data.bonds ? ctx.data.bonds[bondId] : null;
  const zj = rec && rec.zj && rec.zj.bb ? rec.zj.bb : null;
  if (!zj) return p;
  const out = { ...p };
  for (const k of Object.keys(out)) if (zj[k] != null) out[k] = zj[k];
  return out;
}

/** Pay "every `layer` layers +`count` funds" up to the current layers (only while active). */
function settleCoins(ctx, bondId, counterKey, label) {
  if (!ctx.bondActive(bondId)) return 0;
  const p = buff(ctx, bondId, 'bond_layer_gain_coin');
  const step = n(p.layer), count = n(p.count);
  if (!(step > 0) || !(count > 0)) return 0;
  const due = Math.floor(ctx.layers(bondId) / step);
  const paid = ctx.counter(counterKey);
  if (due <= paid) return 0;
  ctx.setCounter(counterKey, due);
  const gain = (due - paid) * count;
  if (prepEnded(ctx)) {
    ctx.addPendingFunds(gain);
    ctx.toast(msg('【{label}】层数达成，下回合开始时获得{gain}资金', { label: dn(label), gain }), 'info');
  } else {
    ctx.addFunds(gain, `bond:${bondId}`);
    ctx.toast(msg('【{label}】层数达成，获得{gain}资金', { label: dn(label), gain }), 'info');
  }
  return gain;
}

/** True between this round's onPrepEnd and the end of its PREP phase (leftover funds are about to be wiped). */
const prepEnded = (ctx) => ctx.phase === 'PREP' && ctx.counter(C_PREP_ENDED) === ctx.round;

/**
 * Latch a bond's permanent shop discount from its `bond_multi_layer_char_goods_price_bond_discount` buff: reaching
 * `layer1` discounts that bond's own operators, reaching `layer2` discounts every operator instead (the higher tier
 * replaces the lower one, never stacks — PRTS 3/27 update). Latched in the player counter, so it survives the layer
 * count dropping; `onPrice` only reads it. 远见 uses layer1 = 80 / layer2 = 150 (tier 1 = 远见 own operators only,
 * tier 2 = every operator). 炸惊的奇迹 used to share this (layer1 = layer2 = 200, 全体) — that whole discount was
 * removed on 2026-10-13 (user #4), so the only bond left here is 远见.
 */
function latchDiscount(ctx, bondId, counterKey, label) {
  if (!ctx.bondActive(bondId)) return;
  const p = buff(ctx, bondId, 'bond_multi_layer_char_goods_price_bond_discount');
  const L = ctx.layers(bondId);
  const cur = ctx.counter(counterKey);
  const t = L >= n(p.layer2, Infinity) ? 2 : L >= n(p.layer1, Infinity) ? 1 : 0;
  if (t > cur) {
    ctx.setCounter(counterKey, t);
    ctx.toast(t >= 2 ? `【${label}】所有干员购买价格永久降低` : `【${label}】${label}干员购买价格永久降低`, 'info');
  }
}

function visiSettle(ctx) {
  settleCoins(ctx, 'visiShip', C_VISI_PAID, '远见');
  latchDiscount(ctx, 'visiShip', C_VISI_DISC, '远见');
}
const miraSettle = (ctx) => {
  // ★ 2026-10-15 修复（玩家反馈「非炸惊模式 100 层奇迹不给钱」）：2026-10-13 用户 #4 要求删除的是
  //   **折扣**那条 ——「首次达到200层，调度中心内所有干员的购买价格永久-1资金」。当时把这一行
  //   `settleCoins` 也一起注释了，属于误删：
  //     · 折扣那条：data/bonds.json 的 miraShip 里 `bond_multi_layer_char_goods_price_bond_discount`
  //       **确实已不存在**（数据+代码都删干净了）—— 那是要删的；
  //     · 给钱这条：`bond_layer_gain_coin { layer: 100, count: 20 }` 在 miraShip.buffs 里**一直都在**，
  //       `layerMilestones` 也还在，descRaw 也还写着「每叠加100层获得20资金」—— 只注释代码 = 只剩一半，
  //       于是普通模式（zkz 的 zj 覆盖里没有这一行，只有普通模式读得到这条描述）描述承诺给钱、实际不给。
  //   ▲ 所以 10-15 那次恢复的目标**只是普通模式** —— 见下面炸惊的分支。
  //
  // ★ 2026-10-16（owner 定案 A）：**炸惊模式下不给这 20 资金**。
  //   2026-10-13 用户 #4 要求把炸惊的这条删掉，但那个意图在全链路上一直没真正生效：
  //     · 数据层：miraShip.zj 只覆盖了刷新那条（bond_refresh_shop_next_free），没排除给钱那条；
  //     · 合并层：shared/zjBonds.js 是**按 key 合并**（同 key 整条替换、新 key 追加）—— **只能加/改，不能删**，
  //       所以 zj 段没有语法能表达"去掉这条 buff"；
  //     · 代码层：settleCoins 读的是 `ctx.data.bonds[bondId].buffs`（**原始数据，未过 zj 视图**），
  //       绕过合并结果 —— 于是两个模式都读得到，代码里没有任何区分机制。
  //   实测（用 zjBondView 跑真实数据）：merge:true 与 merge:false 两个视图里
  //   `bond_layer_gain_coin {layer:100,count:20}` **完全一样地存在**。所以在这里挡是唯一可行的位置。
  //   判定用 ctx.modeId（effectsMeta 的 makeCtx 提供，形如 'mode_single_zhajing'）。
  const modeId = String((ctx && ctx.modeId) || '');
  if (modeId.includes('zhajing')) return;   // 炸惊：不给（2026-10-13 用户 #4 的原意）
  settleCoins(ctx, 'miraShip', C_MIRA_PAID, '奇迹');
  // ★ 2026-10-13（用户 #4）：奇迹的「首次达到200层，调度中心内所有干员的购买价格永久-1资金」
  //   一整条已删除（data/bonds.json 的 miraShip 里已无该 buff），故这里不再 latchDiscount。
};

/** Permanent shop discounts latched by 远见（炸惊的奇迹已无折扣 —— 2026-10-13 用户 #4 删除）。 */
const DISCOUNTS = Object.freeze([['visiShip', C_VISI_DISC]]);

/**
 * `onPrice`: apply the latched discount of `ev.kind === 'chess'` (never below 0 — ctx.modifyPrice).
 *
 * ★ 2026-10-13 修「150 层远见 → 全体 −2」：原来两条带折扣的盟约各减一次、累加成 −2 ✗，与描述不符 ——
 * 现在**取最大的那一档**（不叠加）：无论同时有几个这类盟约在场，全体购买价格都只降 **1** 资金 ✓。
 * （炸惊的奇迹那条已在 2026-10-13 用户 #4 删除，本逻辑现在只服务远见；"取最大"分支保留以便将来复用。）
 */
function discountPrice(ctx, ev) {
  if (!ev || ev.kind !== 'chess') return;
  let best = 0;
  for (const [bondId, counterKey] of DISCOUNTS) {
    const t = ctx.counter(counterKey);
    if (t <= 0) continue;
    const p = buff(ctx, bondId, 'bond_multi_layer_char_goods_price_bond_discount');
    const disc = n(p.discount);
    if (!(disc > 0)) continue;
    if (t < 2) {
      const rec = ctx.chessRecord(ev.id);
      if (!rec || !Array.isArray(rec.bonds) || !rec.bonds.includes(p.bond || bondId)) continue;
    }
    if (disc > best) best = disc;          // 取最大，而不是累加
  }
  if (best > 0) ctx.modifyPrice(-best);    // never below 0 (ctx.modifyPrice); 1 → 0 like any price (owner's decision 2026-10-04)
}

/** A handler object running `fn(ctx)` on every catch-up hook and on the bond's own layer gains. */
function settler(bondId, fn) {
  const h = { onLayers(ctx, ev) { if (ev && ev.bondId === bondId) fn(ctx); } };
  for (const hook of SETTLE_HOOKS) h[hook] = (ctx) => fn(ctx);
  return h;
}

export function registerMeta(registry) {
  registry.global('bondaddon_prepend', {
    onPrepEnd(ctx) { ctx.setCounter(C_PREP_ENDED, ctx.round); },
  });

  registry.bond('deputShip', {
    onPrepEnd(ctx) {
      const me = ctx.bond('deputShip');
      if (!me || !me.active) return;
      // ★ 炸惊要拿 zj 覆盖后的数值（+10 / +30），普通模式仍是 +2 / +4
      const p = buffZj(ctx, 'deputShip', 'bond_activated_add_layer');
      const add = me.tier >= 2 ? n(p.more_layer, n(p.layer)) : n(p.layer);
      if (!(add > 0)) return;
      const active = Object.entries(ctx.bonds()).filter(([, b]) => b && b.active).map(([id]) => id);
      for (const id of active) ctx.addLayers(id, add, { requireActive: true, reason: 'bond:deputShip' });
    },
  });

  registry.bond('visiShip', {
    ...settler('visiShip', visiSettle),
    onPrice: discountPrice,
  });

  registry.bond('miraShip', {
    ...settler('miraShip', miraSettle),
    // ★ 2026-10-14 修 bug：奇迹的减价已按用户 #4（2026-10-13）删除（miraSettle 清空、DISCOUNTS 也只剩
    //   远见），但这里 `onPrice: discountPrice` 是**漏删的残留** —— 它让 discountPrice 被【两个盟约】各调一次，
    //   每次 modifyPrice(-1)，累加成 −2：售价 2 的干员直接 0（FREE，owner report
    //   2026-10-14「远见 150 层二本就免费了」）。删除后同一笔购买只享受一次 −1。
    onRefresh(ctx, ev) {
      if (!ev || ev.trigger || !ctx.bondActive('miraShip')) return;
      if (ctx.grantFreeRefresh(0) > 0) return;
      const p = buff(ctx, 'miraShip', 'bond_refresh_shop_next_free');
      // ★ 2026-10-17（用户给定）：炸惊模拟的概率公式是 **p = 0.18 + 0.00075·L**，与普通模式的
      //   `0.18 + 0.003·L` 不同。不能靠 `zj.bb.prob` 覆盖 —— `buff()` 读的是 `ctx.data.bonds`
      //   **原始数据**（未过 shared/zjBonds.js 的合并视图；miraSettle 上面的注释已记录同一件事），
      //   所以 zj 段里的 prob 拿不到，只能在这里按模式取系数。
      //   数据侧 `miraShip.zj.bb.prob` 已同步写成 0.00075，作为同一事实的声明。
      const zn = String((ctx && ctx.modeId) || '').includes('zhajing');
      const prob = zn ? MIRA_PROB_ZJ : n(p.prob);
      const chance = Math.max(0, Math.min(1, n(p.baseprob) + prob * ctx.layers('miraShip')));
      if (ctx.rng() < chance) {
        ctx.grantFreeRefresh(1);
        ctx.toast('【奇迹】下次刷新不消耗资金', 'info');
      }
    },
  });

  // ★ 2026-10-17（S.E.E.S.txt，用户：「我想起来我的txt里面那几个首次获得也是盟约效果啊 你咋没做呢」）：
  //   「<首次获得虎狼丸>获得 ◤“S.E.E.S”袖章◢ / <首次获得岳羽由加莉>获得月光馆学园校服 /
  //     <首次获得埃癸斯>获得人格面具召唤器」—— 这三条是【S.E.E.S】盟约的效果，
  //   触发点是 `onGain`（server/match/player/acquire.js:85，玩家获得干员时派发，ev = { piece, kind, source }）。
  //   · **不要求盟约已激活**：阈值是 2 名，而「首次获得第一人」时必然只有 1 名 —— 要求激活就永远发不出来；
  //   · 每人每件只发一次：用玩家计数器 `bondaddon:sees:gift:<谁>` 做闩锁；
  //   · 精锐（_b）也算获得（acquireChess 会先解析 baseId，但两手都兜住）。
  const SEES_GIFTS = [
    { flag: 'kormr', who: '虎狼丸', gift: '“S.E.E.S”袖章',
      chess: ['chess_zj_60_2_a', 'chess_zj_60_2_b'], item: 'chess_item_sees_armband_a' },
    { flag: 'yukari', who: '岳羽由加莉', gift: '月光馆学园校服',
      chess: ['chess_zj_60_4_a', 'chess_zj_60_4_b'], item: 'chess_item_sees_uniform_a' },
    { flag: 'aigis', who: '埃癸斯', gift: '人格面具召唤器',
      chess: ['chess_zj_60_3_a', 'chess_zj_60_3_b'], item: 'chess_item_sees_evoker_a' },
  ];
  registry.bond('seesShip', {
    onGain(ctx, ev) {
      const piece = ev && ev.piece;
      if (!piece || ev.kind !== 'chess' || !piece.id) return;
      for (const g of SEES_GIFTS) {
        if (!g.chess.includes(piece.id)) continue;
        const key = `bondaddon:sees:gift:${g.flag}`;
        if (ctx.counter(key)) return;          // 已经发过（同一盟约同一人只发一次）
        ctx.setCounter(key, 1);
        if (ctx.grantItem(g.item)) ctx.toast(`【S.E.E.S】首次获得${g.who}：获得「${g.gift}」`, 'reward');
        return;
      }
    },
  });

  // ★ 2026-10-23（owner）：「<首次获得祐天寺若麦时>获得一个谜の假面」的**发放逻辑在 mujicaBond.js** 的
  //   registry.bond(MUJICA_BOND, {...}) 里 —— 本文件也注册过 bond:mujicaShip，后注册会覆盖先注册，
  //   放这里会被 mujicaBond 的 onRefresh 顶掉（已实测）。此处只留说明，不重复注册。
}
