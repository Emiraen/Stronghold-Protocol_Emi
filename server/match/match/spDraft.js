

import { PHASE, ERR } from "../../../shared/constants.js";

import { generateDraft, applyCard, bountyBattles, isMultiRoundBounty } from "../choices.js";
import { weightedPick } from "../waves.js";

import { botPickCard } from "../bot.js";
import { onPickCard } from '../botEmotes.js';
import { OK, fail, DELAYS } from "./common.js";
export class MatchSpDraft {
  spCardAvailable(card, group = this.sp) {
    return !!card && group?.taken[card.idx] == null && (card.kind !== 'item' || this.itemPool.canGain(card.id));
  }

  enterSpDraft() {
    if (this.isEntertainmentMulti) return this._enterGroupDraft('sp');
    const draft = generateDraft(this.gd, this.rngDraft, this.round, { stageId: this.stageId, bondAvailable: (bondId) => this.bondLive(bondId), itemAvailable: (id) => this.itemPool.canGain(id) });
    const alive = this.alivePlayers();
    if (!draft || !alive.length) { this.enterPrep(); return; }
    this.phase = PHASE.SP_DRAFT;
    const order = alive.map((p) => p.playerId);
    if (!this.isSolo) this.rngDraft.shuffle(order);
    order.splice(0, order.length, ...this.humansFirst(order));
    // untimed: solo and any single-human match (soloUntimed); the co-op order / 6 cards stay
    const untimed = this.soloUntimed;
    this.sp = { ...draft, order, idx: 0, picks: {}, taken: {}, untimed, turnDeadline: 0 };
    this.setDeadline(0);
    this.startSpTurn();
    this.markPublic();
  }

  spTurn(playerId = null) {
    if (this.isEntertainmentMulti) { const g = this.spGroup(playerId); return g && !g.done ? g.order[g.idx] ?? null : null; }
    const s = this.sp;
    if (!s) return null;
    return s.order[s.idx] ?? null;
  }

  startSpTurn(group = this.spGroup()) {
    if (this.isEntertainmentMulti) return this._startGroupTurn('sp', group);
    const s = this.sp;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    while (s.idx < s.order.length) {
      const ps = this.players.get(s.order[s.idx]);
      if (ps && ps.alive && s.picks[ps.playerId] == null) break;
      s.idx++;
    }
    const available = s.cards.filter((c) => this.spCardAvailable(c, s)).map((c) => c.idx);
    if (s.idx >= s.order.length || !available.length) { this.setDeadline(0); this.later(0, () => this.finishSpDraft()); return; }
    const token = ++this._turnToken;
    if (!s.untimed) {
      const first = s.idx === 0;
      const secs = first ? this.gd.timer('spFirst') : this.gd.timer('spTurn');
      this.setDeadline(secs, () => {
        if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken) return;
        const ps = this.players.get(this.spTurn());
        if (!ps) return;
        const avail = s.cards.filter((c) => this.spCardAvailable(c, s)).map((c) => c.idx);
        if (!avail.length) { this.finishSpDraft(); return; }
        this._applyCard(ps, avail[Math.floor(this.rngDraft() * avail.length)]);
      });
      s.turnDeadline = this.deadline;
    } else {
      this.setDeadline(0);
    }
    const cur = this.players.get(this.spTurn());
    if (cur && cur.botControlled) this.scheduleSpBot();
    this.markPublic();
  }

  scheduleSpBot(group = this.spGroup()) {
    if (this.isEntertainmentMulti) return this._startGroupTurn('sp', group);
    const token = this._turnToken;
    this.later(this.scaled(DELAYS.BOT_ACTION), () => {
      if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken || !this.sp) return;
      const ps = this.players.get(this.spTurn());
      if (!ps || !ps.botControlled) return;
      const avail = this.sp.cards.filter((c) => this.spCardAvailable(c)).map((c) => c.idx);
      if (!avail.length) { this.startSpTurn(); return; }
      this._applyCard(ps, botPickCard(this, ps, this.sp.cards, avail));
    });
  }

  pickCard(ps, idx, opts = {}) {
    if (this.isEntertainmentMulti) return this._groupPickCard(ps, idx, opts);
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.sp.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    if (this.spTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.sp.cards.length) return fail(ERR.BAD_TARGET);
    if (!this.spCardAvailable(this.sp.cards[idx])) return fail(ERR.SOLD_OUT);
    this._applyCard(ps, idx);
    return OK;
  }

  _applyCard(ps, idx) {
    if (this.isEntertainmentMulti) return this._applyGroupCard(ps, idx);
    const s = this.sp;
    if (!s || s.picks[ps.playerId] != null || s.taken[idx] != null) return;
    const card = s.cards[idx];
    if (!this.spCardAvailable(card, s)) return;
    s.picks[ps.playerId] = idx;
    s.taken[idx] = ps.playerId;
    try { applyCard(this, ps, card); } catch (e) { this.reportError(`applyCard ${card.id}`, e); }
    onPickCard(this, ps, card);
    this.markPrivate(ps);
    this.markPublic();
    this.startSpTurn();
  }

  finishSpDraft() {
    if (this.phase !== PHASE.SP_DRAFT) return;
    if (this.isEntertainmentMulti) for (const g of this.sp.groups) this._clearGroupTurn(g);
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    this.enterPrep();
  }

  addBounty(ps, card) {
    if (!ps || !card || !this.gd.enemy(card.enemyKey)) return null;
    // a multi-round card lasts MULTI_ROUND_BOUNTY_BATTLES battles (choices.js; the user's call after playtest #6)
    const rounds = bountyBattles(card);
    const b = {
      id: `bounty:${this.nextUid()}`,
      card: { effectId: card.effectId ?? card.id ?? null, name: card.name ?? '悬赏', desc: card.desc ?? '', tier: card.tier ?? 1, coin: Math.max(0, Math.trunc(Number(card.coin) || 0)), payout: card.payout === 'perfect' ? 'perfect' : 'kill', rounds, multiRound: isMultiRoundBounty(card), enemyKey: card.enemyKey, count: Math.max(1, Math.min(20, Number.isInteger(card.count) ? card.count : 1)) },
      roundsLeft: rounds,
    };
    ps.bounties.push(b);
    ps.dirty();
    return b.id;
  }

  rollItemId({ pool = null, tier = null, maxTier = 6, shopLevel = 6, exclude = [] } = {}) {
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof pool === 'string' && Object.hasOwn(pools, pool) ? pools[pool] : null;
    const rng = this.rngMeta;
    const excluded = new Set(Array.isArray(exclude) ? exclude.filter((id) => typeof id === 'string') : []);
    const eligible = (ids) => excluded.size ? ids.filter((id) => !excluded.has(id)) : ids;
    const tierList = (lo, hi) => { const out = []; for (let t = lo; t <= hi; t++) for (const id of this.gd.shopItemsByTier[t] || []) out.push(id); return out; };
    if (p && p.kind === 'equip') {
      if (Array.isArray(p.weighted) && p.weighted.length) {
        const pairs = p.weighted.filter((x) => Array.isArray(x) && !excluded.has(x[0]) && this.gd.item(x[0]) && this.itemPool.canGain(x[0]));
        return this.itemPool.pick(rng, pairs.map((x) => x[0]), new Map(pairs));
      }
      if (Array.isArray(p.items) && p.items.length) {
        const items = p.items.filter((id) => !excluded.has(id) && this.gd.item(id));
        return this.itemPool.pick(rng, items);
      }
      let list;
      if (Array.isArray(p.tiers) && p.tiers.length) list = p.tiers.flatMap((t) => this.gd.shopItemsByTier[t] || []);
      else list = tierList(1, p.maxTier === 'shopLevel' ? Math.max(1, Math.min(6, shopLevel)) : 6);
      return this.itemPool.pick(rng, eligible(list));
    }
    const list = Number.isInteger(tier) ? tierList(tier, tier) : tierList(1, Math.max(1, Math.min(6, maxTier)));
    return this.itemPool.pick(rng, eligible(list));
  }

  rollPool(poolId, { shopLevel = 6, extra = null, chessOf = null, player = null, exclude = [] } = {}) {
    const stock = this.poolFor(player);
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof poolId === 'string' && Object.hasOwn(pools, poolId) ? pools[poolId] : null;
    if (!p || typeof p !== 'object') return null;
    const lvl = Math.max(1, Math.min(6, Number.isInteger(shopLevel) ? shopLevel : 6));
    if (p.kind === 'equip') {
      const id = this.rollItemId({ pool: poolId, shopLevel: lvl, exclude });
      return id ? { kind: 'item', id } : null;
    }
    if (p.kind !== 'chess') return null;
    const rng = this.rngMeta;
    const excluded = new Set(Array.isArray(exclude) ? exclude.filter((id) => typeof id === 'string') : []);
    const allowed = (id) => !excluded.size || (!excluded.has(id) && (!p.golden || !excluded.has(this.gd.goldenIdOf(id) || id)));
    const free = (id) => {
      if (typeof id !== 'string' || !allowed(id) || !this.gd.chess(id)) return false;
      const base = this.gd.baseIdOf(id);
      if (this.bannedChess.includes(base)) return false;
      return !stock.has(base) || stock.left(base) > 0;
    };
    let id = null;
    if (Array.isArray(p.weighted) && p.weighted.length) {
      const pairs = p.weighted.filter((x) => Array.isArray(x) && free(x[0]));
      id = pairs.length ? weightedPick(rng, pairs) : null;
    } else if (Array.isArray(p.items) && p.items.length) {
      const list = p.items.filter(free);
      id = list.length ? list[Math.floor(rng() * list.length)] : null;
    } else {
      const maxTier = p.maxTier === 'shopLevel' ? lvl : Number.isInteger(p.maxTier) ? p.maxTier : 6;
      const minTier = Number.isInteger(p.minTier) ? p.minTier : 1;
      const bond = typeof p.bond === 'string' ? p.bond : null;
      const recOf = typeof chessOf === 'function' ? chessOf : (cid) => this.gd.chess(cid);
      id = stock.roll(rng, {
        extra,
        tier: Number.isInteger(p.tier) ? p.tier : null,
        maxTier,
        filter: (cid, e) => (!excluded.size || allowed(cid)) && e.tier >= minTier && (!bond || (Array.isArray(recOf(cid)?.bonds) && recOf(cid).bonds.includes(bond))),
      });
    }
    if (!id) return null;
    const golden = !!p.golden;
    return { kind: 'chess', id: golden ? this.gd.goldenIdOf(id) || id : id, golden };
  }
}
