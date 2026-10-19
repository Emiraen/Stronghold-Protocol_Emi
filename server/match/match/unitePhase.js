

import { PHASE, GEO, ERR } from "../../../shared/constants.js";

import { deriveSeed } from "../../sim/rng.js";

import { uniteBattleOpts, uniteSurvivors, plannedUniteSurvivors, nextUnitePlan, uniteReserveHelpers } from "../unite.js";

import { FieldRunner, timelineAt, uniteBillBounds } from "../fields.js";
import { uniteLeft } from "../../sim/spec.js";

import { FLOW_TICKER_PRIORITY, DELAYS, OK, fail } from "./common.js";
import { onStartUnite } from '../botEmotes.js';
export class MatchUnite {
  uniteSkipVoteView() {
    const plan = this.unitePlan;
    if (!this.isEntertainmentMulti || this.phase !== PHASE.UNITE || !plan || plan.round >= plan.roundsMax || !uniteReserveHelpers(plan).length) return null;
    const eligible = this.humans().filter((ps) => ps.connected && !ps.autoplay).map((ps) => ps.playerId);
    return { id: `unite:${this.battlePrefix}:${this.round}:${plan.round}`, eligible,
      voters: eligible.filter((pid) => plan.skipVotes.has(pid)), needed: Math.floor(eligible.length / 2) + 1,
      passed: plan.skipRemaining, open: !!this.fields[0]?.live };
  }

  refreshUniteSkipVote() {
    const vote = this.uniteSkipVoteView();
    if (!vote) return;
    this.unitePlan.skipVotes = new Set(vote.voters);
    if (!vote.passed && vote.open && vote.eligible.length && vote.voters.length >= vote.needed) {
      this.unitePlan.skipRemaining = true;
      this.tickerText('投票通过：本轮结束后跳过后续全部联防，按剩余漏怪结算', FLOW_TICKER_PRIORITY);
    }
    this.markPublic();
  }

  voteSkipUnite(ps, { voteId } = {}) {
    const vote = this.uniteSkipVoteView();
    if (!vote || !vote.open || (voteId != null && voteId !== vote.id)) return fail(ERR.WRONG_PHASE);
    if (!vote.eligible.includes(ps.playerId)) return fail(ERR.BAD_TARGET);
    if (vote.passed || this.unitePlan.skipVotes.has(ps.playerId)) return OK;
    this.unitePlan.skipVotes.add(ps.playerId);
    this.refreshUniteSkipVote();
    return OK;
  }

  _afterUniteWave(plan, result) {
    if (this.phase !== PHASE.UNITE || this.unitePlan !== plan) return;
    const next = this.isEntertainmentMulti ? nextUnitePlan(plan, result) : null;
    if (next) this.startUnite(next);
    else this.settle(plan, result);
  }

  startUnite(plan) {
    onStartUnite(this, plan);
    // 成功协助（排位赛计分维度之一）：每担任一次联防协防者记一次
    for (const h of plan.helpers) if (h && !h.isBot) h.stats.assists = (h.stats.assists || 0) + 1;
    if (this.clientCombat) { this._startUniteClient(plan); return; }
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.wave ? this.wave.timeLimit : 60;
    const battle = this.newBattle(this._uniteOpts(plan, limit));
    this.fields = [{ fieldId: 'u', kind: 'unite', players: plan.helpers.map((p) => p.playerId), battle, live: true }];
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.tickerText(`联防阶段：${plan.helpers.map((p) => p.name).join('、')} 迎战突破防线的敌人`, FLOW_TICKER_PRIORITY);
    this._uniteLeftKey = null;
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE) return;
        const res = runner.resultOf(this.fields[0]);
        this._collectSimErrors(this.fields[0], res);
        this.fields[0].live = false;
        this.deadline = 0;
        this.markPublic();
        this.later(this.scaled(DELAYS.COMBAT_END), () => this._afterUniteWave(plan, res));
      },
    });
    this.runner.start();
  }

  _uniteOpts(plan, limit) {
    const { wave, players } = uniteBattleOpts(this, plan, limit);
    return {
      seed: deriveSeed(this.seed, plan.round > 1 ? `u:${this.round}:${plan.round}` : `u:${this.round}`),
      kind: 'unite',
      modeId: this.modeId,
      round: this.round,
      stageId: this.stageId,
      rect: { ...GEO.UNITE_RECT },
      timeLimit: limit,
      players,
      spawns: this._sanitizeSpawns(wave.spawns),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: false, uncappedNumericValues: this.isEndless, ...this.gd.dp },
      fieldId: 'u',
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
    };
  }

  _uniteLeft(ps) {
    const plan = this.unitePlan;
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    const f = this.fields.find((x) => x && x.kind === 'unite') || null;
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      if (this.isEntertainmentMulti) return plannedUniteSurvivors(plan).get(pid) || 0;
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(plan, res).get(pid) || 0;
    const sent = plan.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[3] && typeof sample[3] === 'object' ? sample[3] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) this._uniteBounds = { plan, bounds: uniteBillBounds(plan.leaked, this.gd) };
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    return standing + (plan.notReentered.get(pid) || 0);
  }

  _uniteTick(runner) {
    const f = runner && runner.fields ? runner.fields[0] : null;
    if (!f || !f.battle || runner.ticks % 30 !== 0) return;
    let key = '';
    try { key = JSON.stringify(uniteLeft(f.battle)); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }

  _startUniteClient(plan) {
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.wave ? this.wave.timeLimit : 60;
    const f = this._ccField({ fieldId: 'u', kind: 'unite', players: plan.helpers.map((p) => p.playerId), opts: this._uniteOpts(plan, limit) });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    this._launch([f]);
    // helpers and everyone else (as observers, spectator seats included) simulate the same 联防 spec locally
    for (const ps of this.humans()) {
      this.watchers.set(ps.playerId, 'u');
      this._sendStart(ps.playerId, f, { watch: !f.players.includes(ps.playerId) });
    }
    this.markPublic();
    this.tickerText(`联防阶段：${plan.helpers.map((p) => p.name).join('、')} 迎战突破防线的敌人`, FLOW_TICKER_PRIORITY);
  }

  _finishUniteClient() {
    if (this.phase !== PHASE.UNITE) return;
    const f = this.fields[0];
    const res = f.result;
    this._collectSimErrors(f, res);
    this._stopClientCombat();
    f.live = false;
    this.deadline = 0;
    this.markPublic();
    const plan = this.unitePlan;
    this.later(this.scaled(DELAYS.COMBAT_END), () => this._afterUniteWave(plan, res));
  }
}
