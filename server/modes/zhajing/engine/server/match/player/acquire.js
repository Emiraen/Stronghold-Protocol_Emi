// server/match/player/acquire.js — PlayerState methods: gains and merges — copy counts, acquireChess (hand, overflow
// temp, the no-room rule) and the chess merge (3 copies → the elite, on a consumed deployed copy's tile or in the hand;
// the reward offer), promotion, transformation (突变细胞: a destroy, then a gain), item upgrades, reward / item offers,
// acquireItem and the item merges (2 identical → the golden item; deferred merges at the next prep start).
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { pieceDir, parseDir, mergeTile } from '../board.js';
import { pieceBonds } from '../bondsMeta.js';
import { MAX_OFFER_SLOTS, OK, fail } from './common.js';
import { ERR } from '../../../shared/constants.js';
import { forgeOptionById, isForgeRarity, applyForgePick, drawForge, FORGE_KILLS_PER } from '../../../shared/forgeData.js';
import { cheatForge } from './cheat.js';
// ★ 2026-10-18 深夜：这些是排查期的调试输出，生产环境每秒几百次写入（stdout 重定向到文件时是**同步写**），
//   是事件循环出现 1~2 秒停顿的嫌疑之一。默认关闭，SP_DBG_ACQ=1 才打开。
const dbg = process.env.SP_DBG_ACQ ? (...a) => console.log(...a) : () => {};

// ★ 2026-10-15：`FORGE_KILLS_PER` 原来在这里【又定义了一份 20】，和 shared/forgeData.js 那份是
//   两个独立数字，改一处就会漂移。现在只保留 shared/forgeData.js 作为唯一来源，这里转出去
//   （views.js 是从本文件 import 它的，所以必须继续 export）。
export { FORGE_KILLS_PER };

export class PlayerAcquire {
  /** Normal copies of a base chess currently owned (board/hand/temp). */
  countCopies(baseId) {
    let n = 0;
    for (const loc of this._chessLocations()) {
      const p = loc.piece;
      if (!this.gd.isGolden(p.id) && this.gd.baseIdOf(p.id) === baseId) n++;
    }
    return n;
  }

  /** Would acquiring one more normal copy of `chessId` complete a merge? */
  completesChessMerge(chessId) {
    const rec = this.gd.chess(chessId);
    if (!rec || rec.isGolden) return false;
    const need = this.gd.mergeCount(chessId);
    if (!(need > 1) || !this.gd.goldenIdOf(chessId)) return false;
    return this.countCopies(this.gd.baseIdOf(chessId)) + 1 >= need;
  }

  /**
   * Acquire a chess (buy, reward, effect grant). Takes pool copies (normal 1, elite goldenCopies) when available,
   * merges immediately when it completes a set, otherwise stows it (hand, overflow temp). Fires onGain (for the
   * elite when a merge happened, research 01 §7 "1+1+2"). Returns the owned piece (the elite after a merge) or null.
   * @param {string} chessId
   * @param {{ source?: string, toTemp?: boolean, fromPool?: boolean, silent?: boolean }} [opts]
   */
  acquireChess(chessId, { source = 'grant', toTemp = false, fromPool = true, silent = false } = {}) {
    const rec = this.gd.chess(chessId);
    try { dbg('[ACQ] id=%s rec=%s isDiy=%s diyFor=%s',
      String(chessId), String(!!rec), String(!!(rec || {}).isDiy), String((rec || {}).diyFor)); } catch { /* ignore */ }
    // a DIY slot is only ever this player's own 自选 piece: a slot it has not filled has no body (甄选干员) to gain
    if (!rec || (rec.isDiy && !rec.diyFor)) { try { dbg('[ACQ]   ✗ rec 缺失或 isDiy 但无 diyFor → return null'); } catch { /* ignore */ } return null; }
    const base = this.gd.baseIdOf(chessId);
    const need = rec.isGolden ? this.gd.goldenCopies : 1;
    // the shared pool, or this player's stock of a slotted 自选 piece (player/diy.js poolOf)
    let taken = 0;
    try {
      const pl = this.poolOf(base);
      const before = pl.left(base);
      taken = fromPool ? pl.take(base, need) : 0;
      dbg('[ACQ]   base=%s need=%s left(前)=%s taken=%s', String(base), String(need), String(before), String(taken));
    } catch (e) { try { dbg('[ACQ]   ★poolOf/take 抛错: %s', String(e && e.message)); } catch { /* ignore */ } }
    const piece = this.newPiece('chess', chessId, { poolCopies: taken });
    this.round.gainedChess++;
    let owned = piece;
    if (!rec.isGolden && this.completesChessMerge(chessId)) {
      owned = this._mergeChess(base, piece);
      if (!owned) return null;
    } else {
      const where = this.stow(piece, { allowTemp: true, toTemp });
      try { dbg('[ACQ]   stow → %s', String(where)); } catch { /* ignore */ }
      if (!where) {
        this.returnCopies(piece);
        this.m.toast(this, 'warn', '整备区已满，获得的干员已返还');
        try { dbg('[ACQ]   ✗ 整备区已满 → return null（应弹警告条）'); } catch { /* ignore */ }
        return null;
      }
    }
    this.recompute();
    // ★ 2026-10-16（owner）惊变「死亡回归」：记下"这一个棋子是本次整备阶段获得的"，
    //   回退时按 uid 回收它（不论之后被部署、合成还是留在手牌）。这是唯一可靠的判据 ——
    //   按"回合开始时棋盘快照"判断会漏（购买/部署发生在整备阶段进行中，快照里早就有它了）。
    if (!(this.gainedUids instanceof Set)) this.gainedUids = new Set();
    if (owned && owned.uid != null) this.gainedUids.add(owned.uid);
    if (!silent) this.m.dispatch(this, 'onGain', { piece: owned, kind: 'chess', source });
    this.recompute();
    return owned;
  }

  /**
   * Merge `need` normal copies of `baseId` (the incoming, not yet stowed piece first, then temp, hand, board) into
   * the elite — PRTS 卫戍协议/帮助 §干员的获得与精锐化: "发送1名【精锐】状态的该干员至手牌区（若消耗已部署至作战区的干员，
   * 则发送至作战区对应位置）" (the user's playtest #6 follow-up confirms it). The tile (`mergeTile`): when a consumed copy
   * stood on the board the elite takes its tile and facing — of several, the one that deploys first (the left board
   * column first, top to bottom within a column — Battle.start's order) [ASSUMED]. The incoming copy is never deployed (a 突变细胞 transformation
   * destroyed its carrier before the gain: that tile is no copy's). It replaces a deployed copy, so the deploy count
   * never grows. Otherwise the elite goes to the hand, overflow temp — outside PREP too (a SETTLE merge's elite waits in
   * temp through the next prep, tempDue). The copies' equipment returns to the hand ("干员晋级后已配发装备会回收至整备区";
   * overflow temp; with both full it stays on the elite, up to its equipPerChess (2) slots — any further item is
   * destroyed with a log warning, as before the official rule) and an identical normal pair among it merges like any gain
   * (checkItemMerges); their summons are removed, and an elite on the board
   * gets its own summon stack (grantTokensFor: its loadout, like any deployment). Returns the elite piece (or null if
   * the elite could not be stored).
   * @param {string} baseId
   * @param {any} incoming the acquired, not yet stowed copy (null: only owned copies)
   */
  _mergeChess(baseId, incoming) {
    const need = this.gd.mergeCount(baseId);
    const goldenId = this.gd.goldenIdOf(baseId);
    if (!(need > 1) || !goldenId) return null;
    const locs = this._chessLocations().filter((l) => !this.gd.isGolden(l.piece.id) && this.gd.baseIdOf(l.piece.id) === baseId);
    const consumed = [];
    if (incoming) consumed.push({ piece: incoming, area: 'new' });
    for (const l of locs) { if (consumed.length >= need) break; consumed.push(l); }
    if (consumed.length < need) return null;
    let copies = 0;
    const items = [];
    for (const l of consumed) {
      copies += l.piece.poolCopies || 0;
      if (l.area !== 'new') this._detach(l);
      this.removeTokensOf(l.piece.uid);
      for (const it of l.piece.items || []) items.push(it);
      l.piece.items = [];
    }
    // a new piece: this round's per-piece counters start at 0, none is carried over from the copies — a newly merged
    // elite 拉普兰德 is a new 拉普兰德 and fires +8 on its own first manual refresh this round (GitHub #169; the owner's
    // decision of 2026-10-06; pieceRoundCount)
    const elite = this.newPiece('chess', goldenId, { poolCopies: copies });
    const deployed = consumed.filter((l) => l.key && !this.board.has(l.key)).map((l) => ({ key: l.key, dir: pieceDir(l.piece) }));
    const toTile = (t) => { elite.dir = parseDir(t.dir) || 'RIGHT'; this.board.set(t.key, elite); return 'board'; };
    const tile = mergeTile(deployed, (r, c) => this._legal(elite, r, c));
    let where = tile ? toTile(tile) : this.stow(elite, { allowTemp: true });
    // hand and temp full and no deployed tile legal for it (a terrain change not re-checked yet): it stays on the first
    // deployed copy's tile rather than being lost, like a piece _evictIllegal finds no room for
    if (!where && deployed.length) where = toTile(mergeTile(deployed));
    for (const it of items) {
      if (this.stow(it, { allowTemp: true })) continue;
      if (where && this._itemRoomFor(elite, it)) { elite.items.push(it); continue; }
      this.m.log.warn?.(`[match ${this.m.roomCode}] ${this.playerId}: returned item ${it.id} destroyed (no space)`);
    }
    // the returned equipment follows the auto-merge rule like any other gain ("已拥有2件同一初始装备时…自动合并")
    this.checkItemMerges();
    // deployed like any operator placed by hand: its manually deployable summons join the hand (after the returned
    // equipment, which would be lost in temp — a summon stack removed there comes back at the next round start)
    if (where === 'board') this.grantTokensFor(elite);
    if (!where) {
      this.poolOf(baseId).give(baseId, copies);
      this.m.toast(this, 'warn', '整备区已满，晋升的精锐干员无法放入');
      this.m.log.warn?.(`[match ${this.m.roomCode}] ${this.playerId}: merge result dropped (hand+temp full)`);
      this.recompute();
      return null;
    }
    this.stats.merges++;
    this.forgeOnElite();   // ★ 锻造器：三合一产生精锐
    // 诊断（临时，2026-10-17 排查「精锐了还是原皮」）：合成出来的精锐棋子 id 与它的皮肤解析。
    // 只看结城理；定位完就删这几行。
    if (this.gd.chess(goldenId)?.charId === 'char_4217_makoto') {
      try {
      } catch { /* 非 Node 环境忽略 */ }
    }
    // `from` = the merged operator, for 炸惊模拟 规则13's same-盟约 reward roll
    this.pushRewardOffer('merge', { from: baseId });
    // (named as everyone sees the elite: a chess this player fields as its stand-in by the stand-in's name — 0.2.0 补位,
    // the owner's recall of the official mode, 2026-10-06 [ASSUMED for the ticker])
    const rec = this.gd.chess(goldenId);
    const shown = rec ? this.fieldRecord(rec) || rec : null;
    this.m.tickerFor('GOLDEN_CHAR', [this.name, shown ? shown.name : goldenId], { playerId: this.playerId });
    this.m.dispatch(this, 'onMerge', { kind: 'chess', piece: elite, baseId, consumed: consumed.map((l) => l.piece.uid), area: where });
    return elite;
  }

  /**
   * 炸惊模拟「锻造器」的发放（用户 2026-10-14）：
   *   · 精锐一名干员 → 1 个
   *   · 累计击败 FORGE_KILLS_PER 名敌人 → 1 个（在每场结算时按总数对账）
   * 计数在 this.forge（PlayerState 构造函数），随 m.private 下发。返回本次新发的个数。
   */
  grantForge(n = 1) {
    const k = Math.max(0, Math.floor(Number(n) || 0));
    if (!(k > 0) || !this.forge) return 0;
    this.forge.count += k;
    return k;
  }

  /**
   * 保证手里有一组可选的锻造卡（服务端抽，客户端只展示）。
   * 没有锻造器时返回 null；回来时若已有未消费的 roll 就原样保留。
   */
  forgeRoll() {
    if (!this.forge) return null;
    // ★ 测试模式：每次开面板先把锻造器垫回 999（花掉立刻回满，关闭时是 no-op）
    if (typeof cheatForge === 'function') cheatForge(this);
    if (!(this.forge.count > 0)) { this.forge.roll = null; return null; }
    if (!this.forge.roll) this.forge.roll = drawForge(this.m && typeof this.m.rngMeta === 'function' ? this.m.rngMeta : Math.random);
    return this.forge.roll;
  }

  /**
   * 选一张锻造卡（user 2026-10-14「接效果」）：校验 → 结算 → 扣数 → 立即效果。
   * 已锻造表用 shared/forgeData.js 的 applyForgePick（和客户端显示同一份口径）；
   * 传说攻击力的「+20% 已锻造攻击力，为 0 时 +1500」也在这里算。
   * @param {string} optId 选项 id @param {string} rarity 这一组的稀有度
   */
  forgeTake(optId, rarity) {
    if (!this.forge) return fail(ERR.WRONG_PHASE);
    if (!(this.forge.count > 0)) return fail(ERR.BAD_MSG, 'no forge');
    const opt = forgeOptionById(optId);
    if (!opt || !isForgeRarity(rarity) || !opt.value[rarity]) return fail(ERR.BAD_MSG, 'bad forge option');
    if (this.forge.roll && this.forge.roll.rarity !== rarity) return fail(ERR.BAD_MSG, 'rarity mismatch');
    if (this.forge.roll && Array.isArray(this.forge.roll.picks) && !this.forge.roll.picks.includes(optId)) {
      return fail(ERR.BAD_MSG, 'not in this roll');
    }
    const res = applyForgePick(this.forge.forged || {}, optId, rarity);
    this.forge.forged = res.forged;
    this.forge.count -= 1;
    this.forge.roll = this.forge.count > 0 ? drawForge(this.m && typeof this.m.rngMeta === 'function' ? this.m.rngMeta : Math.random) : null;
    // ★ 必须传玩家：Match.markPrivate(ps) 要一个身位。玩家侧的入口是 basics.js 的
    //   `dirty() { this.m.markPrivate(this); }` —— 原来写成 `this.markPrivate()` 等于传 undefined，
    //   客户端永远收不到新视图（用户 2026-10-14 报「无法选择」就是它）。
    if (typeof this.dirty === 'function') this.dirty();
    // 资金：立刻到账（其余 8 项走战斗输入，见 round.js 的 forge 字段 + content/forge.js）
    if (optId === 'gold' && res.delta > 0) this.addFunds(res.delta, { reason: 'forge' });
    return OK;
  }

  /** 精锐一名干员（三合一 or 升华）→ 一个锻造器。 */
  forgeOnElite() {
    if (!this.forge) return 0;
    this.forge.elites++;
    return this.grantForge(1);
  }

  /**
   * 累计击杀对账：每 FORGE_KILLS_PER 个敌人一个锻造器。
   * 幂等 —— 记住已经发到第几个整数倍（killsPaid），所以重复调用不会多发。
   * 在 match/settle.js 每场结算累加完 ps.stats.kills（含联防）之后调用一次。
   */
  forgeOnKills() {
    if (!this.forge) return 0;
    const due = Math.floor((Number(this.stats && this.stats.kills) || 0) / FORGE_KILLS_PER);
    const gain = due - (this.forge.killsPaid || 0);
    if (!(gain > 0)) return 0;
    this.forge.killsPaid = due;
    return this.grantForge(gain);
  }

  /** Promote a normal chess piece to its elite in place (升华, 博士投影). Takes extra pool copies when available. */
  promote(piece) {
    if (!piece || piece.kind !== 'chess' || this.gd.isGolden(piece.id)) return false;
    const goldenId = this.gd.goldenIdOf(piece.id);
    if (!goldenId) return false;
    const base = this.gd.baseIdOf(piece.id);
    const extra = Math.max(0, this.gd.goldenCopies - (piece.poolCopies || 0));
    piece.poolCopies = (piece.poolCopies || 0) + this.poolOf(base).take(base, extra);
    piece.id = goldenId;
    this.recompute();
    // an elite on the board tops its summon stacks up to the elite's deploy limit, like an elite merged onto a tile
    // (_mergeChess → grantTokensFor): 麦哲伦 / 令 3 → 4, 望 6 → 7 with their modules (0.2.0 review round 17)
    if ([...this.board.values()].includes(piece)) this.grantTokensFor(piece);
    this.forgeOnElite();   // ★ 锻造器：升华为精锐
    return true;
  }

  /**
   * Transformation (突变细胞 "战斗结束后，装备者替换为高一阶的随机干员"; PRTS 卫戍协议：盟约 下半/PRTS盟约记录 备注 "生效时，原
   * 干员销毁，获得一名高一阶的随机初始干员（最高六阶）"): a destroy followed by a gain. The carrier is destroyed wherever it
   * stands — a board tile is freed (the deploy count drops), its summons are removed, its pool copies return. Its
   * equipment, the cell included, comes off first (PRTS 卫戍协议/帮助 "在失去该干员（干员出售、销毁、合并等）…时自动卸除"): to
   * the hand, overflowing into temp, auto-merging like any gain. Then `newId` is gained like any other gained operator
   * (acquireChess, onGain source 'transform'): the hand, overflow temp ("被发送至手牌区的物资优先从右到左填充空位"), and with
   * both full it goes back to the pool ("整备区已满，获得的干员已返还"); it gets no summon card in the hand (only a deployment
   * brings one), and a merge it completes follows the ordinary rule (_mergeChess: the elite on a consumed deployed copy's
   * tile, else the hand — the carrier's freed tile is no copy's). An item that found no slot takes one the gain freed (a
   * merge consumes copies), else stays on the gained operator up to its equipPerChess slots, else it is destroyed with a
   * log warning (as in a merge). Official footage (bilibili BV1vzyVBuEN9, BV1Qkw1zMEoR; pointed out in PR #2): at the
   * next prep the carrier's tile is empty, one more deployment is left and the new operator waits in the 整备区.
   * @param {any} piece the carrier (an owned chess piece)
   * @param {string} newId chess id gained in its place
   * @returns {any} the gained piece (the elite when it completed a merge) or null
   */
  transformChess(piece, newId) {
    const loc = this.find(piece.uid);
    if (!loc || loc.piece.kind !== 'chess' || !this.gd.chess(newId)) return null;
    // 原干员销毁: off its tile / slot, its summons removed, its copies back to the pool
    this._detach(loc);
    this.removeTokensOf(piece.uid);
    const items = piece.items || [];
    piece.items = [];
    this.returnCopies(piece);
    // its equipment comes off first (the returned pair auto-merges, which may free a slot for the gain)
    const left = items.filter((it) => !this.stow(it, { allowTemp: true }));
    this.checkItemMerges();
    // 获得一名…干员: gained like any other gained operator
    const np = this.acquireChess(newId, { source: 'transform' });
    for (const it of left) {
      if (this.stow(it, { allowTemp: true })) continue;
      if (np && this.find(np.uid) && this._itemRoomFor(np, it)) { np.items.push(it); continue; }
      this.m.log.warn?.(`[match ${this.m.roomCode}] ${this.playerId}: returned item ${it.id} destroyed (no space)`);
    }
    if (left.length) this.checkItemMerges();
    this.recompute();
    return np;
  }

  /** Normal item → golden version in place (整备). */
  upgradeItem(piece) {
    const rec = this.gd.item(piece.id);
    if (!rec || rec.isGolden) return false;
    const gid = rec.upgradeChessId || rec.goldenId;
    if (!gid || !this.gd.item(gid)) return false;
    piece.id = gid;
    this.recompute();
    return true;
  }

  /**
   * Queue a reward offer: `count` DIFFERENT chess of tier min(level + offset, maxTier) at price 0 (pick 1). Each is a
   * copy-weighted roll from the shared pool excluding the ones already drawn; a tier left without another chess tops
   * up from the tier below (user playtest #6 item 19: the official promotion reward never offers one operator twice —
   * the user's first-hand report; the normal shop's slots may repeat). The offer reserves no copies (the pick takes one).
   * The player's slotted 自选 pieces join the draw like in its shop (player/diy.js diyRollEntries: once the 调度中心 is at
   * the slot's level) — the reward is a temporary refresh of the shop ("临时刷新3名…干员") [ASSUMED].
   */
  pushRewardOffer(source = 'merge', { tier = null, ids = null, label = null, from = null } = {}) {
    const ro = this.gd.rewardOffer();
    const t = Number.isInteger(tier) ? tier : Math.min(this.shop.level + ro.tierOffset, ro.maxTier);
    // an offer never shows one operator twice, whoever built the list (user playtest #6 item 19)
    let list = Array.isArray(ids) ? [...new Set(ids)].filter((id) => this.gd.chess(id)) : null;
    // 炸惊模拟 规则13: the promotion reward is no longer "one tier above the shop" but a random tier drawn from the
    // mode's own weight table (1 阶 32 … 6 阶 2 — falling, so the low tiers dominate) restricted to operators sharing
    // at least one 盟约 with the operator that was just merged. 变形同构体's granted bonds count as its own (pieceBonds),
    // and the merged operator itself is left out. A tier without a candidate falls to a lower one; if the bond filter
    // leaves nothing at all the ordinary roll runs instead, so a merge never ends without an offer.
    if (!list && ro.sameBond && from && Array.isArray(ro.tierWeights) && ro.tierWeights.length) {
      const bonds = new Set(pieceBonds(this.gd, { id: from }));
      const base0 = this.gd.baseIdOf(from);
      list = [];
      const ok = (id) => !list.includes(id) && this.gd.baseIdOf(id) !== base0 && pieceBonds(this.gd, { id }).some((b) => bonds.has(b));
      // 用户 2026-10-13（方案 D）：奖励的阶权重按**自己当前的商店等级**查表；没有分等级表时回落到一张总表。
      const tierWeights = (ro.tierWeightsByLevel && ro.tierWeightsByLevel[this.shop.level]) || ro.tierWeights;
      // ★ 2026-10-15（用户现场）：掉阶的**下限**必须是权重表里最低的那一档，不能写死 1。
      //   条文里 `tierWeightsByLevel["1"] = {2:70, 3:30}` —— 一级商店的升阶奖励【只有 2/3 阶】。
      //   原来 `tt >= 1` 会在 2、3 阶都没有「与被合并干员同盟约」的候选时一路掉到 **1 阶**，
      //   于是「一级商店精锐化，三选一里冒出一级干员」。掉到表的最低档仍无候选时，
      //   下面 `list.length === 0` 会回落到普通 roll（那条路同样按 floor 收口）。
      const floor = tierWeights.reduce((m, e) => Math.min(m, Number(e[0]) || 6), 6);
      for (let i = 0; i < ro.count; i++) {
        let id = null;
        for (let attempt = 0; attempt < 12 && !id; attempt++) {
          for (let tt = this._weightedTier(tierWeights); tt >= floor && !id; tt--) id = this._rollRewardChess(tt, ok);
        }
        if (id) list.push(id);
      }
      if (!list.length) list = null;
    }
    if (!list) {
      list = [];
      const fresh = (id) => !list.includes(id);
      // ★ 同上的下限，但**只对规则13（有 tierWeights 的炸惊模式）收口**：
      //   没有那张权重表的模式（普通模式）原本就是 `tt >= 1`，必须【逐字节保持原样】。
      //   规则13 时 `t` = min(商店等级 + tierOffset, 封顶) —— 就是条文里的**保底阶**
      //   （方案 D：保底 L+1），所以掉阶也只掉到保底阶，不再掉到 1 阶
      //   （一级商店 t=2，掉到 1 就是同一个 bug 的另一条路径）。
      const rule13 = Array.isArray(ro.tierWeights) && ro.tierWeights.length > 0;
      const lo = rule13 ? t : 1;
      for (let i = 0; i < ro.count; i++) {
        let id = null;
        for (let tt = t; tt >= lo && !id; tt--) id = this.pool().roll(this.m.rngShop, { tier: tt, filter: fresh });
        if (id) list.push(id);
      }
    }
    // ★ 2026-10-17（用户：「精锐规则补一条：如果后两级商店的人数不够3人向下兼容」）：
    //   三选一凑不满 `ro.count`（=3）时，从**低于后两级**的阶继续往下补人。
    //   「后两级」= 目标阶 t 与 t-1（商店 5/6 级时就是 6 和 5）；这两阶的候选不足 3 人时，
    //   从 t-2 一路扫到 1 阶，能抽到几个补几个，直到凑满或池子抽空。
    //   **只加在末尾**：上面的两条既有路径完全不动 ⇒ 凑得满的时候行为逐字节不变。
    if (list.length && list.length < ro.count) {
      for (let tt = Math.max(1, t - 2); tt >= 1 && list.length < ro.count; tt--) {
        for (let guard = 0; guard < 12 && list.length < ro.count; guard++) {
          const id = this.pool().roll(this.m.rngShop, { tier: tt, filter: (x) => !list.includes(x) });
          if (!id) break;
          list.push(id);
        }
      }
    }
    if (!list.length) return null;
    const offer = { tier: t, source, label: typeof label === 'string' && label ? label : null, slots: list.slice(0, MAX_OFFER_SLOTS).map((id) => ({ kind: 'chess', id, price: ro.price, sold: false })) };
    this.offers.push(offer);
    this.dirty();
    return offer;
  }

  /** 炸惊模拟 规则13: one tier drawn from `[[tier, weight], …]` (the mode's rewardOffer.tierWeights). */
  _weightedTier(weights) {
    let total = 0;
    for (const [, w] of weights) total += w;
    if (!(total > 0)) return weights[weights.length - 1][0];
    let r = this.m.rngShop() * total;
    for (const [t, w] of weights) { r -= w; if (r < 0) return t; }
    return weights[weights.length - 1][0];
  }

  _rollRewardChess(tier, filter) {
    // ★ 2026-10-18（owner）：炎国游记改版后不再动精锐奖励的权重（旧实现是五/六阶里【炎】候选 ×2），
    //   现在它自己发一名【炎】干员，每两回合一次 —— 见 server/sim/content/jibian.js。
    return this.pool().roll(this.m.rngShop, { tier, filter });
  }

  /**
   * Queue a free pick-one offer of items (凯瑟琳 定向投放, 娜仁图亚 见者有份); shown as shop.rewardOffer with slots of kind
   * 'item' under its `label` (the effect's name; player report #6 after 0.1.0).
   */
  pushItemOffer(ids, { source = 'effect', tier = null, label = null } = {}) {
    const list = [...new Set(Array.isArray(ids) ? ids : [])].filter((id) => this.gd.item(id)).slice(0, MAX_OFFER_SLOTS);
    if (!list.length) return null;
    const offer = { tier: Number.isInteger(tier) ? tier : null, source, label: typeof label === 'string' && label ? label : null, slots: list.map((id) => ({ kind: 'item', id, price: 0, sold: false })) };
    this.offers.push(offer);
    this.dirty();
    return offer;
  }

  /** Item merge candidates: normal, mergeable, with a golden version. */
  _itemMergeable(id) {
    const rec = this.gd.item(id);
    if (!rec || rec.isGolden || rec.itemType !== 'EQUIP' || !rec.mergeable) return false;
    const n = Number.isInteger(rec.upgradeNum) ? rec.upgradeNum : this.gd.itemMergeCount;
    if (!(n > 1 && n < 100)) return false;
    const gid = rec.upgradeChessId || rec.goldenId;
    return !!(gid && this.gd.item(gid));
  }

  _itemLocations(id) {
    const out = [];
    for (let i = 0; i < this.temp.length; i++) if (this.temp[i] && this.temp[i].kind === 'item' && this.temp[i].id === id) out.push({ piece: this.temp[i], area: 'temp', idx: i });
    for (let i = 0; i < this.hand.length; i++) if (this.hand[i] && this.hand[i].kind === 'item' && this.hand[i].id === id) out.push({ piece: this.hand[i], area: 'hand', idx: i });
    for (const holder of this.allChess()) for (const it of holder.items || []) if (it.id === id) out.push({ piece: it, area: 'equipped', holder });
    return out;
  }

  completesItemMerge(id) {
    if (!this._itemMergeable(id)) return false;
    const rec = this.gd.item(id);
    const n = Number.isInteger(rec.upgradeNum) ? rec.upgradeNum : this.gd.itemMergeCount;
    return this._itemLocations(id).length + 1 >= n;
  }

  /**
   * Acquire an item (buy, supply card, grant). Merges with an identical normal copy (hand/temp/equipped) into the
   * golden item (to the hand). Returns the owned piece or null.
   * `deferMerge` (effectsMeta, while onPrepEnd is on the stack): stow it — hand, else temp — and do not merge in this
   * call, even when an identical normal copy is already owned. The next prep's start runs checkItemMerges. Nothing
   * already equipped is taken off for the fight about to start. Hand and temp both full keeps the 「整备区已满，获得的装备已销毁」
   * outcome. [ASSUMED] every item granted at 休整期结束, not only 维多利亚's 战栗维式重锤 (owner's decision 2026-10-04).
   */
  acquireItem(itemId, { source = 'grant', toTemp = false, silent = false, deferMerge = false } = {}) {
    const rec = this.gd.item(itemId);
    if (!rec) return null;
    let piece = this.newPiece('item', itemId);
    // A prep-end grant may sit beside an identical copy until the next prep. The invariant counts only copies
    // without this mark, so the fight that is about to start is not reported as a missed merge.
    if (deferMerge) piece.deferMerge = true;
    if (!deferMerge && this.completesItemMerge(itemId)) {
      piece = this._mergeItem(itemId, piece);
      if (!piece) return null;
    } else if (!this.stow(piece, { allowTemp: true, toTemp })) {
      this.m.toast(this, 'warn', '整备区已满，获得的装备已销毁');
      return null;
    }
    this.recompute();
    if (!silent) this.m.dispatch(this, 'onGain', { piece, kind: 'item', source });
    return piece;
  }

  _mergeItem(itemId, incoming = null) {
    const rec = this.gd.item(itemId);
    const need = Number.isInteger(rec.upgradeNum) ? rec.upgradeNum : this.gd.itemMergeCount;
    const locs = this._itemLocations(itemId);
    const consumed = incoming ? [{ piece: incoming, area: 'new' }] : [];
    for (const l of locs) { if (consumed.length >= need) break; consumed.push(l); }
    if (consumed.length < need) return null;
    // remember where equipped twins sat: with a full hand AND a full temp the golden item takes the first one's slot
    const slotOf = consumed.filter((l) => l.area === 'equipped').map((l) => ({ holder: l.holder, idx: l.holder.items.indexOf(l.piece) }));
    for (const l of consumed) if (l.area !== 'new') this._detach(l);
    const golden = this.newPiece('item', rec.upgradeChessId || rec.goldenId);
    if (!this.stow(golden, { allowTemp: true })) {
      const at = slotOf[0];
      if (!at || !this.find(at.holder.uid)) {
        this.m.toast(this, 'warn', '整备区已满，合成的装备已销毁');
        return null;
      }
      at.holder.items.splice(Math.max(0, Math.min(at.idx, at.holder.items.length)), 0, golden);
    }
    this.stats.itemMerges++;
    this.m.dispatch(this, 'onMerge', { kind: 'item', piece: golden, itemId, consumed: consumed.map((l) => l.piece.uid) });
    return golden;
  }

  /** Merge every identical normal item pair currently owned (after equips / returns). */
  checkItemMerges() {
    for (let guard = 0; guard < 20; guard++) {
      const counts = new Map();
      const scan = (p) => { if (p && p.kind === 'item' && this._itemMergeable(p.id)) counts.set(p.id, (counts.get(p.id) || 0) + 1); };
      for (const p of this.hand) scan(p);
      for (const p of this.temp) scan(p);
      // ★ 2026-10-17（用户：「叠加不了」）：**已装备的可叠加物品不参与合成**。
      //   维式战锤 `mergeable: true, upgradeNum: 2` —— 原来这一行把"已装备"的也算进合成计数，
      //   于是第 2 把普通锤一上身就被判成"凑够 2 把"、合成成精锐，永远叠不出第 2 层。
      //   用户选的是「合成仍然优先」（手上两把相同仍会合成），所以只把**已装备**的那份排除：
      //   丢在手上 → 照旧合成；先装备再买 → 第二把不合成，正常压进那一叠（上限 20）。
      for (const holder of this.allChess()) {
        for (const it of holder.items || []) {
          const srec = this.gd.item(it.id);
          if (Number(srec && srec.stackMax) > 0) continue;   // 可叠加：上身即成一叠，禁合成
          scan(it);
        }
      }
      let did = false;
      for (const [id, n] of counts) {
        const rec = this.gd.item(id);
        const need = Number.isInteger(rec.upgradeNum) ? rec.upgradeNum : this.gd.itemMergeCount;
        if (n >= need) { if (this._mergeItem(id, null)) did = true; break; }
      }
      if (!did) return;
    }
  }
}
