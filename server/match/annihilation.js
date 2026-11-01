// 湮灭专属实例适配层；不修改任何共享 prototype。
import { PHASE, ERR } from '../../shared/constants.js';
import { OK, fail } from './match/common.js';
import { EffectDispatcher } from './effectsMeta.js';
import { registerMeta as registerRelicMeta } from '../sim/content/relics.js';
import { AnnihilationMethods, AnnihilationPlayer } from './annihilationMethods.js';
import {
  relicRoundStart, relicModsFor, relicPrivateView, relicDraft, relicPriceDiscount,
  relicRefreshBlocked, relicUpgradeDelta, pickRelic, startRelicSpin, flushRelicToast,
  relicBountyMul, relicBountyIncome, relicBountyDeploy,
  restoreRelicState, scheduleBotVotes, reconcileTeamVotes, relicConsumableUsed,
} from './relics.js';

const wrap = (obj, name, fn) => {
  const original = obj[name];
  Object.defineProperty(obj, name, { configurable: true, writable: true,
    value: function(...args) { return fn.call(this, original.bind(this), ...args); } });
};

/** Match 的湮灭分支唯一入口。普通模式、排位、舟铲铲和原无尽不经过此处。 */
export function installAnnihilation(m) {
  m.isEndless = m.gd.endless;
  m.hostId = m.opts.hostId || m.order.find(p => !p.isBot)?.playerId || null;
  const registry = new m.registry.constructor();
  for (const [key, handler] of m.registry._h) registry.register(key, handler);
  registerRelicMeta(registry);
  m.registry = registry;
  m.dispatcher = new EffectDispatcher(m, registry);
  for (const key of Object.getOwnPropertyNames(AnnihilationMethods.prototype)) {
    if (key !== 'constructor') Object.defineProperty(m, key,
      Object.getOwnPropertyDescriptor(AnnihilationMethods.prototype, key));
  }
  wrap(m, 'publicView', function(base) {
    return { ...base(), erosion: this.gd.erosion, endless: this.gd.endless,
      bossRound: this.gd.bossRoundFor(this.round), hiddenRound: this.gd.hiddenRoundFor(this.round),
      spRound: this.gd.isSpRound(this.round) };
  });
  Object.defineProperty(m, 'restoreAnnihilation', { configurable: true, value(doc, decode) {
    const saved = decode(doc.annihilation);
    this.hostId = saved.hostId;
    this.relicTeam = saved.relicTeam;
    for (const player of doc.players) {
      const ps = this.players.get(player.playerId), state = decode(player.annihilation);
      const st = restoreRelicState(ps, state?.relics);
      ps.pendingRelicToast = state?.pendingRelicToast;
      if (st.draft?.team && this.relicTeam?.draft) st.draft = this.relicTeam.draft;
      ps.recompute();
    }
    if (this.relicTeam?.draft) scheduleBotVotes(this, this.relicTeam.draft);
  } });
  for (const method of ['onLeave', 'onDisconnect', 'onReconnect', 'setAutoplay']) wrap(m, method, function(base, ...args) {
    const result = base(...args);
    reconcileTeamVotes(this);
    return result;
  });
  wrap(m, 'dispatchItem', function(base, ps, item, holder, hook, ev) {
    const result = base(ps, item, holder, hook, ev);
    if (!ev.error && hook === 'onEquip' && ev.keep) item.meta.annihilationPendingUse = true;
    if (!ev.error && ((hook === 'onEquip' && !ev.keep && ev.consumed !== false) ||
      (hook === 'onArt' && ev.used !== false))) ps._annItemUses?.push(item);
    return result;
  });
  wrap(m, 'dispatch', function(base, ps, hook, ev) {
    const delayed = hook === 'onRoundStart' ? ps.allChess().flatMap(p => p.items || [])
      .filter(item => item.meta?.annihilationPendingUse) : [];
    const result = base(ps, hook, ev);
    for (const item of delayed) if (!ps.find(item.uid)) relicConsumableUsed(this, ps, item);
    return result;
  });
  wrap(m, '_handle', function(base, ps, msg) {
    if (msg.t === 'g.relic') {
      if (this.phase !== PHASE.PREP || !ps.alive || ps.ready) return fail(ERR.WRONG_PHASE);
      if (msg.start === true) return startRelicSpin(this, ps) ? OK : fail(ERR.BAD_TARGET);
      const result = pickRelic(this, ps, msg.idx);
      if (!result.error) { this.markPrivate(ps); this.maybeEndPrep(); return OK; }
      return fail(result.error === 'NO_DRAFT' ? ERR.WRONG_PHASE : ERR.BAD_TARGET);
    }
    if (msg.t === 'g.relicSeen') { flushRelicToast(ps); ps.dirty(); return OK; }
    return base(ps, msg);
  });
  wrap(m, '_settleBossBounties', function(base, ps, pp) {
    const coins = Math.round(Math.max(0, Math.trunc(Number(pp.coins) || 0)) * relicBountyMul(ps));
    base(ps, { ...pp, coins }); relicBountyIncome(ps, coins);
    relicBountyDeploy(ps, Number(pp.bountyKills) || 0);
  });
  // A stalled AI preparation must not keep ready humans waiting indefinitely.
  wrap(m, 'maybeEndPrep', function(base) {
    const alive = this.alivePlayers();
    const humansReady = alive.some(p => !p.isBot) && alive.filter(p => !p.isBot).every(p => p.ready);
    const bots = alive.filter(p => p.isBot && !p.ready);
    if (this.phase === PHASE.PREP && humansReady && bots.length && !this._annBotReadyFallback) {
      const round = this.round;
      this._annBotReadyFallback = this.later(2000, () => {
        this._annBotReadyFallback = null;
        if (this.phase !== PHASE.PREP || this.round !== round || this.alivePlayers().some(p => !p.isBot && !p.ready)) return;
        for (const ps of this.alivePlayers().filter(p => p.isBot && !p.ready)) {
          this.autoPickPersonalChoice(ps, 'random'); ps.resolveTemp(); ps.setReady(true);
        }
        this.maybeEndPrep();
      });
    } else if ((!humansReady || !bots.length || this.phase !== PHASE.PREP) && this._annBotReadyFallback) {
      this.cancel(this._annBotReadyFallback); this._annBotReadyFallback = null;
    }
    return base();
  });
  for (const ps of m.order) {
    for (const method of ['useArt']) wrap(ps, method, function(base, ...args) {
      const previous = this._annItemUses, used = [];
      this._annItemUses = used;
      try {
        const result = base(...args);
        if (!result?.error) for (const item of used) if (!this.find(item.uid)) relicConsumableUsed(this.m, this, item);
        return result;
      } finally { this._annItemUses = previous; }
    });
    wrap(ps, '_mergeItem', function(base, id, incoming = null, equipped = null) {
      const rec = this.gd.item(id);
      const need = Number.isInteger(rec?.upgradeNum) ? rec.upgradeNum : this.gd.itemMergeCount;
      const pieces = [...(incoming ? [incoming] : []), ...(equipped ? [equipped] : this._itemLocations(id)).map(loc => loc.piece)].slice(0, need);
      const paid = pieces.reduce((sum, item) => sum + (Number(item.meta?.annihilationPaid) || 0), 0);
      const result = base(id, incoming, equipped);
      if (result && paid > 0) result.meta.annihilationPaid = paid;
      return result;
    });
    wrap(ps, 'startRound', function(base, round) { const result = base(round); relicRoundStart(this.m, this); return result; });
    wrap(ps, 'battleInput', function(base, opts) { return { ...base(opts), relicMods: relicModsFor(this) }; });
    wrap(ps, 'privateView', function(base) {
      const view = base();
      return { ...view, relics: relicPrivateView(this), annihilation: { erosion: this.gd.erosion, unlimitedEquipment: this.gd.endless }, canReady: view.canReady && !relicDraft(this) };
    });
    wrap(ps, 'priceOf', function(base, slot) { return Math.max(0, base(slot) + relicPriceDiscount(this, slot)); });
    wrap(ps, 'refresh', function(base) {
      if (this.shop.freeRefreshes <= 0 && relicRefreshBlocked(this))
        return fail(ERR.BAD_TARGET, '本休整期的付费刷新次数已用完');
      return base();
    });
    wrap(ps, 'levelUp', function(base) {
      const level = this.shop.level, result = base();
      if (this.shop.level > level) this.shop.upgradePrice += relicUpgradeDelta(this);
      return result;
    });
    wrap(ps, 'setReady', function(base, on) {
      if (on && relicDraft(this)) return fail(ERR.BAD_TARGET, '请先完成藏品选择');
      return base(on);
    });
    Object.defineProperty(ps, 'stow', { configurable: true, writable: true, value: AnnihilationPlayer.prototype.stow });
  }
}
