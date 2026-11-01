// server/match/match/spDraft.js — Match methods: the 机变 draft (SP_DRAFT) and the rolls the meta effects ask for —
// bounties (addBounty), item ids (rollItemId) and choices.json pools (rollPool).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).
//
// 100-SEAT VARIANT (docs/FINDINGS-100.md §4.4) — the draft runs PER SQUAD, all 25 concurrently:
//   * upstream draws ONE 6-card pool for the room and hands it round-robin, ending the phase when the cards run out:
//     with 100 seats 6 players got a card and 94 got none. Now each squad of 4 draws its OWN pool (generateDraft once
//     per squad — the rng is explicit, so a fixed seed still reproduces the match) and its own members take turns over
//     those 6 cards. 6 >= 4, so everyone can pick (the same motive as the per-player pool, player/rules.js).
//   * `m.sp` is an ARRAY indexed by squad; each entry advances on its own turn counter. A squad is finished once its
//     alive members all hold a card or its pool runs out. The phase ends when ALL squads are done — spDone() — i.e.
//     "队内等待完毕后等待其他小队".
//   * The pool is per squad, so it must not be broadcast: `views.js` keeps `m.public.sp` free of `cards` and each
//     player's own squad view travels in `m.private.sp` (PlayerViews.privateView). `m.public.sp` keeps the public
//     progress only (family / name / who is on the clock).
//   * This file never arms the ROOM-WIDE deadline (25 concurrent clocks cannot share the single `m.deadline` a client
//     countdown reads) — `audit.js` checks that `m.deadline` stays 0. Each squad's own turn clock is separate:
//     `scheduleSpPickTimeout` (config.timers.spTurn, the AFK net) publishes `sp.turnDeadline` / `sp.turnSeconds` in the
//     PRIVATE frame, which is what the 机变 overlay counts down (user request: the built-in timer had to be visible).

import { PHASE, ERR } from '../../../shared/constants.js';

/** 惊变「投资未来」的 pending 计数器键（与 content/jibian.js 的 K.touziPending 一致）。 */
const TOUZI_PENDING = 'jibian:touziweilai:pending';
import { squadIndex } from '../../../shared/squads.js';
import { generateDraft, applyCard, bountyBattles, isMultiRoundBounty, jibianDraftCards, jibianCard } from '../choices.js';
import { weightedPick } from '../waves.js';
import { botPickCard } from '../bot.js';
import { OK, fail, DELAYS } from './common.js';

/**
 * ★ 2026-10-16 撤下（owner：「撤掉测试卡池」）。
 *
 * 原来这里是「开了外援测试模式就在下次惊变阶段额外塞这 8 张卡」。撤掉的原因不是它本身有 bug，
 * 而是它的**门禁假设不成立**：
 *   · 它挂在 `ps.testMode` 上，而 testMode 的解锁码是 `server/lobby.js` 里**硬编码**的一个常量
 *     （`UNLOCK_CODE`，与「房间开放到 100 人」共用同一个码）——  源码是公开仓库，等于码不保密；
 *   · 于是任何输对码的玩家都能在公开服上拿到这 8 张强力惊变卡（含赤霄剑法、追忆、恶魔契约…），
 *     并且同时获得**无限资金 + 商店只刷外援**（cheat.js 的另两项）。
 *   · 旧注释写的「生产服务器与任何分发包都不会走到这里」是**误导**：`SP_CHEAT` 那条确实受环境变量
 *     保护，但 `ps.testMode` 是一条独立路径，代码在包里、随时可触发。
 *
 * 现在的口径：**卡池由环境变量 `SP_TEST_CARDS` 控制，默认关闭**。
 *   · 公开服 / 任何分发包：不设这个变量 → 永远不发这些卡（这段逻辑连池子都不建）。
 *   · 本地调试要复测：启动时设 `SP_TEST_CARDS=1`（或逗号分隔的 effectId 列表）即可，无需改代码。
 * 注意：只撤了「发卡」。`ps.testMode` 的**另外两项**（无限资金、商店只刷外援）仍在，那是 owner 的
 * 既有功能，不在本次范围内 —— 但门禁问题（码硬编码）仍在，见 lobby.js 的 UNLOCK_CODE。
 */

/** 从环境变量读测试卡池：`SP_TEST_CARDS=1` = 用默认那 8 张；或写逗号分隔的 effectId 列表。未设 = 关闭。 */
const TEST_CARDS = (() => {
  const raw = String(process.env.SP_TEST_CARDS || '').trim();
  if (!raw) return Object.freeze([]);
  if (raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'on') {
    return Object.freeze([
      'jibian_chixiaojianfa',    // 赤霄剑法：全队伤害转弱点 + 精锐赤刃明霄陈
      'jibian_siwanghuigui',     // 死亡回归：被淘汰 → 回整备
      'jibian_shenmishangdian',  // “神秘”商店：特殊刷新
      'jibian_shiguangzhimo',    // “时光之末”：非 boss 战濒死不淘汰
      'jibian_emoxieyue',        // 恶魔契约：目标生命当资金用
      'jibian_cengshudaluan',    // 层数大乱
      'jibian_zhuiji',           // 追忆
      'jibian_111fuhuoma',       // “111真复活吗哥”
    ]);
  }
  return Object.freeze(raw.split(',').map((s) => s.trim()).filter(Boolean));
})();

export class MatchSpDraft {
  enterSpDraft(opts = {}) {
    const alive = this.alivePlayers();
    if (!alive.length) { this.enterPrep(); return; }
    // ★ 2026-10-16（owner）惊变「死亡回归」回到惊变回合时：**只有发动者能再选一次**，其他人直接进整备。
    //   做法就是在派发这一刻把参与者收窄成那一个人 —— 牌库是按参与者生成的（下面的 perPlayer 分支），
    //   所以过滤掉别人之后，他们自然不参与；如果过滤后一个都不剩（发动者已不在），下面 live.length 为 0
    //   会直接 enterPrep，正好是"其他人直接进入整备阶段"。
    const onlyId = typeof opts.onlyPlayerId === 'string' ? opts.onlyPlayerId : null;
    const participants = onlyId ? alive.filter((p) => p && p.playerId === onlyId) : alive;
    const untimed = this.soloUntimed;
    // 每个小队有几名存活成员：牌池必须够每人一张。惊变阶段的牌数来自 mode.jibian.cards（3 张），而一个小队最多
    // 4 人 —— 第 4 位会整场拿不到惊变（审计「ends 机变 without a card」，2026-10-11 服务端体检发现）。机变 /
    // 道具 / 悬赏本来就发 6 张 ≥ 4 人，这里只是兜底（generateDraft 的 minCards）。
    // 惊变阶段（规则5）是**每人一副独立牌库**：各抽 3 张、各挑各的，不用等队友也不跟队友抢（用户 2026-10-11 确认）。
    // 机变 / 道具 / 悬赏仍是每小队一副 6 张池、队内轮流挑。
    // 惊变阶段（规则5）是**每人一副独立牌库**；但"追加阶段"（forceFamily，如悬赏）走**每小队一副 6 张池**、
    // 队内轮流挑 —— 所以指定了 forceFamily 时不走 perPlayer 分支。
    const perPlayer = !opts.forceFamily && this.gd.spPhaseKind(this.round) === 'jibian';
    const membersOf = new Map();
    for (const ps of participants) { const k = squadIndex(ps.seat); if (k >= 0) membersOf.set(k, (membersOf.get(k) || 0) + 1); }
    const drafts = [];
    /** @type {Map<number, object>} squad index → its draft */
    const bySquad = new Map();
    for (const ps of participants) {
      const k = squadIndex(ps.seat);
      if (k < 0) continue;
      if (perPlayer) {
        // 按 seat 存这一份（spOf 先按 seat 找 perPlayer 的那份，再回落到小队）
        // 用户 2026-10-12：惊变牌库只排除这名玩家**已经拥有**的惊变（选不到重复的卡）；只是抽到过、没选中的
        // （含被刷新掉的）会回到牌库，之后仍可能再抽到 —— 保持随机性，免得为了某张卡疯狂刷新。
        // ★ 2026-10-14 惊变「投资未来」(jibian_touziweilai)：抽到的那张卡种一个 pending 计数器，
        //   在【下一次惊变阶段】生成牌库时消费 —— 那次的可选卡只出史诗/传说。惊变阶段是 round 1/7，
        //   在 round 1 抽到时牌库已生成完毕，所以标记自然会留到 round 7（文案的「下一轮」）。
        //   生成失败（空池、阶段跳过）时不消费，标记留到再下一个惊变阶段。
        const touzi = !!(ps.counters && ps.counters[TOUZI_PENDING]);
        const rec = generateDraft(this.gd, this.rngDraft, this.round, {
          stageId: this.stageId, bondAvailable: (bondId) => this.bondLive(bondId), minCards: 1,
          exclude: this._jibianOwned(ps),
          noCoreBond: this._jibianNoCore(ps),   // 隐藏规则：没核心盟约 → 传说概率提升
          onlyHighRarity: touzi,                // 投资未来：本阶段只出史诗/传说
          forceFamily: opts.forceFamily || null,
        });
        if (!rec) continue;
        if (touzi && ps.counters) ps.counters[TOUZI_PENDING] = 0;   // 消费掉
        drafts[ps.seat] = { squad: k, perPlayer: true, onlyHighRarity: touzi, ...rec, order: [ps.playerId], idx: 0, picks: {}, taken: {}, want: {}, untimed, turnDeadline: 0 };
        // ★ 测试卡池 (owner 2026-10-16「撤掉测试卡池」)：现在只在 `SP_TEST_CARDS` 设了东西时才发，
        //   见文件上方 TEST_CARDS 的说明。默认（公开服）TEST_CARDS 是空数组 → 整段跳过，
        //   连 _jibianOwned() 都不调用，行为与"这段代码不存在"完全一致。
        if (ps.testMode === true && TEST_CARDS.length) {
          try {
            const d = drafts[ps.seat];
            const owned = this._jibianOwned(ps);
            for (const want of TEST_CARDS) {
              const hasIt = (d.cards || []).some((c) => c && c.effectId === want);
              if (hasIt || (owned && owned.has && owned.has(want))) continue;
              const spec = this.gd.jibian() && (this.gd.jibian().pool || []).find((c) => c && c.effectId === want);
              if (!spec) continue;
              const card = jibianCard(this.gd, spec, spec.rarity || 'normal');
              if (!card) continue;
              card.idx = (d.cards || []).length;
              card.family = 'jibian';
              d.cards = [...(d.cards || []), card];
              this.log?.info?.(`[testcard] ${ps.name} 额外发放 ${want}`);
            }
          } catch (e) { this.reportError('test card', e); }
        }
        continue;
      }
      let d = bySquad.get(k);
      if (!d) {
        // one pool per squad; the rng is explicit so the draw stays reproducible from the match seed
        const rec = generateDraft(this.gd, this.rngDraft, this.round, {
          stageId: this.stageId, bondAvailable: (bondId) => this.bondLive(bondId), minCards: membersOf.get(k) || 1,
          forceFamily: opts.forceFamily || null,
        });
        if (!rec) continue;
        d = { squad: k, ...rec, order: [], idx: 0, picks: {}, taken: {}, want: {}, untimed, turnDeadline: 0 };
        bySquad.set(k, d);
        drafts[k] = d;
      }
      d.order.push(ps.playerId);
    }
    const live = drafts.filter(Boolean);
    if (!live.length) { this.enterPrep(); return; }
    this.phase = PHASE.SP_DRAFT;
    this.sp = drafts;
    // 「AI 队友最后选择」 (GitHub #338): humans before AI seats, after the same shuffle (MatchPhases.humansFirst)
    for (const d of live) {
      if (!this.isSolo) this.rngDraft.shuffle(d.order);
      d.order = this.humansFirst(d.order);
    }
    this.setDeadline(0);
    for (const d of live) { this._spMarkSquad(d); this.startSpTurn(d); }
    for (const ps of participants) this.markPrivate(ps);
    this.markPublic();
  }

  /** Every squad's draft (a sparse array indexed by squad; entries may be undefined). */
  spDrafts() { return Array.isArray(this.sp) ? this.sp.filter(Boolean) : []; }

  /**
   * 用户 2026-10-12：惊变牌库只排除这名玩家**已经拥有**的惊变（`jibian:<effectId>` 的 ref，含潘多拉魔盒开出来的），
   * 作为 exclude 传给抽卡 —— 于是「选不到重复的惊变」，而只是出现在三选一里、没被选中的卡（含被刷新掉的）不在
   * 这个集合里，会回到牌库、之后仍可能再抽到（用户要的随机性）。
   * @param {import('../PlayerState.js').PlayerState} ps
   * @returns {Set<string>}
   */
  _jibianOwned(ps) {
    const out = new Set();
    // ★ 2026-10-26：本局已消耗的一次性惊变（追忆）同样不能再抽到。
    if (ps && ps.jibianConsumed instanceof Set) for (const id of ps.jibianConsumed) out.add(id);
    for (const e of (ps && ps.effects) || []) {
      if (!e || !e.jibian) continue;
      const id = (e.data && e.data.effectId)
        || (typeof e.key === 'string' && e.key.startsWith('jibian:') ? e.key.slice('jibian:'.length) : null);
      if (id) out.add(id);
    }
    return out;
  }

  /**
   * 隐藏规则（用户 2026-10-12，不上界面）：这名玩家**没有激活任何核心盟约**吗？核心 = data/bonds.json 里
   * `isCore: true` 的 8 条（炎 / 萨尔贡 / 维多利亚 / 谢拉格 / 拉特兰 / 阿戈尔 / 叙拉古 / 卡西米尔）—— 投资人、
   * 迅捷、精准、岁、企鹅物流、医师这类附加盟约不算，调和也不算（它只是蹭核心的效果）。
   * 为 true 时抽惊变会把「传说」的概率提升到 `jibian.noCoreLegendWeight`（见 choices.jibianDraftCards）。
   * @param {import('../PlayerState.js').PlayerState} ps
   * @returns {boolean}
   */
  _jibianNoCore(ps) {
    const bonds = ps && ps.bonds;
    if (!bonds || typeof bonds !== 'object') return true;
    for (const [id, b] of Object.entries(bonds)) {
      if (!b || b.active !== true) continue;
      const rec = this.gd.bond(id);
      if (rec && rec.isCore === true) return false;
    }
    return true;
  }

  /**
   * The draft of the squad that holds `ps` (a PlayerState, or a playerId), or null — under the 100-seat variant a
   * player only sees and acts on its own squad's draft. 惊变阶段 is per PLAYER instead (`perPlayer`, stored by seat):
   * everyone draws their own 3 cards and picks without waiting for the squad.
   * @param {any} ps
   */
  spOf(ps) {
    if (!Array.isArray(this.sp) || !this.sp.length) return null;
    const seat = ps && typeof ps === 'object' ? ps.seat : (this.players.get(ps) || {}).seat;
    const own = Number.isInteger(seat) ? this.sp[seat] : null;
    if (own && own.perPlayer) return own;
    const k = squadIndex(seat);
    return k >= 0 ? this.sp[k] ?? null : null;
  }

  /** The player on the clock of `draft`'s squad, or null. */
  spTurnOf(draft) {
    return draft ? draft.order[draft.idx] ?? null : null;
  }

  /** The player on the clock of some unfinished squad (the public progress readout; intents use spOf(ps)). */
  spTurn() {
    for (const d of this.spDrafts()) {
      const pid = this.spTurnOf(d);
      if (pid != null) return pid;
    }
    return null;
  }

  /** Whether every squad's draft is finished — the phase ends only then ("队内等待完毕后等待其他小队"). */
  spDone() {
    const drafts = this.spDrafts();
    return drafts.length ? drafts.every((d) => this._spSquadDone(d)) : true;
  }

  /** Total cards taken across all squads (public progress). */
  spPickCount() {
    let n = 0;
    for (const d of this.spDrafts()) n += Object.keys(d.picks).length;
    return n;
  }

  /** A squad's draft is done once every alive member holds a card, or its 6-card pool ran out. */
  _spSquadDone(d) {
    const alive = new Set(this.alivePlayers().map((p) => p.playerId));
    const members = d.order.filter((pid) => alive.has(pid));
    if (!members.length) return true;
    if (!d.cards.some((c) => d.taken[c.idx] == null)) return true;
    return members.every((pid) => d.picks[pid] != null);
  }

  /**
   * Refresh the PRIVATE frame of every member of squad `s`.
   *
   * The 机变 card picker is built from `m.private` (`priv.sp`), because a squad's pool must not be broadcast to the room.
   * `Match.markPrivate(ps)` only dirties the state of the player it is given, so after a pick the OTHER members of the
   * squad kept a stale `sp.turn` and their picker refused every card — `choiceOverlay.cardPickable` requires
   * `sp.turnPid === myId`, so a two-human squad deadlocked as soon as the first one picked. (The AI-side defect fixed
   * just above was the mirror image of this: the bots were never scheduled.) `_sendPrivate` dedupes by payload, so
   * marking everyone on a turn change costs nothing when nothing changed for them.
   * @param {object} s that squad's draft
   */
  _spMarkSquad(s) {
    if (!s || !Array.isArray(s.order)) return;
    for (const pid of s.order) {
      const ps = this.players.get(pid);
      if (ps) this.markPrivate(ps);
    }
  }

  /**
   * Advance ONE squad's draft to its next live turn; finish that squad when its members are done or its pool is out.
   * @param {object} s that squad's draft
   */
  startSpTurn(s) {
    if (!s) return;
    // 100-seat variant: 25 squad drafts run CONCURRENTLY, so the timer and the token must be PER SQUAD. Upstream kept
    // one `_turnTimer` / one `_turnToken` because there was only ever one draft; here every startSpTurn cancelled the
    // previous squad's scheduled AI turn (and invalidated its token), so only the LAST squad's AI ever acted and the
    // other 24 squads waited on their bot forever — the phase is untimed, so the match hung with "AI is deciding…".
    this.cancel(s._botTimer);
    s._botTimer = null;
    s._botToken = (s._botToken || 0) + 1;
    // The HUMAN turn gets the same treatment, and for a harder reason than the bot one above: without it a player who
    // goes AFK, closes the tab or drops out leaves their squad's `spDone()` false forever, so `finishSpDraft` is never
    // reached and the WHOLE ROOM waits on 机变 for the rest of the match (reported: 「有人退出了不选全房间都会卡死」).
    // `config.timers.spTurn` (16 s) is the figure this phase always declared and never read.
    // It is armed for BOT seats too on purpose: their own timer fires first and applies a card, which bumps the token
    // and makes this one a no-op — so there is never a double pick.
    this.cancel(s._pickTimer);
    s._pickTimer = null;
    s._pickToken = (s._pickToken || 0) + 1;
    s.turnDeadline = 0;
    while (s.idx < s.order.length) {
      const ps = this.players.get(s.order[s.idx]);
      if (ps && ps.alive && s.picks[ps.playerId] == null) break;
      s.idx++;
    }
    const available = s.cards.some((c) => s.taken[c.idx] == null);
    if (s.idx >= s.order.length || !available) {
      // this squad is done; the phase lasts until every squad is (spDone)
      this._spMarkSquad(s);
      if (this.spDone()) this.later(0, () => this.finishSpDraft());
      return;
    }
    // untimed in this variant: 25 concurrent drafts cannot share the one deadline a client countdown reads
    this.setDeadline(0);
    const cur = this.players.get(this.spTurnOf(s));
    // Arm the AFK / dropped-player timeout (see the header of this method). SAFETY NET ONLY: it produces no countdown
    // on the client — showing one would need a single room-wide deadline, which would destroy the parallel "first squad
    // to finish picks first" flow this phase is built on. The AI handles an expired turn exactly like a 托管 seat.
    this.scheduleSpPickTimeout(s);
    if (cur && cur.botControlled) this.scheduleSpBot(s);
    // the turn moved: every member's private frame carries `sp.turn`, so all of them must be refreshed
    this._spMarkSquad(s);
    this.markPublic();
  }

  /**
   * The AFK safety net of a squad's 机变 turn: after `config.timers.spTurn` (16 s) the AI takes the pick for whoever
   * still has not chosen, exactly like a 托管 (botControlled) seat.
   *
   * Why this exists: 25 squash drafts run in parallel and the phase ends only when EVERY squad reports `spDone()`. A
   * player who stops responding therefore holds the whole room in 机变 indefinitely — there is no room-wide deadline to
   * expire, because this variant deliberately arms none (a single `m.deadline` cannot describe 25 parallel clocks).
   * Reported as 「有人退出了不选全房间都会卡死」.
   *
   * It IS shown as a clock (user request): the squad's own turn deadline rides in the PRIVATE frame
   * (`m.private.sp.turnDeadline`, player/views.js) instead of `m.deadline`, so each squad's client counts its own turn
   * down without any room-wide deadline — the parallel per-squad flow is untouched, and `m.deadline` stays 0 (the
   * audit's "per-squad 机变 is timed" check reads that field). `botPickCard` picks the same card an AI seat would
   * (item tier/use, bounty payout, tactic targeting), so an expired turn is scored, not random.
   *
   * @param {object} s that squad's draft
   */
  scheduleSpPickTimeout(s) {
    if (!s) return;
    const token = s._pickToken;
    const secs = this.gd.timer('spTurn');
    const ms = this.scaled(secs * 1000);
    s.turnDeadline = this.sched.now() + ms;
    s._pickTimer = this.later(ms, () => {
      s.turnDeadline = 0;
      if (this.phase !== PHASE.SP_DRAFT) return;
      if (token !== s._pickToken) return;              // the turn moved on (a pick, or a new turn): not our turn anymore
      const ps = this.players.get(this.spTurnOf(s));
      if (!ps) return;
      // the seat that was to act has already picked (e.g. their own bot timer won the race)
      if (s.picks[ps.playerId] != null) return;
      const avail = s.cards.map((c) => c.idx).filter((i) => s.taken[i] == null);
      if (!avail.length) return;                       // pool exhausted: startSpTurn already finished this squad
      // ★ 「我想要」优先：本人标过且那张还在 → 超时就选它；否则走原来的 AI 兜底
      const w = s.want && s.want[ps.playerId];
      const idx = (Number.isInteger(w) && s.taken[w] == null && s.cards[w]) ? w : botPickCard(this, ps, s.cards, avail);
      // `_applyCard` re-checks both guards (already picked / already taken) and advances the squad's turn.
      this._applyCard(ps, s, Number.isInteger(idx) ? idx : avail[0]);
    });
  }

  /** An AI seat's turn inside squad draft `s` (nobody waits on the AI). */
  scheduleSpBot(s) {
    if (!s) return;
    const token = s._botToken;
    s._botTimer = this.later(this.scaled(DELAYS.BOT_ACTION), () => {
      if (this.phase !== PHASE.SP_DRAFT || token !== s._botToken) return;
      const ps = this.players.get(this.spTurnOf(s));
      if (!ps || !ps.botControlled) return;
      const avail = s.cards.map((c) => c.idx).filter((i) => s.taken[i] == null);
      if (!avail.length) return;
      this._applyCard(ps, s, botPickCard(this, ps, s.cards, avail));
    });
  }

  /**
   * 「我想要」：提前把某张卡标成意向，队友在自己的选择界面就能看到。**不要求轮到自己**（这正是它的用途），
   * 也不改轮流选的规则 —— 只在轮到本人且超时未选时作为兜底优先项（scheduleSpPickTimeout）。
   * 每人同时只允许一张：再点同一张即取消，点别的则替换。卡片池只发给本小队（m.private.sp），所以意向天然只在本队可见。
   */
  spWant(ps, idx) {
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    const s = this.spOf(ps);
    if (!s) return fail(ERR.WRONG_PHASE);
    if (s.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    if (!(s.want instanceof Object)) s.want = {};
    if (idx == null) { delete s.want[ps.playerId]; this._spMarkSquad(s); return OK; }
    if (!Number.isInteger(idx) || idx < 0 || idx >= s.cards.length) return fail(ERR.BAD_TARGET);
    if (s.taken[idx] != null) return fail(ERR.SOLD_OUT);
    if (s.want[ps.playerId] === idx) delete s.want[ps.playerId];   // 再点一次 = 取消
    else s.want[ps.playerId] = idx;                                 // 只留一张
    this._spMarkSquad(s);
    return OK;
  }

  pickCard(ps, idx) {
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    const s = this.spOf(ps);
    if (!s) return fail(ERR.WRONG_PHASE);
    if (s.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    if (this.spTurnOf(s) !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!Number.isInteger(idx) || idx < 0 || idx >= s.cards.length) return fail(ERR.BAD_TARGET);
    if (s.taken[idx] != null) return fail(ERR.SOLD_OUT);
    this._applyCard(ps, s, idx);
    return OK;
  }

  /**
   * 炸惊模拟 规则5 — the one reroll of a single 惊变 the 惊变阶段 grants. It redraws card `idx` of the player's own squad
   * pool with the same procedure as the deal (a rarity first, then a card of that rarity) and spends the player's
   * reroll budget (`config.modes[*].jibian.rerolls`, 1). The card that was there goes back to the pool — it is not
   * banned, so it can turn up again later in the match — but the redraw itself skips it along with the other cards still
   * on the table and the 惊变 the player already owns (用户 2026-10-12: 不能选到重复的惊变, and a reroll must not be
   * wasted by handing back the same card).
   *
   * Guards: 惊变阶段 only (family 'jibian'), the player's own turn, before their pick, a card nobody has taken, and a
   * budget left. The whole squad's private frames are refreshed afterwards — the pool is per squad (m.private.sp), so a
   * reroll has to reach every member's card list, not just the rerolling player's.
   *
   * @param {any} ps the player asking
   * @param {number} idx index into that squad's `cards`
   */
  spReroll(ps, idx) {
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    const s = this.spOf(ps);
    if (!s) return fail(ERR.WRONG_PHASE);
    // the reroll is a 惊变阶段 rule: the 快递 and the ordinary families have no cards to redraw
    if (s.family !== 'jibian') return fail(ERR.BAD_TARGET);
    const j = this.gd.jibian();
    const budget = j ? j.rerolls : 0;
    if (budget <= 0) return fail(ERR.BAD_TARGET);
    if (s.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    if (this.spTurnOf(s) !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    // ★ 2026-10-13（用户口径）：重投预算【整局共用】（ps.spRerollsUsed），不再是每个阶段各自 4 次。
    // ★ 2026-10-19（owner）：改成「每张卡各能刷新一次」——同一阶段里刷新过的卡记在 s.rerolled 里，
    //   每张卡只允许刷新一次；不再用整局的 ps.spRerollsUsed 计数（budget 仅作为「每卡次数」=1 的兜底）。
    if (!s.rerolled) s.rerolled = new Set();
    if (s.rerolled.has(idx)) return fail(ERR.ALREADY);
    const perCard = Math.max(1, Number(budget) || 1);
    void perCard;
    if (!Number.isInteger(idx) || idx < 0 || idx >= s.cards.length) return fail(ERR.BAD_TARGET);
    if (s.taken[idx] != null) return fail(ERR.SOLD_OUT);
    // 用户 2026-10-12：刷新只换掉场上这一张 —— 排除「已拥有的惊变」+ 当前场上的这些卡（同一批仍然不重复）；
    // 被换掉的那张不在任何永久集合里，**回到牌库**，之后（含同一阶段的下一次刷新）仍可能再抽到。
    const onTable = new Set(s.cards.filter(Boolean).map((c) => c.id));
    const exclude = new Set([...this._jibianOwned(ps), ...onTable]);
    // 投资未来：重投也守住「只出史诗/传说」（标记来自本阶段生成牌库时的消费结果）
    const fresh = jibianDraftCards(this.gd, this.rngDraft, 1, exclude,
      { noCoreBond: this._jibianNoCore(ps), onlyHighRarity: s.onlyHighRarity === true, owned: this._jibianOwned(ps) });
    if (!fresh || !fresh.length) return fail(ERR.BAD_TARGET);
    const card = fresh[0];
    card.idx = idx;
    card.family = 'jibian';
    card.rerolled = true;   // ★ 这张已经刷过一次，不能再刷
    s.cards[idx] = card;
    s.rerolled.add(idx);
    ps.spRerollsUsed = (ps.spRerollsUsed || 0) + 1;   // 只用于统计，不再限制
    this._spMarkSquad(s);
    this.markPublic();
    return OK;
  }

  _applyCard(ps, s, idx) {
    if (!s || s.picks[ps.playerId] != null || s.taken[idx] != null) return;
    const card = s.cards[idx];
    if (!card) return;
    s.picks[ps.playerId] = idx;
    s.taken[idx] = ps.playerId;
    try { applyCard(this, ps, card); } catch (e) { this.reportError(`applyCard ${card.id}`, e); }
    // ★ 2026-10-25（owner）惊变「快手」（隐秘）：选中后把**同一批的另外两张**也一并拿走 —— "手快全拿了"。
    //   每人一副独立牌库，所以只影响这名玩家的这一批；同批的槽位标记为已取，避免小队牌库里再被别人选走。
    if (card.id === 'jibian_kuaishou') {
      for (let i = 0; i < s.cards.length; i++) {
        if (i === idx || s.taken[i] != null) continue;
        const extra = s.cards[i];
        if (!extra) continue;
        s.taken[i] = ps.playerId;
        try { applyCard(this, ps, extra); } catch (e) { this.reportError(`kuaishou ${extra.id}`, e); }
      }
    }
    this.markPrivate(ps);
    this.markPublic();
    this.startSpTurn(s);
  }

  finishSpDraft() {
    if (this.phase !== PHASE.SP_DRAFT) return;
    for (const d of this.spDrafts()) {
      this.cancel(d._botTimer); d._botTimer = null; d._botToken = (d._botToken || 0) + 1;
      // the AFK safety net is per squad too, and must not outlive the phase (it would otherwise fire into PREP)
      this.cancel(d._pickTimer); d._pickTimer = null; d._pickToken = (d._pickToken || 0) + 1;
    }
    if (this.enterBountyAfterPhase()) return;
    this.enterPrep();
  }

  /**
   * 炸惊（mode.bountyAfterPhase）：**强制阶段（惊变 / 快递）结束后再追加一场「悬赏决策」** —— 两者先后连着出现。
   * 只对配置了这个开关的模式生效（默认关 → 普通模式与其它模式行为不变）；每回合最多追加一次（按 round 记，
   * 不依赖任何重置逻辑）。追加的这场是**每小队一副 6 张悬赏池**（forceFamily 走 per-squad 分支）。
   */
  enterBountyAfterPhase() {
    const mode = this.gd && this.gd.mode;
    if (!mode || !mode.bountyAfterPhase) return false;
    if (this._bountyAfterRound === this.round) return false;
    const kind = this.gd.spPhaseKind(this.round);
    if (kind !== 'jibian' && kind !== 'express') return false;
    this._bountyAfterRound = this.round;
    this.enterSpDraft({ forceFamily: 'bounty' });
    return true;
  }

  addBounty(ps, card) {
    if (!ps || !card || !this.gd.enemy(card.enemyKey)) return null;
    // a multi-round card lasts MULTI_ROUND_BOUNTY_BATTLES battles (choices.js; the user's call after playtest #6)
    const rounds = bountyBattles(card);
    const b = {
      id: `bounty:${this.nextUid()}`,
      card: { effectId: card.effectId ?? card.id ?? null, name: card.name ?? '悬赏', desc: card.desc ?? '', tier: card.tier ?? 1, coin: Math.max(0, Math.trunc(Number(card.coin) || 0)), payout: card.payout === 'perfect' ? 'perfect' : 'kill', rounds, multiRound: isMultiRoundBounty(card), enemyKey: card.enemyKey, count: Math.max(1, Math.min(20, Number.isInteger(card.count) ? card.count : 1)) }, // i18n-ignore: a data-less card's fallback name
      roundsLeft: rounds,
    };
    ps.bounties.push(b);
    ps.dirty();
    return b.id;
  }

  /** Random item id: a choices.json server pool ({ pool }), a tier, or ≤ maxTier shop-eligible items. */
  rollItemId({ pool = null, tier = null, maxTier = 6, shopLevel = 6 } = {}) {
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof pool === 'string' && Object.hasOwn(pools, pool) ? pools[pool] : null;
    const rng = this.rngMeta;
    const tierList = (lo, hi) => { const out = []; for (let t = lo; t <= hi; t++) for (const id of this.gd.shopItemsByTier[t] || []) out.push(id); return out; };
    if (p && p.kind === 'equip') {
      if (Array.isArray(p.weighted) && p.weighted.length) {
        const pairs = p.weighted.filter((x) => Array.isArray(x) && this.gd.item(x[0]));
        let total = 0;
        for (const [, w] of pairs) total += Math.max(0, Number(w) || 0);
        let r = rng() * total;
        for (const [id, w] of pairs) { r -= Math.max(0, Number(w) || 0); if (r < 0) return id; }
        return pairs.length ? pairs[pairs.length - 1][0] : null;
      }
      if (Array.isArray(p.items) && p.items.length) {
        const items = p.items.filter((id) => this.gd.item(id));
        return items.length ? items[Math.floor(rng() * items.length)] : null;
      }
      let list;
      if (Array.isArray(p.tiers) && p.tiers.length) list = p.tiers.flatMap((t) => this.gd.shopItemsByTier[t] || []);
      else list = tierList(1, p.maxTier === 'shopLevel' ? Math.max(1, Math.min(6, shopLevel)) : 6);
      return list.length ? list[Math.floor(rng() * list.length)] : null;
    }
    const list = Number.isInteger(tier) ? tierList(tier, tier) : tierList(1, Math.max(1, Math.min(6, maxTier)));
    return list.length ? list[Math.floor(rng() * list.length)] : null;
  }

  /**
   * Roll a choices.json pool (ctx.rollPool). Equip pools → rollItemId. Chess pools: an `items` (uniform) or `weighted`
   * list — only chess with a free pool copy (or outside the pool) qualify — else a copy-weighted draw from the shared
   * pool filtered by `tier` / `minTier` / `maxTier` (number or 'shopLevel') / `bond`; `golden: true` yields the elite id.
   * `extra` (the drawing player's 自选 stock, player/diy.js diyStockEntries) joins that shared-pool draw, `chessOf` reads the
   * bonds (the player's data view: a slotted slot's operator) — 0.2.0 WE2.
   * @returns {{ kind: 'item'|'chess', id: string, golden?: boolean } | null}
   */
  rollPool(poolId, { shopLevel = 6, extra = null, chessOf = null, pool = null } = {}) {
    // 100-seat variant: `pool` is the drawing player's own pool (player/rules.js), else the match's catalog instance
    const usePool = pool || this.pool;
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof poolId === 'string' && Object.hasOwn(pools, poolId) ? pools[poolId] : null;
    if (!p || typeof p !== 'object') return null;
    const lvl = Math.max(1, Math.min(6, Number.isInteger(shopLevel) ? shopLevel : 6));
    if (p.kind === 'equip') {
      const id = this.rollItemId({ pool: poolId, shopLevel: lvl });
      return id ? { kind: 'item', id } : null;
    }
    if (p.kind !== 'chess') return null;
    const rng = this.rngMeta;
    const free = (id) => {
      if (typeof id !== 'string' || !this.gd.chess(id)) return false;
      const base = this.gd.baseIdOf(id);
      return !usePool.has(base) || usePool.left(base) > 0;
    };
    let id = null;
    // 用户 2026-10-22「三个灰毫放在一起没精锐」：奖池里写死的棋子 id 可能是**普通**记录（pool_char_pinus 的
    // 野鬃/灰毫/远牙、pool_chess_glady 的斯卡蒂/幽灵鲨/深巡），而炸惊用的是自己那套 chess_zj_* —— 直接发普通记录会
    // 得到 baseId 不同的同名棋子，永远合不了精锐。先换成本模式棋库里的同一名干员，再做「还有没有空闲份数」的判定。
    const inRoster = (cid) => this.gd.chessInRoster(cid);
    if (Array.isArray(p.weighted) && p.weighted.length) {
      const pairs = p.weighted
        .filter((x) => Array.isArray(x))
        .map(([cid, w]) => [inRoster(cid), w])
        .filter(([cid]) => free(cid));
      id = pairs.length ? weightedPick(rng, pairs) : null;
    } else if (Array.isArray(p.items) && p.items.length) {
      const list = p.items.map(inRoster).filter(free);
      id = list.length ? list[Math.floor(rng() * list.length)] : null;
    } else {
      const maxTier = p.maxTier === 'shopLevel' ? lvl : Number.isInteger(p.maxTier) ? p.maxTier : 6;
      const minTier = Number.isInteger(p.minTier) ? p.minTier : 1;
      const bond = typeof p.bond === 'string' ? p.bond : null;
      const recOf = typeof chessOf === 'function' ? chessOf : (cid) => this.gd.chess(cid);
      id = usePool.roll(rng, {
        tier: Number.isInteger(p.tier) ? p.tier : null,
        maxTier,
        filter: (cid, e) => e.tier >= minTier && (!bond || (Array.isArray(recOf(cid)?.bonds) && recOf(cid).bonds.includes(bond))),
        extra,
      });
    }
    if (!id) return null;
    const golden = !!p.golden;
    return { kind: 'chess', id: golden ? this.gd.goldenIdOf(id) || id : id, golden };
  }
}
