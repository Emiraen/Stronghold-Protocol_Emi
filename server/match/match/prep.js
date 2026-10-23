

import { PHASE } from "../../../shared/constants.js";

import { botPrepBeginSteps, botPrepEndSteps } from "../bot.js";
import { DELAYS } from "./common.js";
import { queueLocalSimulation } from "../localSimulationQueue.js";
export class MatchPrep {
  enterPrep() {
    this.phase = PHASE.PREP;
    this.sp = null;
    const alive = this.alivePlayers();
    const prepared = [];
    for (const ps of alive) {
      try {
        ps.ready = false;
        // Items gained as the previous prep ended waited unmerged (acquireItem deferMerge). Merge them now, before
        // this prep's onPrepStart grants and before the player acts — not in endPrep, which runs in the same prep
        // that granted them and would take an equipped copy off for the fight about to start.
        ps.checkItemMerges();
        ps.recompute();
        this.dispatch(ps, 'onPrepStart', { round: this.round });
        ps.recompute();
        prepared.push(ps);
      } catch (e) { this.reportError(`enterPrep R${this.round} player ${ps.playerId}`, e); }
    }
    // solo / single-human matches: untimed (soloUntimed); co-op: the round's prepTime
    const secs = this.soloUntimed ? null : this.gd.prepTime(this.round);
    this.setDeadline(secs, () => this.prepDeadline());
    let i = 0;
    for (const ps of prepared) if (ps.botControlled) {
      try { this.scheduleBotPrep(ps, i++); }
      catch (e) { this.reportError(`scheduleBotPrep R${this.round} player ${ps.playerId}`, e); }
    }
    this.markPublic();
    this.maybeEndPrep();
  }

  scheduleBotPrep(ps, i = 0) {
    ps._botWorker?.cancel();
    ps._botWorker = null;
    const round = this.round;
    const token = (ps._botPrepToken = (ps._botPrepToken || 0) + 1);
    const valid = () => !this.disposed && !this.ended && this.phase === PHASE.PREP && this.round === round && ps.alive && !ps.ready && ps.botControlled && ps._botPrepToken === token;
    const bounded = Number.isFinite(this.botSliceMs);
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    /** Step a generator until done or the slice budget is used; `then(value)` once it is done (null on an error). */
    const drive = (gen, label, then) => {
      const t0 = now();
      let r = null;
      try {
        do r = gen.next(); while (!r.done && !(bounded && now() - t0 >= this.botSliceMs));
      } catch (e) {
        this.reportError(`bot ${ps.playerId}${label}`, e);
        then(null);
        return;
      }
      if (r.done) { then(r.value); return; }
      this.later(0, () => { if (valid()) drive(gen, label, then); });
    };
    const ready = () => {
      if (!ps.ready) {
          this.autoPickPersonalChoice(ps, 'random');
          ps.resolveTemp();
          ps.setReady(true);
        }
      };
      const end = (job) => {
        let gen = null;
        try { gen = botPrepEndSteps(this, ps, job); } catch (e) { this.reportError(`bot ${ps.playerId}`, e); }
        if (!gen) { ready(); return; }
        drive(gen, '', ready);
      };
      this.later(this.scaled(DELAYS.BOT_ACTION + i * DELAYS.BOT_STAGGER), () => {
        if (!valid()) return;
        drive(botPrepBeginSteps(this, ps), '', (job) => {
          if (!job) { end(null); return; }
          const slice = () => {
            if (!valid()) return;
            let done = true;
            try { done = job.run(this.botSliceMs); } catch (e) { this.reportError(`bot ${ps.playerId} rehearsal`, e); }
            if (done) { if (bounded) this.later(0, () => { if (valid()) end(job); }); else end(job); }
            else this.later(0, slice);
          };
          const local = () => {
            if (!bounded || this.sched.virtual) { if (bounded) this.later(0, slice); else slice(); return; }
            ps._botWorker = queueLocalSimulation(this, (budgetMs) => {
              let done = true;
              try { done = job.run(Math.min(budgetMs, this.botSliceMs)); }
              catch (e) { this.reportError(`bot ${ps.playerId} rehearsal`, e); }
              if (done) { ps._botWorker = null; this.later(0, () => { if (valid()) end(job); }); }
              return done;
            }, { valid });
          };
          if (this.workerPool && job.workerPayload) {
            const submit = () => {
              if (!valid()) return;
              const task = this._submitWorker('rehearsal', job.workerPayload, {
                valid: () => valid() && ps._botWorker === task,
                complete: ({ bestIndex }) => {
                  ps._botWorker = null;
                  job.best = job.plans[bestIndex] || job.plans[0];
                  job.done = true;
                  this.later(0, () => { if (valid()) end(job); });
                },
                failed: (error) => {
                  ps._botWorker = null;
                  // Optional previews wait for capacity rather than turning overload into main-thread CPU work.
                  if (['REHEARSAL_BUSY', 'POOL_FULL'].includes(error.code)) {
                    this.later(500 + Math.max(0, ps.seat || 0) * 75, submit);
                  } else if (error.code === 'POOL_CLOSED') end(null);
                  else local();
                },
              });
              ps._botWorker = task;
            };
            submit();
            return;
          }
          // bounded slices start in a callback of their own (the economy + default layout above already used this one)
          local();
        });
      });
    }

    onReadyChanged(ps) {
      if (ps.ready) { ps._botWorker?.cancel(); ps._botWorker = null; }
      this.markPublic();
      void ps;
      this.maybeEndPrep();
    }

    maybeEndPrep() {
      if (this.phase !== PHASE.PREP || this._prepEndQueued) return;
      const allReady = () => { const alive = this.alivePlayers(); return alive.length > 0 && alive.every((p) => p.ready); };
      if (!allReady()) return;
      const round = this.round;
      this._prepEndQueued = true;
      // the prep deadline stays armed until the phase really ends: a player may un-ready before this runs
      this.later(0, () => {
        this._prepEndQueued = false;
        if (this.phase === PHASE.PREP && this.round === round && allReady()) this.endPrep();
      });
    }

    prepDeadline() {
      if (this.phase !== PHASE.PREP) return;
      let failed = false;
      for (const ps of this.alivePlayers()) {
        if (ps.ready) continue;
        try {
        this.autoPickPersonalChoice(ps, 'random');
        ps.resolveTemp();
        ps.ready = true;
        ps.dirty();
      } catch (e) { failed = true; this.reportError(`prepDeadline R${this.round} player ${ps.playerId}`, e); }
    }
    // Do not field unresolved inventories. Other players were prepared, but combat depends on every deadline step.
    if (failed) return;
    this.endPrep();
  }

  endPrep() {
    if (this.phase !== PHASE.PREP) return;
    // onPrepEnd may already have paid rewards before a later player failed; never replay the batch.
    if (this._prepEndAttemptedRound === this.round) return;
    for (const ps of this.order) {
      try { ps._botWorker?.cancel(); }
      catch (e) { this.reportError(`cancelBotPrep R${this.round} player ${ps.playerId}`, e); }
      finally { ps._botWorker = null; }
    }
    // Capture before end-of-prep effects so a replay never grants them twice.
    try { this.opts.onCheckpoint?.(this); } catch (e) { this.reportError('checkpoint', e); }
    this._prepEndAttemptedRound = this.round;
    this.setDeadline(0);
    const alive = this.alivePlayers();
    const prepared = [];
    let failed = false;
    for (const ps of alive) {
      try { this.dispatch(ps, 'onPrepEnd', { round: this.round }); prepared.push(ps); }
      catch (e) { failed = true; this.reportError(`onPrepEnd R${this.round} player ${ps.playerId}`, e); }
    }
    for (const ps of prepared) {
      try { ps.endPrep(); }
      catch (e) { failed = true; this.reportError(`endPrep R${this.round} player ${ps.playerId}`, e); }
    }
    // Ending a prep changes inventory/funds. A partially completed player cannot safely be fielded or re-applied.
    if (failed) return;
    const r = this.round;
    // 独眼巨人冲锋：R21 为最终攻势 boss 战；其余回合（含奖励关）直接开战，无隐藏核心
    if (this.isCyclops) {
      if (this.isBossRound(r)) {
        this.hiddenLayerSum = alive.reduce((s, p) => s + p.activatedLayers(), 0);
        this.startFinalAssault(false);
      } else {
        this.startCombat();
      }
      return;
    }
    if (this.isBossRound(r)) {
      this.hiddenLayerSum = alive.reduce((s, p) => s + p.activatedLayers(), 0);
      this.startFinalAssault(false);
    } else if (r === this.gd.hiddenRound) {
      this.startFinalAssault(true);
    } else {
      this.startCombat();
    }
  }
}
