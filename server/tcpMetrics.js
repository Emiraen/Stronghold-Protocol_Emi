import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

function address(raw) {
  let ip = String(raw || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!isIP(ip)) return '';
  if (isIP(ip) === 6) {
    ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(ip);
    if (mapped) {
      const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16);
      ip = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    }
  }
  return ip;
}

function endpoint(text) {
  const colon = text.lastIndexOf(':');
  if (colon < 0) return null;
  const ip = address(text.slice(0, colon));
  const port = Number(text.slice(colon + 1));
  return ip && Number.isInteger(port) && port > 0 && port <= 65535 ? [ip, port] : null;
}

export function socketTuple(socket) {
  const local = address(socket?.localAddress), remote = address(socket?.remoteAddress);
  const lp = socket?.localPort, rp = socket?.remotePort;
  if (!local || !remote || !Number.isInteger(lp) || lp <= 0 || lp > 65535
    || !Number.isInteger(rp) || rp <= 0 || rp > 65535) return null;
  return JSON.stringify([local, lp, remote, rp]);
}

// ss 的第二行 retrans:a/total 取累计重传段数，rtt:ms/variance 取实际 RTT 毫秒。
export function parseTcpMetrics(output) {
  const rows = new Map();
  let key = null;
  for (const line of String(output).split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    const offset = columns[0] === 'ESTAB' ? 1 : 0;
    if (/^\d+$/.test(columns[offset] || '') && /^\d+$/.test(columns[offset + 1] || '')) {
      const local = endpoint(columns[offset + 2] || ''), remote = endpoint(columns[offset + 3] || '');
      key = local && remote ? JSON.stringify([...local, ...remote]) : null;
      if (key) rows.set(key, null);
    } else if (key) {
      const retrans = /(?:^|\s)retrans:(\d+)\/(\d+)(?=\s|$)/.exec(line);
      const rtt = /(?:^|\s)rtt:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?=\s|$)/.exec(line);
      const totalRetrans = retrans && Number.isSafeInteger(Number(retrans[2])) ? Number(retrans[2]) : null;
      const rttMs = rtt && Number.isFinite(Number(rtt[1])) && Number(rtt[1]) >= 0 ? Number(rtt[1]) : null;
      if (totalRetrans != null || rttMs != null) rows.set(key, { totalRetrans, rttMs });
      key = null;
    }
  }
  return rows;
}

export class TcpMetrics {
  constructor({ platform = process.platform, run = execFile, now = () => performance.now(),
    timers = globalThis, intervalMs = 1500, expiryMs = 4500 } = {}) {
    this.enabled = platform === 'linux';
    this.run = run;
    this.now = now;
    this.timers = timers;
    this.intervalMs = intervalMs;
    this.expiryMs = expiryMs;
    this.entries = new Map();
    this.timer = null;
    this.flight = null;
  }

  register(conn, socket) {
    const key = socketTuple(socket);
    if (!this.enabled || !key || conn.closing || conn.ws.readyState !== 1) return;
    this.entries.set(conn, { socket, key, total: null, at: null, sample: null });
    if (this.timer == null) {
      this.timer = this.timers.setInterval(() => this.sample(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  remove(conn) {
    this.entries.delete(conn);
    if (!this.entries.size) this.stop();
  }

  stop() {
    if (this.timer != null) this.timers.clearInterval(this.timer);
    this.timer = null;
    const flight = this.flight;
    this.flight = null;
    try { flight?.child?.kill(); } catch { /* 采样失败不影响传输 */ }
  }

  close() {
    this.entries.clear();
    this.stop();
  }

  get(conn) {
    const e = this.entries.get(conn);
    if (!e || conn.closing || conn.ws.readyState !== 1 || socketTuple(e.socket) !== e.key
      || e.at == null || this.now() - e.at > this.expiryMs) return null;
    return e.sample;
  }

  sample() {
    if (!this.enabled || this.flight || !this.entries.size) return;
    const batch = new Map([...this.entries].filter(([conn, e]) => !conn.closing
      && conn.ws.readyState === 1 && socketTuple(e.socket) === e.key));
    if (!batch.size) return;
    const ports = [...new Set([...batch.values()].map((e) => e.socket.localPort))];
    const filter = ports.flatMap((port, i) => [...(i ? ['or'] : []), 'sport', '=', `:${port}`]);
    const args = ['-tinH', 'state', 'established', ...(ports.length > 1 ? ['(', ...filter, ')'] : filter)];
    const flight = { child: null };
    this.flight = flight;
    const complete = (err, stdout) => {
      if (this.flight !== flight) return;
      this.flight = null;
      const at = this.now();
      const rows = err ? new Map() : parseTcpMetrics(stdout);
      for (const [conn, e] of batch) {
        if (this.entries.get(conn) !== e || conn.closing || conn.ws.readyState !== 1 || socketTuple(e.socket) !== e.key) continue;
        const row = rows.get(e.key);
        const total = row?.totalRetrans;
        const rttMs = row?.rttMs;
        const valid = Number.isSafeInteger(total) && total >= 0;
        const validRtt = Number.isFinite(rttMs) && rttMs >= 0;
        const fresh = e.at != null && at - e.at <= this.expiryMs;
        const reset = valid && e.total != null && total < e.total;
        e.sample = (valid || validRtt) && !reset ? { totalRetrans: valid ? total : null,
          retransDelta: valid && fresh && e.total != null ? total - e.total : null,
          rttMs: validRtt ? rttMs : null, sampledAt: at } : null;
        e.total = valid ? total : null;
        e.at = at;
        if (e.sample) conn.onTcpSample?.(e.sample);
      }
    };
    try {
      flight.child = this.run('ss', args, { encoding: 'utf8', timeout: 1000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, complete);
    } catch (err) { complete(err); }
  }
}
