// server/sim/content/bands/meta.js — prep side of the 40 strategies (bands, data/bands.json).
//
// Every band handler is assembled from the band's buffs by their official buff key (numbers from bb / bbStr, never
// hard-coded); keys that only act in battle (env_gbuff_new_with_verify, auto_chess_change_map) live in battle.js.
// Starting LP (totalHp) and 坎诺特's leftover funds are the match's own rules.
//
//   prep_finish_char_bond_add_layer {layer}            华法琳   prep end: per distinct board tier, 1 random op → its bonds +layer (无需激活)
//   band_first_self_refresh_present_char {count,bond}  杜遥夜   first 2 manual refreshes/round: ≥count <bond> chess (tier ≤ shop level)
//   band_shop_refresh_copy_max_lv_char {count}         梓兰     every manual refresh: highest-tier shop chess copied into another slot, copy frozen
//   preparation_start_gain_chess_from_round {round}    梓兰/小贾斯汀/昆图斯/马克维茨/变形者集群/Pith/夕/杰西卡/缪尔赛思/芬  round start of `round`: bbStr.chess
//   preparation_start_gain_chess_every_n_round {round} 杜宾     every `round` rounds (round % n = 0): bbStr.chess
//   give_coin_in_round {round,coin}                    老鲤     income of round `round` = coin (R1/R2 0, R3 15)
//   prep_start_gain_chess_from_pool_in_round {round}   老鲤     round start of `round`: 1 chess of pool
//   band_coin_cost_gain_random_char_by_shop_level      绮良     every coin_cnt funds spent → count random chess ≤ shop level
//   up_shop_next_refresh_must_present_bond_char        佩佩     level-up to a level of lvlist → the next manual refresh (its usual
//                                                               price) prefers <bond>
//   gain_bond_char_per_round {round,preround,bond}     哈洛德   rounds round, round+preround, …: a <bond> chess (≤ shop level, else any tier)
//   first_buy_in_round_char_price_change {price,bond}  休露丝   first <bond> chess of the round costs `price` (bought in the
//                                                               shop: onBuy — a free pick / grant never uses it up)
//   band_cost_coin_reach_cnt_gain_chess_from_pool      潘格尼尼 once coin_cnt funds spent in total: 1 chess of pool (elite 拉特兰 ≥ T4)
//   round_start_bond_check_gain_layer                  余       round start of `round`: exactly factioncount active bonds → +count1, else each active 
//   zj_si_grant_chyue / zj_si_spend_sui                祀       仅炸惊：R1 发精锐重岳；累计花费 50 → 随机精锐【岁】+count2
//   up_shop_add_special_goods {count,choice,pool}      凯瑟琳   every level-up: pick 1 of `count` items of pool (free)
//   coin_carry_over {capital,interest,max}             坎诺特   leftover ≥ capital at round start → +min(max, ⌊left/capital⌋×interest) income
//   round_start_all_player_change_enemy_2              鸭爵     global: every alive player's battle from `round` (own + teammates;
//                                                                normal, Final Assault, Hidden Core — on the player's half of a
//                                                                pair field): 0–2 ground enemies → enemylist
//   round_start_activate_char_chess_effect_in_board    铃兰     round start: 获得时 traits of the right-most (then bottom-most) board op with one
//   first_sell_char_chess_exchange_char_chess_in_shop  巫恋     first sale of a normal op per round: swapped with a random shop chess (no funds)
//   round_start_gain_char_chess_in_shop_every_n_round  松桐     round % n = 0: a random shop chess for free (its slot empties)
//   round_start_gain_coin_by_bond_char_chess_buy       玛恩纳   each <bond> chess bought → +count funds next round (≤ max_count / round)
//   refresh_shop_count_gain_coin_bond_char_chess       贾维     every refresh_count manual refreshes (match total) → <bond> chess ≤ shop level (≤ max_count / round)
//   preparation_start_add_special_goods_every_n_round  娜仁图亚 round % n = 0: pick choice_cnt of refresh_cnt items of pool (free)
// "进入休整期时" / "回合开始时" = onRoundStart (research 01 §5 step 6).

import { GEO } from '../../../../shared/constants.js';
import { buffsOf, num, bandRecord, gameData } from '../support/index.js';
import { metaBonds } from '../support/meta.js';
import * as garrisons from '../garrisons.js';
import { jibianDuckParams } from '../ejibian.js';

const int = (v, d = 0) => Math.trunc(num(v, d));
const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const hasBond = (ctx, id, bond) => { const c = ctx.gd.chess(id); return !!(c && Array.isArray(c.bonds) && c.bonds.includes(bond)); };
const isNormalChess = (ctx, id) => { const c = ctx.gd.chess(id); return !!(c && !c.isGolden); };

/** Per-round counter: reset lazily when the round changes. */
function roundCounter(ctx, key) {
  if (ctx.counter(`${key}:r`) !== ctx.round) { ctx.setCounter(`${key}:r`, ctx.round); ctx.setCounter(key, 0); }
  return ctx.counter(key);
}
const bumpRound = (ctx, key, n = 1) => { roundCounter(ctx, key); return ctx.incCounter(key, n); };

/** Grant a chess or an item by id. */
function grant(ctx, id, opts = {}) {
  if (ctx.gd.item(id)) return ctx.grantItem(id, opts);
  if (ctx.gd.chess(id)) return ctx.grantChess(id, opts);
  return null;
}

/** Indices of unsold chess slots of the shop. */
const chessSlots = (ctx) => ctx.shopSlots().map((s, i) => (s && s.kind === 'chess' && !s.sold ? i : -1)).filter((i) => i >= 0);

/**
 * Up to `n` distinct item ids of an equip pool.
 * ★ 2026-10-18（移植 0.3.1 #677）：可选 `exclude` —— 凯瑟琳的定向投放用过一次突变细胞之后就不再提供它。
 */
function rollItems(ctx, poolId, n, exclude = []) {
  const out = [];
  for (let k = 0; k < n * 6 && out.length < n; k++) {
    const r = ctx.rollPool(poolId);
    if (!r || r.kind !== 'item') break;
    if (exclude.includes(r.id) || out.includes(r.id)) continue;
    out.push(r.id);
  }
  return out;
}

/** Random chess of `bond`, tier ≤ shop level (fallback: any tier when `anyTier`). */
function rollBond(ctx, bond, { anyTier = false } = {}) {
  return ctx.rollChess({ bond, maxTier: Math.max(1, ctx.shopLevel()) }) || (anyTier ? ctx.rollChess({ bond, maxTier: 6 }) : null);
}

// ---------------------------------------------------------------------------------------------------------------
// buff key → (params[], bandId) → hooks

const K = {};

K.prep_finish_char_bond_add_layer = (ps) => ({
  onPrepEnd(ctx) {
    const n = int(ps[0].layer, 0);
    if (n <= 0) return;
    const byTier = new Map();
    for (const p of ctx.board()) {
      if (!p || p.kind !== 'chess') continue;
      const t = p.tier ?? ctx.gd.tierOf(p.id);
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t).push(p);
    }
    for (const t of [...byTier.keys()].sort((a, b) => a - b)) {
      const p = ctx.rng.pick(byTier.get(t));
      for (const b of metaBonds(ctx, p)) ctx.addLayers(b, n, { requireActive: false, reason: 'band' });
    }
  },
});

K.band_first_self_refresh_present_char = (ps) => ({
  onRefresh(ctx) {
    const p = ps[0];
    if ((ctx.roundStats().refreshes || 0) > 2) return;
    const need = Math.max(1, int(p.count, 1));
    const idx = chessSlots(ctx);
    const slots = ctx.shopSlots();
    let have = idx.filter((i) => hasBond(ctx, slots[i].id, p.bond)).length;
    const others = ctx.rng.shuffle(idx.filter((i) => !hasBond(ctx, slots[i].id, p.bond)));
    for (const i of others) {
      if (have >= need) break;
      const id = rollBond(ctx, p.bond);
      if (!id) break;
      ctx.setShopSlot(i, { kind: 'chess', id });
      have++;
    }
  },
});

K.band_shop_refresh_copy_max_lv_char = () => ({
  onRefresh(ctx) {
    const slots = ctx.shopSlots();
    const idx = chessSlots(ctx);
    if (idx.length < 2) return;
    let best = -1;
    for (const i of idx) best = Math.max(best, ctx.gd.tierOf(slots[i].id));
    const src = ctx.rng.pick(idx.filter((i) => ctx.gd.tierOf(slots[i].id) === best));
    const dst = ctx.rng.pick(idx.filter((i) => i !== src));
    ctx.setShopSlot(dst, { kind: 'chess', id: slots[src].id, frozen: true });
  },
});

K.preparation_start_gain_chess_from_round = (ps) => ({
  onRoundStart(ctx) {
    for (const p of ps) {
      const id = p.chess ?? p.chess_id;
      if (ctx.round !== int(p.round, -1) || !id) continue;
      for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) grant(ctx, id, { requirePool: false, source: 'band' });
    }
  },
});

K.preparation_start_gain_chess_every_n_round = (ps) => ({
  onRoundStart(ctx) {
    for (const p of ps) {
      const n = int(p.round, 0);
      const id = p.chess ?? p.chess_id;
      if (n <= 0 || ctx.round % n !== 0 || !id) continue;
      for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) grant(ctx, id, { source: 'band' });
    }
  },
});

K.give_coin_in_round = (ps) => ({
  onIncome(ctx, ev) {
    for (const p of ps) if (ctx.round === int(p.round, -1)) ev.income = Math.max(0, int(p.coin, 0));
  },
});

K.prep_start_gain_chess_from_pool_in_round = (ps) => ({
  onRoundStart(ctx) {
    for (const p of ps) {
      if (ctx.round !== int(p.round, -1)) continue;
      for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) {
        const r = ctx.rollPool(p.pool);
        if (r) grant(ctx, r.id, { source: 'band' });
      }
    }
  },
});

K.band_coin_cost_gain_random_char_by_shop_level = (ps) => ({
  onSpend(ctx, ev) {
    const p = ps[0];
    const step = int(p.coin_cnt, 0);
    if (step <= 0 || !(ev.amount > 0)) return;
    let acc = ctx.incCounter('band:kirara:acc', ev.amount);
    while (acc >= step) {
      acc = ctx.incCounter('band:kirara:acc', -step);
      for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) {
        const id = ctx.rollChess({ maxTier: Math.max(1, ctx.shopLevel()) });
        if (id) ctx.grantChess(id, { source: 'band' });
      }
    }
  },
});

// 佩佩 博学多通 "升级调度中心至2、4和6级后，获得1次特殊刷新：此次刷新出现的干员优先为<萨尔贡>干员": the special refresh is the
// player's next manual refresh, paid as usual — the text gives no 免费 (德克萨斯's trait says 「获得1次免费刷新」 for a free
// one), and the community report of 2026-10-06 「佩佩策略的特殊刷新也是要花钱的，不是免费」. Until 0.2.0 a free refresh came
// with it (blackboard `price` 0 read as its price) [ASSUMED: `cnt` / `price` 0 change nothing].
K.up_shop_next_refresh_must_present_bond_char = (ps) => ({
  onLevelUp(ctx, ev) {
    const p = ps[0];
    if (!list(p.lvlist).map(Number).includes(ev.level)) return;
    ctx.incCounter('band:pepe:special', 1);
  },
  onRefresh(ctx) {
    if (ctx.counter('band:pepe:special') <= 0) return;
    ctx.incCounter('band:pepe:special', -1);
    const bond = ps[0].bond;
    const slots = ctx.shopSlots();
    for (const i of chessSlots(ctx)) {
      if (hasBond(ctx, slots[i].id, bond)) continue;
      const id = rollBond(ctx, bond);
      if (!id) break;
      ctx.setShopSlot(i, { kind: 'chess', id });
    }
  },
});

K.gain_bond_char_per_round = (ps) => ({
  onRoundStart(ctx) {
    const p = ps[0];
    const r0 = int(p.round, 1), every = Math.max(1, int(p.preround, 1));
    if (ctx.round < r0 || (ctx.round - r0) % every !== 0) return;
    for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) {
      const id = rollBond(ctx, p.bond, { anyTier: true });
      if (id) ctx.grantChess(id, { source: 'band' });
    }
  },
});

K.first_buy_in_round_char_price_change = (ps) => ({
  onPrice(ctx, ev) {
    const p = ps[0];
    if (ev.kind !== 'chess' || !hasBond(ctx, ev.id, p.bond)) return;
    if (ctx.counter('band:sciurus:r') === ctx.round) return;
    ctx.setPrice(Math.min(num(ev.price, 0), int(p.price, 1)));
  },
  onBuy(ctx, ev) {
    if (ev.kind === 'chess' && hasBond(ctx, ev.slot.id, ps[0].bond)) ctx.setCounter('band:sciurus:r', ctx.round);
  },
});

K.band_cost_coin_reach_cnt_gain_chess_from_pool = (ps) => ({
  onSpend(ctx, ev) {
    const p = ps[0];
    if (ctx.counter('band:paganini:done') > 0) return;
    const spent = ctx.incCounter('band:paganini:spent', Math.max(0, int(ev.amount, 0)));
    if (spent < int(p.coin_cnt, 0)) return;
    const r = ctx.rollPool(p.pool);
    if (r && grant(ctx, r.id, { source: 'band' })) ctx.setCounter('band:paganini:done', 1);
  },
});

// ---- 祀 / 长兄如父（owner 2026-10-19，仅炸惊）---------------------------------------------
/** 第 1 回合获得一名精锐重岳（chess_zj_chyue_b：炎 / 岁 / 迅捷）。 */
K.zj_si_grant_chyue = () => ({
  onRoundStart(ctx) {
    if (ctx.round !== 1) return;
    if (ctx.counter('band:zj_si:chyue') > 0) return;
    const got = grant(ctx, 'chess_zj_chyue_b', { requirePool: false, source: 'band' });
    console.log('[band zj_si] R%d grant chyue → %s (counter=%s)', ctx.round, String(got), String(ctx.counter('band:zj_si:chyue')));
    if (got) ctx.setCounter('band:zj_si:chyue', 1);
  },
});

/** 累计花费 50 资金 → 随机获得一名精锐【岁】（一局一次）。 */
K.zj_si_spend_sui = (ps) => ({
  onSpend(ctx, ev) {
    const p = ps[0] || {};
    if (ctx.counter('band:zj_si:sui') > 0) return;
    const need = Math.max(1, int(p.spend ?? p.coin_cnt, 50));
    const spent = ctx.incCounter('band:zj_si:spent', Math.max(0, int(ev.amount, 0)));
    if (spent < need) return;
    // ★ 2026-10-19（owner）：只发「一阶以上」的精锐【岁】——年(tier 1)太伤，排除掉。
    const SUI_ELITE = ['chess_zj_09_b', 'chess_zj_58_b', 'chess_zj_70_b', 'chess_zj_74_b', 'chess_zj_80_b'];
    const pool = SUI_ELITE.filter((cid) => {
      const rec = ctx.gd && typeof ctx.gd.chess === 'function' ? ctx.gd.chess(cid) : null;
      return rec && Number(rec.tier) > 1;
    });
    const list = pool.length ? pool : SUI_ELITE;
    const id = ctx.rng && typeof ctx.rng.pick === 'function' ? ctx.rng.pick(list) : list[0];
    if (id && grant(ctx, id, { requirePool: false, source: 'band' })) ctx.setCounter('band:zj_si:sui', 1);
  },
});

K.round_start_bond_check_gain_layer = (ps) => ({
  onRoundStart(ctx) {
    const p = ps[0];
    if (ctx.round !== int(p.round, -1)) return;
    const active = Object.entries(ctx.bonds()).filter(([, b]) => b && b.active).map(([id]) => id);
    if (active.length === int(p.factioncount, 1)) {
      for (const b of active) ctx.addLayers(b, int(p.count1, 0), { requireActive: true, reason: 'band' });
    } else {
      for (const b of active) ctx.addLayers(b, int(p.count2, 0), { requireActive: true, reason: 'band' });
    }
  },
});

K.up_shop_add_special_goods = (ps) => ({
  onLevelUp(ctx) {
    const p = ps[0];
    // ★ 2026-10-18（移植 0.3.1 #677，官方 aceffect_band_26「count 3, choice 1, pool_equip_kathe」）：
    //   凯瑟琳的【定向投放】每人每局最多领取**一次**突变细胞；领取过之后本效果抽卡时直接排除它
    //   （昆图斯赠送的那份不走这条路，单独算）。见 player/prep.js pickReward 里写标记的那一段。
    const exclude = ctx.counter('band:cathy:cellTaken') ? ['chess_item_5_08_e_a'] : [];
    const ids = rollItems(ctx, p.pool, Math.max(1, int(p.count, 3)), exclude);
    // 来源单独标成 `band:cathy`：prep.js 靠它认出"这是凯瑟琳的投放"，与其它 band 奖励区分开
    if (ids.length) ctx.offerItems(ids, { source: 'band:cathy' });
  },
});

K.coin_carry_over = (ps) => ({
  onIncome(ctx, ev) {
    // 2026-10-13 修复「坎诺特利滚利 不与炸惊利息叠加/不生效」：
    // 乐队数据的参数在 buff.bb 里（{capital,interest,max}），但派发时既可能是 [bb]（数组），
    // 也可能直接是 bb（对象）—— 原来只写 ps[0]，对象形状下 ps[0] === undefined → p.capital 抛错，
    // 被内部 _safe 静默吞掉 → 加成永不生效。这里两种形状都兼容。
    const raw = Array.isArray(ps) ? ps[0] : ps;
    const p = raw && typeof raw === 'object' ? raw : {};
    const cap = int(p.capital, 0), left = ctx.funds();
    if (cap <= 0 || left < cap) return;
    const bonus = Math.min(int(p.max, Infinity), Math.floor(left / cap) * int(p.interest, 0));
    if (bonus > 0) ev.income = int(ev.income, 0) + bonus;   // 累加到炸惊规则10的利息之上 ✓
  },
});

K.round_start_activate_char_chess_effect_in_board = (ps) => ({
  onRoundStart(ctx) {
    const p = ps[0];
    const event = p.event_type || 'SERVER_GAIN';
    const cands = ctx.board().filter((v) => v && v.kind === 'chess' && ctx.garrisonsOf(v.uid).some((g) => g.eventType === event));
    if (!cands.length) return;
    cands.sort((a, b) => (b.col - a.col) || (a.row - b.row));
    for (const v of cands.slice(0, Math.max(1, int(p.count, 1)))) {
      if (event === 'SERVER_GAIN' && typeof garrisons.triggerGainEffects === 'function') garrisons.triggerGainEffects(ctx, v);
      else ctx.triggerGarrisons(v.uid, event);
    }
  },
});

K.first_sell_char_chess_exchange_char_chess_in_shop = (ps) => ({
  onSold(ctx, ev) {
    const piece = ev.piece;
    if (!piece || piece.kind !== 'chess' || !isNormalChess(ctx, piece.id)) return;
    if (roundCounter(ctx, 'band:vodfox') >= Math.max(1, int(ps[0].count, 1))) return;
    const slots = ctx.shopSlots();
    const idx = chessSlots(ctx);
    if (!idx.length) return;
    const i = ctx.rng.pick(idx);
    const got = ctx.grantChess(slots[i].id, { source: 'band' });
    if (!got) return;
    ctx.setShopSlot(i, { kind: 'chess', id: piece.id });
    ev.gain = 0;
    bumpRound(ctx, 'band:vodfox');
  },
});

K.round_start_gain_char_chess_in_shop_every_n_round = (ps) => ({
  onRoundStart(ctx) {
    const p = ps[0];
    const n = int(p.round, 0);
    if (n <= 0 || ctx.round % n !== 0) return;
    for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) {
      const idx = chessSlots(ctx);
      if (!idx.length) return;
      const i = ctx.rng.pick(idx);
      if (ctx.grantChess(ctx.shopSlots()[i].id, { source: 'band' })) ctx.setShopSlot(i, null);
    }
  },
});

K.round_start_gain_coin_by_bond_char_chess_buy = (ps) => ({
  onBuy(ctx, ev) {
    const p = ps[0];
    if (ev.kind !== 'chess' || !hasBond(ctx, ev.slot.id, p.bond)) return;
    const n = int(p.count, 1), max = int(p.max_count, Infinity);
    const used = roundCounter(ctx, 'band:mlynar');
    const add = Math.min(n, max - used);
    if (add <= 0) return;
    ctx.addPendingFunds(add);
    bumpRound(ctx, 'band:mlynar', add);
  },
});

K.refresh_shop_count_gain_coin_bond_char_chess = (ps) => ({
  onRefresh(ctx) {
    const p = ps[0];
    const every = int(p.refresh_count, 0);
    if (every <= 0) return;
    if (ctx.incCounter('band:chiave:refreshes', 1) % every !== 0) return;
    if (roundCounter(ctx, 'band:chiave') >= int(p.max_count, Infinity)) return;
    const id = rollBond(ctx, p.bond);
    if (id && ctx.grantChess(id, { source: 'band' })) bumpRound(ctx, 'band:chiave');
  },
});

K.preparation_start_add_special_goods_every_n_round = (ps) => ({
  onRoundStart(ctx) {
    const p = ps[0];
    const n = int(p.round, 0);
    if (n <= 0 || ctx.round % n !== 0) return;
    const ids = rollItems(ctx, p.pool, Math.max(1, int(p.refresh_cnt, 2)));
    for (let k = 0; k < Math.max(1, int(p.choice_cnt, 1)) && ids.length; k++) ctx.offerItems(ids, { source: 'band' });
  },
});

// ---------------------------------------------------------------------------------------------------------------
// 鸭爵 “神秘顾客”: "从第5回合起，你和队友遭遇的部分敌人可能会替换为<鸭爵><高普尼克><流泪小子><圆仔>，击倒这些敌人者获得1资金奖励
// （包括联防阶段）". A global handler rewrites the battle spawn list of every alive player while the band is held by that
// player or a teammate: from round `round`, in the normal battle, the Final Assault and the Hidden Core (PRTS 卫戍协议：盟约
// 下半/PRTS盟约记录 鸭爵 备注 "每回合将有0~2名敌人被替换为上述敌人之一…且在最终回合和隐秘核心回合中仍然生效"; the 联防 phase
// replaces nothing: its enemies are leaks, which keep their bounty). min..max (0–2, uniform [ASSUMED]) of the player's
// ground enemies from the `minweight`–`maxweight` share of the player's enemies (time order) [ASSUMED reading of the two
// weights] — any wave enemy but the leader, its parts, bounties, earlier swaps and uncounted units. Elites are eligible
// too [ASSUMED: the text names no rank; one rule for every battle; about two thirds of the leader rounds' escorts in that
// share are elites, so a NORMAL-only rule would leave most Final Assault halves without a candidate — ≈ 80 % instead of
// ≈ 36 % of the R14 pair-field halves over 40 seeds]. Flyers are never swapped [ASSUMED: the four are ground units and a
// FLY action's route is a FLY route]. A swapped unit becomes a random enemylist enemy (the act2 `_2` versions) at the
// replaced unit's time and route, worth DUCK_COINS to its killer (bounty, also in 联防). A pair boss field has one spawn
// list that its two players' handlers edit in turn; each player's 0–2 come from the enemies whose route ends on that
// player's half (`ev.side` + `ev.routes`, the half rule of the field's bounties, server/match/waves.js routeByMotion), the
// share taken over that half [ASSUMED: "你和队友遭遇的敌人" — the enemies heading for the player's own protection point;
// each official client simulates its own battle, docs/research/08 appendix A]. The originals never exist, so none of
// their death / kill / leak effects happen. Reaching the protection point costs 1 LP ("但进入保护目标点将减少1点目标生命值":
// the enemies' data lpr, tools/build-data.mjs). The swaps carry the spawn tag 'duck': their 隐匿 (流泪小子) comes back no
// sooner than 1 s after a block ends, not the official 0 s (content/enemies/helpers.js DUCK_STEALTH_RESTORE — the owner's
// decision of 2026-10-07, a deliberate deviation).

export const DUCK_BAND = 'band_ducklord';
/** "击倒这些敌人者获得1资金奖励" (the blackboard's `count` is 1 too). */
export const DUCK_COINS = 1;
/** Battle kinds the swap applies to (PRTS: the Final Assault and the Hidden Core too). */
const DUCK_KINDS = new Set(['normal', 'boss', 'hidden']);
/** Boss-field column between the left ('L') and the right ('R') player's half (the goals are at cols 2–3 / 17). */
const BOSS_MID_COL = (GEO.BOSS_RECT.c0 + GEO.BOSS_RECT.c1) / 2;

function duckParams() {
  for (const b of buffsOf(bandRecord(DUCK_BAND))) if (b.key === 'round_start_all_player_change_enemy_2') return b.p;
  return null;
}

/**
 * Rewrite `spawns` in place (exported for tests). Returns the replaced spawn specs. `side` ('L' | 'R', a pair boss
 * field) limits the swap to the spawns whose route (`routes[routeIndex]`) ends on that half of the field.
 */
export function duckReplace(ctx, spawns, p, ownerPlayerId, { routes = null, side = null } = {}) {
  const gd = ctx.gd;
  const ducks = list(p.enemylist).filter((k) => gd.enemy(k));
  if (!ducks.length || !Array.isArray(spawns)) return [];
  const lo = Math.max(0, int(p.min, 0)), hi = Math.max(lo, int(p.max, lo));
  const want = lo + ctx.rng.int(hi - lo + 1);
  if (want <= 0) return [];
  const half = side === 'L' || side === 'R';
  const onHalf = (s) => {
    if (!half) return true;
    const r = Array.isArray(routes) ? routes[s.routeIndex] : null;
    const c = r && Array.isArray(r.end) ? Number(r.end[1]) : NaN;
    return side === 'R' ? c > BOSS_MID_COL : c < BOSS_MID_COL;
  };
  // one entry per enemy of the player (split multi-count specs), in spawn-time order
  const flat = [];
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[i];
    if (!s || !onHalf(s)) continue;
    const cnt = Math.max(1, int(s.count, 1));
    for (let k = 0; k < cnt; k++) flat.push({ i, k, t: num(s.time, 0) + k * num(s.interval, 0) });
  }
  flat.sort((a, b) => a.t - b.t || a.i - b.i || a.k - b.k);
  const w0 = num(p.minweight, 0), w1 = num(p.maxweight, 1);
  const n = flat.length;
  const ok = flat.filter((f, j) => {
    const s = spawns[f.i];
    const e = gd.enemy(s.enemyKey);
    const frac = n > 1 ? j / (n - 1) : 0;
    return !s.tag && s.countInTotal !== false && e && e.rank !== 'BOSS' && !e.notCountInTotal && e.stats?.motion !== 'FLY'
      && frac >= w0 - 1e-9 && frac <= w1 + 1e-9;
  });
  // ★ 2026-10-13（用户）：惊变卡「谁选的鸭爵？？」的第 7/8 回合要求【整轮都被鸭爵覆盖】——
  //   replaceAll 时取全部候选（候选集合本身不变：非领袖 / 非飞行 / 非器物 / 未被换过 ✓）
  const picked = p.replaceAll ? ok.slice() : ctx.rng.shuffle(ok).slice(0, want);
  if (!picked.length) return [];
  const byIdx = new Map();
  for (const f of picked) { if (!byIdx.has(f.i)) byIdx.set(f.i, new Set()); byIdx.get(f.i).add(f.k); }
  const out = [];
  const add = [];
  for (const [i, ks] of byIdx) {
    const s = spawns[i];
    const cnt = Math.max(1, int(s.count, 1));
    const keep = cnt - ks.size;
    for (const k of ks) {
      const d = {
        ...s, mods: s.mods ? { ...s.mods } : undefined, count: 1, interval: 0,
        time: num(s.time, 0) + k * num(s.interval, 0), enemyKey: ctx.rng.pick(ducks), tag: 'duck',
        bounty: { coins: DUCK_COINS, ownerPlayerId },
      };
      if (d.mods) delete d.mods.slot;
      add.push(d);
      out.push(d);
    }
    if (keep <= 0) spawns[i] = null;
    else if (ks.size) {
      // keep the unreplaced copies of a multi-count spec as single specs at their original times
      const rest = [];
      for (let k = 0; k < cnt; k++) if (!ks.has(k)) rest.push({ ...s, mods: s.mods ? { ...s.mods } : undefined, count: 1, interval: 0, time: num(s.time, 0) + k * num(s.interval, 0) });
      spawns[i] = null;
      add.push(...rest);
    }
  }
  for (let i = spawns.length - 1; i >= 0; i--) if (spawns[i] == null) spawns.splice(i, 1);
  spawns.push(...add);
  return out;
}

const duckGlobal = {
  onBattleStart(ctx, ev) {
    if (!ev || !DUCK_KINDS.has(ev.kind) || !Array.isArray(ev.spawns)) return;
    const p = duckParams();
    if (!p || ctx.round < int(p.round, 1)) return;
    const cards = typeof ctx.enemyJibian === 'function' ? ctx.enemyJibian() : null;
    const yajue = (Array.isArray(cards) ? cards : cards ? [cards] : []).includes('ejibian_yajue');
    const held = ctx.bandId() === DUCK_BAND || ctx.teammates().some((t) => t.bandId() === DUCK_BAND);
    // ★ 2026-10-23（owner）：删掉「必须有人选鸭爵」这个前置条件 —— 只要敌方惊变
    //   「谁选的鸭爵？？」在场，7/8 回合**没人选鸭爵也会替换**（否则那张牌在没人选鸭爵时完全无效）。
    if (!held && !(yajue && [7, 8].includes(ctx.round))) return;
    // 炸惊模拟 规则14 敌方惊变「谁选的鸭爵？？」(ejibian_yajue)：第 7/8 回合把替换概率拉满（content/ejibian.js
    // jibianDuckParams）。
    duckReplace(ctx, ev.spawns, jibianDuckParams(p, { round: ctx.round, cards }), ctx.playerId, { routes: ev.routes, side: ev.side });
  },
};

// ---------------------------------------------------------------------------------------------------------------

/** Merge hook objects (same hook → called in order). */
function merge(parts) {
  const out = {};
  for (const h of parts) {
    for (const [name, fn] of Object.entries(h)) {
      if (typeof fn !== 'function') continue;
      const prev = out[name];
      out[name] = prev ? function merged(ctx, ev) { prev(ctx, ev); fn(ctx, ev); } : fn;
    }
  }
  return out;
}

/** Hooks of one band (null when it has no prep effect). */
export function bandMetaHandler(bandId) {
  const groups = new Map();
  for (const b of buffsOf(bandRecord(bandId))) {
    if (!b.key || !K[b.key]) continue;
    if (!groups.has(b.key)) groups.set(b.key, []);
    // 2026-10-13 修复「坎诺特利滚利 不与炸惊利息叠加 / 完全不生效」：
    // 乐队（bands.json）的参数存放在 buff.bb 里（如 coin_carry_over 的 {capital,interest,max}），
    // 全项目其它地方读的都是 .bb（bot.js / choices.js / bonds addon 的 { ...b.bb, ...b.bbStr }）。
    // 这里原来写的是 b.p → undefined → K[key]([undefined]) → ps[0].capital 抛错 → 被 _safe 静默吞掉，
    // 于是所有"带参数的乐队增益"都不生效。改为按同一约定取 bb（并兼容旧的 p 写法）。
    groups.get(b.key).push({ ...(b.bb && typeof b.bb === 'object' ? b.bb : {}), ...(b.bbStr && typeof b.bbStr === 'object' ? b.bbStr : {}), ...(b.p && typeof b.p === 'object' ? b.p : {}) });
  }
  if (!groups.size) return null;
  return merge([...groups].map(([k, ps]) => K[k](ps, bandId)));
}

export function registerMeta(registry) {
  for (const id of Object.keys(gameData().bands || {})) {
    const h = bandMetaHandler(id);
    if (h) registry.band(id, h);
  }
  registry.global('bands_ducklord', duckGlobal);
}
