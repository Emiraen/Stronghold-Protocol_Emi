import { resultSnapshot } from '../resultSnapshot.js';


import { boardOrder, pieceDir } from "../board.js";

import { computeBonds, bondSnapshot, activatedLayers, bondsWithGains } from "../bondsMeta.js";

import { cyclopsInterestWith, cyclopsHooks, normalizeCyclopsGiftHooks } from "../cyclops.js";

export class PlayerRound {
  startRound(r) {
    this.round = { refreshes: 0, buys: 0, sells: 0, spent: 0, gainedChess: 0, arts: 0 };
    this.pendingLayerGains = null; // settled (or lapsed) at the last SETTLE
    if (r > 1 && !this.m.isCyclops) this.shop.upgradePrice = Math.max(0, this.shop.upgradePrice - 1);
    // onIncome handlers may rewrite ev.income / ev.pending (e.g. 老鲤 withholds R1–R2 income until R3)
    const ev = { round: r, income: this.gd.income(r), pending: this.pendingFunds };
    this.pendingFunds = 0;
    this.m.dispatch(this, 'onIncome', ev);
    const nonNeg = (v) => (Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
    let income = nonNeg(ev.income) + nonNeg(ev.pending);
    // 独眼巨人冲锋：存款利息 —— 资金≤50 每满 10 金 +1/回合（上回合末结存）
    if (this.m.isCyclops) {
      const hooks = cyclopsHooks(this);
      const capBonus = hooks.reduce((n, e) => n + (e.params.capBonus || 0), 0);
      const cap = Math.max(5 + capBonus, ...hooks.map(e => e.params.interestCap || 0));
      const interest = cyclopsInterestWith(this.funds, { capBonus: cap - 5, uncapped: hooks.some(e => e.params.interestUncapped) });
      income += Math.max(0, Math.trunc(interest));
    }
    this.addFunds(income, { reason: 'income' });
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
  }

  endPrep() {
    this.resolveTemp();
    this.prepsEnded++;
    for (const uid of [...this._tempDue.keys()]) if (!this.temp.some((p) => p && p.uid === uid)) this._tempDue.delete(uid);
    this.offers = [];
    this.clearUnfrozenShop();
    // 独眼巨人冲锋：资金保留并下回合生息；普通模式沿用原清零规则
    if (!this.m.isCyclops && !this.m.isEndless && !this.gd.leftoverKeptBands.includes(this.bandId)) this.funds = 0;
    this.ready = true;
    this.dirty();
  }

  eliminate(round) {
    // Preserve the final deployed roster for reports only; elimination/pool accounting stays unchanged.
    if (!this._resultSnapshot) this._resultSnapshot = resultSnapshot(this);
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
    this.personalChoice = null;
    this.shop.slots = [];
    this.funds = 0;
    this.pendingFunds = 0;
    this.recompute();
  }

  recompute() {
    this.deployMap(); // a change of the deploy field (a boss round's prep) marks the legality stale
    if (this._legalityStale) this._evictIllegal();
    this._liftOutOfRange();
    this.bonds = computeBonds(this.gd, this);
    this.dirty();
  }

  activatedLayers() { return activatedLayers(this.bonds); }

  bondsView() { return bondsWithGains(this.bonds, this.pendingLayerGains, this.m?.isEndless ? Infinity : undefined); }

  battleInput({ side = 'L', colOffset = 0, carry = null, reached = false } = {}) {
    normalizeCyclopsGiftHooks(this);
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
        }
        const cv = u.standIn ? null : this.cultivationFor(this.gd.chess(piece.id));
        if (cv) { u.potential = cv.potential; u.cultivate = cv.cultivate; }
        u.skin = this.skinFor(piece.id);
        if (carry && carry.has(piece.uid)) u.carryState = carry.get(piece.uid);
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
      bandId: this.bandId,
      devOps: this.devOps === true,
      cyclops: this.m.isCyclops,
      playerEffects: this.effects.filter((e) => e.battle !== false || (this.m.isCyclops && e.data?.tacticKind === 'cyclops')).map((e) => ({
        id: e.id, key: e.key ?? null, source: e.iconKind ?? null, params: e.params ?? null, counter: e.counter ?? null, data: e.data ?? null,
      })),
      deviceOverrides: { ...this.deviceOverrides },
    };
  }
}
