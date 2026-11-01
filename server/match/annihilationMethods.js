import { isRankedMatch } from "../../shared/ranks.js";
import { PHASE, layerGainRoom, canStackBond, GEO, ERR } from "../../shared/constants.js";
import { uniteSurvivors, plannedUniteSurvivors, planUnite, uniteBattleOpts, nextUnitePlan, uniteReserveHelpers } from "./unite.js";
import { isCyclopsBonusRound, cyclopsBonusReward, settleCyclopsHexes, cyclopsHooks } from "./cyclops.js";
import { buildResult } from "./results.js";
import { REWARD_FAILURE_TEXT } from "./rewardRecovery.js";
import { FLOW_TICKER_PRIORITY, DELAYS, POOL_MIN_GAP_MS, BOSS_CLOCK_MS, BOSS_PUBLIC_MS, BOSS_RESULT_GRACE_MS, BOSS_MIN_CLEAR_GS, BOSS_LP_BURST, BOSS_LP_PER_GS, OK, fail } from "./match/common.js";
import { onSettle, onStartUnite } from "./botEmotes.js";
import { markSend } from "../sendMetadata.js";
import { createRng, deriveSeed } from "../sim/rng.js";
import { buildBossWave, bountySpawns, withBounties } from "./waves.js";
import { pairPlayers, bossPoolHp, SharedBossPool, hiddenEligible, BOSS_HIT_STEPS, CreditPool } from "./finalAssault.js";
import { FieldRunner, HeadlessPacer, syntheticResult, BOSS_SILENCE_MS, CATCHUP_TICKS_PER_INTERVAL, DeadBattle, timelineAt, uniteBillBounds } from "./fields.js";
import { uniteLeft } from "../sim/spec.js";
import { tileKey, boardOrder, freeSlot } from "./board.js";
import { relicBountyMul, relicBountyIncome, relicBountyDeploy, relicOnSettle } from './relics.js';
export class AnnihilationMethods {
settle(plan, uniteResult) {
    if (this._statsSettledRound === this.round) return;
    this._statsSettledRound = this.round;
    this.phase = PHASE.SETTLE;
    this.runner = null;
    this._cancelWorkerTasks();
    this._stopClientCombat();
    // the pending in-battle gains the views showed become persistent below (alive players) or lapse (DESIGN §20.15)
    for (const ps of this.order) if (ps.pendingLayerGains) {
      ps.pendingLayerGains = null;
      try { ps.dirty(); } catch (e) { this.reportError(`settle dirty R${this.round} player ${ps.playerId}`, e); }
    }
    const cap = this.gd.lpCapPerRound;
    // a 联防 battle that could not run at all (synthetic result) must not wipe the leakers' losses: charge their own leaks
    const uniteRan = !!(plan && uniteResult && !uniteResult.synthetic);
    const survivors = uniteRan ? uniteSurvivors(plan, uniteResult)
      : this.isEntertainmentMulti && plan ? plannedUniteSurvivors(plan) : null;
    const uniteWaves = this.isEntertainmentMulti ? [...(plan?.history || []), uniteResult].filter((r) => r && !r.synthetic)
      : uniteResult ? [uniteResult] : [];
    if (this.isEntertainmentMulti && plan) this.uniteResultView = {
      rounds: plan.round, roundsMax: plan.roundsMax, skipped: plan.skipRemaining,
      helpers: [...plan.usedHelpers, ...plan.helpers].map((p) => p.playerId), survivors: Object.fromEntries(survivors || []),
      leakers: plan.leakers.map((p) => p.playerId), losses: {},
      through: plan.leakers.reduce((n, p) => n + (survivors?.get(p.playerId) || 0), 0),
    };
    const alive = this.alivePlayers();
    // 本回合中途退出的玩家也保留已产生的个人有效伤害，不因退出丢失或复制给队友。
    for (const ps of this.order) {
      try {
        const r = this.lastResults.get(ps.playerId);
        if (r && !r.synthetic) ps.stats.rankedDamage += Number(r.rankedDamage) || 0;
        for (const wave of uniteWaves) {
          const up = wave.perPlayer?.[ps.playerId];
          if (up && !wave.synthetic) ps.stats.rankedDamage += Number(up.rankedDamage) || 0;
        }
      } catch (e) { this.reportError(`settle rankedDamage R${this.round} player ${ps.playerId}`, e); }
    }
    for (const ps of alive) {
      // The round-wide once guard stays set even when a player fails after partial mutation. Never repay earlier
      // players or this player's already-applied rewards; isolate at the independent player boundary instead.
      try {
        const r = this.lastResults.get(ps.playerId) || { leaked: [], perfect: true, coins: 0, layerGains: {}, killed: 0, damageDealt: 0 };
        const counted = (r.leaked || []).filter((l) => l && l.counted !== false).length;
        let loss = survivors && plan.leakers.includes(ps) ? Math.min(cap, survivors.get(ps.playerId) || 0) : Math.min(cap, counted);
        if (this.isCyclops && !isCyclopsBonusRound(this.round) && counted > 0 && loss > 0 && ps.cyclopsStreak < 0 && cyclopsHooks(ps, 'cyc_streak').some(e => e.data.quality === 'prismatic')) loss = Math.max(1, loss - 2);
        if (this.isEntertainmentMulti && this.uniteResultView) this.uniteResultView.losses[ps.playerId] = loss;
        ps.lp -= loss;
        ps.stats.lpLost += loss;
        ps.stats.leaks += counted;
        ps.stats.kills += Number(r.killed) || 0;
        ps.stats.dmgDealt += Number(r.damageDealt) || 0;
        ps.stats.healing += Number(r.healingDone) || 0;
        if (r.perfect !== false && counted === 0) ps.stats.perfectRounds++;
        // bounty coins (own battle + unite kills) are credited to the next prep
        let coins = Math.max(0, Math.trunc(Number(r.coins) || 0));
        const ups = uniteWaves.map((wave) => wave.perPlayer?.[ps.playerId]).filter(Boolean);
        const up = ups[0];
        for (const part of ups) {
          coins += Math.max(0, Math.trunc(Number(part.coins) || 0));
          ps.stats.dmgDealt += Number(part.damageDealt) || 0;
          ps.stats.kills += Number(part.killed) || 0;
          if (this.isEntertainmentMulti) ps.stats.healing += Number(part.healingDone) || 0;
        }
        // 一回合只记一次，联防不是新回合；没真正运行的占位结果不能凭空得到完美分。
        if (ps.lp > 0 && this.lastResults.has(ps.playerId) && !r.synthetic) ps.stats.survivalRounds++;
        const noLeak = (x) => x && x.perfect !== false && !(x.leaked || []).some((l) => l && l.counted !== false)
          && !(Number(x.leaderLpLoss) > 0);
        if (r.rankedStatsValid && noLeak(r) && (!up || (up.rankedStatsValid && noLeak(up))) && loss === 0
          && !r.synthetic && !uniteResult?.synthetic) ps.stats.rankedPerfectRounds++;
        // 舟铲铲基础连胜/连败：奖励关保留原战绩，不推进、不打断，也不另发基础连胜连败金币。
        const previousCyclopsStreak = ps.cyclopsStreak;
        if (this.isCyclops && !isCyclopsBonusRound(this.round) && this.lastResults.has(ps.playerId) && !r.synthetic) {
          const won = noLeak(r);
          const previous = ps.cyclopsStreak;
          ps.cyclopsStreak = won ? Math.max(0, previous) + 1 : Math.min(0, previous) - 1;
          const streak = Math.abs(ps.cyclopsStreak);
          const bonus = streak >= 6 ? 3 : streak >= 4 ? 2 : streak >= 2 ? 1 : 0;
          coins += bonus;
          if (bonus) this.toast(ps, 'ok', `${won ? '连胜' : '连败'}${streak}回合：下次备战额外获得${bonus}金币`);
        }
        // perfect-payout bounties (战术特训): own phase perfect
        for (const b of ps.bounties) if (b.card.payout === 'perfect' && counted === 0 && r.perfect !== false) coins += b.card.coin;
        // 独眼巨人冲锋奖励关（4/8/12/16，无联防）：按击杀数分级赠装
        //   击杀 <5：无奖励；5~9：1 件；10 只全灭（不漏）：2 件。装备品阶 2/3/4/5。
        if (this.isCyclops && isCyclopsBonusRound(this.round)) {
          const total = Math.max(0, Math.trunc(Number(r.total) || 0));
          const killed = Math.max(0, Math.trunc(Number(r.killed) || 0));
          let gifts = 0;
          if (killed >= total && total > 0) gifts = 2;           // 全部打死
          else if (killed >= 5) gifts = 1;                       // 打死 5-9 只
          for (let i = 0; i < gifts; i++) {
            const itemId = cyclopsBonusReward(this.gd, this.rngMeta, this.itemPool, this.round);
            if (!itemId) break;
            const piece = ps.acquireItem(itemId, { source: 'cyclops', deferMerge: true });
            if (piece) this.toast(ps, 'ok', `奖励关战利品（击杀 ${killed}/${total}）：获得「${this.gd.item(itemId)?.name || itemId}」`);
          }
          if (!gifts && killed > 0) this.toast(ps, 'warn', `奖励关击杀不足（${killed}/10），未获得赠礼`);
        }
        coins = Math.round(coins * relicBountyMul(ps));
        relicBountyIncome(ps, coins);
        if (coins > 0) { ps.pendingFunds += coins; ps.stats.fundsGained += coins; }
        for (const b of ps.bounties) b.roundsLeft--;
        ps.bounties = ps.bounties.filter((b) => b.roundsLeft > 0);
        // IN_BATTLE layer gains (normal battles only), at most the room left under BOND_LAYER_CAP (999, as the battle's
        // live copy: Battle.addLayers); a bond at the cap gains nothing and dispatches nothing
        for (const [bondId, n] of Object.entries(r.layerGains || {})) {
          if (!this.gd.bond(bondId) || !canStackBond(bondId) || !(n > 0)) continue;
          const before = ps.layers[bondId] || 0;
          const add = layerGainRoom(before, Math.floor(n), this.gd.endless ? Infinity : undefined);
          if (!(add > 0)) continue;
          ps.layers[bondId] = before + add;
          this.dispatch(ps, 'onLayers', { bondId, from: before, to: ps.layers[bondId], reason: 'battle' });
        }
        if (this.isCyclops && this.lastResults.has(ps.playerId)) settleCyclopsHexes(this, ps, r, noLeak(r), previousCyclopsStreak);
        try { this._charDamageTickers(ps, r); }
        catch (e) { this.reportError(`settle ticker R${this.round} player ${ps.playerId}`, e); }
        this.dispatch(ps, 'onBattleResult', { result: r, lpLoss: loss, perfect: counted === 0 && r.perfect !== false, unite: uniteResult || null, ...(this.isEntertainmentMulti ? { uniteResults: uniteWaves } : {}) });
        relicBountyDeploy(ps, Number(r.bountyKills) || 0);
        relicOnSettle(ps);
        ps.recompute();
      } catch (e) { this.reportError(`settle R${this.round} player ${ps.playerId}`, e); }
    }
    let eliminationFailed = false;
    for (const ps of alive) {
      if (ps.lp <= 0) {
        try {
          ps.lp = 0;
          ps.eliminate(this.round);
        } catch (e) {
          // If eliminate itself failed, its pool/inventory cleanup may be partial. Healthy players still finish,
          // but do not launch another round from an invalid elimination state or retry already-paid settlement.
          eliminationFailed = true;
          this.reportError(`settle eliminate R${this.round} player ${ps.playerId}`, e);
          continue;
        }
        try {
          this.toast(ps, 'error', '你的目标生命值耗尽，已被淘汰');
          this.tickerText(`${ps.name}博士的目标生命值已耗尽`, FLOW_TICKER_PRIORITY);
        } catch (e) { this.reportError(`settle eliminate notice R${this.round} player ${ps.playerId}`, e); }
      }
    }
    this.fields = [];
    this.watchers.clear();
    this.markPublic();
    try { onSettle(this); } catch (e) { this.reportError(`settle emotes R${this.round}`, e); }
    if (eliminationFailed) {
      // A partial inventory/pool cleanup cannot safely start another round, but must not leave SETTLE locked.
      this._settlementAbort = { playerId: null, stage: 'eliminate', code: 'RESULT_ELIMINATION_FAILED' };
      this.finish({ victory: false, reason: 'settlement_error' });
      return;
    }
    this.setDeadline(DELAYS.SETTLE / 1000, () => this.afterSettle(), { silent: this.soloUntimed });
  }
startFinalAssault(hidden) {
    const alive = this.alivePlayers();
    if (!alive.length) { this.finish({ victory: false, reason: 'eliminated' }); return; }
    this.phase = hidden ? PHASE.HIDDEN_CORE : PHASE.FINAL_ASSAULT;
    this.lastResults = new Map();
    // Every annihilation leader round has its own prep; include that prep's LP changes.
    this.teamLp = alive.reduce((s, p) => s + Math.max(0, p.lp), 0);
    for (const ps of alive) ps.lpAtFinal = Math.max(0, ps.lp);
    const bossId = hidden ? this.hiddenBossId : this.endlessBossPlan(this.round)?.bossId || this.bossId;
    // BOSS_HIT tickers ("对敌方领袖造成的伤害超过20% / 50% / 80%"): the player's damage to THIS leader over its pool —
    // the pool's own per-player tally, one pool per boss round. stats.bossDamage (the result's 领袖伤害) adds up both
    // rounds, so it would credit the Final Assault's damage to the hidden leader ("隐藏boss还没打就出了50%播报").
    const hitSteps = new Map();
    const pool = new SharedBossPool(bossPoolHp(this.gd, bossId, alive.length) * this.endlessMul(this.round), {
      onHit: (pid, dmg) => {
        const ps = this.players.get(pid);
        if (!ps) return;
        ps.stats.bossDamage += dmg;
        ps.stats.rankedDamage += dmg; // 只取已确认个人血池credit，最终结果不再重复叠Boss伤害。
        const share = (pool.byPlayer.get(pid) || 0) / pool.maxHp;
        const done = hitSteps.get(pid) || 0;
        let reached = done;
        BOSS_HIT_STEPS.forEach((s, i) => { if (share >= s) reached = Math.max(reached, i + 1); });
        if (reached > done) {
          hitSteps.set(pid, reached);
          this.tickerFor('BOSS_HIT', [ps.name], { playerId: pid, param: String(BOSS_HIT_STEPS[reached - 1]) });
        }
      },
    });
    this.bossPool = pool;
    const groups = pairPlayers(alive);
    const reuse = this.bossWaves && this.bossWaves.length === groups.length && this.bossWaves.every((w, i) => w.players.join() === groups[i].map((p) => p.playerId).join());
    this.fields = groups.map((g, i) => {
      const solo = this.isSolo || g.length === 1;
      const wave = reuse ? this.bossWaves[i].wave : buildBossWave(this.gd, this.rngWaves, this.factions, this.round, { bossId, solo });
      // one spawn list per field, shared by the field's players' onBattleStart handlers (edit it in place)
      const spawns = wave.spawns.map((s) => ({ ...s, mods: s.mods ? { ...s.mods } : undefined }));
      // bounties with battles left (a multi-round card lasts MULTI_ROUND_BOUNTY_BATTLES) follow their player into the
      // boss field, on the player's half
      g.forEach((ps, j) => {
        for (const b of bountySpawns(this.gd, this.round, wave, ps.bounties, ps.playerId, { solo: this.isSolo, side: j === 0 ? 'L' : 'R' })) spawns.push(b);
      });
      const inputs = g.map((ps, j) => {
        const input = ps.battleInput({ side: j === 0 ? 'L' : 'R', colOffset: j === 0 ? 0 : 8 });
        input.lpForBoss = this.teamLp;
        // `side` + `routes`: the player's half of a pair field (spawn-list edits for one player, e.g. 鸭爵's swap)
        const ev = { input, kind: hidden ? 'hidden' : 'boss', round: this.round, spawns, routes: wave.routes, side: g.length > 1 ? (j === 0 ? 'L' : 'R') : null };
        this.dispatch(ps, 'onBattleStart', ev);
        return ev.input && typeof ev.input === 'object' ? ev.input : input;
      });
      const fieldId = `b${i + 1}`;
      const bopts = {
        seed: deriveSeed(this.seed, `${fieldId}:${this.round}`),
        kind: hidden ? 'hidden' : 'boss',
        modeId: this.modeId,
        round: this.round,
        stageId: this.stageId,
        rect: { ...GEO.BOSS_RECT },
        timeLimit: Infinity,
        players: inputs,
        spawns: this._sanitizeSpawns(spawns),
        routes: wave.routes,
        sharedBoss: this.bossPool,
        flags: { layerGainsEnabled: false, uncappedBondLayers: this.gd.endless, uncappedNumericValues: this.isEndless, ...this.gd.dp, ...this.gd.annihilationFlags(hidden ? 'hidden' : 'boss', this.round), enemyScale: this.gd.enemyScale(this.round), ...(this.isEntertainmentMulti ? { entertainmentMulti: true } : {}) },
        fieldId,
        enemyOverrides: wave.overrides,
        waveId: wave.templateId,
        bossId,
      };
      if (this.clientCombat) return { fieldId, kind: hidden ? 'hidden' : 'boss', players: g.map((p) => p.playerId), opts: bopts, battle: null, live: true };
      const battle = this.newBattle(bopts);
      try {
        battle.on('enemyLeak', (ctx) => this._bossLeak(ctx && ctx.enemy), { priority: -1000, owner: 'match' });
        // leader "扣除目标生命" effects (boss_7 Doom, 斥退 …: server/sim/content/bosses.js lpLoss) hit the team pool
        battle.on('lpLoss', (ctx) => this._teamLpLoss(ctx && ctx.amount), { priority: -1000, owner: 'match' });
      } catch (e) { this.reportError('boss leak hook', e); }
      return { fieldId, kind: hidden ? 'hidden' : 'boss', players: g.map((p) => p.playerId), battle, live: true };
    });
    this.overtimeApplied = 0;
    // HUD: the boss level's countdown (maxPlayTime, 120 real s — the battle goes on past it) and the moment the
    // overtime drain starts (150 real s), both on the field clock
    const onClock = (realS) => this.sched.now() + Math.round(((realS * this.gd.combatTimeScale) / this.gameSpeed) * 1000);
    const levelTime = this.gd.bossLevelTime(this.round);
    this.deadline = this.sched.instant || !levelTime ? 0 : onClock(levelTime);
    const team = this.order.filter((p) => !p.left);
    this.bossOvertimeStartReal = team.length > 1 && team.some((p) => p.isBot)
      ? this.gd.bossOvertimeAfterReal : (levelTime || this.gd.bossOvertimeAfterReal);
    this.overtimeAt = this.sched.instant ? 0 : onClock(this.bossOvertimeStartReal);
    if (this.clientCombat) { this._startFinalClient(hidden); return; }
    this._defaultWatch();
    this.markPublic();
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._bossTick(runner),
      onDone: (runner) => this._finalDone(runner, hidden),
    });
    this.runner.start();
  }
_finishFinal(hidden, resultOf) {
    if (this.phase !== (hidden ? PHASE.HIDDEN_CORE : PHASE.FINAL_ASSAULT) || this._finalStatsRound === this.round) return;
    this._finalStatsRound = this.round;
    this._stopClientCombat();
    for (const f of this.fields) {
      const res = resultOf(f);
      this._collectSimErrors(f, res);
      f.live = false;
      for (const pid of f.players) {
        const pp = res.perPlayer && res.perPlayer[pid];
        const ps = this.players.get(pid);
        if (pp) this.lastResults.set(pid, pp);
        if (pp && ps) {
          ps.stats.dmgDealt += Number(pp.damageDealt) || 0;
          ps.stats.rankedDamage += Number(pp.rankedDamage) || 0;
          if (ps.alive && this.teamLp > 0 && !res.synthetic) ps.stats.survivalRounds++;
          const noLeak = !(pp.leaked || []).some((l) => l && l.counted !== false);
          if (ps.alive && this.teamLp > 0 && (this._finalEnding ? this._finalEnding === 'cleared' : this.bossPool.hp <= 0)
            && pp.rankedStatsValid && !res.synthetic && noLeak && pp.perfect !== false
            && !(pp.leaderLpLoss > 0) && !(this.overtimeApplied > 0)) ps.stats.rankedPerfectRounds++;
          ps.stats.kills += Number(pp.killed) || 0;
          ps.dirty(); // m.private.stats
          this._charDamageTickers(ps, pp);
        }
        if (pp && ps) this._settleBossBounties(ps, pp);
        if (pp && ps) this.dispatch(ps, 'onBattleResult', { result: pp, lpLoss: 0, perfect: !!pp.perfect, boss: true });
      }
    }
    // the end condition the server registered first decides (client-side combat: _endFinal — pool 0 → victory, team LP 0
    // → defeat); a boss field's final result may never turn a defeat into a victory (user playtest #6 item 5)
    const victory = this._finalEnding ? this._finalEnding === 'cleared' : this.bossPool.hp <= 0;
    this._syncTeamLp();
    // Apply LP relics after the shared pool has been apportioned, not before it overwrites ps.lp.
    for (const ps of this.alivePlayers()) relicOnSettle(ps);
    this.teamLp = this.alivePlayers().reduce((sum, ps) => sum + Math.max(0, ps.lp), 0);
    this.deadline = 0;
    this.overtimeAt = 0;
    this.markPublic();
    this.runner = null;
    if (!hidden) {
      const next = this.gd.hiddenAfter(this.round);
      const eligible = victory && !!next && (this.gd.endless || (!!this.hiddenBossId && hiddenEligible(this.gd, { layerSum: this.hiddenLayerSum, teamLp: this.teamLp, playerCount: this.alivePlayers().length })));
      if (!eligible) return this.finish({ victory, reason: victory ? 'victory' : 'defeat' });
      this.later(this.scaled(DELAYS.SETTLE), () => {
        if (this.disposed || this.ended) return;
        this.hiddenReached = true; this.bossPool = null; this._finalEnding = null;
        this.teamLp = null;
        for (const ps of this.order) ps.lpAtFinal = null;
        this.tickerText('隐秘核心已解锁', FLOW_TICKER_PRIORITY);
        this.startRound(next);
      });
    } else {
      if (!victory) return this.finish({ victory: false, reason: 'defeat' });
      if (this.gd.isLastHidden(this.round)) return this.finish({ victory: true, hiddenCleared: true, reason: 'victory' });
      this.later(this.scaled(DELAYS.SETTLE), () => {
        if (this.disposed || this.ended) return;
        this.hiddenReached = false; this.hiddenLayerSum = 0; this.bossPool = null;
        this.teamLp = null;
        for (const ps of this.order) ps.lpAtFinal = null;
        this._finalEnding = null; this.bossIdForRound = null;
        this.tickerText('作战继续', FLOW_TICKER_PRIORITY);
        this.startRound(this.round + 1);
      });
    }
  }
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
      flags: { layerGainsEnabled: true, ...this.gd.dp, ...this.gd.annihilationFlags('normal', this.round), uncappedBondLayers: this.gd.endless, uncappedNumericValues: this.gd.endless },
      fieldId: `n:${ps.playerId}`,
      enemyOverrides: wave.overrides,
      waveId: wave.templateId,
    };
  }
_uniteOpts(plan, limit) {
    const { wave, players } = uniteBattleOpts(this, plan, limit);
    return {
      seed: deriveSeed(this.seed, plan.round > 1 ? `u:${this.round}:${plan.round}` : `u:${this.round}`),
      kind: 'unite',
      modeId: this.modeId,
      round: this.round,
      stageId: this.stageId,
      rect: { ...GEO.UNITE_RECT },
      timeLimit: limit,
      players,
      spawns: this._sanitizeSpawns(wave.spawns),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: false, ...this.gd.dp, ...this.gd.annihilationFlags('unite', this.round), uncappedBondLayers: this.gd.endless, uncappedNumericValues: this.gd.endless },
      fieldId: 'u',
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
    };
  }
  isBossRound(round) { return this.gd.isBossRound(round); }
  endlessMul() { return 1; }
  endlessBossPlan() { return null; }
  _planBossWaves() {
    const hidden = this.gd.isHiddenRound(this.round);
    const weights = this.gd.bossWeights(hidden);
    let roll = this.rngMeta() * weights.reduce((sum, [, weight]) => sum + Number(weight), 0);
    let bossId = weights.at(-1)?.[0] || (hidden ? this.hiddenBossId : this.bossId);
    for (const [id, weight] of weights) { roll -= Number(weight); if (roll < 0) { bossId = id; break; } }
    if (hidden) this.hiddenBossId = bossId; else this.bossId = bossId;
    this.bossIdForRound = bossId;
    this.bossWaves = pairPlayers(this.alivePlayers()).map(group => ({
      players: group.map(p => p.playerId),
      wave: buildBossWave(this.gd, this.rngWaves, this.factions, this.round, { bossId, solo: this.isSolo || group.length === 1 }),
    }));
  }
}
export class AnnihilationPlayer {
stow(piece, { allowTemp = true, toTemp = false, preferIdx = null } = {}) {
    const unlimitedItem = piece.kind === 'item' && !this.m.ranked && (
      this.m.variant === 'entertainment_multi' ||
      this.m.variant === 'entertainment_cyclops' ||
      this.m.variant === 'entertainment_endless'
    );
    // A legacy bot may detach a hand item before trying to free a slot. Keep
    // that item in the finite hand instead of parking it in ordinary temp.
    if (toTemp && piece.kind === 'item' && !unlimitedItem && this.botControlled) {
      const i = freeSlot(this.hand);
      if (i >= 0) { this.hand[i] = piece; return 'hand'; }
    }
    if (!toTemp) {
      if (Number.isInteger(preferIdx) && preferIdx >= 0 && preferIdx < this.hand.length && this.hand[preferIdx] == null) {
        this.hand[preferIdx] = piece;
        return 'hand';
      }
      const i = freeSlot(this.hand);
      if (i >= 0) { this.hand[i] = piece; return 'hand'; }
      if (!allowTemp && piece.kind !== 'item') return null;
    }
    if (this.relics?.flags.tempDisabled) return null;
    const j = freeSlot(unlimitedItem ? this.temp : this.temp.slice(0, this.gd.tempSize));
    if (j >= 0) { this._putTemp(j, piece); return 'temp'; }
    if (unlimitedItem) { this._putTemp(this.temp.length, piece); return 'temp'; }
    return null;
  }
}
