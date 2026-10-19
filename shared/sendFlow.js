const utf8 = new TextEncoder();
const priorities = ['high', 'medium', 'low'];
const priorityOf = (priority) => priorities.includes(priority) ? priority : 'high';
const byteLength = (data) => typeof data === 'string' ? utf8.encode(data).byteLength
  : ArrayBuffer.isView(data) || data instanceof ArrayBuffer ? data.byteLength
    : utf8.encode(JSON.stringify(data)).byteLength;

export class PrioritySender {
  constructor({ buffered, send, now = () => Date.now(), timers = globalThis, interval = 250,
    hardBytes = 256 * 1024, lowBytes = 20 * 1024, mediumBytes = 50 * 1024,
    resumeBytes = 10 * 1024, resumeMs = 250, tickMs = 25, lowTtlMs = 2000,
    maxEntries = 128, batchSize = 2 } = {}) {
    Object.assign(this, { buffered, send, now, timers, interval, hardBytes, lowBytes,
      mediumBytes, resumeBytes, resumeMs, tickMs, lowTtlMs, maxEntries, batchSize });
    this.queues = { high: [], medium: [], low: [] };
    this.queuedBytes = 0;
    this.timer = null;
    this.level = 0;
    this._resumeAt = null;
    this._lastSent = new Map();
    this._batchAt = { medium: 0, low: 0 };
    this._draining = false;
    this._closed = false;
  }

  _sample() {
    const buffered = Math.max(0, this.buffered() || 0);
    const now = this.now();
    const level = buffered > this.mediumBytes ? 2 : buffered > this.lowBytes ? 1 : 0;
    if (level > this.level) this.level = level;
    if (this.level && buffered < this.resumeBytes) {
      if (this._resumeAt == null) this._resumeAt = now + this.resumeMs;
      if (now >= this._resumeAt) {
        this.level--;
        // 延迟唤醒也只恢复一档，避免跨过滞回直接突发。
        this._resumeAt = this.level ? now + this.resumeMs : null;
      }
    } else this._resumeAt = null;
    return buffered;
  }

  allows(priority = 'high') {
    if (this._closed) return false;
    this._sample();
    this._schedule();
    priority = priorityOf(priority);
    return priority === 'high' || (!this._draining
      && (priority === 'medium' ? this.level < 2 : this.level === 0));
  }

  enqueue(data, options = {}) {
    if (this._closed) return false;
    const priority = priorityOf(options.priority);
    const key = options.key ?? null;
    const entry = { data, options: { ...options, priority, key }, priority, key,
      bytes: byteLength(data), at: this.now(), sent: false };
    this._sample();
    this._expire();
    if (key != null && (priority === 'high' || priority === 'medium')) {
      this.clear((pending) => pending.key === key
        && (priority === 'high' ? pending.priority !== 'high' : pending.priority === 'medium'));
    }
    const overflowing = () => this.queuedBytes + entry.bytes > this.hardBytes
      || priorities.reduce((n, p) => n + this.queues[p].length, 0) >= this.maxEntries;
    if (priority === 'medium') {
      // 最新中档状态优先于可丢弃低档，字节与条目预算都可腾出。
      for (const pending of [...this.queues.low]) {
        if (!overflowing()) break;
        this._remove(pending);
      }
    }
    // 高档仅为重入暂存FIFO，不能因非高档积压被丢弃；硬预算仍由实际send执行。
    if (priority !== 'high' && overflowing()) {
      this._schedule();
      options.onOverflow?.();
      return false;
    }
    this.queues[priority].push(entry);
    this.queuedBytes += entry.bytes;
    this.drain();
    // 无 key 的中档消息没有可合并的状态，不保留积压。
    if (priority === 'medium' && key == null && !entry.sent) {
      this.clear((pending) => pending === entry);
    }
    return entry.sent;
  }

  _remove(entry) {
    const queue = this.queues[entry.priority];
    const index = queue.indexOf(entry);
    if (index < 0) return;
    queue.splice(index, 1);
    this.queuedBytes -= entry.bytes;
  }

  _expire() {
    const now = this.now();
    for (const entry of [...this.queues.low]) {
      if (now - entry.at >= this.lowTtlMs) this._remove(entry);
    }
  }

  _interval(entry) {
    const value = entry.options.interval ?? this.interval;
    return Math.max(0, Number(typeof value === 'function' ? value(entry) : value) || 0);
  }

  _wait(entry) {
    if (entry.priority !== 'medium' || !entry.options.periodic) return 0;
    const last = this._lastSent.get(entry.key);
    return last == null ? 0 : Math.max(0, last + this._interval(entry) - this.now());
  }

  drain() {
    if (this._closed || this._draining) return;
    this._draining = true;
    const counts = { medium: 0, low: 0 };
    try {
      this._sample();
      this._expire();
      while (!this._closed) {
        let entry = this.queues.high[0];
        if (!entry) {
          const buffered = this._sample();
          this._expire();
          for (const priority of ['medium', 'low']) {
            if (counts[priority] >= this.batchSize || this.now() < this._batchAt[priority]) continue;
            if (priority === 'medium' ? this.level >= 2 : this.level !== 0) continue;
            const candidates = priority === 'low' ? this.queues.low.slice(0, 1) : this.queues.medium;
            entry = candidates.find((pending) => this._wait(pending) === 0
              && (buffered + pending.bytes <= this.hardBytes || pending.options.onOverflow));
            if (entry) break;
          }
        }
        if (!entry) break;
        // 底层发送仍负责硬预算和完成回调；这里不伪造成功或 callback。
        const buffered = this._sample();
        if (entry.priority !== 'high' && ((buffered + entry.bytes > this.hardBytes && !entry.options.onOverflow)
            || (entry.priority === 'medium' ? this.level >= 2 : this.level !== 0))) continue;
        this._remove(entry);
        entry.sent = this.send(entry.data, entry.options) === true;
        if (entry.sent && entry.key != null) {
          this._lastSent.delete(entry.key);
          this._lastSent.set(entry.key, this.now());
          if (this._lastSent.size > this.maxEntries) this._lastSent.delete(this._lastSent.keys().next().value);
        }
        if (entry.priority !== 'high') {
          counts[entry.priority]++;
          if (counts[entry.priority] >= this.batchSize) this._batchAt[entry.priority] = this.now() + this.tickMs;
        }
      }
    } finally {
      this._draining = false;
      this._schedule();
    }
  }

  _schedule() {
    if (this.timer != null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (this._closed) return;
    const entries = priorities.flatMap((priority) => this.queues[priority]);
    if (!entries.length && this._resumeAt == null) return;
    const now = this.now();
    let delay = this.tickMs;
    if (this._resumeAt != null) delay = Math.min(delay, Math.max(1, this._resumeAt - now));
    if (!entries.length && this._resumeAt != null) delay = Math.max(1, this._resumeAt - now);
    if (entries.length && entries.every((entry) => entry.priority === 'medium'
        && this.level < 2 && this._wait(entry) > 0)) {
      delay = Math.min(this.resumeMs, ...entries.map((entry) => this._wait(entry)));
      if (this._resumeAt != null) delay = Math.min(delay, Math.max(1, this._resumeAt - now));
    }
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.drain();
    }, Math.max(1, delay));
    this.timer.unref?.();
  }

  pending(key) {
    return priorities.some((priority) => this.queues[priority].some((entry) => entry.key === key));
  }

  clear(predicate = () => true) {
    for (const priority of priorities) {
      for (const entry of [...this.queues[priority]]) if (predicate(entry)) this._remove(entry);
    }
    this._schedule();
  }

  close() {
    this._closed = true;
    this.clear();
    this._lastSent.clear();
    this._resumeAt = null;
    this.level = 0;
  }
}

export class CongestionTrend {
  constructor({ expiryMs = 15000, now = () => Date.now() } = {}) {
    this.expiryMs = expiryMs;
    this.now = now;
    this.clear();
  }

  clear() {
    this._factor = 1;
    this._sample = null;
    this._rising = 0;
    this._stable = 0;
  }

  update({ source, at, rtt, retransDelta = null }) {
    if (!Number.isFinite(at)) return;
    const validRtt = Number.isFinite(rtt) && rtt >= 0;
    const validRetrans = Number.isFinite(retransDelta) && retransDelta >= 0;
    if (!validRtt && !validRetrans) return;
    let previous = this._sample;
    if (previous && at <= previous.at) return;
    if (!previous || previous.source !== source || at - previous.at > this.expiryMs) {
      this.clear();
      previous = null;
    }
    this._sample = { source, at, rtt: validRtt ? rtt : null };
    const comparable = validRtt && Number.isFinite(previous?.rtt);
    const rising = comparable && rtt - previous.rtt > Math.max(5, previous.rtt * 0.1);
    const retrans = validRetrans && retransDelta > 0;
    this._rising = rising ? this._rising + 1 : 0;
    // 只有纯 RTT 来源可以在重传未知时恢复；TCP 来源必须提供真实零增量。
    const stable = comparable && !rising && !retrans
      && (validRetrans || source === 'rtt');
    const noRtt = !validRtt && !Number.isFinite(previous?.rtt);
    this._stable = stable || (previous && noRtt && validRetrans && !retrans)
      ? this._stable + 1 : 0;
    if (retrans || this._rising >= 2) {
      this._factor = Math.min(4, this._factor + 1);
      this._rising = this._stable = 0;
    } else if (this._stable >= 3) {
      this._factor = Math.max(1, this._factor - 1);
      this._stable = 0;
    }
  }

  factor(now = this.now()) {
    if (this._sample && now - this._sample.at > this.expiryMs) {
      // 保留时间戳去重，过期样本重喂不能再次驱动拥塞。
      this._factor = 1;
      this._rising = this._stable = 0;
    }
    return this._factor;
  }
}
