// server/match/match/settle.js — Match methods: SETTLE (the LP loss — a leaker's 联防 survivors —, stats, bounty coins,
// the IN_BATTLE layer gains clamped by layerGainRoom, CHAR_DAMAGE tickers, eliminations, the 联防 outcome the SETTLE
// view carries) and RESULT (finish: m.result to every human still here, onEnd).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, layerGainRoom } from '../../../shared/constants.js';
import { uniteSurvivors } from '../unite.js';
import { buildResult } from '../results.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from './common.js';
import { msg } from '../../../shared/i18n.js';

export class MatchSettle {
  settle(plan, uniteResult) {
    this.phase = PHASE.SETTLE;
    this.runner = null;
    this._stopClientCombat();
    // the pending in-battle gains the views showed become persistent below (alive players) or lapse (DESIGN §20.15)
    for (const ps of this.order) if (ps.pendingLayerGains) { ps.pendingLayerGains = null; ps.dirty(); }
    const cap = this.gd.lpCapPerRound;
    // a 联防 battle that could not run at all (synthetic result) must not wipe the leakers' losses: charge their own leaks
    const uniteRan = !!(plan && uniteResult && !uniteResult.synthetic);
    const survivors = uniteRan ? uniteSurvivors(plan, uniteResult) : null;
    // ★ 2026-10-24（反馈「兜底了还会掉血」）：留一条可诊断的账目 —— 伤害到底是按联防幸存数算的，
    //   还是因为结果被标成 synthetic（战场没跑起来）回落到「自己那场的漏怪」。线上排查就看这一行。
    try {
      if (plan && plan.leakers) {
        const detail = {};
        const unspawnedBy = {};
        for (const u of ((uniteResult && uniteResult.unspawned) || [])) {
          if (u && u.sourcePlayerId) unspawnedBy[u.sourcePlayerId] = (unspawnedBy[u.sourcePlayerId] || 0) + 1;
        }
        for (const lk of plan.leakers) {
          const pid = lk.playerId;
          const own = this.lastResults.get(pid);
          detail[pid] = {
            byUnite: uniteRan ? Math.max(0, survivors.get(pid) || 0) : null,
            ownLeaks: (own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0),
            bounced: plan.notReentered ? (plan.notReentered.get(pid) || 0) : 0,
            unspawned: unspawnedBy[pid] || 0,
          };
        }
        const helpers = Array.isArray(plan.helpers) ? plan.helpers.length : 0;
        // ★ 2026-10-26：uniteRan=false 时把「为什么没开打」一起打出来 —— 下次「兜住却扣血」能直接定位
        const why = uniteRan ? '' : ` 未开打原因{leakers:${plan.leakers.length},helpers:${helpers},`
          + `result:${uniteResult ? 'obj' : 'null'},relayPlans:${Array.isArray(this.relayPlans) ? this.relayPlans.length : 0},`
          + `phase1:${this._phase1Settle ? 1 : 0},fields:${(this.fields || []).filter((f) => f && f.kind === 'unite').length}}`;
        this.log.info?.(`[match ${this.roomCode}] R${this.round} 联防结算 uniteRan=${uniteRan} synthetic=${!!(uniteResult && uniteResult.synthetic)} ${JSON.stringify(detail)}${why}`);
        if (!uniteRan && helpers > 0) {
          this.log.warn?.(`[match ${this.roomCode}] R${this.round} 联防异常：helpers=${helpers} 但 uniteRan=false（结果丢失？）`);
        }
      }
    } catch { /* 诊断日志不影响结算 */ }
    // The 联防's outcome as data for the SETTLE view (m.public.uniteResult, views.js; GitHub #235, PR #112 by @Convey123):
    // each client pops the official result box from it (ui/gameLogic/phases.js uniteResultBox) — `through` = the leakers'
    // enemies that still got through (uncapped; only decides whether 「全员无伤！」 is true), `losses` = every alive
    // player's own LP charge of this round, the same `loss` deducted below, so the box and the LP bar never disagree. A
    // leaker's own battle leaks are not its charge in a 联防 round, which is why the client cannot work the number out
    // itself. No ticker line: the official reports the outcome in the one dialog. null when no 联防 resolved.
    this.uniteResultView = uniteRan && plan.leakers.length ? {
      through: plan.leakers.reduce((n, lk) => n + Math.max(0, survivors.get(lk.playerId) || 0), 0),
      helpers: plan.helpers.map((p) => p.playerId),
      leakers: plan.leakers.map((p) => p.playerId),
      losses: {},
    } : null;
    const alive = this.alivePlayers();
    for (const ban of uniteResult?.greatSealBans || []) {
      const ps = this.players.get(ban.playerId);
      if (!ps) continue;
      ps.greatSealUsed = true;
      ps.mem.greatSealBanRound = ban.round;
      for (const piece of [...ps.board.values(), ...ps.hand]) {
        if (piece && String(piece.id).startsWith('chess_zj_60_5')) piece.greatSealBanRound = ban.round;
      }
      ps.dirty();
    }
    const lossLog = {};
    for (const ps of alive) {
      const r = this.lastResults.get(ps.playerId) || { leaked: [], perfect: true, coins: 0, layerGains: {}, killed: 0, damageDealt: 0 };
      const counted = (r.leaked || []).filter((l) => l && l.counted !== false).length;
      const loss = uniteRan && plan.leakers.includes(ps) ? Math.min(cap, survivors.get(ps.playerId) || 0) : Math.min(cap, counted);
      if (this.uniteResultView) this.uniteResultView.losses[ps.playerId] = loss;
      ps.lp -= loss;
      ps.stats.lpLost += loss;
      if (plan && plan.leakers) lossLog[ps.playerId] = { loss, lp: ps.lp, alive: ps.alive };
      ps.stats.leaks += counted;
      ps.stats.kills += Number(r.killed) || 0;
      ps.stats.dmgDealt += Number(r.damageDealt) || 0;
      ps.stats.healing += Number(r.healingDone) || 0;
      if (r.perfect !== false && counted === 0) ps.stats.perfectRounds++;
      // bounty coins (own battle + unite kills) are credited to the next prep
      let coins = Math.max(0, Math.trunc(Number(r.coins) || 0));
      const up = uniteResult && uniteResult.perPlayer && uniteResult.perPlayer[ps.playerId];
      if (up) {
        coins += Math.max(0, Math.trunc(Number(up.coins) || 0));
        ps.stats.dmgDealt += Number(up.damageDealt) || 0;
        ps.stats.kills += Number(up.killed) || 0;
      }
      // ★ 炸惊模拟「锻造器」：累计击杀每满 FORGE_KILLS_PER 个发一个（幂等，见 player/acquire.js forgeOnKills）
      ps.forgeOnKills?.();
      // perfect-payout bounties (战术特训): own phase perfect
      for (const b of ps.bounties) if (b.card.payout === 'perfect' && counted === 0 && r.perfect !== false) coins += b.card.coin;
      if (coins > 0) { ps.pendingFunds += coins; ps.stats.fundsGained += coins; }
      for (const b of ps.bounties) b.roundsLeft--;
      ps.bounties = ps.bounties.filter((b) => b.roundsLeft > 0);
      try { if (Object.keys(lossLog).length) this.log.info?.(`[match ${this.roomCode}] R${this.round} 联防扣血 ${JSON.stringify(lossLog)}`); } catch { /* ignore */ }
    // IN_BATTLE layer gains, at most the room left under BOND_LAYER_CAP (999, as the battle's live copy:
      // Battle.addLayers); a bond at the cap gains nothing and dispatches nothing.
      // ★ 2026-10-15（用户：「联防阶段…可以叠层」）：原来只结算【自己那场】的 gains。联战的叠层记在
      //   uniteResult.perPlayer[pid].layerGains 里（unite.js combineUniteResults 原样拷贝每场的 pp），
      //   这里把两份相加 —— 同一名干员先打自己的场、再在联战里打一场，两边涨的层数都算数。
      const gains = { ...(r.layerGains || {}) };
      // ★ 2026-10-23 惊变「集中一点」：窗口期内，这一场的所有叠层并到层数最高的已激活盟约
      {
        const top = ps.jizhongyidianTarget ? ps.jizhongyidianTarget('__none__') : null;
        if (top) {
          let total = 0;
          for (const n of Object.values(gains)) if (Number.isFinite(n) && n > 0) total += n;
          if (total > 0) {
            for (const k of Object.keys(gains)) delete gains[k];
            gains[top] = total;
          }
        }
      }
      // 「只有炸惊有」：非炸惊时联战的 layerGainsEnabled 是 false，up.layerGains 本来就是空的，
      // 这里再加一道显式闸，意图写在代码里。
      if (this.gd.zhajing && up && up.layerGains && typeof up.layerGains === 'object') {
        for (const [bid, n] of Object.entries(up.layerGains)) {
          if (Number.isFinite(n) && n > 0) gains[bid] = (gains[bid] || 0) + n;
        }
      }
      for (const [bondId, n] of Object.entries(gains)) {
        if (!this.gd.bond(bondId) || !(n > 0)) continue;
        const before = ps.layers[bondId] || 0;
        const add = layerGainRoom(before, Math.floor(n), this.gd.bondLayerCap);
        if (!(add > 0)) continue;
        ps.layers[bondId] = before + add;
        this.dispatch(ps, 'onLayers', { bondId, from: before, to: ps.layers[bondId], reason: 'battle' });
      }
      this._charDamageTickers(ps, r);
      this.dispatch(ps, 'onBattleResult', { result: r, lpLoss: loss, perfect: counted === 0 && r.perfect !== false, unite: uniteResult || null });
      ps.recompute();
    }
    for (const ps of alive) {
      if (ps.lp <= 0) {
        // ★「时光之末」(惊变, owner 2026-10-16): 仅一次，非 boss 战里目标生命降为 0 时不淘汰该玩家，
        //   使其目标生命 +1 并进入下一回合。判定放在这里（结算完、淘汰前），handler 通过 ev.saved 阻止淘汰；
        //   卡片由 handler 自己 removeEffect（一次性的）。
        // ★ 「时光之末」的「非boss战」判断要用**本回合**的战场性质：`this.kind` 在 Match 上从来没有被赋过值
        //   （只有 Field 有 `kind`），传下去永远是 undefined ⇒ boss/hidden 的两个判断恒为假，一旦 boss 轮
        //   走到这条淘汰路径就会误触发。这里按本回合号判定，与 audit.js / phases.js 的口径一致。
        //   （boss 战正常失败走的是 bossRounds.js 的 `_bossEnd`，那里有死亡回归分支，不经过这里。）
        const roundKind = (this.round === this.gd.hiddenRound && this.round !== this.gd.bossRound) ? 'hidden'
          : this.round === this.gd.bossRound ? 'boss' : 'normal';
        const saveEv = this.dispatch(ps, 'onWouldEliminate', { lp: ps.lp, round: this.round, kind: roundKind });
        if (!saveEv.saved) {
          for (const mate of alive) {
            if (mate === ps || !mate.jibianHas('jibian_shiguangzhimo')) continue;
            this.dispatch(mate, 'onWouldEliminate', saveEv);
            if (saveEv.saved) break;
          }
        }
        if (saveEv && saveEv.saved) {
          ps.lp = Math.max(1, ps.lp + 1);
          ps.dirty?.();
          if (saveEv.toast !== false) this.toast(ps, 'info', '“时光之末”：目标生命+1，继续前进');
          if (saveEv.ticker !== false) this.tickerText(msg('{name}博士被“时光之末”拉回了循环', { name: ps.name }), FLOW_TICKER_PRIORITY);
          continue;
        }
        // ★「死亡回归」(惊变, owner 2026-10-16): 仅一次 —— 因目标生命降为 0 被淘汰时，
        //   不淘汰该玩家，而是走死亡回归（播报 + 3 秒后全体回到该回合整备阶段，本回合整备买的干员回收）。
        //   与按钮共用 PlayerState.deathReturnTrigger，语义完全一致（按钮 = 主动提前发动）。
        if (typeof ps.jibianHas === 'function' && ps.jibianHas('jibian_siwanghuigui')
            && !(ps.counters && ps.counters['jibian:siwanghuigui:used'] > 0)) {
          try {
            if (ps.deathReturnTrigger({ auto: true })) {
              this.toast(ps, 'info', '“死亡回归”：你回到了本回合的整备阶段');
              continue;
            }
          } catch (e) { this.reportError('deathReturn auto', e); }
        }
        ps.lp = 0;
        ps.eliminate(this.round);
        this.toast(ps, 'error', '你的目标生命值耗尽，已被淘汰');
        this.tickerText(msg('{name}博士的目标生命值已耗尽', { name: ps.name }), FLOW_TICKER_PRIORITY);
      }
    }
    this.fields = [];
    this.watchers.clear();
    this.markPublic();
    this.setDeadline(DELAYS.SETTLE / 1000, () => this.afterSettle(), { silent: this.soloUntimed });
  }

  /**
   * CHAR_DAMAGE tickers: one per board unit of the battle (its highest threshold); units created in battle (summons,
   * no board uid) count once per unit type (the highest of them) — a result can never announce more units than the
   * lineup has kinds of.
   */
  _charDamageTickers(ps, r) {
    const steps = (Array.isArray(this.gd.config.broadcasts) ? this.gd.config.broadcasts : []).filter((b) => b.type === 'CHAR_DAMAGE' && Array.isArray(b.params)).map((b) => Number(b.params[0])).filter((n) => n > 0).sort((a, b) => b - a);
    if (!steps.length) return;
    const board = new Set();
    for (const p of ps.board.values()) board.add(p.uid);
    const best = new Map();
    for (const u of r.unitStats || []) {
      if (!u) continue;
      const key = Number.isInteger(u.uid) && board.has(u.uid) ? `uid:${u.uid}` : `def:${u.defId}`;
      const cur = best.get(key);
      if (!cur || (Number(u.dmg) || 0) > (Number(cur.dmg) || 0)) best.set(key, u);
    }
    for (const u of best.values()) {
      const hit = steps.find((s) => (u.dmg || 0) >= s);
      if (hit) this.tickerFor('CHAR_DAMAGE', [ps.name, u.name || u.defId, String(hit)], { playerId: ps.playerId, param: String(hit) });
    }
  }

  afterSettle() {
    if (!this.alivePlayers().length) { this.finish({ victory: false, reason: 'eliminated' }); return; }
    this.startRound(this.round + 1);
  }

  finish({ victory, hiddenCleared = false, reason = 'defeat' }) {
    if (this.ended || this.disposed) return;
    this.ended = true;
    if (this.runner) { try { this.runner.stop(); } catch { /* ignore */ } this.runner = null; }
    this._stopClientCombat();
    this.cancel(this._phaseTimer);
    this.cancel(this._turnTimer);
    for (const h of this._timers) { try { this.sched.clearTimeout(h); } catch { /* ignore */ } }
    this._timers.clear();
    this.phase = PHASE.RESULT;
    this.deadline = 0;
    for (const f of this.fields) f.live = false;
    this.outcome = { victory: !!victory, hiddenReached: this.hiddenReached, hiddenCleared: !!hiddenCleared, reason };
    let result;
    try {
      result = buildResult(this, this.outcome);
    } catch (e) {
      this.reportError('buildResult', e);
      result = { t: 'm.result', victory: !!victory, roundsPassed: 0, reason, modeId: this.modeId, difficulty: this.difficulty, players: [] };
    }
    this.lastResultMsg = result;
    this.markPublic();
    try { this.flush(true); } catch (e) { this.reportError('flush', e); }
    // every human still here gets the settlement — the spectator seats the same public rows (none of them their own)
    for (const ps of this._viewers()) this.sendTo(ps.playerId, { ...result, playerId: ps.playerId });
    const { t, ...summary } = result;
    void t;
    summary.errors = this.errorCount;
    try { this.onEndFn(summary); } catch (e) { this.reportError('onEnd', e); }
  }
}
