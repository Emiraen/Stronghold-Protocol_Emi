// server/match/match/clientCombat.js — Match methods: client-side combat bookkeeping (DESIGN §14) — field records (the
// JSON BattleSpec + the authority / result state), spec battles on the server, the field clock, the authority (the
// lowest connected seat), b.start per recipient, result deadlines and releases, server runs (headless slices,
// takeovers), field completion → the phase end, and the timers of it all.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, CLIENT_BOTS_SOLO_MAX, CLIENT_BOTS_PER_PERSON } from '../../../shared/constants.js';
import { DeadBattle, syntheticResult, RESULT_GRACE_MS, HARD_CAP_SECONDS, HeadlessJob } from '../fields.js';
import { buildBattleSpec, createBattleFromSpec } from '../../sim/spec.js';

/** 服务端自己跑的战斗，相邻两场构建之间隔多少毫秒（避免一个回调里连建多场）。 */
const SERVER_FIELD_STAGGER_MS = 40;

/** 单人房最多把几个机器人字段交给房主浏览器代跑（默认 = CLIENT_BOTS_SOLO_MAX；SP_CLIENT_BOTS_MAX 可调，0 = 不代跑）。 */
// ★ 2026-10-22（owner）：默认**不再**把机器人字段派给房主浏览器代跑。
//   实测今天线上日志：bot field → client exec 2101 次，其中 1835 次以 server takeover (timeout) 收场 ——
//   也就是每一轮都在等 `timeLimit / gameSpeed + 15 s` 的宽限，玩家看到的就是「AI 打的时候要等时间流完」。
//   服务端 headless 跑一场只要几十到几百毫秒，没有必要交给浏览器。需要时可用 SP_CLIENT_BOTS_MAX 调回来。
const CLIENT_EXEC_MAX = Number.isFinite(Number(process.env.SP_CLIENT_BOTS_MAX))
  ? Math.max(0, Math.floor(Number(process.env.SP_CLIENT_BOTS_MAX)))
  : 0;   // 共享上限，lobby.js 的房间 AI 上限用的是同一个数
/** ★ 2026-10-18 深夜：多真人房里**每个真人**最多代跑几个机器人字段（房主一个人扛 12 个会掉帧，摊开更好）。 */
const CLIENT_EXEC_PER_PERSON = Number.isFinite(Number(process.env.SP_CLIENT_BOTS_PER_PERSON))
  ? Math.max(0, Math.floor(Number(process.env.SP_CLIENT_BOTS_PER_PERSON)))
  : CLIENT_BOTS_PER_PERSON;   // 多真人房每人分摊数（共享常量，与 lobby.js 的房间上限同源）
export { CLIENT_EXEC_MAX };

export class MatchClientCombat {
  /** Stop every client-combat timer and the headless pacer (phase end, finish, dispose). */
  _stopClientCombat() {
    if (this._progressTimer) { this.cancel(this._progressTimer); this._progressTimer = null; }
    if (this._bossClock) { this.cancel(this._bossClock); this._bossClock = null; }
    this._bossClockOn = false;
    // a pending throttled boss refresh: the merged team LP is written back now (m.result / settlement read it)
    if (this._bossPubTimer) { this.cancel(this._bossPubTimer); this._bossPubTimer = null; this._syncTeamLp(); this.markPublic(); }
    this._clearPause();
    if (this._poolTimer) { this.cancel(this._poolTimer); this._poolTimer = null; }
    if (this.pacer) { try { this.pacer.stop(); } catch { /* ignore */ } this.pacer = null; }
    for (const f of this.fields) this._clearFieldTimers(f);
  }

  _clearFieldTimers(f) {
    if (!f || !f.cc) return;
    for (const k of ['deadlineTimer', 'doneTimer', 'waitTimer', 'sliceTimer', 'stallTimer']) if (f[k]) { this.cancel(f[k]); f[k] = null; }
    f.job = null;
  }

  /** A client-combat field record: the JSON BattleSpec of its Battle options plus the authority / result state. */
  _ccField({ fieldId, kind, players, opts, boss = null }) {
    const seq = `${this.battlePrefix}.${this.round}.${++this._battleSeq}`;
    // protocol ids are ≤ 64 chars (shared/protocol.js isId): the field id is informational, the sequence is unique
    const battleId = seq.length + 1 + String(fieldId).length <= 64 ? `${seq}.${fieldId}` : seq;
    const spec = buildBattleSpec({ ...opts, battleId, fieldId, kind, content: this.battleContent, boss });
    let total = 0;
    for (const x of spec.spawns) if (x && x.tag !== 'boss' && x.tag !== 'part') total += Math.max(1, Math.floor(Number(x.count) || 1));
    return {
      cc: true, fieldId, kind, players: players.slice(), battleId, spec, battle: null, live: true, done: false,
      mode: null, authority: null, startAt: this.sched.now(), result: null, resultSource: null, timeline: null, endGt: null,
      progress: { gt: 0, killed: 0, total, leaks: 0, done: false }, lastProgressAt: this.sched.now(),
      bossAcked: 0, bossBy: {}, lpAcked: 0, lpCum: 0, deadlineTimer: null, doneTimer: null, waitTimer: null, stallTimer: null,
      // boss fields: the latest client reports (re-credited as the plausibility budget grows), the server run's
      // CreditPool, humans demoted for an implausible result (never the authority of this field again), a 'cleared'
      // b.result waiting for the budget to credit the pool it emptied (`heldResult`, _onResult)
      bossReported: null, lpReported: 0, credit: null, demoted: new Set(), heldResult: null,
    };
  }

  /** A battle built from a spec on the server (headless / takeover / verification); never throws. */
  _specBattle(spec, { sharedBoss = null } = {}) {
    try {
      return createBattleFromSpec(spec, this.ds, { BattleClass: this.BattleClass, sharedBoss, logger: this.log, recordEvents: false });
    } catch (e) {
      this.reportError(`battle ${spec && spec.fieldId} construct`, e);
      return new DeadBattle({ fieldId: spec && spec.fieldId, kind: spec && spec.kind, players: (spec && spec.players) || [], rect: spec && spec.rect, stageId: spec && spec.stageId }, 'forced');
    }
  }

  /** Game seconds a field has run (its clock; a finished field: its final time). */
  _fieldElapsed(f) {
    if (f.done && f.result && Number.isFinite(f.result.time)) return f.result.time;
    const gt = Math.max(0, ((this._clockNow() - f.startAt) / 1000) * this.gameSpeed);
    if (f.endGt != null) return Math.min(gt, f.endGt);
    const lim = f.spec && f.spec.timeLimit > 0 ? f.spec.timeLimit : HARD_CAP_SECONDS;
    return Math.min(gt, lim);
  }

  /** The connected human who simulates a field: lowest seat among its players (normal: the owner). */
  _authorityFor(f, exclude = null) {
    let best = null;
    for (const pid of f.players) {
      if (pid === exclude || (f.demoted && f.demoted.has(pid))) continue;
      const ps = this.players.get(pid);
      if (!ps || ps.isBot || ps.left || !ps.connected) continue;
      if (!best || ps.seat < best.seat) best = ps;
    }
    return best ? best.playerId : null;
  }

  /**
   * ★ 2026-10-18（owner：机器人把服务端主线程堵死 → 玩家 ms 飙 500~700）：
   * 单人房（本局只有 1 个真人）里，机器人字段可以交给**这个真人的浏览器**去算 —— 客户端本来就有同一套
   * `/sim` 模拟代码，算完回 b.result，服务端照旧 validateClientResult 校验；且本方法只在
   * `SP_CLIENT_BOTS !== '0'` 时启用，出问题一个环境变量就能关掉。
   * @returns {string|null} 可代跑的真人 playerId
   */
  /** 本回合已经派给某个真人几个机器人字段。 */
  _execLoadOf(pid) {
    return (this._execLoad && this._execLoad.get(pid)) || 0;
  }

  /**
   * 挑一个真人来代跑机器人字段。
   * 单人房：房主，上限 CLIENT_EXEC_MAX。
   * 多真人房（SP_CLIENT_BOTS_MULTI，默认开）：按「本回合已派数量 → 座位」轮流，每人上限
   * CLIENT_EXEC_PER_PERSON —— 摊到多台机器上，谁的画面都不会因为帮别人算机器人而掉帧。
   * @returns {string|null}
   */
  clientExecHost() {
    if (this.clientBots === false) return null;
    const humans = [];
    for (const ps of this.players.values()) {
      if (!ps || ps.isBot || ps.left || !ps.connected) continue;
      humans.push(ps);
    }
    if (!humans.length) return null;
    if (humans.length > 1 && this.clientBotsMulti === false) return null;
    humans.sort((a, b) => (this._execLoadOf(a.playerId) - this._execLoadOf(b.playerId)) || (a.seat - b.seat));
    const pick = humans[0];
    const cap = humans.length === 1 ? CLIENT_EXEC_MAX : CLIENT_EXEC_PER_PERSON;
    if (cap <= 0) return null;
    if (this._execLoadOf(pick.playerId) >= cap) return null;
    return pick.playerId;
  }

  /** 这个字段能不能交给客户端代跑：普通字段、非 boss/联防、且已经分出去的不超过上限。 */
  _canClientExec(f) {
    if (!f || f.kind !== 'normal') return false;
    if (this.clientExecCount >= CLIENT_EXEC_MAX) return false;
    return true;
  }

  /**
   * b.start of a field for one recipient (`watch`: not a player of the field).
   *
   * `frozen` (batch only, see _sendStartBatch): `{ serverNow, elapsed }` fixed for a whole batch, so that every
   * recipient of one launch gets the SAME clock base and the frames can be encoded once and shared. Omitted
   * (every single-recipient call site) ⇒ the values are read live, exactly as before.
   */
  _startMsg(f, pid, { watch = false } = {}, frozen = null) {
    return {
      t: 'b.start', battleId: f.battleId, fieldId: f.fieldId, kind: f.kind,
      spec: this.spectators.has(pid) ? this._spectatorSpec(f) : f.spec,
      authoritative: !!(!f.done && f.mode === 'client' && f.authority === pid && !watch),
      exec: !!f.clientExec,   // ★ 客户端代跑的机器人字段：只算不显示
      startAt: f.startAt, serverNow: frozen ? frozen.serverNow : this.sched.now(),
      elapsed: frozen ? frozen.elapsed : Math.round(this._fieldElapsed(f) * 1000) / 1000,
      speed: this.gameSpeed, watch: !!watch, done: !!f.done,
    };
  }

  _sendStart(pid, f, opts = {}) {
    const ps = this.players.get(pid) || this.spectators.get(pid);
    if (!ps || ps.isBot || ps.left || !ps.connected) return false;
    return this.sendTo(pid, this._startMsg(f, pid, opts));
  }

  /**
   * b.start 批量发出（用户 2026-10-13）。联防阶段原来是「每个观看者 × 每场战斗各编码一次」
   * （unitePhase.js），而一帧联防 relay 规格实测 **75,321 B** —— 100 人一次开战就是几十 MB 的 JSON 工作。
   * 这里按 (spec 来源, watch, 是否权威) 分组，**每组只编码一次**再逐人发送（走已编码通道 sendToRaw）。
   *
   * 分组只有 ≤3 种：`P|0|0` 绝大多数人、`P|0|1` 只有该场的 authority 一个、`P/S|1|*` 观看者。
   * ★ 语义：整批冻结同一个 `serverNow`/`elapsed`（同一批开战本来就该有同一个时间基准）；
   *   单收件人的 `_sendStart`（迟到的观看者、普通回合）完全不受影响，仍实时取值。
   * @param {object} f @param {Array<{ pid: string, watch?: boolean }>} recipients @returns {number} 实际发出的帧数
   */
  _sendStartBatch(f, recipients) {
    const frozen = { serverNow: this.sched.now(), elapsed: Math.round(this._fieldElapsed(f) * 1000) / 1000 };
    const frames = new Map();
    let sent = 0;
    for (const r of recipients) {
      const pid = r && r.pid;
      const ps = this.players.get(pid) || this.spectators.get(pid);
      if (!ps || ps.isBot || ps.left || !ps.connected) continue;
      const watch = !!r.watch;
      const msg = this._startMsg(f, pid, { watch }, frozen);
      const key = `${this.spectators.has(pid) ? 'S' : 'P'}|${watch ? 1 : 0}|${msg.authoritative ? 1 : 0}`;
      let data = frames.get(key);
      if (data === undefined) {
        try { data = JSON.stringify(msg); } catch { data = null; }
        frames.set(key, data);
      }
      if (data != null && this.sendToRaw(pid, data, { type: 'b.start' })) { sent++; continue; }
      if (this.sendTo(pid, msg)) sent++;            // 没有已编码通道（测试桩）时退回逐人编码
    }
    return sent;
  }

  /** Give every field its authority (a connected human) or run it on the server. */
  _launch(fields) {
    const now = this.sched.now();
    this._execLoad = new Map();   // ★ 每回合重置：这个回合把机器人字段派给了谁、各几个
    let serverQueue = 0;          // ★ 服务端字段错峰构建的序号
    this.fields = fields;
    for (const f of fields) { f.startAt = now; f.lastProgressAt = now; }
    for (const f of fields) {
      const auth = this._authorityFor(f);
      if (auth) this._assignClient(f, auth);
      else {
        // ★ 2026-10-18：单人房把机器人字段交给房主浏览器算（上限 CLIENT_EXEC_MAX），其余仍服务端跑
        const host = this._canClientExec(f) ? this.clientExecHost() : null;
        if (host) {
          this.clientExecCount = (this.clientExecCount | 0) + 1;
          this._execLoad.set(host, this._execLoadOf(host) + 1);
          f.clientExec = true;
          this._assignClient(f, host);
          this.log.info?.(`[match ${this.roomCode}] ${f.fieldId} R${this.round}: bot field → client exec (${host})`);
        } else {
          // ★ 2026-10-18 深夜：服务端跑的战斗要**同步构建整场 Battle**（一场约 100~300ms）。
          //   一个房间连建几场，就是玩家看到的「1~2 秒卡一下」。这里摊到后续调度回调里，
          //   每次回调最多建一场（间隔 SERVER_FIELD_STAGGER_MS）。
          const lag = serverQueue++ * SERVER_FIELD_STAGGER_MS;
          if (lag <= 0) this._runOnServer(f, 'no-human');
          else this.later(lag, () => { if (!f.done && f.mode !== 'client') this._runOnServer(f, 'no-human'); });
        }
      }
    }
  }

  _assignClient(f, pid) {
    f.mode = 'client';
    f.authority = pid;
    f.lastProgressAt = this.sched.now();
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    if (f.kind === 'boss' || f.kind === 'hidden') return; // the pool / team LP / silence watchdog end those
    if (this.paused) { f.rearmDeadline = true; return; }
    this._armDeadline(f);
    // 2026-10-26：联防字段另挂卡死看门狗（打完却没送结果时不再无限等）
    if (f.kind === 'unite') this._armStallWatch(f);
  }

  /** A client field's result deadline: its time limit on the field clock + RESULT_GRACE_MS (then the server takes over). */
  _armDeadline(f) {
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    const lim = f.spec.timeLimit > 0 ? f.spec.timeLimit : 60;
    const at = f.startAt + Math.round((lim / this.gameSpeed) * 1000) + RESULT_GRACE_MS;
    f.deadlineTimer = this.later(Math.max(0, at - this.sched.now()), () => {
      f.deadlineTimer = null;
      if (f.done || f.mode !== 'client') return;
      this._runOnServer(f, 'timeout');
    });
  }

  /**
   * 2026-10-26：联防字段的卡死看门狗（客户端算完却没送结果 / 中途掉线时由服务端接手）。
   *   5 秒轮询一次；满足任一条件就 takeover：
   *   · now ≥ 战场时限 + 30 秒（硬上限，客户端再慢也不能无限等）；
   *   · 已开打 20 秒以上，且连续 45 秒没有任何进度（lastProgressAt 不更新）。
   *   正常结算/换 authority 时 _runOnServer 会清掉 stallTimer。
   */
  _armStallWatch(f) {
    if (f.stallTimer) { this.cancel(f.stallTimer); f.stallTimer = null; }
    const tick = () => {
      f.stallTimer = null;
      if (f.done || f.mode !== 'client') return;
      const now = this.sched.now();
      const lim = f.spec.timeLimit > 0 ? f.spec.timeLimit : 60;
      const hard = f.startAt + Math.round((lim / this.gameSpeed) * 1000) + 30_000;
      const inField = now - f.startAt;
      const quiet = now - (Number(f.lastProgressAt) || f.startAt);
      if (now >= hard || (inField > 20_000 && quiet > 45_000)) {
        this._runOnServer(f, 'stall');
        return;
      }
      f.stallTimer = this.later(5_000, tick);
    };
    f.stallTimer = this.later(5_000, tick);
  }

  /**
   * ★ 2026-10-22（owner）：这场战斗有没有真人在看 —— 该场里有连接的真人，或有连接的观战者。
   * 用来决定结果要不要按战场时钟压着发：没人看的场次（纯 AI 场）算完就即时出结果，
   * 有人看的场次保持原来的实时节奏（队友的进度条不会跳）。
   */
  _fieldWatched(f) {
    const mine = new Set(f.players || []);
    for (const ps of (this.players && this.players.values ? this.players.values() : [])) {
      if (!ps || ps.isBot || ps.left || !ps.connected) continue;
      if (mine.has(ps.playerId)) return true;
    }
    for (const sp of (this.spectators && this.spectators.values ? this.spectators.values() : [])) {
      if (sp && !sp.isBot && !sp.left && sp.connected) return true;
    }
    return false;
  }

  /** A server-run normal / 联防 field's result is released at the battle's natural end on the field clock. */
  _armRelease(f) {
    if (f.doneTimer) { this.cancel(f.doneTimer); f.doneTimer = null; }
    if (f.done || f.result == null) return;
    if (this.paused) { f.rearmRelease = true; return; }
    const doneAt = f.startAt + Math.round(((f.endGt || 0) / this.gameSpeed) * 1000);
    const wait = this.sched.instant ? 0 : Math.max(0, doneAt - this.sched.now());
    f.doneTimer = this.later(wait, () => { f.doneTimer = null; this._fieldDone(f); });
  }

  /**
   * The server simulates a field: normal / 联防 headlessly at once (the result is released at the battle's natural end
   * on the field's clock, so the teammates' progress UI and the round pacing stay as if it ran live); boss fields in
   * real time on the pacer (they share the pool), fast-forwarded to the field's clock on a takeover.
   */
  _runOnServer(f, reason) {
    const prev = f.mode === 'client' ? f.authority : null;
    if (prev) {
      this.verifyStats.takeovers++;
      this.log.info?.(`[match ${this.roomCode}] ${f.fieldId} R${this.round}: server takeover from ${prev} (${reason})`);
    }
    f.mode = 'server';
    f.authority = null;
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    if (f.stallTimer) { this.cancel(f.stallTimer); f.stallTimer = null; }
    // the former authority (still online after a timeout / an invalid result) stops reporting and keeps its view
    if (prev) this.sendTo(prev, { t: 'b.end', battleId: f.battleId, fieldId: f.fieldId, reason: 'takeover' });
    if (f.kind === 'boss' || f.kind === 'hidden') { this._bossServerRun(f); return; }
    const job = new HeadlessJob(this._specBattle(f.spec), { onError: (e) => this.reportError(`field ${f.fieldId} step`, e), players: f.players });
    f.job = job;
    f.battle = job.battle;
    f.timeline = job.timeline; // grows while the job runs (the teammates' progress UI reads it on the field clock)
    if (f.sliceTimer) { this.cancel(f.sliceTimer); f.sliceTimer = null; }
    const complete = () => {
      if (f.job !== job || f.done) return;
      f.job = null;
      const run = job.output();
      f.battle = run.battle;
      f.result = run.result;
      f.resultSource = 'server';
      f.timeline = run.timeline;
      f.endGt = Number(run.battle.time) || 0;
      // ★ 2026-10-22（owner）：没人看的场次（纯 AI 场）算完立即出结果。
      //   旧行为一律等「这场战斗在战场上自然结束」才释放（_armRelease），而 AI 的场次常常打满时间上限，
      //   于是每一轮都要陪等 AI 的整场时长 —— 玩家反馈的「AI 打的时候也要等时间流完」即此。
      //   有真人观看 / 暂停中仍走原来的实时节奏。
      if (!this.paused && !this._fieldWatched(f)) { this._fieldDone(f); return; }
      this._armRelease(f);
    };
    if (!Number.isFinite(this.headlessSliceMs)) {
      job.run(Infinity);
      complete();
    } else {
      // a real host: wall-clock-bounded slices in callbacks of their own (3 bot fields at combat start would otherwise
      // block the event loop for ~0.2–0.5 s here, seconds on a low-power mini PC)
      const slice = () => {
        f.sliceTimer = null;
        if (f.job !== job || f.done) return;
        if (job.run(this.headlessSliceMs)) complete();
        else f.sliceTimer = this.later(0, slice);
      };
      f.sliceTimer = this.later(0, slice);
    }
    this._armProgressTicker();
  }

  /** m.public ~1 Hz while server-run fields progress along their timelines. */
  _armProgressTicker() {
    if (this._progressTimer || this.sched.instant) return;
    const tick = () => {
      this._progressTimer = null;
      if (!this.fields.some((f) => f.cc && f.mode === 'server' && !f.done && f.timeline)) return;
      this.markPublic();
      this._progressTimer = this.later(1000, tick);
    };
    this._progressTimer = this.later(1000, tick);
  }

  /** A field has its final result. */
  _fieldDone(f) {
    if (!f || f.done) return;
    f.done = true;
    f.live = false;
    this._clearFieldTimers(f);
    if (!f.result) f.result = syntheticResult(f.players, { bossBy: f.bossBy });
    f.progress.done = true;
    this.markPublic();
    this._maybeFieldsDone();
  }

  _maybeFieldsDone() {
    if (!this.fields.length || this.fields.some((f) => f.cc && !f.done)) return;
    if (!this.fields.every((f) => f.cc)) return;
    if (this.phase === PHASE.COMBAT) this._finishCombat((f) => f.result);
    else if (this.phase === PHASE.UNITE) this._finishUniteClient();
    else if (this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE) this._finishFinal(this.phase === PHASE.HIDDEN_CORE, (f) => f.result);
  }

  /** An authoritative human disconnected / left: normal & 联防 fields → server takeover; boss → the partner or the server. */
  _authorityLost(ps, why) {
    for (const f of this.fields) {
      if (!f.cc || f.done || f.mode !== 'client' || f.authority !== ps.playerId) continue;
      if (f.kind === 'boss' || f.kind === 'hidden') this._bossHandover(f, why);
      else this._runOnServer(f, why);
    }
  }
}
