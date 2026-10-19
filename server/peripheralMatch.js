// 外围适配层：原版Match及其全部机制文件不改；只旁观结果并附加排位回执。
import { Match } from './match/Match.js';
import { PHASE } from '../shared/constants.js';
import { isRankedMatch } from '../shared/ranks.js';
import { observeRankedBattle, rankedObservationOf, validRankedObservation } from '../shared/rankedObservation.js';
import { uniteSurvivors } from './match/unite.js';

export class PeripheralMatch extends Match {
  constructor(opts) {
    super(opts);
    this.ranked = isRankedMatch(opts.ranked, this.difficulty);
    this.rankedStore = opts.rankedStore || null;
    this.rankSeats = new Map((opts.seats || []).map((s) => [s.playerId, s]));
    this.matchId = opts.matchId;
    this.startingParticipantCount = this.order.length;
    this.rankStats = new Map(this.order.map((p) => [p.playerId, { rankedDamage: 0, survivalRounds: 0, rankedPerfectRounds: 0, assists: 0 }]));
    this.rankResults = new Map();
    this.rankNormal = new Map();
    this.rankLeaks = [];
    this.rankSeen = new Set();
    this.rankSettledRounds = new Set();
    this.rankAssistedRounds = new Set();
    this.rankFinalRounds = new Set();
    this.rankReceipt = null;
    const send = this.sendFn, end = this.onEndFn;
    this.sendFn = (id, msg) => send(id, msg?.t === 'm.result' ? this.withRankedResult(msg) : msg);
    this.onEndFn = (summary) => end(this.withRankedResult(summary));
  }

  newBattle(opts) {
    const b = super.newBattle(opts);
    if (this.ranked) observeRankedBattle(b, { leakBudgets: opts.kind === 'unite' ? this.rankLeaks : [] });
    return b;
  }

  _specBattle(spec, opts) {
    const b = super._specBattle(spec, opts);
    if (this.ranked) observeRankedBattle(b, { leakBudgets: spec.kind === 'unite' ? this.rankLeaks : [] });
    if (this.rankVerification) this.rankVerification.battle = b;
    return b;
  }

  _verifyResult(f, result) {
    if (!this.ranked || this.verifyMode !== 'all') return super._verifyResult(f, result);
    const verification = this.rankVerification = { battle: null };
    try {
      const accepted = super._verifyResult(f, result);
      // 原版全量校验可替换结果但仍标记 client；旁观统计必须随实际采用的结果切换。
      if (accepted !== result) f.rankVerified = rankedObservationOf(verification.battle);
      return accepted;
    } finally {
      this.rankVerification = null;
    }
  }

  _startMsg(f, pid, opts) {
    const msg = super._startMsg(f, pid, opts);
    if (this.ranked) msg.rankedObservation = { enabled: true, leakBudgets: f.kind === 'unite' ? this.rankLeaks : [] };
    return msg;
  }

  handle(playerId, msg) {
    if (msg?.t !== 'b.rankedObservation') return super.handle(playerId, msg);
    const ps = this.players.get(playerId), f = this._fieldByBattle(msg.battleId);
    if (!this.ranked || this.ended || this.disposed || !ps || ps.left || ps.isBot || !f || f.done || f.heldResult || f.mode !== 'client' || f.authority !== playerId || !validRankedObservation(msg.observation)) {
      return { error: 'BAD_TARGET' };
    }
    f.rankReported = structuredClone(msg.observation);
    return { ok: true };
  }

  _collectSimErrors(f, res) {
    super._collectSimErrors(f, res);
    this.captureRankedResult(f, res);
  }

  captureRankedResult(f, res) {
    if (!this.ranked || !res || res.synthetic || this.rankSeen.has(f)) return;
    this.rankSeen.add(f);
    const observation = f.resultSource === 'client' ? (f.rankVerified ?? f.rankReported) : rankedObservationOf(f.battle);
    const accepted = new Map();
    for (const pid of f.players) {
      const pp = res.perPlayer?.[pid], observed = observation?.perPlayer?.[pid];
      if (!pp || !observed) continue;
      const damage = Math.min(Math.max(0, Number(observed.rankedDamage) || 0), Math.max(0, Number(pp.damageDealt) || 0));
      const stats = { rankedDamage: damage, leaderLpLoss: Math.max(0, Number(observed.leaderLpLoss) || 0),
        perfect: pp.perfect !== false && !(pp.leaked || []).some((l) => l && l.counted !== false) && !(observed.leaderLpLoss > 0) };
      accepted.set(pid, stats);
      if (f.kind === 'normal' || f.kind === 'unite') this.rankStats.get(pid).rankedDamage += damage;
      if (f.kind === 'normal') this.rankNormal.set(pid, stats);
    }
    this.rankResults.set(res, accepted);
    if (f.kind === 'normal' && observation) this.rankLeaks.push(...observation.leaks);
  }

  _finishCombat(resultOf) {
    if (this.phase === PHASE.COMBAT) { this.rankNormal.clear(); this.rankLeaks = []; }
    return super._finishCombat(resultOf);
  }

  startUnite(plan) {
    if (this.ranked && !this.rankAssistedRounds.has(this.round)) {
      this.rankAssistedRounds.add(this.round);
      for (const h of plan.helpers) if (!h.isBot) this.rankStats.get(h.playerId).assists++;
    }
    return super.startUnite(plan);
  }

  settle(plan, uniteResult) {
    const count = this.ranked && !this.rankSettledRounds.has(this.round);
    const before = this.alivePlayers().map((p) => [p, p.lp]);
    const survivors = plan && uniteResult && !uniteResult.synthetic ? uniteSurvivors(plan, uniteResult) : null;
    const lossOf = (p) => survivors && plan.leakers.includes(p) ? Math.min(this.gd.lpCapPerRound, survivors.get(p.playerId) || 0)
      : Math.min(this.gd.lpCapPerRound, (this.lastResults.get(p.playerId)?.leaked || []).filter((l) => l && l.counted !== false).length);
    const counts = count ? before.map(([p, lp]) => ({ pid: p.playerId, survived: lp - lossOf(p) > 0,
      normal: this.rankNormal.get(p.playerId), unite: this.rankResults.get(uniteResult)?.get(p.playerId), loss: lossOf(p) })) : [];
    if (count) this.rankSettledRounds.add(this.round);
    const out = super.settle(plan, uniteResult);
    for (const x of counts) {
      const s = this.rankStats.get(x.pid);
      if (x.survived && x.normal) s.survivalRounds++;
      if (x.normal?.perfect && (!uniteResult?.perPlayer?.[x.pid] || x.unite?.perfect) && x.loss === 0 && !uniteResult?.synthetic) s.rankedPerfectRounds++;
    }
    return out;
  }

  _finishFinal(hidden, resultOf) {
    if (this.ranked && this.phase === (hidden ? PHASE.HIDDEN_CORE : PHASE.FINAL_ASSAULT) && !this.rankFinalRounds.has(this.round)) {
      this.rankFinalRounds.add(this.round);
      for (const f of this.fields) {
        const res = resultOf(f);
        this.captureRankedResult(f, res);
        const accepted = this.rankResults.get(res);
        for (const pid of f.players) {
          const p = this.players.get(pid), a = accepted?.get(pid), s = this.rankStats.get(pid);
          if (!p || !a || !s) continue;
          // Boss本体只取原版服务端确认的个人血池credit；普通随从仍按初始HP额度计入。
          s.rankedDamage += a.rankedDamage;
          if (p.alive && this.teamLp > 0 && !res.synthetic) s.survivalRounds++;
          if (p.alive && this.teamLp > 0 && (this._finalEnding ? this._finalEnding === 'cleared' : this.bossPool.hp <= 0)
            && a.perfect && !(this.overtimeApplied > 0) && !res.synthetic) s.rankedPerfectRounds++;
        }
      }
    }
    return super._finishFinal(hidden, resultOf);
  }

  withRankedResult(msg) {
    if (!Array.isArray(msg.players)) return msg;
    if (!this.rankReceipt) {
      const result = structuredClone(msg);
      result.startingParticipantCount = this.startingParticipantCount;
      for (const row of result.players) {
        const ps = this.players.get(row.playerId), seat = this.rankSeats.get(row.playerId), extra = this.rankStats.get(row.playerId);
        if (!ps || !extra) continue;
        row.stats = { ...row.stats, ...extra, rankedDamage: extra.rankedDamage + (Number(ps.stats.bossDamage) || 0), rankedStatsVersion: 1 };
        if (this.ranked && this.rankedStore && !ps.isBot && seat?.aid) {
          row.rank = this.rankedStore.settleMatch({ aid: seat.aid, name: seat.name, playerId: seat.playerId, debugAuthorized: false },
            { difficulty: this.difficulty, mode: this.mode, matchId: this.matchId, startingParticipantCount: this.startingParticipantCount,
              teamWin: !!this.outcome?.victory, hiddenCleared: !!this.outcome?.hiddenCleared },
            { alive: ps.alive, eliminatedRound: ps.eliminatedRound, roundsPassed: row.roundsPassed,
              ...row.stats, layers: row.stats.activatedLayers ?? 0 });
        }
      }
      this.rankReceipt = result;
    }
    return { ...msg, startingParticipantCount: this.startingParticipantCount, players: this.rankReceipt.players };
  }
}
