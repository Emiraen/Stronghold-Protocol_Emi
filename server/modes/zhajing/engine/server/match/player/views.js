// server/match/player/views.js — PlayerState methods: the views — pieceView, effectsView (the effects column: 策略 / 机变 /
// 悬赏 …) and m.private (privateView).
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { PHASE } from '../../../shared/constants.js';
import { boardOrder, pieceDir } from '../board.js';
import { bondList, offBondCounts } from '../bondsMeta.js';
import { bountyText, cardView } from '../choices.js';
import { FORGE_KILLS_PER } from './acquire.js';

export class PlayerViews {
  pieceView(p, rc = null) {
    const rec = p.kind === 'item' ? this.gd.item(p.id) : p.kind === 'token' ? this.gd.token(p.id) : this.gd.chess(p.id);
    const v = {
      uid: p.uid,
      kind: p.kind,
      id: p.id,
      golden: !!(rec && rec.isGolden),
      tier: rec && Number.isInteger(rec.tier) ? rec.tier : null,
      items: p.kind === 'chess' ? (p.items || []).map((it) => ({ uid: it.uid, id: it.id })) : [],
      count: p.kind === 'token' ? (p.count || 1) : 1,
      ownerUid: p.kind === 'token' ? p.ownerUid ?? null : null,
    };
    if (rc) { v.row = rc[0]; v.col = rc[1]; v.dir = pieceDir(p); }
    return v;
  }

  effectsView() {
    const out = [];
    // 规则14: the 敌方惊变 — match-long global enemy buffs, drawn once per configured round (config enemyJibian.rounds:
    // 第 1 与第 6 回合各一次) and ALL of them stay in force. The panel therefore lists every card drawn so far
    // (用户 2026-10-12「两个可叠加」)：以前只列最近抽到的那一张，第 6 回合抽到第二张后第一张就从面板里消失了。
    // Listed ahead of 策略 because they condition the round's enemies, not this player's board.
    const ej = this.m && this.m.enemyJibian;
    const ejCfg = this.gd && typeof this.gd.enemyJibian === 'function' ? this.gd.enemyJibian() : null;
    // ★ 2026-10-24（反馈：已选惊变里出现一张空白的「敌方惊变」）：隐秘池的卡不在 ejCfg.pool 里，
    //   之前只查普通池 → 隐秘卡查不到名字/描述，只能回落成「敌方惊变 / 普通」。两张池子都要查。
    const ejPool = ejCfg
      ? [
          ...(Array.isArray(ejCfg.pool) ? ejCfg.pool : []),
          ...(ejCfg.hidden && Array.isArray(ejCfg.hidden.pool) ? ejCfg.hidden.pool : []),
        ]
      : [];
    const ids = [];
    for (const id of (this.m && Array.isArray(this.m.enemyJibianCards) ? this.m.enemyJibianCards : [])) {
      if (id && !ids.includes(id)) ids.push(id);   // 同一张重复抽到只列一次（效果本来就只算一次）
    }
    const ejId = ej && ej.card ? (ej.card.id || ej.card.effectId || null) : null;   // 卡视图用 id，原始配置记录只有 effectId
    if (!ids.length && ejId) ids.push(ejId);   // 兜底：老状态里没有 enemyJibianCards
    for (const id of ids) {
      const cur = ej && ej.card && (ej.card.id === id || ej.card.effectId === id) ? ej.card : null;
      const rec = ejPool.find((c) => c && (c.effectId === id || c.id === id)) || null;
      out.push({
        id, name: (cur && cur.name) || (rec && rec.name) || '敌方惊变', desc: (cur && cur.desc) || (rec && rec.desc) || '',
        iconKind: 'enemy', iconId: null, jibian: true, enemy: true,
        rarity: (cur && cur.rarity) || (rec && rec.rarity) || (ej && ej.rarity) || null,
        flavor: (cur && cur.flavor) || (rec && rec.flavor) || null,
      }); // i18n-ignore: a data-less card's fallback name
    }
    const band = this.bandId ? this.gd.band(this.bandId) : null;
    if (band) out.push({ id: band.effectId || band.bandId, name: band.effectName || band.name, desc: band.desc || '', iconKind: 'band', iconId: band.iconId || band.bandId });
    for (const e of this.effects) {
      if (e.hidden) continue;
      const v = { id: e.id, name: e.name || e.id, desc: e.desc || '', iconKind: e.iconKind || 'choice', iconId: e.iconId || e.id };
      if (e.counter != null) v.counter = e.counter;
      // 惊变阶段: the picked 惊变 cards — the 已选惊变 panel reads these apart from the ordinary 机变 effects
      if (e.jibian) { v.jibian = true; if (e.rarity) v.rarity = e.rarity; if (e.flavor) v.flavor = e.flavor; }
      if (e.iconBond) v.iconBond = e.iconBond;
      out.push(v);
    }
    for (const b of this.bounties) {
      // the battles the bounty's enemies still come for (an official multi-round card: every battle, no counter) and
      // the card's official rich text (blue "下场作战" / "两场作战", red "每场"; a multi-round card reads as long as it
      // lasts — choices.js bountyText, MULTI_ROUND_BOUNTY_BATTLES) — user playtest #6 item 4
      const left = b.roundsLeft >= 90 ? null : b.roundsLeft;
      const eff = b.card.effectId ? this.gd.effect(b.card.effectId) : null;
      out.push({
        id: b.id, name: b.card.name || '悬赏', desc: bountyText((eff && eff.descRaw) || b.card.desc || '', b.card), iconKind: 'choice', iconId: b.card.effectId || 'bounty', // i18n-ignore: a data-less card's fallback name
        counter: left, counterText: left == null ? '之后的每场作战' : `还剩 ${left} 场作战`, // i18n-ignore: older clients (ui/effectsList.js builds it from counter)
      });
    }
    return out;
  }

  privateView() {
    const slots = this.shop.slots.map((s) => (s ? { kind: s.kind, id: s.id, price: this.priceOf(s), basePrice: s.basePrice, sold: !!s.sold, frozen: !!s.frozen } : null));
    const offer = this.offers[0] || null;
    const free = this.shop.freeRefreshes > 0;
    const board = [];
    for (const { r, c, piece } of boardOrder(this.board)) board.push(this.pieceView(piece, [r, c]));
    // a boss round's prep: the partner's board on its half of the boss field (Match.bossMateView, item 51)
    const bossMate = typeof this.m.bossMateView === 'function' ? this.m.bossMateView(this) : null;
    // 100-seat variant: the 机变 draft is per squad, so THIS player's squad pool travels here rather than in m.public
    // (a public frame is broadcast to the whole room, which would expose all 25 pools). Shape matches what the public
    // frame carried upstream, so the client's normalizeSp reads it unchanged.
    const sd = typeof this.m.spOf === 'function' ? this.m.spOf(this) : null;
    // 规则5: how many 惊变 rerolls THIS player still has (the 惊变阶段's one redraw of a single card) — 0 elsewhere
    const jb = sd && sd.family === 'jibian' && typeof this.gd.jibian === 'function' ? this.gd.jibian() : null;
    const sp = sd ? {
      family: sd.family, name: sd.name, desc: sd.desc, eventId: sd.eventId, cards: sd.cards.map(cardView),
      order: sd.order.slice(), turn: typeof this.m.spTurnOf === 'function' ? this.m.spTurnOf(sd) : null,
      picks: { ...sd.picks }, taken: { ...sd.taken }, untimed: !!sd.untimed,
      // ★ 「我想要」：本小队每人最多一张的意向卡（playerId → 卡片 idx）。只在私有帧里发，天然只对本队可见。
      want: sd.want && typeof sd.want === 'object' ? { ...sd.want } : {},
      // 机变阶段：本小队当前这一手的截止时间 + 这一手有多长（spDraft.js scheduleSpPickTimeout 的 AFK 安全网）。
      // 客户端拿它画倒计时；房间级的 m.deadline 在 SP_DRAFT 恒为 0（25 个小队并行，塞不下）。
      turnDeadline: Number.isFinite(sd.turnDeadline) && sd.turnDeadline > 0 ? sd.turnDeadline : 0,
      turnSeconds: typeof this.gd.timer === 'function' ? this.gd.timer('spTurn') : 16,
      // ★ 2026-10-19：每张卡各能刷新一次 → 这里报「还有几张卡没刷过」，供界面决定按钮可用性
    rerollLeft: jb ? (sd.cards || []).filter((c, i) => c && !c.takenBy && !(sd.rerolled && sd.rerolled.has(i))).length : 0,   // ★ 整局共用计数（与 spDraft.spReroll 同一口径）
    } : null;
    return {
      t: 'm.private', zhajing: true, benchSize: 20,
      playerId: this.playerId,
      seat: this.seat,
      alive: this.alive,
      lp: this.lp,
      funds: this.funds,
      // ★ 2026-10-16 恶魔契约（惊变 jibian_emoxieyue）：本玩家这一局能不能拿目标生命当资金用。
      //   必须下发 —— 客户端 shop.js 的 shopBlockReason() 要靠它决定「资金不足」要不要真的拦下购买。
      //   不给的话，服务端已经允许（economy.spend 的 lp 抵扣分支），前端却把按钮判成「资金不足」，
      //   玩家看到的就是「恶魔契约花不了生命」（玩家 2026-10-16 反馈的实情）。
      //   值直接取 economy.js 的同一个判据，保证两边永不漂移。
      lpPayment: typeof this.jibianLpPayment === 'function' ? this.jibianLpPayment() : false,
      // 规则10 preview: the shop funds card's 「下回合最少获得：x（包含y利息）」 line (round.js nextIncomePreview)
      income: typeof this.nextIncomePreview === 'function' ? this.nextIncomePreview() : null,
      bandId: this.bandId,
      ready: this.ready,
      canReady: this.alive && this.tempEmpty && this.m.phase === PHASE.PREP,
      shop: {
        level: this.shop.level,
        maxLevel: this.gd.maxShopLevel,
        upgradePrice: this.shop.level >= this.gd.maxShopLevel ? 0 : this.shop.upgradePrice,
        refreshPrice: free ? 0 : this.gd.refreshPrice,
        freeRefreshes: this.shop.freeRefreshes,
        frozen: this.shop.frozen,
        // ★ 0.3.3 移植：商店槽位布局（第一期 5 级的空装备栏也要留在装备列）
        layout: { ...(this.shop.layout || this.gd.shopSlots(this.shop.level)) },
        slots,
        // `source` 'merge' = the promotion reward (晋升奖励); any other offer (a strategy, an item, a 特质) carries the
        // `label` the bar shows instead; `queued` = offers waiting behind it (player report #6 after 0.1.0)
        rewardOffer: offer ? { tier: offer.tier, source: offer.source === 'merge' ? 'merge' : 'special', label: offer.label || null, queued: this.offers.length - 1, slots: offer.slots.map((s) => ({ kind: s.kind === 'item' ? 'item' : 'chess', id: s.id, price: s.price, sold: !!s.sold })) } : null,
      },
      hand: this.hand.map((p) => (p ? this.pieceView(p) : null)),
      temp: this.temp.map((p) => (p ? this.pieceView(p) : null)),
      board,
      deployCap: this.deployCap,
      deployCount: this.deployCount,
      // + the mode-off bonds it has members of (`off: true`, the strip's grey 本局禁用 discs — bondsMeta.offBondCounts)
      bonds: bondList(this.gd, this.bondsView(), { full: true, off: offBondCounts(this.gd, this) }),
      effects: this.effectsView(),
      nextEnemies: this.m.nextEnemiesFor(this),
      sp,
      // 惊变「维多利亚的秘密」(用户 2026-10-12): 本回合剩余的特殊刷新次数（商店栏那个按钮）
      spRefresh: typeof this.jibianSpecialRefreshLeft === 'function' ? this.jibianSpecialRefreshLeft() : 0,
      // 惊变「”神秘“商店」(owner 2026-10-16): **独立的**按钮与入口（两张卡可同时持有，必须能分别发动）
      mysticRefresh: typeof this.jibianMysticRefreshLeft === 'function' ? this.jibianMysticRefreshLeft() : 0,
    // 惊变「死亡回归」(owner 2026-10-16)：1 = 持有且未用过 → 商店栏显示那个按键（按下 → 假淘汰 → 回到该回合整备）
    deathReturn: (typeof this.jibianHas === 'function' && this.jibianHas('jibian_siwanghuigui')
      && !(this.counters && this.counters['jibian:siwanghuigui:used'] > 0)) ? 1 : 0,
      // 惊变「板藤」(用户 2026-10-12): 当前卖价（0 = 没有这张卡），商店栏的「出售板藤」键位用它决定显不显示与金额
      banteng: typeof this.jibianBantengValue === 'function' ? this.jibianBantengValue() : 0,
      // 惊变「高卢银行支票」(用户 2026-10-13): null = 没有这张卡（不显示「提现」键位）；数字 = 本次提现金额
      // （0 时按钮仍然显示但置灰 —— 玩家能看到这张卡还在，下个整备阶段会重掷）
      cheque: typeof this.jibianHas === 'function' && this.jibianHas('jibian_gaoluzhipiao')
        ? (typeof this.jibianChequeValue === 'function' ? this.jibianChequeValue() : 0) : null,
      // DESIGN §16: the effective operator loadout ({ [baseChessId]: { skill, module } }; chess not listed use defaults)
      loadout: this.loadout,
      // 0.2.2 潜能 / 练度: `{ [charId]: { potential, cultivate } }`, {} = every operator at the defaults — so the
      // briefing's 干员调配 entry opens on what the player set.
      ops: this.ops,
      // 卡池预选: this player's own 盟约 ban picks (shared/banPick.js profile) — what its own pool was built from
      bans: this.bans,
      // 卡池预选: the 盟约 actually switched off for THIS player's pool (its own picks + the random fill, never a ❤).
      // The grey 「部分盟约所含干员阵容不完整」 marks MUST read this, not m.public.drawnDisabledBonds: that one is the
      // match-level draw, which no player with picks uses — showing it made a favourited 盟约 look banned.
      deniedBonds: this.deniedBonds || null,
      // this player's own banned chess ids (its pool's id set), for the marks that count members
      bannedChess: this.bannedChess || null,
      // 0.2.0 补位: the base chess ids this player fields as their stand-ins in this match (the not-owned list the seat had
      // at the match start; [] = every operator owned) — the client shows these as their stand-ins (cards, pieces, the
      // detail card, with a small 「替补」 mark)
      standIns: this.standIns,
      // 0.2.0 自选编队: this player's 自选 picks in this match ({ [slotBaseId]: { charId, skillIndex, uniEquipId } } — the seat's
      // when the match started; {} = none) — the client composes the operator's record for its own cards and pieces
      // (shared/diy.js diyRecord); `diyBanned`: the slotted slots out of the shop this match (every bond of the operator
      // switched off)
      diy: this.diy,
      diyBanned: this.diyBanned,
      // 最终攻势 / 隐秘核心 prep (community report of 2026-10-06, item 51): `{ playerId, side, units }` — the pair partner's
      // board pieces as UnitInfo on its half of the boss field (mirrored on the right half, as the battle places them);
      // the own prep view draws them beside the own half, read-only. Absent otherwise.
      ...(bossMate ? { bossMate } : {}),
      stats: {
        dmgDealt: Math.round(this.stats.dmgDealt), kills: this.stats.kills, leaks: this.stats.leaks, gold: this.stats.gold,
        refreshes: this.stats.refreshes, merges: this.stats.merges,
      },
      // ★ 炸惊模拟「锻造器」(user 2026-10-14): 服务端权威的发放计数，客户端按钮/计数器读它。
      //   count 没用掉的个数 · killsPaid 已按击杀发到第几个 20 · elites 累计精锐数 · per 每多少个敌人一个
      forge: {
        count: Math.max(0, Math.trunc(Number(this.forge && this.forge.count) || 0)),
        killsPaid: Math.max(0, Math.trunc(Number(this.forge && this.forge.killsPaid) || 0)),
        elites: Math.max(0, Math.trunc(Number(this.forge && this.forge.elites) || 0)),
        per: FORGE_KILLS_PER,
        // ★ 外援测试模式（本玩家自己的作弊开关）：客户端据此在没有炸惊的房间里也显示锻造器
        testMode: this.testMode === true,
        // ★ 已锻造累计 —— 发【原始 map】{ [optId]: { total, count } }，客户端用 shared/forgeData.js 的
        //   forgedEntries() 自己折算成条目。原来这里发的是 forgedEntries() 的【数组】，而客户端又拿它当
        //   map 用（f[o.id]），于是永远得到 []、「已锻造」徽标一直不显示（用户 2026-10-14 报的"还是没了"）。
        forged: this.forge && this.forge.forged ? { ...this.forge.forged } : {},
        // ★ 当前这一组（服务端抽的；没有锻造器时为 null）
        rolled: typeof this.forgeRoll === 'function' ? this.forgeRoll() : null,
      },
    };
  }
}
