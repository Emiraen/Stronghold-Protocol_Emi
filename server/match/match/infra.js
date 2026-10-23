

import { buildDeployMap } from "../board.js";

export class MatchInfra {
  guard(fn) {
    if (this.disposed) return;
    try { fn(); } catch (e) { this.reportError('guard', e); }
    try { this.flush(); } catch (e) { this.reportError('flush', e); }
  }

  reportError(label, e) {
    this.errorCount++;
    const msg = `${label}: ${e && e.message ? e.message : e}`;
    if (this.errors.length < 50) this.errors.push({ label, message: String(e && e.message ? e.message : e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : null });
    try {
      this.log.error?.(`[match ${this.roomCode}] ${msg}`, e && e.stack ? String(e.stack).split('\n').slice(1, 4).join(' | ') : '');
    } catch { /* The error remains in memory; never let a logger failure break player isolation. */ }
  }

  // Results can arrive after their field, prep or match has ended. Ownership is checked on every callback.
  _submitWorker(type, payload, { valid, complete, failed, progress, priority = 0 }) {
    let inner = null, cancelled = false, settled = false;
    const release = () => { settled = true; payload = null; this._workerTasks.delete(handle); inner = null; };
    const live = () => !cancelled && !this.disposed && !this.ended && !this.sched.suspended && valid();
    const handle = { type, cancel: () => {
      if (settled) return;
      cancelled = true;
      this.workerStats.cancelled++;
      inner?.cancel();
      release();
    } };
    this._workerTasks.add(handle);
    this.workerStats.submitted++;
    // Defer even a synchronous submit failure until the caller has attached its ownership handle.
    Promise.resolve().then(() => {
      if (cancelled || this.disposed || this.ended || this.sched.suspended) return;
      inner = this.workerPool.submit(type, payload, { priority,
        onProgress: progress ? (out) => { if (live()) this.guard(() => progress(out)); } : null });
      payload = null;
      return inner.promise;
    }).then((out) => {
      const active = live();
      release();
      if (!active) return;
      this.workerStats.completed++;
      this.guard(() => complete(out));
    }, (err) => {
      const active = live();
      release();
      if (!active || err.code === 'TASK_CANCELLED') return;
      const rejected = ['POOL_CLOSED', 'POOL_FULL', 'REHEARSAL_BUSY'].includes(err.code);
      this.workerStats[rejected ? 'rejected' : 'failed']++;
      if (this.sched.now() - this._workerAuditAt >= 10000) {
        this._workerAuditAt = this.sched.now();
        this.log.warn?.('[match ' + this.roomCode + '] worker ' + type + ': ' + err.message + '; using bounded local slices');
      }
      this.guard(() => failed(err));
    });
    return handle;
  }

  _cancelWorkerTasks() {
    for (const task of this._workerTasks) task.cancel();
    this._workerTasks.clear();
  }

  later(ms, fn) {
    if (this.disposed) return null;
    let h = null;
    h = this.sched.setTimeout(() => {
      this._timers.delete(h);
      if (this.disposed) return;
      this.guard(fn);
    }, ms);
    if (h) this._timers.add(h);
    return h;
  }

  cancel(h) {
    if (!h) return;
    this.sched.clearTimeout(h);
    this._timers.delete(h);
  }

  scaled(ms) { return Math.max(0, Math.round(ms * this.timerScale)); }

  setDeadline(seconds, fn, { silent = false } = {}) {
    this.cancel(this._phaseTimer);
    this._phaseTimer = null;
    if (!(seconds > 0) || typeof fn !== 'function') { this.deadline = 0; return; }
    const ms = this.scaled(seconds * 1000);
    this.deadline = silent ? 0 : this.sched.now() + ms;
    this._phaseTimer = this.later(ms, () => { this._phaseTimer = null; fn(); });
  }

  get soloUntimed() { return this.isSolo || this.loneHuman; }

  nextUid() { return ++this.uidSeq; }

  alivePlayers() { return this.order.filter((p) => p.alive); }

  poolFor(player) {
    const ps = typeof player === 'string' ? this.players.get(player) : player;
    return ps?.pool || this.pool;
  }

  bondInPool(bondId) {
    for (const id of this.pool.entries.keys()) {
      const c = this.gd.chess(id);
      if (c && Array.isArray(c.bonds) && c.bonds.includes(bondId)) return true;
    }
    return false;
  }

  bondLive(bondId) {
    return !!this.gd.bond(bondId) && !this.gd.modeInactiveBonds.has(bondId);
  }

  humans() { return this.order.filter((p) => !p.isBot && !p.left); }

  bossGroupOf(ps) {
    if (!ps || !Array.isArray(this.bossWaves)) return null;
    const g = this.bossWaves.find((x) => Array.isArray(x.players) && x.players.includes(ps.playerId));
    return g ? { wave: g.wave, players: g.players, side: g.players.indexOf(ps.playerId) === 1 ? 'R' : 'L' } : null;
  }

  deployFieldOf(ps) {
    const g = this.bossGroupOf(ps);
    return !g ? 'normal' : g.side === 'R' ? 'bossR' : 'bossL';
  }

  deployMapFor(ps, field = this.deployFieldOf(ps)) {
    return buildDeployMap(this.stage, { deviceOverrides: ps.deviceOverrides, tileOverrides: ps.tileOverrides, field });
  }

  dispatch(ps, hook, ev = {}, opts = {}) {
    try { return this.dispatcher.dispatch(ps, hook, ev, opts); } catch (e) { this.reportError(`dispatch ${hook}`, e); return ev; }
  }

  dispatchItem(ps, item, holder, hook, ev) {
    try { return this.dispatcher.dispatchItem(ps, item, holder, hook, ev); } catch (e) { this.reportError(`dispatchItem ${hook}`, e); return ev; }
  }
}
