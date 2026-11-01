// server/match/match/messaging.js — Match methods: messaging — unicast, broadcast, toasts, the ticker lines
// (config.broadcasts by type; the remake's CUSTOM lines), the dirty marks and flush: m.private per player only when it
// changed (plus the prep scouts of that player's board), m.public throttled (DELAYS.PUBLIC_THROTTLE) and deduplicated.
// i18n (docs/I18N.md): a toast / CUSTOM line is a string (its own msgid) or a shared/i18n.js msg(msgid, params); the frame
// carries `text` (the Chinese rendering, what older clients show) plus `msgid` / `params`; a broadcast line carries its
// `args` so the client can fill the localized config.broadcasts template.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { DELAYS, FLOW_TICKER_PRIORITY } from './common.js';
import { msg, wireMessage } from '../../../shared/i18n.js';
import { PHASE } from '../../../shared/constants.js';

/**
 * Per-phase `m.public` throttle (see MatchMessaging.publicThrottleMs). PREP is where the room-wide snapshot is both
 * most frequently invalidated (every buy / refresh / merge / level-up) and least urgent to the other seats, so it is
 * relaxed 5×; the draft is slower still because it is a click-once screen.
 */
const PREP_PUBLIC_THROTTLE = 500;
const DRAFT_PUBLIC_THROTTLE = 1000;

/**
 * 推送瘦身的「影子模式」(Match `opts.msgShadow === true`, 默认关 —— 生产一分钱不花): 每发一帧额外算一次
 * 「如果只发改动字段会省多少」, **只统计, 绝不改变发送行为**。账本放在 `m.msgShadow`, 由画像脚本
 * (tools 之外的 _garrison-list/perf-profile.mjs) 读出来; `msgShadowReport()` 给汇总。
 *
 * 口径就是真要落地时的做法, 所以影子数字可以直接当预期收益:
 *   * 整包 = 现在真的发出去的那一帧的 JSON 长度 (m.public 含 `serverNow`; m.private 是 privateView())
 *   * 增量 = `{ t: 'm.patch', set: {...} }` (+ 有删除时的 `del: [路径]`) 的 JSON 长度
 *   * 增量 ≥ 整包 → 记一次「退回整包」(真实实现也会退), 不计入节省; 改动路径超过 DIFF_MAX_PATHS 同样退回
 *   * 公共帧的 `serverNow` 不进 diff (每帧都变, 真实实现放在包头), 所以它只算进「整包」那一侧
 */
const DIFF_MAX_PATHS = 4000;

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const jsonLen = (v) => { try { return JSON.stringify(v).length; } catch { return 0; } };

/**
 * 字段级 diff: 把「新值」写进 `out` (路径用 `.` 连接, 数组按下标), 删掉的键收进 `st.del`。
 * 只递归普通对象与**等长**数组; 其它值 (原始值、长度变了的数组) 整块替换 —— 够真实实现用, 也够这张画像用。
 */
function diffInto(prev, next, out, prefix, st) {
  if (prev === next || st.paths > DIFF_MAX_PATHS) return;
  const po = isPlainObj(prev);
  const no = isPlainObj(next);
  if (po && no) {
    for (const k of Object.keys(next)) {
      if (Object.hasOwn(prev, k)) diffInto(prev[k], next[k], out, `${prefix}${k}.`, st);
      else { out[`${prefix}${k}`] = next[k]; st.paths++; }
    }
    for (const k of Object.keys(prev)) if (!Object.hasOwn(next, k)) { st.del.push(`${prefix}${k}`); st.paths++; }
    return;
  }
  const pa = Array.isArray(prev);
  const na = Array.isArray(next);
  if (pa && na && prev.length === next.length) {
    for (let i = 0; i < next.length; i++) diffInto(prev[i], next[i], out, `${prefix}${i}.`, st);
    return;
  }
  let same = false;
  try { same = JSON.stringify(prev) === JSON.stringify(next); } catch { same = false; }   // 不可序列化的值 → 当作变了
  if (same) return;
  out[prefix.slice(0, -1) || '.'] = next;
  st.paths++;
}

export class MatchMessaging {
  sendTo(playerId, msg) {
    if (this.disposed) return false;
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (!ps || ps.isBot || ps.left) return false;
    try { return !!this.sendFn(playerId, msg); } catch (e) { this.reportError('send', e); return false; }
  }

  broadcast(msg) {
    if (this.disposed) return;
    try { this.broadcastFn(msg); } catch (e) { this.reportError('broadcast', e); }
  }

  /** Send an **already-encoded** frame to one player; false when the platform has no raw channel (callers fall back). */
  sendToRaw(playerId, data, opts) {
    if (this.disposed || !this.sendRawFn) return false;
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (!ps || ps.isBot || ps.left) return false;
    try { return !!this.sendRawFn(playerId, data, opts); } catch (e) { this.reportError('sendRaw', e); return false; }
  }

  /** Broadcast an **already-encoded** frame; false when there is no raw channel (caller falls back to broadcast()). */
  broadcastRaw(data, opts) {
    if (this.disposed || !this.broadcastRawFn) return false;
    try { this.broadcastRawFn(data, opts); return true; } catch (e) { this.reportError('broadcastRaw', e); return false; }
  }

  /** @param {string|{ msgid: string, params?: object }} text a string or msg() (shared/i18n.js) */
  toast(ps, kind, text) {
    if (!ps || ps.isBot || ps.left || !ps.connected) return;
    this.sendTo(ps.playerId, { t: 'm.toast', kind, ...wireMessage(text) });
  }

  /** Broadcast ticker from config.broadcasts by type; `param` picks the variant (SHOP_LEVEL level, BOSS_HIT share…). */
  tickerFor(type, args = [], { playerId = null, to = null, param = null } = {}) {
    const list = Array.isArray(this.gd.config.broadcasts) ? this.gd.config.broadcasts.filter((b) => b && b.type === type) : [];
    let b = list[0];
    if (param != null) b = list.find((x) => Array.isArray(x.params) && x.params.includes(String(param))) || b;
    const tpl = b && typeof b.text === 'string' ? b.text : null;
    if (!tpl) return;
    const text = tpl.replace(/\{(\d)\}/g, (_, i) => (args[Number(i)] != null ? String(args[Number(i)]) : ''));
    const msg = { t: 'm.ticker', text, id: b.id, type, priority: Number(b.priority) || 0, playerId, args: args.map((a) => String(a ?? '')) };
    if (to) this.sendTo(to, msg);
    else this.broadcast(msg);
  }

  /**
   * A ticker line of the remake's own (type CUSTOM). `priority`: the match-flow notices (隐秘核心已解锁, 联防阶段, a player out
   * or gone) take FLOW_TICKER_PRIORITY so the strip does not hold them behind shop-level lines; other lines 0.
   */
  tickerText(text, priority = 0, opts = {}) {
    if (!text) return;
    const w = wireMessage(text);
    // `sound`（可选）：这一行自带的播报音 key（客户端 ui/ticker.js → audio.announceSound）。
    // 惊变「异戒神将」叠满 90% 时用它放 owner 给的那段音频；普通行不带，客户端仍放默认的 broadcast。
    const msg = { t: 'm.ticker', ...w, text: w.text.slice(0, 200), id: null, type: 'CUSTOM', priority: Number(priority) || 0, playerId: null };
    if (typeof opts.sound === 'string' && opts.sound) msg.sound = opts.sound;
    this.broadcast(msg);
  }

  /**
   * 惊变「死亡回归」(owner 2026-10-16)：`{name}博士宣布了自己可以死亡回归` 的**上方大字播报**，
   * 并让**全场**播其专属播报音（客户端 `m.deathReturn` → `audio.deathReturnAnnounce()`）。
   * 音频口径（owner 指定）：走「背景音乐」通道（音乐滑条能控它）、再 ×0.7、结尾 2 秒线性淡出、
   * 且**完全不受「司凤」类开关影响**（不读 emoteSfx / emoteSfxVolume / bossRainlove / sifengBgm）。
   * @param {any} ps 按下那个按钮的玩家
   */
  /**
   * 「死亡回归」的 3 秒后：把全体拉回**该回合的整备阶段**。
   * · `startRound(r)` 本身就是"回合开始 → 整备阶段"的入口（ROUND_START → … → PREP），
   *   所以用同一个回合号再走一次，就是卡面写的"回到此回合整备阶段"；
   * · 按下按钮的玩家此刻 `alive === false`，而 startRound 只处理 alivePlayers —— 先把他置回 true，
   *   并**恢复被扣的目标生命 +3**（卡面「此玩家恢复扣除的目标生命」；+3 是它同时改成
   *   「你激怒了某位大人，她不再保护你」后的保底生命，避免刚好 0 又被立刻淘汰）；
   * · 随后把效果改名（本卡失效）—— 用 ctx.addEffect 原地替换不了，所以直接改 effects 里的 name/desc。
   * @param {any} ps
   */
  _deathReturnRewind(ps) {
    if (!ps) return;
    const r = Number.isFinite(ps._deathReturnRound) ? ps._deathReturnRound : this.round;
    ps.alive = true;
    ps.ready = false;
    ps.lp = Math.max(1, Number(ps._deathReturnLp) || 0) + 3;
    ps._deathReturnRound = null;
    ps._deathReturnLp = null;
    // 本卡失效：改效果面（保留 ref，但改名/改写描述 —— 等于"变成了另一张卡"）
    try {
      const e = (ps.effects || []).find((x) => x && x.key === 'jibian:jibian_siwanghuigui');
      if (e) { e.name = '你激怒了某位大人'; e.desc = '她不再保护你。'; e.iconKind = 'choice'; e.iconId = null; }
    } catch { /* cosmetic */ }
    ps.dirty();
    this.tickerText(msg('全体回到了第 {round} 回合的整备阶段', { round: String(r) }), FLOW_TICKER_PRIORITY);
    // ★ 2026-10-16（owner）：回到的这一回合若本来有**惊变阶段**，只让发动者再选一次，其他人直接进整备。
    //   `afterEnemyJibian` 会把这个标记传给 enterSpDraft 并消费掉（消费掉是为了不影响后续回合）。
    this._jibianSoloPick = ps.playerId;
    // ★ 2026-10-16（owner）回退语义：**所有人失去本回合整备阶段购买的干员，带着一开始的资金回到整备阶段**。
    //   startRound 会再发一次收入、再刷一次商店 —— 那正是之前"资金多了 10"的来源。所以先标记这次是回退，
    //   startRound 里每人在发完钱之后会立刻用自己开局时的快照恢复（资金 / 棋盘 / 商店牌面），
    //   回到"整备阶段刚开始"的那一刻。放在 flags 里是因为 startRound 是按玩家跑的。
    this._jibianRewindRound = r;
    this.startRound(r);
  }

  deathReturnAnnounce(ps, o = {}) {
    if (!ps) return;
    // 文案分流（owner 2026-10-16）：被动（生命归 0 自动触发）说「触发了」；
    // 主动（按商店栏那个按钮）说「宣布了自己可以」—— 后者是"预告"，前者是"已经发生"。
    const text = o && o.auto
      ? msg('{name}博士触发了死亡回归', { name: ps.name })
      : msg('{name}博士宣布了自己可以死亡回归', { name: ps.name });
    this.tickerText(text, FLOW_TICKER_PRIORITY);
    this.broadcast({ t: 'm.deathReturn', playerId: ps.playerId, name: ps.name });
  }

  markPublic() { this._pubDirty = true; }
  /**
   * A player's state changed: its m.private and (throttled, deduplicated) m.public (level, board, bonds…) — in a boss
   * round's prep also its pair partner's m.private, which shows this board on its other half (bossMate, item 51).
   */
  markPrivate(ps) {
    if (!ps) return;
    this._privDirty.add(ps);
    this._pubDirty = true;
    const m = this._bossMateOf(ps);
    if (m) this._privDirty.add(m.mate);
  }

  /** Send pending m.private (per player, only when changed) and m.public (throttled ≤ 10/s). */
  flush(forcePublic = false) {
    if (this.disposed) return;
    if (this._privDirty.size) {
      const list = [...this._privDirty];
      this._privDirty.clear();
      for (const ps of list) {
        if (!(ps.isBot || ps.left || !ps.connected)) this._sendPrivate(ps, false);
        this._notifyPrepScouts(ps);
      }
    }
    if (this._pubDirty || forcePublic) this._maybeSendPublic(forcePublic);
  }

  _sendPrivate(ps, force) {
    let view;
    try { view = ps.privateView(); } catch (e) { this.reportError('privateView', e); return; }
    const json = JSON.stringify(view);
    if (!force && json === ps._lastPriv) return;
    if (this.msgShadowOn) this._shadowCount('priv', ps.playerId, json.length, view);
    ps._lastPriv = json;
    // ★ 这份 json 就是线上帧：直接发，别让平台再 encode 一遍（用户 2026-10-13 审计：每人每帧白编一次，
    //   实测 privateView+stringify = 0.164 ms）。没有 raw 通道（测试桩）就退回原来的路径。
    if (!this.sendToRaw(ps.playerId, json, { type: 'm.private' })) this.sendTo(ps.playerId, view);
  }

  /**
   * How long an `m.public` snapshot must wait, in real ms, for the CURRENT phase.
   *
   * The snapshot is a FULL room listing (one entry per player, `bonds` included), so at 100 seats it is ~65-80 KB and a
   * single player's action makes the server re-encode and fan it out to every client. `markPrivate` — i.e. any shop
   * refresh, buy, merge, level-up or deploy — sets `_pubDirty`, so during PREP the trigger rate is the highest of the
   * whole match, while almost nothing in the snapshot is time-critical for the other 99 seats (a teammate's board and
   * shop level are glanceable information, not inputs). PREP therefore gets a slower clock; the battle-heavy phases
   * keep the responsive one. Reported symptom that motivates this: 91 players in one room pinned the latency counter at
   * its 9999 display cap.
   */
  publicThrottleMs() {
    switch (this.phase) {
      case PHASE.PREP: return PREP_PUBLIC_THROTTLE;
      // the draft screens are driven by their own frames (m.public.draft is inside the snapshot, but every pick also
      // sends a ticker line), and nobody is watching another seat's board during them
      case PHASE.BAND_DRAFT: return DRAFT_PUBLIC_THROTTLE;
      default: return DELAYS.PUBLIC_THROTTLE;
    }
  }

  _maybeSendPublic(force) {
    const now = this.sched.now();
    const throttle = this.publicThrottleMs();
    if (!force && now - this._lastPubAt < throttle) {
      if (!this._pubTimer) {
        const wait = Math.max(1, throttle - (now - this._lastPubAt));
        this._pubTimer = this.sched.setTimeout(() => {
          this._pubTimer = null;
          if (this.disposed) return;
          try { this._maybeSendPublic(false); } catch (e) { this.reportError('public', e); }
        }, wait);
      }
      return;
    }
    this._pubDirty = false;
    let view;
    try { view = this.publicView(); } catch (e) { this.reportError('publicView', e); return; }
    const { serverNow, ...rest } = view;
    const json = JSON.stringify(rest);
    if (!force && json === this._lastPubJson) return;
    // 影子统计 (opts.msgShadow, 默认关): 整包按真正发出去的 `view` 量, diff 只跑不含 serverNow 的 `rest`
    if (this.msgShadowOn) this._shadowCount('pub', null, jsonLen(view), rest);
    this._lastPubJson = json;
    this._lastPubAt = now;
    // ★ 同一份 JSON 不再编第二遍：线上帧 = 去重用的 rest + serverNow（追加在末尾；客户端按键取值，
    //   不依赖键序，所以语义不变）。serverNow 不是有限数、或平台没有 raw 通道时退回原来的整包编码。
    const frame = Number.isFinite(serverNow) && json.endsWith('}')
      ? `${json.slice(0, -1)},"serverNow":${serverNow}}`
      : null;
    if (!frame || !this.broadcastRaw(frame, { type: 'm.public' })) this.broadcast(view);
  }

  // ---- 影子统计 (只统计, 不改发送; 见文件头) ------------------------------------------------------------

  /** 影子统计开着吗 (Match `opts.msgShadow === true`, 默认关 = 热路径上只有这一次属性读)。 */
  get msgShadowOn() { return !!this.opts && this.opts.msgShadow === true; }

  /** 影子账本 (第一次用到时才建; `msgShadow` 因此也是「有没有在统计」的标记)。 */
  _msgShadow() {
    if (!this.msgShadow) {
      this.msgShadow = {
        pub: { frames: 0, full: 0, patch: 0, fallback: 0, first: 0, paths: 0, maxFull: 0, maxPatch: 0, prev: null },
        priv: { frames: 0, full: 0, patch: 0, fallback: 0, first: 0, paths: 0, maxFull: 0, maxPatch: 0, prev: new Map() },
      };
    }
    return this.msgShadow;
  }

  /**
   * 记一帧。`size` = 这一帧真的发出去的长度, `diffable` = 用来做字段级 diff 的对象 (公共帧不含 serverNow)。
   * `kind` 'priv' 时 `key` = 收件人 (每人一份影子副本, 私有帧是各人各异的)。
   */
  _shadowCount(kind, key, size, diffable) {
    const b = this._msgShadow()[kind];
    const n = Number.isFinite(size) && size > 0 ? size : 0;
    b.frames++;
    b.full += n;
    if (n > b.maxFull) b.maxFull = n;
    const prev = kind === 'pub' ? b.prev : b.prev.get(key);
    let patch = n;
    if (prev == null) b.first++;
    else {
      const st = { paths: 0, del: [] };
      const set = {};
      try { diffInto(prev, diffable, set, '', st); } catch { st.paths = DIFF_MAX_PATHS + 1; }
      if (st.paths <= DIFF_MAX_PATHS) {
        let m = n + 1;
        try { m = jsonLen(st.del.length ? { t: 'm.patch', set, del: st.del } : { t: 'm.patch', set }); } catch { m = n + 1; }
        if (m > 0 && m < n) patch = m;
        b.paths += st.paths;
      }
    }
    if (patch >= n) b.fallback++;
    b.patch += patch;
    if (patch > b.maxPatch) b.maxPatch = patch;
    if (kind === 'pub') b.prev = diffable;
    else b.prev.set(key, diffable);
  }

  /** 现在会收到公共帧的在线人类数 (广播的实际收件人; 画像脚本按它把单份字节放大成出网量)。 */
  shadowRecipients() {
    let n = 0;
    for (const ps of [...this.players.values(), ...this.spectators.values()]) {
      if (ps && !ps.isBot && !ps.left && ps.connected) n++;
    }
    return n;
  }

  /**
   * 影子统计汇总 (没有开统计时 null)。字节都是**单份**: 公共帧乘 `recipients` 才是出网量。
   * @returns {{ pub: any, priv: any, recipients: number } | null}
   */
  msgShadowReport() {
    const S = this.msgShadow;
    if (!S) return null;
    const one = (b) => ({
      frames: b.frames,
      fullBytes: b.full,
      patchBytes: b.patch,
      savedBytes: b.full - b.patch,
      savedPct: b.full ? Math.round((1 - b.patch / b.full) * 1000) / 10 : 0,
      avgFull: b.frames ? Math.round(b.full / b.frames) : 0,
      avgPatch: b.frames ? Math.round(b.patch / b.frames) : 0,
      maxFull: b.maxFull,
      maxPatch: b.maxPatch,
      fallbackFrames: b.fallback,
      firstFrames: b.first,
      changedPaths: b.paths,
    });
    return { pub: one(S.pub), priv: one(S.priv), recipients: this.shadowRecipients() };
  }
}
