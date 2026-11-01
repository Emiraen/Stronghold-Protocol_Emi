// server/match/match/unitePhase.js — Match methods: 联防 glue (the rules: server/match/unite.js) — the UNITE phase in
// both modes (the 联防 field from the helpers' carried state and the leakers' enemies), its end, and the leakers' live
// counts (_uniteLeft, user playtest #6 item 7; _uniteTick in the server-run mode).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { uniteBattleOpts, uniteSurvivors, combineUniteResults } from '../unite.js';
import { takeUnhandled, planRelayBySquad, relayPlanFor, squadsOf, squadStrength } from '../unite100.mjs';
import { FieldRunner, timelineAt, uniteBillBounds } from '../fields.js';
import { uniteLeft } from '../../sim/spec.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from './common.js';
import { msg } from '../../../shared/i18n.js';

export class MatchUnite {
  /**
   * 联防 (100-seat variant, docs/FINDINGS-100.md §3.8): ONE FIELD PER SQUAD.
   *
   * Upstream takes a single room-wide plan and builds the single field 'u'. Here `plans` is the per-squad list from
   * unite100.js planUniteBySquad — each squad defends its OWN leakers with its OWN perfect members (阶段 1 队内兜底).
   * Every plan gets its own field (`u<squad>`), all fields step in lockstep in one FieldRunner, and the phase ends
   * when ALL of them are done ("队内等待完毕后等待其他小队") — FieldRunner._finish fires only when every field is not
   * live, so that semantic comes for free.
   *
   * @param {Array<object>|object} plans one plan (upstream shape) or the per-squad list
   * @param {number} [round] 1 (阶段 1) or 2 (阶段 2 relay)
   * @param {Array<object>} [fieldPlans] what to actually RUN as fields. Defaults to `plans`. It differs when 阶段 2 has
   *        to see a squad that fields nobody: a BARE relay case (`relayCase`, no helpers ⇒ no field) is carried in
   *        `plans` for the hand-off but must never be started as a battlefield of its own.
   */
  startUnite(plans, round = 1, fieldPlans = null) {
    const list = (Array.isArray(plans) ? plans : [plans]).filter(Boolean);
    if (!list.length) { this.settle(null, null); return; }
    const fields = (Array.isArray(fieldPlans) ? fieldPlans : list).filter(Boolean);
    // The hand-off list (what 阶段 2 must consider) is kept apart from the field list, and results are paired with their
    // plans by identity — never by index, which would silently mis-pair the moment one plan has no field.
    this._uniteHandoff = list;
    // The ROUND must come from the caller: resetting it to 1 here clobbered the `uniteRound = 2` that _afterUniteRound
    // set for 阶段 2, so every round end believed it was still phase 1 and started ANOTHER unite round — an unbounded
    // re-entry that re-ran takeUnhandled over relay plans and mixed squads' charges (the 16-seat defect).
    this.uniteRound = Number.isInteger(round) && round > 0 ? round : 1;
    this._uniteToken = (this._uniteToken || 0) + 1;   // one token per 联防 round (see _afterUniteRound idempotence)
    if (!fields.length) {
      // NOBODY can field a 阶段 1 battlefield: every squad that leaked has no perfect member, so planUniteBySquad yielded
      // BARE relay cases only. Settling here — which is what this used to do — threw away the entire 联防, and with it
      // 阶段 2, the one stage a bare case exists for. Their enemies all survive by definition (nothing was sent to hold
      // them), so hand the plans straight to the post-round hook with NO results and let `takeUnhandled` carve them out
      // for the relay. (Owner's report 「五号玩家漏怪了…没有联防阶段」 — 5 seats = squad 0 (0-3) + a lone seat 4.)
      //
      // `phase` / `uniteRound` must be set BEFORE the hook runs: `_enterRelayBattlefield` launches the second
      // battlefield from a `later(0)` callback guarded by `phase === PHASE.UNITE && uniteRound === 1`.
      //
      // A real, MERGED plan — never `null`: `_finishRelayBattlefield` merges phase 1 back in by identity, and a null
      // would also be skipped by combineUniteResults' `filter(Boolean)` while its results array is not filtered.
      const merged = combineUniteResults(list, []).plan;
      this.unitePlans = [];
      this.unitePlan = list[0];           // kept for the single-plan consumers (statusOf / legacy views)
      this.deadline = 0;
      this.phase = PHASE.UNITE;
      this.markPublic();
      this.later(this.scaled(DELAYS.COMBAT_END), () => this._afterUniteRound(merged, null, list, [], new Map()));
      return;
    }
    if (this.clientCombat) { this._startUniteClient(fields); return; }
    this.phase = PHASE.UNITE;
    this.unitePlans = fields;
    this.unitePlan = fields[0];            // kept for the single-plan consumers (statusOf / legacy views)
    const limit = this.wave ? this.wave.timeLimit : 60;
    this.fields = fields.map((plan) => {
      const fieldId = fields.length === 1 ? 'u' : `u${plan.squad ?? 0}`;
      return {
        fieldId, kind: 'unite', players: plan.helpers.map((p) => p.playerId),
        // ★ 2026-10-26：把 leakers 也记在战场上 —— 漏怪的人不在 players（那是兜底干员）里，
        //   默认观战/fieldOf 找不到自己的战场，就会跳到别人的联防去。只做归属标记，不参与 sides/战斗。
        leakers: plan.leakers.map((p) => p.playerId),
        battle: this.newBattle(this._uniteOpts(plan, limit, fieldId)), live: true,
      };
    });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    const names = list.flatMap((p) => p.helpers.map((h) => h.name));
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names }), FLOW_TICKER_PRIORITY);
    this._uniteLeftKey = null;
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE) return;
        const results = this.fields.map((f) => {
          const res = runner.resultOf(f);
          this._collectSimErrors(f, res);
          f.live = false;
          return res;
        });
        this.deadline = 0;
        this.markPublic();
        const combined = combineUniteResults(fields, results);
        // Pair each RESULT with the plan that produced it. `list` can carry plans with no field (a bare relay case),
        // so an index into `results` would mis-pair every plan after the first one that did not run.
        const byPlan = new Map(fields.map((p, i) => [p, results[i] || null]));
        this.later(this.scaled(DELAYS.COMBAT_END), () => this._afterUniteRound(combined.plan, combined.result, list, results, byPlan));
      },
    });
    this.runner.start();
  }

  /**
   * After one 联防 round: 阶段 2 (跨队兜底) or settlement.
   *
   * First round: carve the UNHANDLED enemies out of every squad's outcome (unite100.takeUnhandled) — those are what got
   * through — pick a receiving squad per relaying squad by remaining strength (planRelayBySquad) and run a SECOND 联防
   * round with those receivers. A relaying squad whose enemies have no relayable form (unknown enemy keys) settles them
   * directly, as does every relay that found no receiver.
   *
   * Second round: settlement. Whatever the receivers did not stop is billed to the ORIGINAL source players
   * (relayPlanFor keeps them as `leakers`), which is the owner's rule "第二波也没兜住时，漏怪就此结算扣 LP".
   */

  /**
   * After one 联防 round: 阶段 2 (跨队兜底) or settlement.
   *
   * First round: carve the UNHANDLED enemies out of every squad's outcome (unite100.takeUnhandled) — those are what got
   * through — pick a receiving squad per relaying squad by remaining strength (planRelayBySquad) and run a SECOND 联防
   * round with those receivers. A relaying squad whose enemies have no relayable form (unknown enemy keys) settles them
   * directly, as does every relay that found no receiver.
   *
   * Second round: settlement. Whatever the receivers did not stop is billed to the ORIGINAL source players
   * (relayPlanFor keeps them as `leakers`), which is the owner's rule "第二波也没兜住时，漏怪就此结算扣 LP".
   */
  _afterUniteRound(plan, result, plans, results, byPlan = null) {
    // 100-seat 联防 has two stages (owner's rules):
    //   阶段 1 队内兜底  — every squad defends its OWN leakers with its OWN perfect members (the fields started by
    //                      startUnite(plans, 1)).
    //   阶段 2 跨队串联兜底 — what a squad could not stop is handed to ONE other squad, which defends it on ITS own
    //                      field (relayBattlefield) or with a synchronous check (atomic mode).
    //
    // RE-ENTRANCY is what made the original 阶段 2 fail: this hook can fire more than once for the same round (a squad's
    // field finishes first, then the runner finishes), and the second call re-carved the RELAY plans as if they were
    // 阶段 1 — mixing squads' charges, the 16-seat defect. Two independent guards now prevent it:
    //   * `uniteRound` — a phase-2 finish settles; it never plans another round;
    //   * `_phase1Driven` — a round number may be planned exactly once, no matter how often this hook fires.
    if (this.uniteRound !== 1) { this.settle(plan, result); return; }
    if (this._phase1Driven === this.round) return;      // already planned for this round: nothing more to do
    this._phase1Driven = this.round;
    // `byPlan` pairs a plan with the result it actually produced; a plan with no field (bare relay case) has none, and
    // its leaks are then counted straight from the plan by takeUnhandled. Index pairing is only the legacy fallback.
    const phase1 = plans.map((p, i) => {
      const res = (byPlan && byPlan.has(p)) ? byPlan.get(p) : (results[i] || null);
      return { plan: p, result: res, unhandled: takeUnhandled(this.gd, p, res) };
    });
    const settledBy = new Map();
    for (const p of phase1) for (const [pid, n] of (p.unhandled.settledBy || [])) settledBy.set(pid, (settledBy.get(pid) || 0) + n);
    const anyUnhandled = phase1.some((p) => p.unhandled.relayable > 0);
    const relays = anyUnhandled ? planRelayBySquad(this, phase1, this.lastResults) : [];
    if (!relays.length) { this.settle(plan, result); return; }

    // 阶段 2 as a REAL second battlefield (config.unite.relayBattlefield): each receiver defends the relayed enemies on
    // its own field, and the phase settles when that round finishes (see _finishRelayBattlefield). `sourcePlayerId`
    // travels with every relayed enemy (relayLeak), so a leak that gets through again is still billed to the player who
    // originally let it past — exactly as the atomic path does.
    if (this.gd.unite.relayBattlefield) { this._enterRelayBattlefield(plan, result, relays, settledBy); return; }

    // Atomic fallback: the helpers are credited with defending without a field. Their remaining strength decides how
    // much they stop (the same `standing`-first strength that picked them). What they cannot stop is added straight back
    // to the source players' charge. `planRelayBySquad` already built the merged plan (helpers + every squad's
    // leftovers), so there is nothing left to look up here.
    const extraLeaked = [];
    const extraLeakers = new Set();
    for (const r of relays) {
      const rp = (r && r.plan) || null;
      if (!rp || !rp.helpers.length) continue;            // nobody left to send: the enemies settle
      const held = this._relayHeld(rp);
      const unhandled = rp.leaked.slice(held);            // what the helpers could not stop
      for (const l of unhandled) { extraLeaked.push(l); extraLeakers.add(l.sourcePlayerId); }
    }
    if (extraLeaked.length) {
      const sources = this.order.filter((ps) => extraLeakers.has(ps.playerId));
      this.settle(
        { helpers: plan.helpers, leakers: [...plan.leakers, ...sources], leaked: [...plan.leaked, ...extraLeaked], notReentered: plan.notReentered },
        result,
      );
      return;
    }
    this.settle(plan, result);
  }

  /**
   * 阶段 2: start the relay battlefield — one field per receiving squad, exactly like 阶段 1.
   *
   * The relay plans come from relayPlanFor, which gives the receiver's own perfect members and keeps every relayed
   * enemy's original `sourcePlayerId`. Field ids get an `r` prefix (`r<squad>`) so they can never collide with the
   * phase-1 `u<squad>` ids in `this.fields`, and `uniteRound = 2` makes the round-end hook settle instead of planning
   * another round.
   *
   * @param {object} plan the combined phase-1 plan (what settlement bills if nothing else happens)
   * @param {object|null} result the combined phase-1 result
   * @param {Array<{ to: number, plan: object }>} relays
   */
  _enterRelayBattlefield(plan, result, relays, settledBy = null) {

    // ONE relay battlefield for the whole room (owner's rule): every squad's leftovers go to the same two helpers, which
    // fight them together. `planRelayBySquad` already merged them and picked the helpers, so this only has to drop a
    // plan that ended up with nobody to send (those enemies settle instead).
    const list = [];
    for (const r of relays) {
      const rp = (r && r.plan) || null;
      if (!rp || !rp.helpers || !rp.helpers.length) continue;
      list.push(rp);
    }
    if (!list.length) { this.settle(plan, result); return; }
    // Remember what phase 1 produced: if the relay cannot be fought (or the round is interrupted) settlement still has
    // to bill phase 1's leaks, not lose them.
    this._phase1Settle = { plan, result, settledBy: settledBy instanceof Map ? settledBy : new Map() };
    this.relayPlans = list;
    this._relayToken = (this._relayToken || 0) + 1;
    const token = this._relayToken;
    const names = list.flatMap((p) => p.helpers.map((h) => h.name));
    this.tickerText(msg('跨队兜底：{names} 接手全房间的漏怪', { names }), FLOW_TICKER_PRIORITY);
    // `later(0)` defers the launch out of this finish hook: _finishUniteClient is still unwinding, and starting fields
    // inside it is what let the old implementation fire the round-end hook again mid-round.
    this.later(0, () => {
      if (token !== this._relayToken) return;             // superseded (a newer round started)
      if (this.phase !== PHASE.UNITE || this.uniteRound !== 1) return;
      this.startUnite(list, 2);
    });
  }

  /**
   * 阶段 2 is over: settle. The relay fields' own result is what the receiving squads stopped; whatever got past them
   * again is billed to the enemy's original leaker through `takeUnhandled` + `uniteSurvivors`, because every relayed
   * leak kept its `sourcePlayerId`. Phase 1's outcome is merged back in so its leaks can never be lost.
   */
  _finishRelayBattlefield(plan, result, plans, results) {
    const p1 = this._phase1Settle || { plan, result: null, settledBy: null };
    const settledBy = p1.settledBy instanceof Map ? p1.settledBy : new Map();
    const p1Plan = p1.plan && typeof p1.plan === 'object' ? p1.plan : null;
    const p1Result = p1.result || null;
    const relayPlans = (Array.isArray(plans) ? plans : []).filter(Boolean);
    const relayResults = Array.isArray(results) ? results : [];
    // 统计（层数 / 资金 / 击杀 / 伤害）要**合并**阶段1 与阶段2 —— 玩家反馈「第二次协防时第一次叠的层消失」
    // 就是这里原来按 pid 直接覆盖造成的。
    const mergeStats = (into, r) => {
      if (!r || !r.perPlayer) return into;
      for (const [pid, pp] of Object.entries(r.perPlayer)) {
        if (!pp) continue;
        const cur = into[pid] || (into[pid] = {
          killed: 0, total: 0, leaked: [], perfect: true, layerGains: {}, coins: 0,
          damageDealt: 0, bossDamage: 0, healingDone: 0, deaths: 0, unitsEnd: [], unitStats: [],
        });
        for (const k of ['killed', 'total', 'coins', 'damageDealt', 'bossDamage', 'healingDone', 'deaths']) {
          cur[k] = Number(cur[k] || 0) + (Number(pp[k]) || 0);
        }
        for (const [bid, n] of Object.entries(pp.layerGains || {})) {
          if (Number.isFinite(n) && n > 0) cur.layerGains[bid] = (cur.layerGains[bid] || 0) + Math.floor(n);
        }
        if (pp.perfect === false) cur.perfect = false;
      }
      return into;
    };
    const perPlayer = {};
    mergeStats(perPlayer, p1Result);
    for (const r of relayResults) mergeStats(perPlayer, r);
    // ★ 计费只看**阶段2**的漏怪：阶段1 漏出去的怪已经被 relay 接手、在阶段2 里又打了一次；
    //   如果再把阶段1 的 leaked 算进来，就会出现「跨队兜底成功却仍然扣血」。
    //   阶段1 里「没有可转交模板」的（settledBy）和「没能重新进场」的（notReentered）才直接结算。
    const billedLeaks = {};
    for (const r of relayResults) {
      if (!r || !r.perPlayer) continue;
      for (const [pid, pp] of Object.entries(r.perPlayer)) {
        if (!pp || !Array.isArray(pp.leaked)) continue;
        (billedLeaks[pid] || (billedLeaks[pid] = [])).push(...pp.leaked);
      }
    }
    for (const [pid, cur] of Object.entries(perPlayer)) cur.leaked = billedLeaks[pid] || [];
    for (const [pid, arr] of Object.entries(billedLeaks)) {
      if (!perPlayer[pid]) perPlayer[pid] = { killed: 0, total: 0, leaked: arr, perfect: arr.length === 0, layerGains: {}, coins: 0, damageDealt: 0, bossDamage: 0, healingDone: 0, deaths: 0, unitsEnd: [], unitStats: [] };
    }
    // 阶段1 的漏怪玩家全部进 leakers —— settle() 用「是否 leaker」来决定按联防幸存数还是按自己那场的漏怪扣血，
    // 漏掉他们就会在阶段2 结算时按自己那场的漏怪**重复扣一次**。
    const leakers = [];
    for (const lk of [...((p1Plan && p1Plan.leakers) || []), ...relayPlans.flatMap((p) => p.leakers || [])]) {
      if (lk && !leakers.some((x) => x.playerId === lk.playerId)) leakers.push(lk);
    }
    const helpers = [];
    for (const h of [...((p1Plan && p1Plan.helpers) || []), ...relayPlans.flatMap((p) => p.helpers || [])]) {
      if (h && !helpers.some((x) => x.playerId === h.playerId)) helpers.push(h);
    }
    const notReentered = new Map((p1Plan && p1Plan.notReentered) || []);
    for (const [pid, n] of settledBy) notReentered.set(pid, (notReentered.get(pid) || 0) + n);
    const unspawned = [];
    for (const r of relayResults) if (r && Array.isArray(r.unspawned)) unspawned.push(...r.unspawned);
    const synthetic = !!((p1Result && p1Result.synthetic) || relayResults.some((r) => r && r.synthetic));
    this.settle(
      { helpers, leakers, leaked: relayPlans.flatMap((p) => p.leaked || []), notReentered, combined: 1 + relayPlans.length },
      { perPlayer, unspawned, synthetic },
    );
  }

  /**
   * How many of a relay plan's enemies receiving squad `to` stops, from its remaining strength
   * (unite100.squadStrength): `standing` operators hold one enemy each, plus one per board unit. The rest get through
   * and settle against the player who originally let them past.
   */

  /**
   * How many of a relay plan's enemies the HELPERS stop, from their remaining strength (unite100.squadStrength):
   * `standing` operators hold one enemy each, plus one per board unit. The rest get through and settle against the
   * player who originally let them past. The helpers are room-wide now, so their combined strength is what counts.
   */
  _relayHeld(rp) {
    const helpers = (rp && rp.helpers) || [];
    const s = squadStrength(this, helpers, this.lastResults);
    return Math.max(0, Math.min(rp.leaked.length, s.standing + s.units));
  }
  /**
   * Battle options of the 联防 field (helpers' carried end state, the leakers' enemies) on its own map — the escaped
   * template's (unite.js uniteStageId; GitHub #41), the round's stage only when the data lacks it. The field meta and the
   * client-run spec carry that stageId, so every viewer draws the 联防 map.
   */

  /**
   * Battle options of the 联防 field (helpers' carried end state, the leakers' enemies) on the round's battlefield, its
   * terrain, crates, water, devices and runes included (unite.js header; the owner's decision of 2026-10-07 — 0.2.0's
   * escaped-level map is withdrawn). The field meta and the client-run spec carry the match stageId, so every viewer
   * draws the battlefield the boards stand on.
   */
  _uniteOpts(plan, limit, fieldId = 'u') {
    const { wave, players } = uniteBattleOpts(this, plan, limit);
    return {
      seed: deriveSeed(this.seed, `u:${this.round}:${fieldId}`),
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
      // ★ 2026-10-15（用户：「联防阶段…可以叠层」＋「只有炸惊有」）：原来写死 false ⇒ 联战里 `gainLayers`
      //   直接 return 0，战斗中的叠层特质（塑心 / 砾 / 玛恩纳 …）在联战里【完全不触发】。
      //   现在跟随模式：`gd.zhajing`（gamedata.js:118）⇒ 只有炸惊的联战会叠层，普通难度的联战
      //   仍然逐字节是 false（层数照样不产生）。叠回来的部分见 settle.js。
      flags: { layerGainsEnabled: !!this.gd.zhajing, ...this.gd.dp, allyScale: this.gd.allyScale, bondLayerCap: this.gd.bondLayerCap, enemyJibian: this.enemyJibianCards || [] },
      fieldId,
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
    };
  }

  _startUniteClient(plans) {
    const list = (Array.isArray(plans) ? plans : [plans]).filter(Boolean);
    if (!list.length) { this.settle(null, null); return; }
    this.phase = PHASE.UNITE;
    this.unitePlans = list;
    this.unitePlan = list[0];              // kept for the single-plan consumers (statusOf / legacy views)
    const limit = this.wave ? this.wave.timeLimit : 60;
    const fields = list.map((plan) => {
      const fieldId = list.length === 1 ? 'u' : `u${plan.squad ?? 0}`;
      return this._ccField({ fieldId, kind: 'unite', players: plan.helpers.map((p) => p.playerId), opts: this._uniteOpts(plan, limit, fieldId) });
    });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    // A new 联防 round must not leave the PREVIOUS round's fields in `this.fields`: clientCombat finishes a phase as
    // soon as every field is done, so stale (already done) fields made it fire the round-end hook a second time — which
    // then ran takeUnhandled over the relay plans and pulled in other receivers' enemies.
    this.fields = [];
    this._launch(fields);
    // helpers watch their own squad's field; everyone else observes one of them (spectator seats included). The client
    // simulates the 联防 spec locally, so every field is watched by all viewers independently.
    const viewers = [...this._viewers()];
    for (const f of fields) {
      // 一次编码、多发送（用户 2026-10-13）：联防 relay 规格实测 75,321 B，原来每个观看者各编码一次
      const batch = [];
      for (const ps of viewers) {
        const mine = f.players.includes(ps.playerId);
        if (mine || !this.watchers.has(ps.playerId)) this.watchers.set(ps.playerId, f.fieldId);
        batch.push({ pid: ps.playerId, watch: !mine });
      }
      this._sendStartBatch(f, batch);
    }
    this.markPublic();
    const names = list.flatMap((p) => p.helpers.map((h) => h.name));
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names }), FLOW_TICKER_PRIORITY);
  }

  /** All squad fields are done (clientCombat only calls this once every cc field has finished). */

  /** All squad fields are done (clientCombat only calls this once every cc field has finished). */
  _finishUniteClient() {
    if (this.phase !== PHASE.UNITE) return;
    const fields = this.fields.filter((f) => f && f.kind === 'unite');
    const results = fields.map((f) => {
      this._collectSimErrors(f, f.result);
      f.live = false;
      return f.result;
    });
    this._stopClientCombat();
    this.deadline = 0;
    this.markPublic();
    const plans = this.unitePlans || [this.unitePlan];
    const handoff = this._uniteHandoff || plans;      // includes plans with no field (bare relay cases)
    const combined = combineUniteResults(plans, results);
    const byPlan = new Map(plans.map((p, i) => [p, results[i] || null]));
    const round = this.uniteRound;
    this.later(this.scaled(DELAYS.COMBAT_END), () => {
      // 阶段 2's fields report through the same hook: they have nothing left to plan, so they settle directly.
      if (round === 2) { this._finishRelayBattlefield(combined.plan, combined.result, plans, results); return; }
      this._afterUniteRound(combined.plan, combined.result, handoff, results, byPlan);
    });
  }

  /**
   * 联防 (user playtest #6 item 7; PRTS 卫戍协议/帮助 "防卫失败的玩家可通过上方信息栏确认自身所属敌人的剩余数量"): how many of
   * a leaker's enemies are still standing on the 联防 field — not spawned yet, alive, or through the objective again —
   * plus its leaks that could not re-enter: what settle() charges it (before the per-round cap) if the 联防 ended now.
   * It falls as the helpers strike them down and rises when one splits or summons (the children carry the leaker).
   * Live from the field (client run: the authority's b.progress `left`; server run: the headless timeline on the field
   * clock, or the streamed battle itself), clamped to what settlement can bill that leaker (fields.js uniteBillBounds:
   * sent in + the offspring bound, validateClientResult's budget); exact once the field has its result (unite.js
   * uniteSurvivors; a synthetic result charges the own leaks, as settle()). null for anyone but a leaker of the running
   * 联防.
   * @returns {number|null}
   */

  _uniteLeft(ps) {
    const plan = this.unitePlan;
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    const f = this.fields.find((x) => x && x.kind === 'unite') || null;
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(plan, res).get(pid) || 0;
    const sent = plan.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[3] && typeof sample[3] === 'object' ? sample[3] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) this._uniteBounds = { plan, bounds: uniteBillBounds(plan.leaked, this.gd) };
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    // 阶段2（转交战场）结算用的是 combineUniteResults([阶段1, 阶段2])，所以这里也要把阶段1那份算进来：阶段1里
    // 「没能重新进场」的敌人原先只在结算那一刻冒出来 —— 玩家看到 -0、结算却扣血淘汰（用户反馈 2026-10-11
    // 「一轮兜完了但是AI还是扣血淘汰了」「明明显示-0然后又扣除了血量」）。这一项是静态的，与战场进度无关。
    const p1 = this._phase1Settle && this._phase1Settle.plan ? this._phase1Settle.plan : null;
    const carried = p1 && p1 !== plan ? (p1.notReentered.get(pid) || 0) : 0;
    return standing + (plan.notReentered.get(pid) || 0) + carried;
  }

  /** Server-run 联防 (streaming mode): refresh m.public about once a game second when a leaker's count moved. */
  _uniteTick(runner) {
    const f = runner && runner.fields ? runner.fields[0] : null;
    if (!f || !f.battle || runner.ticks % 30 !== 0) return;
    let key = '';
    try { key = JSON.stringify(uniteLeft(f.battle)); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }
}
