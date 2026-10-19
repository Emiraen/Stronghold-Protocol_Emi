

import { PHASE } from "../../../shared/constants.js";

import { botPrepBeginSteps, botPrepEndSteps } from "../bot.js";
import { DELAYS } from "./common.js";
export class MatchPrep {
  enterPrep() {
    this.phase = PHASE.PREP;
    this.sp = null;
    const alive = this.alivePlayers();
    for (const ps of alive) {
      ps.ready = false;
      // Items gained as the previous prep ended waited unmerged (acquireItem deferMerge). Merge them now, before
      // this prep's onPrepStart grants and before the player acts — not in endPrep, which runs in the same prep
      // that granted them and would take an equipped copy off for the fight about to start.
      ps.checkItemMerges();
      ps.recompute();
      this.dispatch(ps, 'onPrepStart', { round: this.round });
      ps.recompute();
    }
    // solo / single-human matches: untimed (soloUntimed); co-op: the round's prepTime
    const secs = this.soloUntimed ? null : this.gd.prepTime(this.round);
    this.setDeadline(secs, () => this.prepDeadline());
    let i = 0;
    for (const ps of alive) if (ps.botControlled) this.scheduleBotPrep(ps, i++);
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
        if (this.workerPool && job.workerPayload) {
          const task = this._submitWorker('rehearsal', job.workerPayload, {
            valid: () => valid() && ps._botWorker === task,
            complete: ({ bestIndex }) => {
              ps._botWorker = null;
              job.best = job.plans[bestIndex] || job.plans[0];
              job.done = true;
              this.later(0, () => { if (valid()) end(job); });
            },
            failed: () => { ps._botWorker = null; this.later(0, slice); },
          });
          ps._botWorker = task;
          return;
        }
        // bounded slices start in a callback of their own (the economy + default layout above already used this one)
        if (bounded) this.later(0, slice);
        else slice();
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
    for (const ps of this.alivePlayers()) {
      if (ps.ready) continue;
      this.autoPickPersonalChoice(ps, 'random');
      ps.resolveTemp();
      ps.ready = true;
      ps.dirty();
    }
    this.endPrep();
  }

  endPrep() {
    if (this.phase !== PHASE.PREP) return;
    for (const ps of this.order) { ps._botWorker?.cancel(); ps._botWorker = null; }
    // Capture before end-of-prep effects so a replay never grants them twice.
    try { this.opts.onCheckpoint?.(this); } catch (e) { this.reportError('checkpoint', e); }
    this.setDeadline(0);
    const alive = this.alivePlayers();
    for (const ps of alive) this.dispatch(ps, 'onPrepEnd', { round: this.round });
    for (const ps of alive) ps.endPrep();
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
