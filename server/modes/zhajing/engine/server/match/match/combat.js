// server/match/match/combat.js — Match methods: the battles of a normal round — Battle construction (newBattle, the
// spawn list sanitised, a player's normal field after the onBattleStart handlers), the COMBAT phase in both modes
// (server-run streaming, client-side combat), the per-field results and the sim-error log, then 联防 or SETTLE.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { withBounties } from '../waves.js';
import { planUniteBySquad } from '../unite100.mjs';
import { FieldRunner, DeadBattle } from '../fields.js';
import { msg } from '../../../shared/i18n.js';
import { DELAYS, FLOW_TICKER_PRIORITY } from './common.js';

export class MatchCombat {
  /** Construct a battle; a constructor failure yields a finished stand-in (clean result) and is logged. */
  newBattle(opts) {
    const full = { data: this.ds, content: this.battleContent, logger: this.log, ...opts };
    try {
      return new this.BattleClass(full);
    } catch (e) {
      this.reportError(`battle ${opts.fieldId} construct`, e);
      return new DeadBattle(full, 'forced');
    }
  }

  /**
   * Spawn list of a field after the onBattleStart handlers (which may edit `ev.spawns`): malformed entries are dropped
   * and a kill bounty is copied into `mods.bountyCoins`, so a leaked bounty enemy keeps paying its killer in 联防.
   */
  _sanitizeSpawns(list, ownerPlayerId = null) {
    const out = [];
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || typeof s !== 'object' || typeof s.enemyKey !== 'string' || !this.gd.enemy(s.enemyKey)) continue;
      const spec = { ...s, mods: s.mods && typeof s.mods === 'object' ? { ...s.mods } : {} };
      if (ownerPlayerId && spec.ownerPlayerId == null) spec.ownerPlayerId = ownerPlayerId;
      const coins = spec.bounty && typeof spec.bounty === 'object' ? Math.trunc(Number(spec.bounty.coins) || 0) : 0;
      if (coins > 0 && spec.mods.bountyId == null && spec.mods.bountyCoins == null) spec.mods.bountyCoins = coins;
      out.push(spec);
    }
    return out;
  }

  _normalBattle(ps) { return this.newBattle(this._normalOpts(ps)); }

  /** Battle options of a player's normal field (after the onBattleStart handlers). */
  _normalOpts(ps) {
    const wave = this.wave;
    const input = ps.battleInput({ side: 'L', colOffset: 0 });
    // the client's list: bounty units inserted among their host action's own units, which are re-timed around them
    const spawns = withBounties(this.gd, this.round, wave, ps.bounties, ps.playerId).map((s) => ({ ...s, ownerPlayerId: ps.playerId }));
    const ev = { input, kind: 'normal', round: this.round, spawns };
    this.dispatch(ps, 'onBattleStart', ev);
    return {
      seed: deriveSeed(this.seed, `n:${this.round}:${ps.seat}`),
      kind: 'normal',
      modeId: this.modeId,
      round: this.round,
      stageId: this.stageId,
      rect: { ...GEO.NORMAL_RECT },
      timeLimit: wave.timeLimit,
      players: [ev.input && typeof ev.input === 'object' ? ev.input : input],
      spawns: this._sanitizeSpawns(Array.isArray(ev.spawns) ? ev.spawns : spawns, ps.playerId),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: true, ...this.gd.dp, allyScale: this.gd.allyScale, bondLayerCap: this.gd.bondLayerCap, enemyJibian: this.enemyJibianCards || [] },
      fieldId: `n:${ps.playerId}`,
      enemyOverrides: wave.overrides,
      waveId: wave.templateId,
    };
  }

  startCombat() {
    if (this.clientCombat) { this._startCombatClient(); return; }
    this.phase = PHASE.COMBAT;
    const alive = this.alivePlayers();
    this.lastResults = new Map();
    this.fields = alive.map((ps) => ({ fieldId: `n:${ps.playerId}`, kind: 'normal', players: [ps.playerId], battle: this._normalBattle(ps), live: true }));
    const limit = this.wave ? this.wave.timeLimit : 60;
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.runner = new FieldRunner(this, this.fields, { onDone: (runner) => this.combatDone(runner) });
    this.runner.start();
  }

  _startCombatClient() {
    this.phase = PHASE.COMBAT;
    const alive = this.alivePlayers();
    this.lastResults = new Map();
    this.watchers.clear();
    const fields = alive.map((ps) => this._ccField({ fieldId: `n:${ps.playerId}`, kind: 'normal', players: [ps.playerId], opts: this._normalOpts(ps) }));
    const limit = this.wave ? this.wave.timeLimit : 60;
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._launch(fields);
    // every fighting human runs its own field; eliminated humans (and spectator seats) keep watching (research 09 §3.1
    // "Keep-watching auto-observes the first available field", switching freely with 前往查看): a replica of the field
    // of the player they follow — the one they last watched, else the first player still in (item 56) — else the first
    for (const f of fields) for (const pid of f.players) {
      const ps = this.players.get(pid);
      if (!ps || ps.isBot || ps.left) continue;
      this.watchers.set(pid, f.fieldId);
      this._sendStart(pid, f);
    }
    const first = fields.find((f) => f.mode === 'client') || fields[0] || null;
    if (first) {
      for (const ps of this._viewers()) {
        if (ps.alive || this.watchers.has(ps.playerId)) continue;
        const f = this._watchTargetField(ps, fields) || first;
        this.watchers.set(ps.playerId, f.fieldId);
        this._sendStart(ps.playerId, f, { watch: true });
      }
    }
    this.markPublic();
  }

  /** Aggregate a finished field's content/engine errors (battle.errors: unique records) for diagnostics. */
  _collectSimErrors(f, res) {
    this.simErrors += Number(res && res.errors) || 0;
    const list = f && f.battle && Array.isArray(f.battle.errors) ? f.battle.errors : [];
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const key = `${e.label}|${e.who || ''}|${e.message}`;
      let rec = this.simErrorLog.get(key);
      if (!rec) {
        if (this.simErrorLog.size >= 500) continue;
        rec = { label: String(e.label), who: String(e.who || ''), message: String(e.message), stack: e.stack ? String(e.stack) : null, battles: 0, count: 0 };
        this.simErrorLog.set(key, rec);
      }
      rec.battles++;
      rec.count++;
    }
  }

  combatDone(runner) { this._finishCombat((f) => runner.resultOf(f)); }

  /** Every normal field has its result: record them, then 联防 or SETTLE. */
  _finishCombat(resultOf) {
    if (this.phase !== PHASE.COMBAT) return;
    this._stopClientCombat();
    for (const f of this.fields) {
      const res = resultOf(f);
      this._collectSimErrors(f, res);
      for (const pid of f.players) {
        const pp = res.perPlayer && res.perPlayer[pid];
        this.lastResults.set(pid, pp || { killed: 0, total: 0, leaked: [], perfect: true, layerGains: {}, coins: 0, damageDealt: 0, unitsEnd: [], unitStats: [] });
        // the views show the layers the battle reached until settle() makes them persistent (DESIGN §20.15)
        const ps = this.players.get(pid);
        // 伟大封印：本场结城理阵亡 → 本整备期这块棋子不能再上场
        const ban = (res.greatSealBans || [res.greatSealBan]).find(b => b?.playerId === pid);
        if (ps && ban && ban.playerId === pid) {
          const round = Number(ban.round) || 0;
          try {
            ps.greatSealUsed = true; // 整场比赛只触发一次
            ps.mem.greatSealBanRound = round;
            for (const piece of ps.board.values()) {
              if (piece && String(piece.chessId || piece.id).startsWith('chess_zj_60_5')) piece.greatSealBanRound = round;
            }
            for (const piece of ps.hand) {
              if (piece && String(piece.chessId || piece.id).startsWith('chess_zj_60_5')) piece.greatSealBanRound = round;
            }
            ps.dirty();
          } catch { /* 标记失败不影响结算 */ }
        }
        const gains = pp && pp.layerGains && typeof pp.layerGains === 'object' ? pp.layerGains : null;
        if (ps && gains && Object.keys(gains).length) { ps.pendingLayerGains = { ...gains }; ps.dirty(); }
      }
    }
    for (const f of this.fields) f.live = false;
    // 惊变「异戒神将」(owner 2026-10-16)：本场战斗里有敌人把伤害减免叠满 90% 时，全场播报一次
    // 「注意！有敌人适应了你的攻击」+ owner 给的专属音频（客户端 ui/ticker.js 的 `sound` 通道）。
    // 一场只播一次：`battle.yijieAdapted` 由 sim（content/ejibian.js）在正好叠满那一刻置位。
    if (this.fields.some((f) => f && f.battle && f.battle.yijieAdapted)) {
      this.tickerText(msg('注意！有敌人适应了你的攻击'), FLOW_TICKER_PRIORITY, { sound: 'yijieshenjiang' });
    }
    this.deadline = 0;
    this.markPublic();
    this.later(this.scaled(DELAYS.COMBAT_END), () => this._afterCombat());
  }

  /**
   * After the COMBAT_END pause: 联防 or SETTLE. The plan is made now, from the players still in — a player who quit
   * during the last field or the pause (中途退出 = eliminated, board cleared) is neither a helper nor a leaker whose
   * enemies re-enter.
   *
   * 100-seat variant (docs/FINDINGS-100.md §3.8): 联防 is PER SQUAD — each squad's perfect members defend that
   * squad's own leakers (阶段 1 队内兜底), and every squad with something to defend gets its own field on one shared
   * timeline. `plans` therefore replaces the upstream single room-wide plan.
   */
  _afterCombat() {
    if (this.phase !== PHASE.COMBAT) return;
    const planned = planUniteBySquad(this, this.lastResults);
    // 阶段 1 fields are only the squads that actually field somebody. A BARE relay case (no perfect member ⇒ no helpers)
    // must never start a battlefield of its own, but it MUST still reach 阶段 2 — that is the whole point of the
    // cross-squad stage, and the guard used to be `if (plans.length) … else settle`, which dropped the entire 联防 round
    // exactly when the ONLY leak was a lone squad's (5 seats: squad 0 = seats 0-3, squad 1 = seat 4 alone). It settled
    // the leak with no 联防 at all (owner's report 「五号玩家漏怪了…没有联防阶段」). `startUnite` now handles the empty
    // field list by going straight to the hand-off, so the test here is "is there anything to defend at all".
    const plans = planned.filter((p) => p && !p.relayCase);
    if (planned.length) this.startUnite(planned, 1, plans);
    else this.settle(null, null);
  }
}
