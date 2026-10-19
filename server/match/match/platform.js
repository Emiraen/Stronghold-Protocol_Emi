

import { PHASE, ERR } from "../../../shared/constants.js";

import { syntheticResult } from "../fields.js";
import { bossPoolHp } from '../finalAssault.js';

import { FLOW_TICKER_PRIORITY, GAME_TYPES, OK, fail } from "./common.js";
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

  handle(playerId, msg) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    if (this.disposed || this.ended) {
      // a battle report that crossed the match end (the last b.progress of a field) is stale: ignored, never an error
      // (DESIGN §14 — an error frame without a rid would surface as a toast in the browser)
      return this.clientCombat && msg && (msg.t === 'b.progress' || msg.t === 'b.result' || msg.t === 'b.yield') ? OK : fail(ERR.WRONG_PHASE);
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

  setSkins(playerId, skins) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK) return false;
    this.guard(() => {
      ps.skins = Object.freeze({ ...skins });
      this.markPrivate(ps);
    });
    return true;
  }

  setLoadout(playerId, loadout, ops = undefined) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE, 'loadout locked for this match');
    let res = OK;
    this.guard(() => {
      if (!ps.setLoadout(loadout, ops)) { res = fail(ERR.BAD_TARGET, 'loadout does not match the game data'); return; }
      this.markPrivate(ps);
    });
    return res;
  }

  onDisconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || this.disposed) return;
    this.guard(() => {
      ps.connected = false;
      if (this.setupVote) this.cancelSetupVote();
      this.refreshUniteSkipVote();
      // a paused solo battle resumes (the server takes the field over; nobody is left to resume it)
      this._resume();
      if (this.clientCombat) this._authorityLost(ps, 'disconnect');
      this.markPublic();
    });
  }

  onReconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return;
    const was = ps.connected;
    ps.connected = true;
    this.refreshUniteSkipVote();
    this.sendTo(playerId, this.publicView());
    if (!this.ended) {
      ps._lastPriv = null;
      this._sendPrivate(ps, true);
      if (this.clientCombat) this._resendBattle(ps);
      else {
        const fid = this.watchers.get(playerId);
        if (fid) this._sendField(playerId, fid);
      }
    } else if (this.lastResultMsg) {
      this.sendTo(playerId, { ...this.lastResultMsg, playerId });
    }
    if (!was) this.markPublic();
    this.flush();
  }

  onLeave(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return;
    this.guard(() => {
      ps.left = true;
      if (this.setupVote) this.cancelSetupVote();
      ps.connected = false;
      ps._botWorker?.cancel();
      ps._botWorker = null;
      ps.autoplay = false;
      this.refreshUniteSkipVote();
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

  _quit(ps) {
    this.maybeEndInfo();
    if (!ps.alive) return;
    const phase = this.phase;
    const d = this.draft;
    if (phase === PHASE.BAND_DRAFT && d && !d.picks[ps.playerId]) {
      // the departed seat passes its turn with the default band (never one a teammate holds — defaultBand)
      const turn = this.draftTurn(ps.playerId) === ps.playerId;
      d.picks[ps.playerId] = this.defaultBand(ps.playerId);
      if (this.isEntertainmentMulti) this.draftGroup(ps.playerId).picks[ps.playerId] = d.picks[ps.playerId];
      ps.bandId = d.picks[ps.playerId];
      if (turn) this.startDraftTurn(this.draftGroup(ps.playerId));
    }
    const passedRound = phase === PHASE.SETTLE ? this.round + 1 : Math.max(1, this.round);
    const leavingBossLayers = this.isEntertainmentMulti && phase === PHASE.FINAL_ASSAULT ? ps.activatedLayers() : 0;
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
    if (this.isEntertainmentMulti) {
      if (phase === PHASE.FINAL_ASSAULT) this.hiddenLayerSum = Math.max(0, this.hiddenLayerSum - leavingBossLayers);
      if (this.bossPool && (phase === PHASE.FINAL_ASSAULT || phase === PHASE.HIDDEN_CORE) && this.alivePlayers().length) {
        const bossId = phase === PHASE.HIDDEN_CORE ? this.hiddenBossId : this.bossId;
        this.bossPool.rescale(bossPoolHp(this.gd, bossId, this.alivePlayers().length));
        this._broadcastPool(true);
      }
    }
    this.tickerText(`${ps.name}博士中途退出了模拟`, FLOW_TICKER_PRIORITY);
    if (this.bossWaves && (phase === PHASE.ROUND_START || phase === PHASE.SP_DRAFT || phase === PHASE.PREP)) {
      // before the boss fight: pair the players left again (the prep preview shows the new partner / template); a
      // player moved to the other half re-checks its board there at once (recompute → deployMap, marks it private)
      this._planBossWaves();
      for (const p of this.alivePlayers()) p.recompute();
    }
    this.markPublic();
    if (this.teamLp != null) this._syncTeamLp();
    if (!this.alivePlayers().length) {
      // only eliminated spectators are left
      this.finish({ victory: false, reason: 'eliminated' });
      return;
    }
    if (phase === PHASE.SP_DRAFT && this.sp && this.spTurn(ps.playerId) === ps.playerId) this.startSpTurn(this.spGroup(ps.playerId));
    else if (phase === PHASE.PREP) this.maybeEndPrep();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.runner) { try { this.runner.stop(); } catch { /* ignore */ } }
    this._cancelWorkerTasks();
    this._stopClientCombat();
    for (const h of this._timers) { try { this.sched.clearTimeout(h); } catch { /* ignore */ } }
    this._timers.clear();
    this.watchers.clear();
    this.observers.clear();
    if (this._pubTimer) { try { this.sched.clearTimeout(this._pubTimer); } catch { /* ignore */ } this._pubTimer = null; }
    if (this.ownsScheduler) this.sched.dispose();
  }
}
