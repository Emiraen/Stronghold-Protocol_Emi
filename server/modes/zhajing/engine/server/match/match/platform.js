// server/match/match/platform.js — Match methods: the platform interface of the server/match/Match.js header
// (server/lobby.js ⇄ Match) — start, handle (validation, error isolation, flush; the intents themselves: intents.js
// _handle), setLoadout (INFO_CHECK only), onDisconnect / onReconnect and the full resync of one human, onLeave and 中途退出
// = elimination (_quit), dispose.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { C2S } from '../../../shared/protocol.js';
import { PHASE, ERR } from '../../../shared/constants.js';
import { syntheticResult } from '../fields.js';
import { FLOW_TICKER_PRIORITY, OK, fail } from './common.js';
import { msg } from '../../../shared/i18n.js';

const GAME_TYPES = new Set(Object.keys(C2S).filter((t) => Object.hasOwn(C2S, t) && (t.startsWith('g.') || t.startsWith('b.'))));

export class MatchPlatform {
  start() {
    if (this.disposed || this.ended || this.phase !== PHASE.LOBBY) return;
    this.guard(() => {
      if (!this.gd.visibleChess.length || this.pool.entries.size === 0) {
        this.log.error?.(`[match ${this.roomCode}] game data unusable (no chess pool) — ending the match`);
        this.phase = PHASE.INFO_CHECK;
        this.markPublic();
        this.flush(true);
        this.finish({ victory: false, reason: 'error' });
        return;
      }
      this.enterInfoCheck();
    });
  }

  /**
   * @param {string} playerId
   * @param {{ t: string }} msg validated intent
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  handle(playerId, msg) {
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    // a spectator seat only watches (the platform routes nothing else of it)
    if (ps.spectator && (!msg || msg.t !== 'g.watch')) return fail(ERR.SPECTATOR);
    if (this.disposed || this.ended) {
      // a battle report that crossed the match end (the last b.progress of a field) is stale: ignored, never an error
      // (DESIGN §14 — an error frame without a rid would surface as a toast in the browser)
      return this.clientCombat && msg && (msg.t === 'b.progress' || msg.t === 'b.result') ? OK : fail(ERR.WRONG_PHASE);
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || !GAME_TYPES.has(msg.t)) return fail(ERR.BAD_MSG);
    let res;
    try {
      res = this._handle(ps, msg);
    } catch (e) {
      this.reportError(`handle ${msg.t}`, e);
      res = fail(ERR.INTERNAL);
    }
    try { this.flush(); } catch (e) { this.reportError('flush', e); }
    if (res && typeof res === 'object' && res.error) return res;
    return OK;
  }

  /**
   * room.loadout during the match (DESIGN §16): only while INFO_CHECK runs (the briefing's 干员调配 entry); the lobby
   * already checked it against the data (PlayerState.setLoadout re-checks it). `ops` (0.2.2 潜能 / 练度) and `bans`
   * (卡池预选) ride along: refused as a whole when any part does not fit the data.
   * @param {string} playerId
   * @param {Record<string, { skill: number, module: string|null }> | null} loadout
   * @param {Record<string, { potential: number, cultivate: number }> | null} [ops]
   * @param {any} [bans] shared/banPick.js profile
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  setLoadout(playerId, loadout, ops = null, bans = null) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE, 'loadout locked for this match');
    let res = OK;
    this.guard(() => {
      if (!ps.setLoadout(loadout)) { res = fail(ERR.BAD_TARGET, 'loadout does not match the game data'); return; }
      if (ops != null && !ps.setOps(ops)) { res = fail(ERR.BAD_TARGET, 'operator settings do not match the game data'); return; }
      if (bans != null && !ps.setBans(bans)) { res = fail(ERR.BAD_TARGET, 'ban picks do not match the game data'); return; }
      this.markPrivate(ps);
    });
    return res;
  }


  /**
   * 休整期（PREP）自由更换干员技能 / 模组（第三方 mod 移植，2026-10-11）：回合之间改派己方干员的技能与精英模组。
   * 与 setLoadout（仅 INFO_CHECK、整份替换）不同，这里接受**部分 entries**（一名干员即可），并把它合并进玩家当前的
   * 配发（m.private.loadout），所以单处改动不会清掉其他干员的配发；自选编队干员（自选槽）的增量则交给
   * `ps.setDiyPick` 合并进该槽的 pick 并重组记录（player/diy.js）。已「准备」（ps.ready）或不在 PREP 阶段一律拒绝。
   * @param {string} playerId
   * @param {Record<string, { skill?: number, module?: string|null }> | null} loadout 单干员或多干员的**增量**
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  setPrepLoadout(playerId, loadout) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    if (this.disposed || this.ended || this.phase !== PHASE.PREP || ps.ready) return fail(ERR.WRONG_PHASE, 'loadout locked outside prep');
    let res = OK;
    this.guard(() => {
      const lo = loadout && typeof loadout === 'object' && !Array.isArray(loadout) ? loadout : {};
      const entries = Object.entries(lo);
      if (!entries.length) { res = fail(ERR.BAD_MSG, 'empty loadout'); return; }
      const rest = {};
      for (const [id, e] of entries) {
        if (typeof e !== 'object' || e === null) { res = fail(ERR.BAD_MSG, `bad entry ${id}`); return; }
        // 自选槽：改的是该槽的 pick（技能/模组），不是配发
        if (typeof ps.hasDiySlot === 'function' && ps.hasDiySlot(id)) {
          if (!ps.setDiyPick(id, e)) { res = fail(ERR.BAD_TARGET, `bad 自选 pick ${id}`); return; }
        } else {
          // 非自选：只接受 legal 的技能/模组值；合并进现有配发（缺字段 = 用该干员当前/默认值）
          const one = {};
          if (e.skill !== undefined) { if (!Number.isInteger(e.skill)) { res = fail(ERR.BAD_MSG, `bad skill ${id}`); return; } one.skill = e.skill; }
          if (e.module !== undefined) { if (typeof e.module !== 'string') { res = fail(ERR.BAD_MSG, `bad module ${id}`); return; } one.module = e.module; }
          if (!Object.keys(one).length) { res = fail(ERR.BAD_MSG, `empty entry ${id}`); return; }
          rest[id] = one;
        }
      }
      if (Object.keys(rest).length) {
        const base = ps.loadout && typeof ps.loadout === 'object' && !Array.isArray(ps.loadout) ? ps.loadout : {};
        // ★ 2026-10-19：把同一条 loadout 同时记到 baseId / goldenId 两个键上 ——
        //   棋盘上的精锐棋子是 _b，而配发按 _a 存；只存一个键时详情卡/战斗里会出现「切了但没生效」。
        for (const [id, one] of Object.entries(rest)) {
          const rec = ps.gd && typeof ps.gd.chess === 'function' ? ps.gd.chess(id) : null;
          const twin = rec ? (rec.isGolden ? rec.baseId : rec.goldenId) : null;
          if (typeof twin === 'string' && twin && !(twin in rest)) rest[twin] = { ...one };
        }
        const merged = { ...base, ...rest };
        // setLoadout 是整份替换 + 语义校验（shared/protocol.js checkLoadout）：增量不合法就整体拒绝
        if (!ps.setLoadout(merged)) { res = fail(ERR.BAD_TARGET, 'loadout does not match the game data'); return; }
      }
      // 自选那部分 setDiy 已经重建了记录；两边都要让玩家看到新的详情卡
      this.markPrivate(ps);
    });
    return res;
  }

  /**
   * room.skins during the match (docs/SKINS.md): replace a player's chosen operator skins.
   *
   * Unlike `setLoadout` this is accepted in ANY phase — a skin changes only which model is drawn, never what the
   * unit does, so there is nothing to lock (and swapping mid-match is what a player expects from a 换装 tab).
   * `markPublic` because the choice rides in `publicView().players[]` for teammates to see.
   * @param {string} playerId
   * @param {Record<string, string> | null} skins
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  setSkins(playerId, skins) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    let res = OK;
    this.guard(() => {
      ps.setSkins(skins);
      this.markPublic();
    });
    return res;
  }

  onDisconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || this.disposed) return;
    this.guard(() => {
      ps.connected = false;
      // a paused solo battle resumes (the server takes the field over; nobody is left to resume it)
      this._resume();
      if (this.clientCombat) this._authorityLost(ps, 'disconnect');
      this.markPublic();
    });
  }

  onReconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return;
    this.guard(() => {
      const was = ps.connected;
      ps.connected = true;
      this._resync(ps);
      if (!was) this.markPublic();
    });
  }

  /**
   * The full state of one human (a reconnect, a resync, a spectator seat): m.public, its m.private (players only), the
   * field it is on / watches — a spectator, like an eliminated player, the field of the player it follows (item 56),
   * else the first; in a prep phase that player's board — or the result once ended.
   */
  _resync(ps) {
    const playerId = ps.playerId;
    this.sendTo(playerId, this.publicView());
    if (!this.ended) {
      if (!ps.spectator) {
        ps._lastPriv = null;
        this._sendPrivate(ps, true);
      }
      if (this.clientCombat) this._resendBattle(ps);
      else if (!this.fields.length && this._follows(ps)) this._followScout(ps, { keep: true });
      else {
        let fid = this.watchers.get(playerId);
        if (!fid && ps.spectator && this.fields.length) { fid = (this._watchTargetField(ps, this.fields) || this.fields[0]).fieldId; this.watchers.set(playerId, fid); }
        if (fid) this._sendField(playerId, fid);
      }
    } else if (this.lastResultMsg) {
      this.sendTo(playerId, { ...this.lastResultMsg, playerId });
    }
  }

  onLeave(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return;
    this.guard(() => {
      ps.left = true;
      ps.connected = false;
      ps.autoplay = false;
      this.watchers.delete(playerId);
      if (this.ended) return;
      this._resume();
      if (this.clientCombat) this._authorityLost(ps, 'left');
      this.markPublic();
      if (!this.order.some((p) => !p.isBot && !p.left)) {
        this.finish({ victory: false, reason: 'abandoned' });
        return;
      }
      this._quit(ps);
    });
  }

  /**
   * 中途退出 counts as elimination (research 00-INDEX §3, 01 §9, 06 §7 / §10.3): every copy the player holds goes back
   * to the shared pool at once, and the seat has no place in later rounds, the Final Assault pairing or the boss pool
   * (bloodPoint per player alive at the fight's start, DESIGN §25.13.4). Rounds passed = the rounds the player had
   * survived when leaving.
   */
  _quit(ps) {
    this.maybeEndInfo();
    if (!ps.alive) return;
    const phase = this.phase;
    const d = this.draft;
    if (phase === PHASE.BAND_DRAFT && d && !d.picks[ps.playerId]) {
      // the departed seat passes its turn with the default band (never one a teammate holds — defaultBand)
      const turn = this.draftTurn() === ps.playerId;
      d.picks[ps.playerId] = this.defaultBand(ps.playerId);
      ps.bandId = d.picks[ps.playerId];
      if (turn) this.startDraftTurn();
    }
    const passedRound = phase === PHASE.SETTLE ? this.round + 1 : Math.max(1, this.round);
    // its own normal battle has nobody left to fight for
    for (const f of this.fields) {
      if (f.live && f.kind === 'normal' && f.players.length === 1 && f.players[0] === ps.playerId) {
        if (this.clientCombat && f.cc) {
          if (!f.result) f.result = syntheticResult(f.players);
          this._fieldDone(f);
          continue;
        }
        try { f.battle.forceEnd('left'); } catch (e) { this.reportError('quit forceEnd', e); }
      }
    }
    ps.lp = 0;
    ps.eliminate(passedRound);
    this.tickerText(msg('{name}博士中途退出了模拟', { name: ps.name }), FLOW_TICKER_PRIORITY);
    if (this.bossWaves && (phase === PHASE.ROUND_START || phase === PHASE.SP_DRAFT || phase === PHASE.PREP)) {
      // before the boss fight: pair the players left again (the prep preview shows the new partner / template); a
      // player moved to the other half re-checks its board there at once (recompute → deployMap, marks it private)
      this._planBossWaves();
      for (const p of this.alivePlayers()) p.recompute();
    }
    // whoever scouted the departed player's board follows the next player still in (item 56)
    for (const v of this._viewers()) if (this.watchers.get(v.playerId) === `n:${ps.playerId}`) this._followScout(v);
    this.markPublic();
    if (this.teamLp != null) this._syncTeamLp();
    if (!this.alivePlayers().length) {
      // only eliminated spectators are left
      this.finish({ victory: false, reason: 'eliminated' });
      return;
    }
    if (phase === PHASE.SP_DRAFT && this.sp) { const d = this.spOf(ps); if (d && this.spTurnOf(d) === ps.playerId) this.startSpTurn(d); }
    else if (phase === PHASE.PREP) this.maybeEndPrep();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.runner) { try { this.runner.stop(); } catch { /* ignore */ } }
    this._stopClientCombat();
    for (const h of this._timers) { try { this.sched.clearTimeout(h); } catch { /* ignore */ } }
    this._timers.clear();
    if (this._pubTimer) { try { this.sched.clearTimeout(this._pubTimer); } catch { /* ignore */ } this._pubTimer = null; }
    if (this.ownsScheduler) this.sched.dispose();
  }
}
