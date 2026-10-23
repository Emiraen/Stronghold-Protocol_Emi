

import { isRankedMatch } from "../../../shared/ranks.js";
import { PHASE, layerGainRoom } from "../../../shared/constants.js";

import { uniteSurvivors, plannedUniteSurvivors } from "../unite.js";
import { isCyclopsBonusRound, cyclopsBonusReward, settleCyclopsHexes, cyclopsHooks } from "../cyclops.js";

import { buildResult } from "../results.js";
import { REWARD_FAILURE_TEXT } from '../rewardRecovery.js';

import { FLOW_TICKER_PRIORITY, DELAYS } from "./common.js";
import { onSettle } from '../botEmotes.js';
const RESULT_WAIT_MS = 3000;
export class MatchSettle {
  settle(plan, uniteResult) {
    if (this._statsSettledRound === this.round) return;
    this._statsSettledRound = this.round;
    this.phase = PHASE.SETTLE;
    this.runner = null;
    this._cancelWorkerTasks();
    this._stopClientCombat();
    // the pending in-battle gains the views showed become persistent below (alive players) or lapse (DESIGN §20.15)
    for (const ps of this.order) if (ps.pendingLayerGains) {
      ps.pendingLayerGains = null;
      try { ps.dirty(); } catch (e) { this.reportError(`settle dirty R${this.round} player ${ps.playerId}`, e); }
    }
    const cap = this.gd.lpCapPerRound;
    // a 联防 battle that could not run at all (synthetic result) must not wipe the leakers' losses: charge their own leaks
    const uniteRan = !!(plan && uniteResult && !uniteResult.synthetic);
    const survivors = uniteRan ? uniteSurvivors(plan, uniteResult)
      : this.isEntertainmentMulti && plan ? plannedUniteSurvivors(plan) : null;
    const uniteWaves = this.isEntertainmentMulti ? [...(plan?.history || []), uniteResult].filter((r) => r && !r.synthetic)
      : uniteResult ? [uniteResult] : [];
    if (this.isEntertainmentMulti && plan) this.uniteResultView = {
      rounds: plan.round, roundsMax: plan.roundsMax, skipped: plan.skipRemaining,
      helpers: [...plan.usedHelpers, ...plan.helpers].map((p) => p.playerId), survivors: Object.fromEntries(survivors || []),
      leakers: plan.leakers.map((p) => p.playerId), losses: {},
      through: plan.leakers.reduce((n, p) => n + (survivors?.get(p.playerId) || 0), 0),
    };
    const alive = this.alivePlayers();
    // 本回合中途退出的玩家也保留已产生的个人有效伤害，不因退出丢失或复制给队友。
    for (const ps of this.order) {
      try {
        const r = this.lastResults.get(ps.playerId);
        if (r && !r.synthetic) ps.stats.rankedDamage += Number(r.rankedDamage) || 0;
        for (const wave of uniteWaves) {
          const up = wave.perPlayer?.[ps.playerId];
          if (up && !wave.synthetic) ps.stats.rankedDamage += Number(up.rankedDamage) || 0;
        }
      } catch (e) { this.reportError(`settle rankedDamage R${this.round} player ${ps.playerId}`, e); }
    }
    for (const ps of alive) {
      // The round-wide once guard stays set even when a player fails after partial mutation. Never repay earlier
      // players or this player's already-applied rewards; isolate at the independent player boundary instead.
      try {
        const r = this.lastResults.get(ps.playerId) || { leaked: [], perfect: true, coins: 0, layerGains: {}, killed: 0, damageDealt: 0 };
        const counted = (r.leaked || []).filter((l) => l && l.counted !== false).length;
        let loss = survivors && plan.leakers.includes(ps) ? Math.min(cap, survivors.get(ps.playerId) || 0) : Math.min(cap, counted);
        if (this.isCyclops && !isCyclopsBonusRound(this.round) && counted > 0 && loss > 0 && ps.cyclopsStreak < 0 && cyclopsHooks(ps, 'cyc_streak').some(e => e.data.quality === 'prismatic')) loss = Math.max(1, loss - 2);
        if (this.isEntertainmentMulti && this.uniteResultView) this.uniteResultView.losses[ps.playerId] = loss;
        ps.lp -= loss;
        ps.stats.lpLost += loss;
        ps.stats.leaks += counted;
        ps.stats.kills += Number(r.killed) || 0;
        ps.stats.dmgDealt += Number(r.damageDealt) || 0;
        ps.stats.healing += Number(r.healingDone) || 0;
        if (r.perfect !== false && counted === 0) ps.stats.perfectRounds++;
        // bounty coins (own battle + unite kills) are credited to the next prep
        let coins = Math.max(0, Math.trunc(Number(r.coins) || 0));
        const ups = uniteWaves.map((wave) => wave.perPlayer?.[ps.playerId]).filter(Boolean);
        const up = ups[0];
        for (const part of ups) {
          coins += Math.max(0, Math.trunc(Number(part.coins) || 0));
          ps.stats.dmgDealt += Number(part.damageDealt) || 0;
          ps.stats.kills += Number(part.killed) || 0;
          if (this.isEntertainmentMulti) ps.stats.healing += Number(part.healingDone) || 0;
        }
        // 一回合只记一次，联防不是新回合；没真正运行的占位结果不能凭空得到完美分。
        if (ps.lp > 0 && this.lastResults.has(ps.playerId) && !r.synthetic) ps.stats.survivalRounds++;
        const noLeak = (x) => x && x.perfect !== false && !(x.leaked || []).some((l) => l && l.counted !== false)
          && !(Number(x.leaderLpLoss) > 0);
        if (r.rankedStatsValid && noLeak(r) && (!up || (up.rankedStatsValid && noLeak(up))) && loss === 0
          && !r.synthetic && !uniteResult?.synthetic) ps.stats.rankedPerfectRounds++;
        // 舟铲铲基础连胜/连败：奖励关保留原战绩，不推进、不打断，也不另发基础连胜连败金币。
        const previousCyclopsStreak = ps.cyclopsStreak;
        if (this.isCyclops && !isCyclopsBonusRound(this.round) && this.lastResults.has(ps.playerId) && !r.synthetic) {
          const won = noLeak(r);
          const previous = ps.cyclopsStreak;
          ps.cyclopsStreak = won ? Math.max(0, previous) + 1 : Math.min(0, previous) - 1;
          const streak = Math.abs(ps.cyclopsStreak);
          const bonus = streak >= 6 ? 3 : streak >= 4 ? 2 : streak >= 2 ? 1 : 0;
          coins += bonus;
          if (bonus) this.toast(ps, 'ok', `${won ? '连胜' : '连败'}${streak}回合：下次备战额外获得${bonus}金币`);
        }
        // perfect-payout bounties (战术特训): own phase perfect
        for (const b of ps.bounties) if (b.card.payout === 'perfect' && counted === 0 && r.perfect !== false) coins += b.card.coin;
        // 独眼巨人冲锋奖励关（4/8/12/16，无联防）：按击杀数分级赠装
        //   击杀 <5：无奖励；5~9：1 件；10 只全灭（不漏）：2 件。装备品阶 2/3/4/5。
        if (this.isCyclops && isCyclopsBonusRound(this.round)) {
          const total = Math.max(0, Math.trunc(Number(r.total) || 0));
          const killed = Math.max(0, Math.trunc(Number(r.killed) || 0));
          let gifts = 0;
          if (killed >= total && total > 0) gifts = 2;           // 全部打死
          else if (killed >= 5) gifts = 1;                       // 打死 5-9 只
          for (let i = 0; i < gifts; i++) {
            const itemId = cyclopsBonusReward(this.gd, this.rngMeta, this.itemPool, this.round);
            if (!itemId) break;
            const piece = ps.acquireItem(itemId, { source: 'cyclops', deferMerge: true });
            if (piece) this.toast(ps, 'ok', `奖励关战利品（击杀 ${killed}/${total}）：获得「${this.gd.item(itemId)?.name || itemId}」`);
          }
          if (!gifts && killed > 0) this.toast(ps, 'warn', `奖励关击杀不足（${killed}/10），未获得赠礼`);
        }
        if (coins > 0) { ps.pendingFunds += coins; ps.stats.fundsGained += coins; }
        for (const b of ps.bounties) b.roundsLeft--;
        ps.bounties = ps.bounties.filter((b) => b.roundsLeft > 0);
        // IN_BATTLE layer gains (normal battles only), at most the room left under BOND_LAYER_CAP (999, as the battle's
        // live copy: Battle.addLayers); a bond at the cap gains nothing and dispatches nothing
        for (const [bondId, n] of Object.entries(r.layerGains || {})) {
          if (!this.gd.bond(bondId) || !(n > 0)) continue;
          const before = ps.layers[bondId] || 0;
          const add = layerGainRoom(before, Math.floor(n), this.isEndless ? Infinity : undefined);
          if (!(add > 0)) continue;
          ps.layers[bondId] = before + add;
          this.dispatch(ps, 'onLayers', { bondId, from: before, to: ps.layers[bondId], reason: 'battle' });
        }
        if (this.isCyclops && this.lastResults.has(ps.playerId)) settleCyclopsHexes(this, ps, r, noLeak(r), previousCyclopsStreak);
        try { this._charDamageTickers(ps, r); }
        catch (e) { this.reportError(`settle ticker R${this.round} player ${ps.playerId}`, e); }
        this.dispatch(ps, 'onBattleResult', { result: r, lpLoss: loss, perfect: counted === 0 && r.perfect !== false, unite: uniteResult || null, ...(this.isEntertainmentMulti ? { uniteResults: uniteWaves } : {}) });
        ps.recompute();
      } catch (e) { this.reportError(`settle R${this.round} player ${ps.playerId}`, e); }
    }
    let eliminationFailed = false;
    for (const ps of alive) {
      if (ps.lp <= 0) {
        try {
          ps.lp = 0;
          ps.eliminate(this.round);
        } catch (e) {
          // If eliminate itself failed, its pool/inventory cleanup may be partial. Healthy players still finish,
          // but do not launch another round from an invalid elimination state or retry already-paid settlement.
          eliminationFailed = true;
          this.reportError(`settle eliminate R${this.round} player ${ps.playerId}`, e);
          continue;
        }
        try {
          this.toast(ps, 'error', '你的目标生命值耗尽，已被淘汰');
          this.tickerText(`${ps.name}博士的目标生命值已耗尽`, FLOW_TICKER_PRIORITY);
        } catch (e) { this.reportError(`settle eliminate notice R${this.round} player ${ps.playerId}`, e); }
      }
    }
    this.fields = [];
    this.watchers.clear();
    this.markPublic();
    try { onSettle(this); } catch (e) { this.reportError(`settle emotes R${this.round}`, e); }
    if (eliminationFailed) {
      // A partial inventory/pool cleanup cannot safely start another round, but must not leave SETTLE locked.
      this._settlementAbort = { playerId: null, stage: 'eliminate', code: 'RESULT_ELIMINATION_FAILED' };
      this.finish({ victory: false, reason: 'settlement_error' });
      return;
    }
    this.setDeadline(DELAYS.SETTLE / 1000, () => this.afterSettle(), { silent: this.soloUntimed });
  }

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
    // hiddenReached 仅在普通Boss通关后记录；附加战斗失败不覆盖通关，提前退出规则不变。
    if (this.hiddenReached && reason === 'defeat') { victory = true; reason = 'victory'; }
    this.ended = true;
    if (this.runner) { try { this.runner.stop(); } catch { /* ignore */ } this.runner = null; }
    this._stopClientCombat();
    this.cancel(this._phaseTimer);
    this.cancel(this._turnTimer);
    for (const h of this._timers) { try { this.sched.clearTimeout(h); } catch { /* ignore */ } }
    this._timers.clear();
    this.watchers.clear();
    this.observers.clear();
    this.phase = PHASE.RESULT;
    this.deadline = 0;
    for (const f of this.fields) f.live = false;
    this.outcome = { victory: !!victory, hiddenReached: this.hiddenReached, hiddenCleared: !!hiddenCleared, reason };
    let result;
    try {
      result = buildResult(this, this.outcome);
    } catch (e) {
      this.reportError('buildResult', e);
      result = { t: 'm.result', victory: !!victory, reason, modeId: this.modeId, difficulty: this.difficulty, players: [],
        incomplete: true, settlementErrors: [{ playerId: null, stage: 'buildResult', code: 'RESULT_BUILD_UNAVAILABLE' }] };
    }
    result.matchId = this.matchId;
    if (this._settlementAbort) {
      result.incomplete = true;
      result.settlementErrors = [...(result.settlementErrors || []), this._settlementAbort];
    }
    result.mode = this.mode;
    result.variant = this.variant;
    result.startingParticipantCount = this.startingParticipantCount;
    let job;
    try { job = this._resultJob(result); } catch (error) {
      this.reportError('result job', error);
      result.incomplete = true;
      result.settlementErrors = [{ playerId: null, stage: 'job', code: 'RESULT_STATS_UNAVAILABLE' }];
    }
    // Publish a clearly pending preview, never pretend the economic receipt has already arrived.
    this.finishPromise = this._persistResult(result, job);
    return this.finishPromise;
  }

  _resultJob(result) {
    // No partial/stub row may become an apparently valid zero-valued entry.
    if (result.incomplete || result.settlementErrors?.length) return null;
    const invalidRows = [...this.players.values()].filter((ps) => !ps.isBot && ps.aid).flatMap((ps) => {
      const row = result.players?.find((p) => p.playerId === ps.playerId);
      if (!row || row.settlementError || !row.stats
        || ['survivalRounds', 'rankedDamage', 'bossDamage', 'rankedPerfectRounds', 'activatedLayers'].some((key) => !Number.isFinite(row.stats[key]))
        || !Number.isFinite(row.roundsPassed)) {
        return [{ playerId: ps.playerId, stage: 'job', code: 'RESULT_STATS_UNAVAILABLE' }];
      }
      return [];
    });
    if (invalidRows.length) {
      result.incomplete = true;
      result.settlementErrors = invalidRows;
      return null;
    }
    const ranked = isRankedMatch(this.ranked, this.difficulty);
    const entries = [...this.players.values()].filter((ps) => !ps.isBot && ps.aid)
      .sort((a, b) => a.seat - b.seat || a.playerId.localeCompare(b.playerId))
      .flatMap((ps) => {
        const row = result.players.find((p) => p.playerId === ps.playerId);
        if (!row) return [];
        return [{ who: { aid: ps.aid, name: ps.name, playerId: ps.playerId, debugAuthorized: ps.devOps === true },
          row: { alive: !!ps.alive, eliminatedRound: ps.eliminatedRound ?? null,
            roundsPassed: row.roundsPassed, survivalRounds: row.stats?.survivalRounds,
            rankedDamage: row.stats?.rankedDamage, bossDamage: row.stats?.bossDamage,
            rankedPerfectRounds: row.stats?.rankedPerfectRounds, layers: row.stats?.activatedLayers ?? 0,
            assists: row.stats?.assists ?? 0 } }];
      });
    return { ranked, at: this.sched.now(), seats: this.archiveSeats,
      match: { matchId: this.matchId, difficulty: this.difficulty, mode: this.isSolo ? 'solo' : this.mode,
        startingParticipantCount: this.startingParticipantCount, teamWin: !!this.outcome?.victory,
        hiddenCleared: !!this.outcome?.hiddenCleared }, entries, result: structuredClone(result) };
  }

  _publishResult(result, diagnostic = null) {
    this.lastResultMsg = result;
    try { this.markPublic(); this.flush(true); } catch (e) { this.reportError('result flush', e); }
    for (const ps of this.humans()) {
      try { this.sendTo(ps.playerId, { ...result, playerId: ps.playerId }); }
      catch (e) { this.reportError(`result send player ${ps.playerId}`, e); }
      if (diagnostic) try {
        this.sendTo(ps.playerId, { t: 'm.toast', kind: 'error', text: REWARD_FAILURE_TEXT,
          diagnostic: { source: 'result', hook: 'settlement', code: diagnostic, matchId: this.matchId } });
      } catch (e) { this.reportError(`result notice player ${ps.playerId}`, e); }
    }
  }

  _endResult(result) {
    if (this._resultEndNotified) return;
    this._resultEndNotified = true;
    const { t, ...summary } = result;
    summary.errors = this.errorCount;
    try {
      // Room teardown has its own error boundary; a history writer must not retain this ended match.
      Promise.resolve(this.onEndFn(summary)).catch((e) => this.reportError('onEnd', e));
    } catch (e) { this.reportError('onEnd', e); }
  }

  async _persistResult(result, job) {
    if (result.incomplete || result.settlementErrors?.length || !job) {
      // Keep the full local evidence for deliberate repair. The completion
      // interface is atomic for the roster: it cannot safely submit a subset.
      // Do not auto-replay an economic request whose external receipt is unknown.
      this.pendingResultJob = { result, job, outcome: this.outcome, blocked: 'RESULT_INCOMPLETE' };
      this.reportError('settlement incomplete', new Error('result statistics unavailable; no economic request submitted'));
      this._publishResult(result, 'RESULT_INCOMPLETE');
      this._endResult(result);
      return;
    }
    const preview = { ...result, settlementPending: true };
    this._publishResult(preview);
    let timer;
    const timeout = new Promise((resolve) => { timer = this.sched.setTimeout(() => resolve({ pending: true }), RESULT_WAIT_MS); });
    const commit = Promise.resolve().then(async () => {
      if (this.completeMatch) {
        const saved = await this.completeMatch(job);
        if (!saved?.result || !Array.isArray(saved.result.players)) throw new Error('invalid settlement receipt');
        result = { ...saved.result, matchId: this.matchId };
        this.historyPersisted = true;
      } else {
        await this._settleRanked(result);
        await this.rankedStore?.flush?.();
      }
      return { result };
    }).catch((error) => {
      // A rejected call is not proof that nothing was committed. No existing
      // completion receipt API can prove an authoritative pre-commit failure.
      // Preserve the request, but never replay partial ranked rewards here.
      this.reportError('settlement', error);
      this.pendingResultJob = { result, job, outcome: this.outcome, blocked: 'RESULT_SETTLEMENT_FAILED', receipt: 'unknown' };
      const failed = { ...result, incomplete: true,
        settlementErrors: [{ playerId: null, stage: 'persist', code: 'RESULT_SETTLEMENT_FAILED' }] };
      return { result: failed, diagnostic: 'RESULT_SETTLEMENT_FAILED' };
    });
    const receipt = await Promise.race([commit, timeout]);
    if (receipt.pending) {
      this.pendingResultJob = { result, job, outcome: this.outcome, blocked: 'RESULT_SETTLEMENT_PENDING', receipt: 'unknown' };
      this._endResult(preview);
      // The original request remains attached and is NEVER resubmitted. Only the matching archived result may update.
      void commit.then((late) => {
        if (!late.diagnostic) this.pendingResultJob = undefined;
        this.lastResultMsg = late.result;
        try { this.opts.onResultUpdate?.(late.result); } catch (e) { this.reportError('late result', e); }
      });
      return;
    }
    this.sched.clearTimeout(timer);
    this._publishResult(receipt.result, receipt.diagnostic);
    this._endResult(receipt.result);
  }

  async _settleRanked(result) {
    if (!isRankedMatch(this.ranked, this.difficulty) || !this.rankedStore) return;
    const humans = [...this.players.values()].filter((ps) => !ps.isBot)
      .sort((a, b) => a.seat - b.seat || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
    const ctx = {
      matchId: this.matchId,
      difficulty: this.difficulty,
      mode: this.isSolo ? 'solo' : this.mode,
      startingParticipantCount: this.startingParticipantCount,
      teamWin: !!this.outcome?.victory,
      hiddenCleared: !!this.outcome?.hiddenCleared,
    };
    for (const ps of humans) {
      const row = result.players.find((p) => p.playerId === ps.playerId);
      if (!row || row.rank || !ps.aid || !this.rankedStore) continue;
      const info = await this.rankedStore.settleMatch(
        { aid: ps.aid, name: ps.name, playerId: ps.playerId, debugAuthorized: ps.devOps === true },
        ctx,
        {
          alive: !!ps.alive,
          eliminatedRound: ps.eliminatedRound ?? null,
          roundsPassed: row.roundsPassed,
          survivalRounds: row.stats?.survivalRounds,
          rankedDamage: row.stats?.rankedDamage,
          bossDamage: row.stats?.bossDamage,
          rankedPerfectRounds: row.stats?.rankedPerfectRounds,
          layers: row.stats?.activatedLayers ?? 0,
          assists: row.stats?.assists ?? 0,
        },
      );
      row.rank = info;
    }
    await this.rankedStore.flush?.();
    // 所有同档案成员看到的是累计后的最终档案，不是各自结算时的中间快照。
    for (const ps of humans) if (ps.aid) {
      try { this.sendTo(ps.playerId, { t: 'rank.me', ...this.rankedStore.summary(ps.aid, ps.name, ps.devOps === true) }); } catch { /* ignore */ }
    }
  }
}
