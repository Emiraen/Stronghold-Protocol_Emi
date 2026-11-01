// server/match/player/round.js — PlayerState methods: the round lifecycle the match calls — startRound (income, pending
// coins, the shop, summon stacks topped up), endPrep, eliminate (every copy back to the pool), recompute (legality,
// out-of-range summons, temp pieces into free hand slots, bonds), the bond views — and battleInput (the player's
// PlayerBattleInput: board units with their loadout, their 补位 mark or their 自选 pick, carried 联防 state, the reached
// layers).
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { boardOrder, pieceDir } from '../board.js';
import { computeBonds, bondSnapshot, activatedLayers, bondsWithGains } from '../bondsMeta.js';
import { msg, wireMessage } from '../../../shared/i18n.js';
import { forgeBattleMods } from '../../../shared/forgeData.js';
import { SKADI_CORRUPTED } from '../../sim/content/jibian.js';

export class PlayerRound {
  startRound(r) {
    // ★ 2026-10-16（owner）死亡回归：**必须在覆盖 prepSnapshot 之前**先把上一份抢下来 ——
    //   只有那份（由上一次 endPrep 写的）带 boardUids，它才是"哪些棋子是这一整备阶段买的"的判据。
    //   顺序错了会退化成"一个都回收不了"（实测 pieces=3/3）。
    const rewindSnap = (this.m && this.m._jibianRewindRound === r) ? this.prepSnapshot : null;
    this.round = { refreshes: 0, buys: 0, sells: 0, spent: 0, gainedChess: 0, arts: 0 };
    this.pendingLayerGains = null; // settled (or lapsed) at the last SETTLE
    if (r > 1) this.shop.upgradePrice = Math.max(0, this.shop.upgradePrice - 1);
    // onIncome handlers may rewrite ev.income / ev.pending (e.g. 老鲤 withholds R1–R2 income until R3)
    // 炸惊模拟 规则10 利息: the funds carried through the last round pay interest — ≥5 资金 → +1, ≥10 资金 → +2
    // (mode.interest { capital: 5, interest: 1, max: 2 }), the same shape as the 坎诺特 band's `coin_carry_over`
    // (bands/meta.js K.coin_carry_over), which stacks on top of it. It is folded into ev.income so every onIncome hook
    // and the client see one number; `interestCapped` marks the 「封顶」 case (the bonus already sits at `max`).
    // ★ 2026-10-23 敌方惊变「惊天魔盗团」：**上回合剩余资金清 0**。
    //   放在利息计算之前 —— 清空后本金为 0，本轮只发基础收入，也不会再算利息。
    const ejCards = Array.isArray(this.m && this.m.enemyJibianCards) ? this.m.enemyJibianCards : [];
    if (ejCards.includes('ejibian_jingtianmodaotuan') && this.funds > 0) {
      const lost = this.funds;
      this.funds = 0;
      try { this.m.toast(this, 'warn', `惊天魔盗团：上回合剩余 ${lost} 资金被清空`); } catch { /* toast 失败不影响 */ }
    }
    const it = this.gd.interest;
    const held = Math.max(0, Math.trunc(Number(this.funds) || 0));
    const interest = it && held >= it.capital ? Math.min(it.max, Math.floor(held / it.capital) * it.interest) : 0;
    const ev = {
      round: r,
      income: this.gd.income(r) + interest,
      pending: this.pendingFunds,
      interest,
      interestFunds: held,
      interestCapped: !!it && it.max > 0 && interest >= it.max,
    };
    this.pendingFunds = 0;
    this.m.dispatch(this, 'onIncome', ev);
    // 规则10: the interest is the only part of the income a player cannot infer from the round number, so it is said
    // out loud — 「利息 +N」, and 「利息 +N（封顶）」 once the bonus sits at `max` (10 资金 ⇒ +2, like 坎诺特's 利滚利
    // capital/interest/max triple). UNICAST: it is this seat's own funds, unlike the room-wide SHOP_LEVEL / BOSS_HIT lines.
    if (interest > 0) {
      const w = wireMessage(ev.interestCapped ? msg('利息 +{n}（封顶）', { n: String(interest) }) : msg('利息 +{n}', { n: String(interest) }));
      this.m.sendTo(this.playerId, { t: 'm.ticker', ...w, id: null, type: 'CUSTOM', priority: 0, playerId: this.playerId, args: [String(interest)] });
    }
    const nonNeg = (v) => (Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
    if (rewindSnap) {
      // ★ 2026-10-16（owner）死亡回归回退：**不再发一次收入** —— startRound 每次都会发，
      //   回退时再发就变成"凭空多了一份"（实测回合 1：9 → 10，多的 9 就是重发的收入 + 1 利息）。
      //   直接把资金摆回本回合的起始值（快照 funds，回合 1 = 9）。
      this.funds = Number(rewindSnap.funds) || 0;
    } else {
      this.addFunds(nonNeg(ev.income) + nonNeg(ev.pending), { reason: 'income' });
    }
    // temp is NOT wiped here: the last prep's deadline resolved what the player could act on (endPrep); what overflowed
    // after it (battle-result grants, SETTLE merges, returned equipment) is shown and usable in this prep (tempDue).
    // Likewise reward offers of the last prep already expired at its end; what is still queued was earned after it —
    // a merge completed during SETTLE / the Final Assault (突变细胞, battle-result grants) — and is shown in this prep
    this.ready = false;
    // summon stacks removed from temp at the last prep deadline come back (PRTS 卫戍协议/帮助 §手牌区); full hand ⇒ temp
    for (const p of [...this.board.values()]) if (p.kind === 'chess') this.grantTokensFor(p);
    this.rollShop({ keepFrozen: true });
    this.shop.frozen = false;
    for (const s of this.shop.slots) if (s) s.frozen = false;
    this.recompute();
    // ★ 2026-10-16（owner）惊变「死亡回归」：回合开始时只记"这一回合的号"和商店牌面。
    //   棋盘快照**不在这里** —— 购买/部署发生在本回合的整备阶段里（startRound 之后），
    //   在这里存会把上一个整备买的干员当成"本来就有"（实测 pieces=3/3，一个都没回收）。
    //   正确的快照点在 PlayerState.endPrep（整备结束、刚买完摆完那一刻）。
    this.prepSnapshot = {
      round: r,
      funds: this.funds,
      shop: this.shop.slots.map((x) => (x ? { kind: x.kind, id: x.id, price: x.price } : null)),
    };
    // ★ 死亡回归回退：用**上一份快照**（整备结束时那份，带 boardUids）回收本整备阶段买的干员。
    //   资金不动（干员回收、钱不退 —— owner 口径）。
    if (rewindSnap) {
      try {
        this.prepSnapshot = rewindSnap;          // 临时换成旧那份（供回收用）
        this.restorePrepSnapshot();
      } catch (e) { this.m.reportError('deathReturn restore', e); }
    }
  }

  /**
   * 惊变「死亡回归」：把这一位玩家恢复到"本回合整备阶段刚开始"的状态。
   * 资金回到当时的值、整备阶段里买的棋子退掉（还回卡池）、商店牌面恢复成当时那三张。
   * @returns {boolean} 是否有快照可用
   */
  restorePrepSnapshot() {
    const snap = this.prepSnapshot;
    if (!snap) return false;
    // ★ 2026-10-16（owner 口径，最终修正）：
    //   · 回退掉的干员**直接回收、钱不退** —— 所以**资金保持原样**（= 按下按钮那一刻的余额），
    //     不能用快照覆盖：快照是"还没买东西"时的余额，覆盖回去等于把花掉的钱退了回来（实测 +12）。
    //   · 「资金按回合开始算」指的是 startRound 已经发过本轮收入这件事本身，不需要我们再发一次。
    //   · pendingFunds 照常清零（本回合还没结算的待发资金作废）。
    this.pendingFunds = 0;
    // ★ 2026-10-16（owner）按"获得标记"回收：这才是"本回合整备阶段买的干员"的正确定义。
    const marks = this.gainedUids instanceof Set ? this.gainedUids : null;
    if (marks && marks.size) {
      const gone = [];
      for (const [uid, p] of [...this.board]) if (marks.has(uid)) { gone.push(uid); this.returnCopies(p); this.board.delete(uid); }
      for (let i = 0; i < this.hand.length; i++) { const p = this.hand[i]; if (p && marks.has(p.uid)) { this.returnCopies(p); this.hand[i] = null; } }
      for (let i = 0; i < this.temp.length; i++) { const p = this.temp[i]; if (p && marks.has(p.uid)) { this.returnCopies(p); this.temp[i] = null; } }
      for (const uid of gone) { try { this.removeTokensOf(uid); } catch { /* ignore */ } }
      marks.clear();
      this.ready = false;
      this.recompute();
      return true;
    }
    // 回落：没有标记（本回合什么都没获得）→ 无可回收
    if (!snap.boardUids) { this.recompute(); return true; }
    const gone = [];
    for (const [uid, p] of [...this.board]) {
      if (snap.boardUids.has(uid)) continue;
      gone.push(uid);
      this.returnCopies(p);
      this.board.delete(uid);
    }
    for (const uid of gone) { try { this.removeTokensOf(uid); } catch { /* ignore */ } }
    // 手牌 / 临时区里整备阶段新拿的也退掉
    for (const zone of (Array.isArray(this.hand) ? [this.hand] : [])) {
      for (let i = 0; i < zone.length; i++) {
        const p = zone[i];
        if (!p) continue;
        if (p.kind === 'chess' && !snap.handUids?.has?.(p.uid)) { this.returnCopies(p); zone[i] = null; }
      }
    }
    // 商店牌面恢复
    if (Array.isArray(snap.shop) && this.shop.slots.length === snap.shop.length) {
      for (let i = 0; i < snap.shop.length; i++) {
        const sv = snap.shop[i];
        const cur = this.shop.slots[i];
        if (!sv || !cur) continue;
        cur.kind = sv.kind; cur.id = sv.id; cur.price = sv.price; cur.sold = false;
      }
    }
    this.ready = false;
    this.recompute();
    return true;
  }

  /**
   * 规则10 preview (user request): what this seat is GUARANTEED to receive when the NEXT round starts — the shop
   * funds card's 「下回合最少获得：x（包含y利息）」 line. Same arithmetic as startRound's income: the next round's base
   * income (gd.income) + the interest that TODAY's funds already pay + the pending funds already parked for it.
   *
   * It is a FLOOR, not a promise: spending during the prep only lowers the interest, so counting today's funds is the
   * guaranteed part. The real round start still runs the onIncome hooks, which can move it either way — 坎诺特's
   * coin_carry_over/利滚利 stacks extra interest on top, 老鲤 withholds R1–R2 income until R3.
   *
   * @returns {{ round: number, base: number, interest: number, pending: number, total: number, capped: boolean }}
   */
  nextIncomePreview() {
    const round = (Number(this.m && this.m.round) || 0) + 1;
    const it = this.gd.interest;
    const held = Math.max(0, Math.trunc(Number(this.funds) || 0));
    const interest = it && held >= it.capital ? Math.min(it.max, Math.floor(held / it.capital) * it.interest) : 0;
    const pending = Math.max(0, Math.trunc(Number(this.pendingFunds) || 0));
    const base = this.gd.income(round);
    return { round, base, interest, pending, total: base + interest + pending, capped: !!it && it.max > 0 && interest >= it.max };
  }

  /**
   * Prep deadline (Match.endPrep, after the <休整期结束时> onPrepEnd effects): the temp pieces due at this prep are
   * resolved; what overflowed after Ready or during onPrepEnd stays for the next prep, which `prepsEnded` now names.
   */
  endPrep() {
    // ★ 2026-10-16（owner）死亡回归的回退基准：整备结束这一刻场上/手牌/临时区的棋子全部记下来。
    //   这一整备阶段**新买**的棋子 uid 不在其中，回退时它们就是"要回收"的那批。
    try {
      if (this.prepSnapshot) {
        this.prepSnapshot.boardUids = new Set([...this.board.keys()]);
        this.prepSnapshot.handUids = new Set();
        this.prepSnapshot.tempUids = new Set();
        for (const p of this.hand) if (p) this.prepSnapshot.handUids.add(p.uid);
        for (const p of this.temp) if (p) this.prepSnapshot.tempUids.add(p.uid);
      }
    } catch { /* ignore */ }

    this.resolveTemp();
    this.prepsEnded++;
    for (const uid of [...this._tempDue.keys()]) if (!this.temp.some((p) => p && p.uid === uid)) this._tempDue.delete(uid);
    this.offers = [];
    this.clearUnfrozenShop();
    // 炸惊模拟 规则10: funds carry over for everyone (mode.leftoverFundsKept), not just the 坎诺特 band
    if (!this.gd.leftoverFundsKept && !this.gd.leftoverKeptBands.includes(this.bandId)) this.funds = 0;
    this.ready = true;
    this.dirty();
  }

  // `effects` are kept: a 信标 gift still pending is delivered to the teammate at the next round start (builtin_gift is
  // flagged afterElimination — GitHub #86); nothing else of an eliminated player is dispatched.
  eliminate(round) {
    this.alive = false;
    this.ready = false;
    this.eliminatedRound = round;
    const all = [];
    for (const p of this.board.values()) all.push(p);
    for (const p of this.hand) if (p) all.push(p);
    for (const p of this.temp) if (p) all.push(p);
    for (const p of all) this.returnCopies(p);
    this.board.clear();
    this.hand.fill(null);
    this.temp.fill(null);
    this._tempDue.clear();
    this.offers = [];
    this.bounties = [];
    this.shop.slots = [];
    this.funds = 0;
    this.pendingFunds = 0;
    this.recompute();
  }

  recompute() {
    this.deployMap(); // a change of the deploy field (a boss round's prep) marks the legality stale
    if (this._legalityStale) this._evictIllegal();
    this._liftOutOfRange();
    // a free regular hand slot pulls a temp piece in (PRTS 卫戍协议/帮助 §手牌区 "常规手牌区出现空位时自动移入")
    this._fillHandFromTemp();
    this.bonds = computeBonds(this.gd, this);
    this.dirty();
  }

  activatedLayers() { return activatedLayers(this.bonds); }

  /**
   * The bond states the views show (m.private bonds, m.public players[].bonds): the computed states plus the pending
   * in-battle gains of this round's finished normal battle (bondsMeta.bondsWithGains). The 联防 field fights with them too
   * (battleInput `reached`); no other rule reads them.
   */
  bondsView() { return bondsWithGains(this.bonds, this.pendingLayerGains, this.gd.bondLayerCap); }

  /**
   * `reached`: the bonds carry the layers this round's own combat reached (bondsView: the pending in-battle gains, capped
   * like settle()) — the 联防 field (unite.js; PRTS 卫戍协议/帮助 §联防阶段 "将以其阵地当前的状态", [ASSUMED] the current
   * state includes those layers, as the strip shows them). The gains stay pending: settle() adds them once.
   */
  battleInput({ side = 'L', colOffset = 0, carry = null, reached = false } = {}) {
    // a terrain change not yet followed by a recompute (a content hook at the prep end) never fields an illegal board
    this.deployMap();
    if (this._legalityStale) this.recompute();
    const units = [];
    for (const { r, c, piece } of boardOrder(this.board)) {
      if (piece.kind === 'chess') {
        const u = { uid: piece.uid, kind: 'chess', chessId: piece.id, row: r, col: c, dir: pieceDir(piece), items: (piece.items || []).map((i) => i.id) };
        const pick = this.diyPickOf(piece.id);
        if (pick) {
          // 0.2.0 自选编队: a slotted DIY slot fights as its pick (sim getChess(id, { diy }): the operator's body, the pick's
          // skill and module — no loadout fields, docs/SIM.md §12)
          u.diy = { charId: pick.charId, skillIndex: pick.skillIndex, uniEquipId: pick.uniEquipId };
        } else if (this.fieldsStandIn(piece.id)) {
          // 0.2.0 补位: a chess this player does not own fights as its stand-in (sim getChess(id, { standIn: true }): the
          // backup skill / module — no loadout fields, docs/SIM.md §12)
          u.standIn = true;
        } else {
          // DESIGN §16: the equipped skill / module (elite only) from the loadout (defaults when absent)
          const lo = this.loadoutFor(this.gd.chess(piece.id));
          u.skillIndex = lo.skillIndex;
          u.moduleId = lo.moduleId;
          // 潜能 / 练度 (0.2.2): the player's own setting for this OPERATOR (charId — the normal, elite and 自选 forms of
          // one operator share it). Only a real body takes them: a 补位 stand-in and a prototype 自选 pick are another
          // operator's body, so they fight at the data's own values (潜能 6, no 练度).
          const rec = this.gd.chess(piece.id);
          const op = this.opsFor(rec?.charId);
          if (op) { u.potential = op.potential; u.cultivate = op.cultivate; }
        }
        if (carry && carry.has(piece.uid)) u.carryState = carry.get(piece.uid);
        // 干员皮肤 (docs/SKINS.md): which model to draw for this piece. Same key order as views.js and the client's
        // pieceInfo — the base chess first (a variant shares the base's model), then the piece, then the DIY slot's
        // character. The simulator never looks a skin up, it only carries the id through to the snapshot.
        const skin = this.skinOfPiece(piece.id, pick);
        if (skin) u.skin = skin;
        // 诊断（临时，2026-10-17 排查「精锐了还是原皮」）：服务端发给战斗的 skin 到底是什么。
        // 只看结城理（char_4217_makoto）；定位完就删这几行。
        if (this.gd.chess(piece.id)?.charId === 'char_4217_makoto') {
          try {
          } catch { /* 非 Node 环境忽略 */ }
        }
        units.push(u);
      } else if (piece.kind === 'token') {
        const u = { uid: piece.uid, kind: 'token', tokenId: piece.id, row: r, col: c, dir: pieceDir(piece), ownerUid: piece.ownerUid };
        if (carry && carry.has(piece.uid)) u.carryState = carry.get(piece.uid); // 联防: { sp } (unite.js)
        units.push(u);
      }
    }
    return {
      playerId: this.playerId,
      seat: this.seat,
      side,
      colOffset,
      units,
      bonds: bondSnapshot(reached ? this.bondsView() : this.bonds),
      // ★ 炸惊模拟「锻造器」(user 2026-10-14)：把已锻造的数值折算成战斗用的扁平值，
      //   战斗侧 content/forge.js 会把它铺到这一玩家的所有干员身上。
      forge: forgeBattleMods(this.forge && this.forge.forged),
      // ★ 2026-10-25：策略「山岸风花·神通法」按「调度中心等级」加层 —— 战斗侧拿不到 match 的 shop，
      //   所以把等级随参战数据一起下发（服务端 / 客户端模拟都用这一份输入）。
      shopLevel: this.shop && Number.isInteger(this.shop.level) ? this.shop.level : 1,
      // 伟大封印：整场比赛只能触发一次，跨战斗带到下一次输入
      greatSealUsed: !!this.greatSealUsed,
      bandId: this.bandId,
      playerEffects: this.effects.filter((e) => e.battle !== false).map((e) => ({
        id: e.id, key: e.key ?? null, source: e.iconKind ?? null, params: e.params ?? null, counter: e.counter ?? null, data: e.data ?? null,
      })),
      deviceOverrides: { ...this.deviceOverrides },
      // ★ 2026-10-21：加入大群 / 叠层手在战斗侧要用到、但只有匹配赛这边知道的两个事实
      //   （浊心斯卡蒂可能在整备区；叠层手的生效回合记在 counters 上）。
      jibianFlags: {
        skadi: [...this.board.values(), ...this.hand, ...this.temp]
          .some((p) => p && p.kind === 'chess' && (SKADI_CORRUPTED.includes(p.id) || SKADI_CORRUPTED.includes(p.baseId))),
        doubler: Number(this.counters && this.counters['jibian:diecengshou:until']) >= Number(this.m && this.m.round),
      },
    };
  }
}
