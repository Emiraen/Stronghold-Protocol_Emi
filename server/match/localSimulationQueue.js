// One cooperative CPU budget per process, shared by fallback battles and verification.
// A worker rejection must not give every room another independent main-thread budget.
export class LocalSimulationQueue {
  constructor({ budgetMs = 8, quantumMs = 2, delayMs = 8,
    now = () => performance.now(), timers = globalThis } = {}) {
    this.budgetMs = budgetMs;
    this.quantumMs = quantumMs;
    this.delayMs = delayMs;
    this.now = now;
    this.timers = timers;
    this.queue = [];
    this.timer = null;
    this.running = false;
  }

  submit(run, { valid = () => true, onError = () => {} } = {}) {
    const task = { run, valid, onError, cancelled: false };
    const handle = { cancel: () => {
      task.cancelled = true;
      this.queue = this.queue.filter((entry) => entry !== task);
      if (!this.queue.length && this.timer != null) {
        this.timers.clearTimeout(this.timer);
        this.timer = null;
      }
    } };
    this.queue.push(task);
    this._arm(0);
    return handle;
  }

  _arm(delay) {
    if (this.running || this.timer != null || !this.queue.length) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this._drain();
    }, delay);
    this.timer?.unref?.();
  }

  _drain() {
    this.running = true;
    const started = this.now();
    // Visit each queued room at most once in this turn; unfinished work joins the tail.
    let remaining = this.queue.length;
    try {
      while (remaining-- > 0 && this.queue.length) {
        const budget = this.budgetMs - (this.now() - started);
        if (budget <= 0) break;
        const task = this.queue.shift();
        if (task.cancelled) continue;
        try {
          if (!task.valid()) continue;
          const done = task.run(Math.min(this.quantumMs, budget));
          if (!done && !task.cancelled) this.queue.push(task);
        } catch (error) {
          try { task.onError(error); } catch { /* One failed job cannot stop other rooms. */ }
        }
      }
    } finally {
      this.running = false;
      this._arm(this.delayMs);
    }
  }
}

export const localSimulationQueue = new LocalSimulationQueue();

/** Share Match's existing cancellation lifetime with worker tasks, including sampled verification. */
export function queueLocalSimulation(match, run, { valid = () => true,
  onError = (error) => match.reportError('local simulation', error) } = {}) {
  let inner = null;
  const release = () => { match._workerTasks.delete(handle); inner = null; };
  const handle = { cancel: () => { inner?.cancel(); release(); } };
  match._workerTasks.add(handle);
  inner = localSimulationQueue.submit((budgetMs) => {
    let done = true;
    let failure = null;
    // guard records its own errors without throwing. Do not mistake a swallowed job exception for completion.
    match.guard(() => {
      try { done = run(budgetMs); }
      catch (error) { failure = { error }; }
    });
    if (failure) throw failure.error;
    if (done) release();
    return done;
  }, {
    valid: () => {
      const live = !match.disposed && !match.ended && !match.sched.suspended && valid();
      if (!live) release();
      return live;
    },
    onError: (error) => { release(); match.guard(() => onError(error)); },
  });
  return handle;
}
