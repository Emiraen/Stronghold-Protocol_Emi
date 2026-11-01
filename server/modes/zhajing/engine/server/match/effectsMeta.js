// server/match/effectsMeta.js — registry + dispatcher of prep-phase ("SERVER_*") effects (DESIGN §6.4).
// Full API reference with examples: docs/META.md.
//
// Registry keys (one handler object per key; a later register() of the same key replaces the earlier one, so content
// registered by server/sim/content/*.js → registerMeta(registry) overrides the engine's built-in defaults):
//   garrison:<effectKey>   特质 prep effects (data/garrisons.json effectKey, e.g. 'garrison:SERVER_ADD_BOND_METHOD')
//   band:<bandId>          strategy (band) effects
//   bond:<bondId>          bond meta effects (助力 per-round layers, 远见 milestones, …)
//   item:<itemKey>         equipment / Arts (itemKey = item id without the _a/_b suffix, e.g. 'item:chess_item_1_03_e')
//   choice:<effectId>      机变 card application (overrides the family default in choices.js)
//   effect:<id>            persistent EffectRefs added with ctx.addEffect({ key: 'effect:<id>' … })
//   global:<name>          runs for every player on every hook
//
// Hooks (handler methods; all optional, signature (ctx, ev)):
//   onRoundStart onIncome onPrepStart onPrepEnd onGain onSold onRefresh onPrice onBuy onSpend onMerge onLevelUp
//   onBattleStart onBattleResult onChoicePick onEquip onArt onDestroy onLayers
// Garrisons fire only on the hook of their eventType (SERVER_GAIN→onGain of the gained piece, SERVER_PREP_START→
// onRoundStart, SERVER_PREP_FIN→onPrepEnd, SERVER_CHESS_SOLD→onSold of the sold piece, SERVER_PRICE→onPrice of the
// slot's chess, SERVER_REFRESH_SHOP→onRefresh); the dispatcher calls `handler[hook] ?? handler.run`. A handler may
// widen that per garrison with `garrisonHooks(garrison) → hook[]` (e.g. "<进入休整期时><休整期结束时>"). Owned-piece
// garrisons fire for board pieces, and for hand pieces unless bbStr.conditionkey is 'character_target_inboard'. A
// refresh (onRefresh) runs those that stood on the board / in the hand when it happened (taken before its first
// handler): a chess gained during its dispatch — 贾维's gift, the elite that gift completes — waits for the next refresh.
// 投资人 (investShip) active ⇒ SERVER_GAIN garrisons run ×2 (×3 at ≥ 100 layers) — owned by the dispatcher.
// ctx.triggerGarrisons(uid, eventType) re-runs another piece's garrisons (铃兰, "触发…的获得时效果", 特质相同).
// Items: onEquip / onArt / onDestroy go to the item's own handler only; every other hook runs for items equipped on
// owned chess (ev.source.holder). That step walks a snapshot — the owned chess and each holder's items as they stand
// when it begins (every [holder, item] pair, taken before the first item runs) — and runs an item only if, when its
// turn comes, it is still equipped on that holder and the holder is still owned: handlers move and destroy pieces
// mid-walk (突变细胞 destroys its holder, returns the equipment to the hand and gains an operator; normal 博士投影
// destroys itself, which splices holder.items), and a live walk skipped the next item or ran it with a holder that was
// gone. Pieces gained or equipped during the walk wait for the next dispatch; an item moved during it runs at most once
// (on the holder it stood on, if its turn came before the move).
// Dispatch order per player: global → band → bonds → garrisons (board reading order,
// then hand) → equipped items → effects (insertion order); onPrice runs the priced chess's own 特质 first (购买价格为N
// sets the price the discounts and caps of bonds / strategies then act on — user playtest #5). Every call is
// try/catch-guarded; nested dispatch depth is capped (MAX_DEPTH) so content can never loop the server.
// An eliminated player gets no dispatch, except the persistent effects whose handler sets `afterElimination: true`
// (onRoundStart, EffectDispatcher.dispatchEliminated: 信标's gift — GitHub #86).

import { itemKey } from './gamedata.js';
import { boardOrder, parseKey, tileKey } from './board.js';
import { pieceBonds as bondsOfPiece } from './bondsMeta.js';
import { registerAllMeta } from '../sim/content/index.js';
import { registerBuiltins } from './builtinMeta.js';
import { msg, dn } from '../../shared/i18n.js';
import { activeBonds as jibianActiveBonds, ownedJibianIdsOf } from '../sim/content/jibianBonds.js';
// ★ 2026-10-18 深夜：这些是排查期的调试输出，生产环境每秒几百次写入（stdout 重定向到文件时是**同步写**），
//   是事件循环出现 1~2 秒停顿的嫌疑之一。默认关闭，SP_DBG_ACQ=1 才打开。
const dbg = process.env.SP_DBG_ACQ ? (...a) => console.log(...a) : () => {};

/** 惊变「二极管」(jibian_erjiguan) 翻倍的概率（其余为「不生效」）。可调：改这一个数即可。 */
const DIODE_DOUBLE_CHANCE = 0.5;

export const HOOKS = Object.freeze([
  'onLayout',   // ★ 2026-10-13：摆位完成（placement.move）派发，影分身用
  'onRoundStart', 'onIncome', 'onPrepStart', 'onPrepEnd', 'onGain', 'onSold', 'onRefresh', 'onPrice', 'onBuy',
  'onSpend', 'onMerge', 'onLevelUp', 'onBattleStart', 'onBattleResult', 'onChoicePick', 'onEquip', 'onArt',
  'onDestroy', 'onLayers',
  // ★ 2026-10-16（owner）：两个**内容侧**的钩子。加进白名单是必须的 —— dispatcher 只派发列在这里的名字，
  //   没列出的 handler 方法会被启动自检报成 "is not a hook and will never run" 而**永远不执行**
  //   （「时光之末」的 onWouldEliminate 与「追忆」的 onRoundWouldStart 就是这样静默失效的）。
  //   `onWouldEliminate`：MatchPhases.settle 的淘汰判定之前派发，handler 置 `ev.saved = true` 可阻止淘汰（时光之末）。
  //   `onRoundWouldStart`：MatchPhases.startRound 最前面派发（this.round 刚写上、状态还没重置），
  //                       handler 改写 `ev.round` 即改变本回合的回合号（追忆跳回合）。
  'onWouldEliminate', 'onRoundWouldStart',
]);
/** Non-hook members a handler object may carry. */
const HANDLER_EXTRAS = new Set(['run', 'garrisonHooks']);

/** Garrison eventType → dispatcher hook. */
export const GARRISON_HOOK = Object.freeze({
  SERVER_GAIN: 'onGain',
  SERVER_PREP_START: 'onRoundStart',
  SERVER_PREP_FIN: 'onPrepEnd',
  SERVER_CHESS_SOLD: 'onSold',
  SERVER_PRICE: 'onPrice',
  SERVER_REFRESH_SHOP: 'onRefresh',
});

// `jibian:` = 炸惊模拟 惊变 cards (server/sim/content/jibian.js): a picked card is an EffectRef added by
// server/match/choices.js applyDefault under the key `jibian:<effectId>`, and its prep-side part is dispatched here.
const KEY_RE = /^(garrison|band|bond|item|choice|effect|jibian|global):[A-Za-z0-9_\-.:#]+$/;
export const MAX_DEPTH = 6;

export class MetaRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this._h = new Map();
    /** registration problems that do not throw (unknown hook names — usually a typo) */
    this.warnings = [];
  }

  /**
   * Register a handler object (or a bare function = { run }) under a key. Replaces an existing registration.
   * @param {string} key
   * @param {object|Function} handler
   */
  register(key, handler) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new TypeError(`MetaRegistry.register: bad key ${String(key)}`);
    const h = typeof handler === 'function' ? { run: handler } : handler;
    if (!h || typeof h !== 'object') throw new TypeError(`MetaRegistry.register(${key}): handler must be an object or function`);
    for (const name of Object.keys(h)) {
      if (typeof h[name] === 'function' && !HOOKS.includes(name) && !HANDLER_EXTRAS.has(name) && this.warnings.length < 200) {
        this.warnings.push(`${key}: '${name}' is not a hook (${HOOKS.join(' ')})`);
      }
    }
    this._h.set(key, h);
    return this;
  }

  unregister(key) { return this._h.delete(key); }
  get(key) { return this._h.get(key) ?? null; }
  has(key) { return this._h.has(key); }
  keys() { return [...this._h.keys()]; }

  // sugar
  garrison(effectKey, h) { return this.register(`garrison:${effectKey}`, h); }
  band(bandId, h) { return this.register(`band:${bandId}`, h); }
  bond(bondId, h) { return this.register(`bond:${bondId}`, h); }
  item(key, h) { return this.register(`item:${itemKey(key)}`, h); }
  choice(effectId, h) { return this.register(`choice:${effectId}`, h); }
  effect(id, h) { return this.register(`effect:${id}`, h); }
  global(name, h) { return this.register(`global:${name}`, h); }

  globals() {
    const out = [];
    for (const [k, h] of this._h) if (k.startsWith('global:')) out.push([k, h]);
    return out;
  }
}

let defaultRegistry = null;

/** Build a registry: engine built-ins first, then every content module's registerMeta (content wins). */
export function createRegistry({ builtins = true, content = true, log = console } = {}) {
  const reg = new MetaRegistry();
  if (builtins) {
    try { registerBuiltins(reg); } catch (e) { log.error?.('[meta] registerBuiltins failed', e); }
  }
  if (content) {
    try { registerAllMeta(reg); } catch (e) { log.error?.('[meta] registerAllMeta failed', e); }
  }
  if (reg.warnings.length) log.warn?.(`[meta] ${reg.warnings.length} handler method(s) are not hooks and will never run, e.g. ${reg.warnings.slice(0, 3).join('; ')}`);
  return reg;
}

/** Process-wide registry (server boot): built-ins + content. */
export function getDefaultRegistry() {
  if (!defaultRegistry) defaultRegistry = createRegistry();
  return defaultRegistry;
}

/** Tests: drop the singleton. */
export function resetDefaultRegistry() { defaultRegistry = null; }

// =====================================================================================================
// dispatcher

export class EffectDispatcher {
  /**
   * @param {import('./Match.js').Match} m
   * @param {MetaRegistry} registry
   */
  constructor(m, registry) {
    this.m = m;
    this.registry = registry;
    this.depth = 0;
    this.errors = 0;
    this._errKeys = new Set();
    /** `${key}.${hook}: message` → { count, stack } (diagnostics, tools/matchrun.mjs --errors) */
    this.errorsByKey = new Map();
  }

  _report(key, hook, e) {
    this.errors++;
    const msg = `${key}.${hook}: ${e && e.message ? e.message : e}`;
    const rec = this.errorsByKey.get(msg);
    if (rec) rec.count++;
    else if (this.errorsByKey.size < 500) this.errorsByKey.set(msg, { count: 1, stack: e && e.stack ? String(e.stack) : null });
    if (this._errKeys.has(msg)) return;
    this._errKeys.add(msg);
    if (this._errKeys.size > 500) this._errKeys.clear();
    this.m.log.error?.(`[match ${this.m.roomCode}] meta handler error ${msg}`, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : '');
  }

  _call(ps, key, handler, hook, source, ev, repeat = 1) {
    const fn = typeof handler[hook] === 'function' ? handler[hook] : source.kind === 'garrison' && typeof handler.run === 'function' ? handler.run : null;
    if (!fn) return;
    const ctx = makeCtx(this.m, ps, source, hook, ev);
    for (let i = 0; i < repeat; i++) {
      try { fn.call(handler, ctx, ev); } catch (e) { this._report(key, hook, e); }
    }
  }

  /** 获得时 multiplier from 投资人 (investShip): ×2 while active, ×3 at ≥ 100 layers (research 02 §3.17). */
  investRepeat(ps) {
    const v = this._investRepeatBase(ps);
    // ★ 惊变羁绊「真·投资人」：把一次触发直接翻倍（无投资人 1→2；有投资人 2→4）
    try {
      // ★ 2026-10-21：读 effects（匹配赛阶段）而不是 playerEffects（只有战斗快照才有）
      if (jibianActiveBonds(ownedJibianIdsOf(ps)).some((a) => a.def.id === 'true_investor')) return Math.max(1, v) * 2;
    } catch { /* 羁绊出错就用原值 */ }
    return v;
  }

  /** 原来的投资人/盟约口径（不含真·投资人）。 */
  _investRepeatBase(ps) {
    // 惊变「投资人」(jibian_touziren, 用户 2026-10-12):「你触发的每个【获得时】效果改为触发两次」—— 这就是引擎里
    // 唯一的"获得时 ×N"乘法点，所以这张卡在这里生效：没有投资人盟约时给 2 次；已经有更高的次数时不往下压。
    const card = !!(ps && Array.isArray(ps.effects) && ps.effects.some((e) => e && e.key === 'jibian:jibian_touziren'));
    // ★ 2026-10-19 惊变羁绊「真·投资人」：把「一次触发」直接翻倍 —— 没有投资人卡时 1→2，
    //   有投资人卡时 2→4（owner 口径：把一次触发改成 2 次 / 有投资人就 4 次）。
    const trueInv = (() => {
      try {
        return jibianActiveBonds(ownedJibianIdsOf(ps)).some((a) => a.def.id === 'true_investor');
      } catch { return false; }
    })();
    const b = ps.bonds && ps.bonds.investShip;
    if (!b || !b.active) return card ? 2 : 1;
    const bond = this.m.gd.bond('investShip');
    const bb = bond && bond.bb ? bond.bb : {};
    // data: bb.count 2 ("每次触发2次"), layerMilestones [{ layer: 100 }] ("<达到100层>…每次触发3次")
    const base = Number.isInteger(bb.count) && bb.count > 1 ? bb.count : 2;
    // 炸惊模拟 (bonds.json `zj`): 阈值 2 / 3 —— 2 名触发 2 次，3 名触发 3 次，不再看层数
    if (this.m.gd.zhajing) {
      const n = b.tier >= 2 ? base + 1 : base;
      return card ? Math.max(n, 2) : n;
    }
    const ms = bond && Array.isArray(bond.layerMilestones) ? bond.layerMilestones.find((x) => x && Number(x.layer) > 0) : null;
    const hi = ms ? Number(ms.layer) : Number.isFinite(bb.layer) && bb.layer > 0 ? bb.layer : 100;
    const n = b.layers >= hi ? base + 1 : base;
    return card ? Math.max(n, 2) : n;
  }

/** 惊变「二极管」翻倍的概率（其余为「不生效」）。 */

  /**
   * 惊变「二极管」(jibian_erjiguan, 用户 2026-10-14):「你的干员触发卫戍特质时有概率获得以下随机一种效果：
   * 此次特质效果翻倍 / 此次特质效果不生效」。`_call` 的 `repeat` 参数就是"这个 handler 跑几次"，
   * 所以这里返回 base×2（翻倍）或 0（不生效）即可 —— 不需要碰任何特质自己的实现。
   * 随机走 `rngMeta`（Match.js:310，专门给 meta 效果的那条流）。
   * 可调：DIODE_DOUBLE_CHANCE 是"翻倍"的概率，其余即"不生效"；改它就能整体加/减这张卡的期望。
   */
  diodeRepeat(ps, base) {
    const n = Number.isFinite(base) ? base : 1;
    if (!(n > 0)) return n;
    if (!ps || !Array.isArray(ps.effects)) return n;
    if (!ps.effects.some((e) => e && e.key === 'jibian:jibian_erjiguan')) return n;
    // ★ 惊变羁绊「出老千」：二极管改成**只会翻倍**（owner 2026-10-19 的定义）
    if (this.jibianBondActive(ps, 'cheat')) return n * 2;
    return this.m.rngMeta() < DIODE_DOUBLE_CHANCE ? n * 2 : 0;
  }

  /**
   * 这个玩家是否已激活某个惊变羁绊（出老千等卡面改写用）。
   * @param {any} ps @param {string} bondId @returns {boolean}
   */
  jibianBondActive(ps, bondId) {
    try {
      return jibianActiveBonds(ownedJibianIdsOf(ps)).some((a) => a.def.id === bondId);
    } catch { return false; }
  }

  /**
   * Dispatch a hook for one player. `ev` is passed to every handler (mutable: onPrice writes ev.price, onSold
   * ev.gain, onBattleStart ev.input, …) and returned.
   */
  dispatch(ps, hook, ev = {}, { quiet = false, skipKey = null } = {}) {
    if (!ps || this.depth >= MAX_DEPTH) {
      if (ps && !quiet) this.m.log.warn?.(`[match ${this.m.roomCode}] meta dispatch depth limit (${hook})`);
      return ev;
    }
    this.depth++;
    // An item granted while 休整期结束 is on the stack (this hook, or onGain re-entering it — 维多利亚 pays the next
    // milestone from the grant's onGain) is stowed and not merged until the next prep start. [ASSUMED] every such
    // item, not only the 战栗维式重锤 (owner's decision 2026-10-04: "an item that arrives at 休整期结束").
    const deferItems = hook === 'onPrepEnd';
    if (deferItems) ps._deferItemMerge = (ps._deferItemMerge || 0) + 1;
    try {
      const reg = this.registry;
      // onRefresh: the board / hand chess as they stood when the refresh happened, taken before any handler runs — a
      // chess gained during this dispatch (贾维's gift on the 6th refresh, the elite its copy completes) was not there
      // when it happened: its 刷新时 特质 waits for the next manual refresh (拉普兰德's "本回合首次主动刷新", PR #196)
      const refreshed = hook === 'onRefresh' ? refreshPieces(ps) : null;
      // 0. onPrice: the priced chess's own 特质 first — 购买价格为N defines the price every other modifier acts on
      if (hook === 'onPrice') this._garrisons(ps, hook, ev);
      // 1. globals
      for (const [key, h] of reg.globals()) this._call(ps, key, h, hook, { kind: 'global', key }, ev);
      // 2. band
      if (ps.bandId) {
        const key = `band:${ps.bandId}`;
        const h = reg.get(key);
        if (h) this._call(ps, key, h, hook, { kind: 'band', key, bandId: ps.bandId, band: this.m.gd.band(ps.bandId) }, ev);
      }
      // 3. bonds
      for (const bondId of this.m.gd.bondIds) {
        const key = `bond:${bondId}`;
        const h = reg.get(key);
        if (h) this._call(ps, key, h, hook, { kind: 'bond', key, bondId, bond: ps.bonds[bondId] ?? null }, ev);
      }
      // 4. garrisons (onPrice: already run as step 0)
      if (hook !== 'onPrice') this._garrisons(ps, hook, ev, refreshed);
      // 5. equipped items (not for the item-specific hooks): every [holder, item] pair of the owned chess, taken before
      // the first item runs; each runs only while still equipped on its still-owned holder — handlers move / destroy
      // pieces (header). Taking the pairs per holder as the walk reached it ran an item equipped meanwhile onto a later
      // holder, and twice an item moved from a holder already walked to a later one.
      if (hook !== 'onEquip' && hook !== 'onArt' && hook !== 'onDestroy') {
        const pairs = [];
        for (const holder of ownedChess(ps)) for (const it of holder.items || []) pairs.push([holder, it]);
        for (const [holder, it] of pairs) {
          const key = `item:${itemKey(it.id)}`;
          const h = reg.get(key);
          if (h && stillEquipped(ps, holder, it)) this._call(ps, key, h, hook, { kind: 'item', key, piece: it, holder, item: this.m.gd.item(it.id) }, ev);
        }
      }
      // 6. persistent effects
      for (const ref of ps.effects.slice()) {
        if (!ref || typeof ref.key !== 'string' || ref.key === skipKey) continue;
        const h = reg.get(ref.key);
        if (h) this._call(ps, ref.key, h, hook, { kind: 'effect', key: ref.key, ref }, ev);
      }
    } finally {
      if (deferItems) ps._deferItemMerge--;
      this.depth--;
    }
    return ev;
  }

  /**
   * `hook` for an ELIMINATED player (Match.startRound: onRoundStart): only its persistent effects whose handler sets
   * `afterElimination: true` run — 信标's gift still reaches the teammate when its sender is out (builtinMeta.js
   * builtin_gift, GitHub #86). Nothing else of an eliminated player is dispatched.
   */
  dispatchEliminated(ps, hook, ev = {}) {
    if (!ps || ps.alive || this.depth >= MAX_DEPTH) return ev;
    this.depth++;
    try {
      for (const ref of ps.effects.slice()) {
        if (!ref || typeof ref.key !== 'string') continue;
        const h = this.registry.get(ref.key);
        if (h && h.afterElimination === true) this._call(ps, ref.key, h, hook, { kind: 'effect', key: ref.key, ref }, ev);
      }
    } finally {
      this.depth--;
    }
    return ev;
  }

  /** Hooks a garrison handler runs on: its eventType's hook, or what `handler.garrisonHooks(garrison)` returns. */
  _garrisonHooks(h, g) {
    if (typeof h.garrisonHooks === 'function') {
      try {
        const list = h.garrisonHooks(g);
        if (Array.isArray(list) && list.length) return list;
      } catch (e) { this._report(`garrison:${g.effectKey}`, 'garrisonHooks', e); }
    }
    return [GARRISON_HOOK[g.eventType]];
  }

  /**
   * Run the owned chess's garrisons of `hook`. `refreshed` (onRefresh): the board / hand chess taken when the dispatch
   * began (refreshPieces) — each runs if it is still on the board or in the hand (where it stands now); a chess gained
   * meanwhile does not run, nor one that left (sold, consumed by a merge, moved to the 临时整备区).
   */
  _garrisons(ps, hook, ev, refreshed = null) {
    const gd = ps.gd || this.m.gd;
    const run = (piece, where) => {
      const rec = gd.chess(piece.id);
      if (!rec || !Array.isArray(rec.garrisonIds)) return;
      for (const gid of rec.garrisonIds) {
        const g = gd.garrison(gid);
        if (!g) continue;
        const key = `garrison:${g.effectKey}`;
        const h = this.registry.get(key);
        if (!h || !this._garrisonHooks(h, g).includes(hook)) continue;
        if (where === 'hand' && g.bbStr && g.bbStr.conditionkey === 'character_target_inboard') continue;
        const repeat = this.diodeRepeat(ps, hook === 'onGain' ? this.investRepeat(ps) : 1);   // 二极管：翻倍 / 不生效
        this._call(ps, key, h, hook, { kind: 'garrison', key, piece, garrisonId: gid, garrison: g, bb: g.bb || {}, bbStr: g.bbStr || {}, where }, ev, repeat);
      }
    };
    if (hook === 'onGain' || hook === 'onSold') {
      if (ev && ev.piece && ev.piece.kind === 'chess') run(ev.piece, hook === 'onGain' ? 'gained' : 'sold');
      return;
    }
    if (hook === 'onPrice') {
      if (ev && ev.slot && ev.slot.kind === 'chess') run({ uid: 0, kind: 'chess', id: ev.slot.id, items: [] }, 'shop');
      return;
    }
    if (hook !== 'onRoundStart' && hook !== 'onPrepEnd' && hook !== 'onRefresh') return;
    if (refreshed) {
      for (const piece of refreshed) {
        const loc = ps.find(piece.uid);
        if (loc && loc.piece === piece && (loc.area === 'board' || loc.area === 'hand')) run(piece, loc.area);
      }
      return;
    }
    for (const { piece } of boardOrder(ps.board)) if (piece.kind === 'chess') run(piece, 'board');
    for (const p of ps.hand) if (p && p.kind === 'chess') run(p, 'hand');
  }

  /**
   * Run the garrisons of `piece` whose eventType is `eventType` as if that event happened now (ctx.triggerGarrisons).
   * `asPiece` runs them with another piece as `ctx.source.piece` (特质 "与其相同" copies). 投资人 still multiplies
   * SERVER_GAIN. SERVER_PRICE cannot be triggered. Returns the number of garrison handlers run.
   */
  triggerGarrisons(ps, piece, eventType, { asPiece = null, triggeredBy = null } = {}) {
    const gd = ps.gd || this.m.gd;
    const hook = eventType === 'SERVER_PRICE' ? null : GARRISON_HOOK[eventType];
    const rec = piece && piece.kind === 'chess' ? gd.chess(piece.id) : null;
    if (!hook || !rec || !Array.isArray(rec.garrisonIds) || this.depth >= MAX_DEPTH) return 0;
    const self = asPiece || piece;
    let n = 0;
    this.depth++;
    try {
      for (const gid of rec.garrisonIds) {
        const g = gd.garrison(gid);
        if (!g || g.eventType !== eventType) continue;
        const key = `garrison:${g.effectKey}`;
        const h = this.registry.get(key);
        if (!h) continue;
        const ev = hook === 'onGain' ? { piece: self, kind: 'chess', source: 'trigger' }
          : hook === 'onSold' ? { piece: self, gain: 0 }
          : hook === 'onRefresh' ? { slots: ps.shop.slots, free: true, price: 0, trigger: true }
          : { round: this.m.round, trigger: true };
        const repeat = this.diodeRepeat(ps, hook === 'onGain' ? this.investRepeat(ps) : 1);   // 二极管：翻倍 / 不生效
        const loc = ps.find(self.uid);
        const where = loc ? (loc.area === 'board' ? 'board' : loc.area) : 'trigger';
        this._call(ps, key, h, hook, { kind: 'garrison', key, piece: self, garrisonId: gid, garrison: g, bb: g.bb || {}, bbStr: g.bbStr || {}, where, trigger: true, triggeredBy }, ev, repeat);
        n++;
      }
    } finally {
      this.depth--;
    }
    return n;
  }

  /** Item-specific hook (onEquip / onArt / onDestroy) for one item piece. */
  dispatchItem(ps, item, holder, hook, ev) {
    if (!item || this.depth >= MAX_DEPTH) return ev;
    const key = `item:${itemKey(item.id)}`;
    const h = this.registry.get(key);
    if (!h) return ev;
    this.depth++;
    try {
      this._call(ps, key, h, hook, { kind: 'item', key, piece: item, holder, item: this.m.gd.item(item.id) }, ev);
    } finally {
      this.depth--;
    }
    return ev;
  }

  /** Run one registry handler directly (choice cards). Returns true when a handler existed. */
  runKey(ps, key, hook, source, ev) {
    const h = this.registry.get(key);
    if (!h) return false;
    const fn = typeof h[hook] === 'function' ? h[hook] : typeof h.run === 'function' ? h.run : null;
    if (!fn) return false;
    if (this.depth >= MAX_DEPTH) return true;
    this.depth++;
    try {
      const ctx = makeCtx(this.m, ps, { ...source, key }, hook, ev);
      try { fn.call(h, ctx, ev); } catch (e) { this._report(key, hook, e); }
    } finally {
      this.depth--;
    }
    return true;
  }
}

function ownedChess(ps) {
  const out = [];
  for (const { piece } of boardOrder(ps.board)) if (piece.kind === 'chess') out.push(piece);
  for (const p of ps.hand) if (p && p.kind === 'chess') out.push(p);
  for (const p of ps.temp) if (p && p.kind === 'chess') out.push(p);
  return out;
}

/** The board chess (reading order) then the hand chess — the pieces whose 刷新时 特质 a refresh runs (onRefresh). */
function refreshPieces(ps) {
  const out = [];
  for (const { piece } of boardOrder(ps.board)) if (piece.kind === 'chess') out.push(piece);
  for (const p of ps.hand) if (p && p.kind === 'chess') out.push(p);
  return out;
}

/** Dispatch step 5: is `it` still equipped on `holder`, and `holder` still an owned chess of `ps`? */
function stillEquipped(ps, holder, it) {
  if (!Array.isArray(holder.items) || !holder.items.includes(it)) return false;
  const loc = ps.find(holder.uid);
  return !!loc && loc.piece === holder;
}

// =====================================================================================================
// handler context — the ONLY way content mutates player state (see docs/META.md)

const finiteInt = (n) => (Number.isFinite(n) ? Math.trunc(n) : 0);

/**
 * What a pick-one offer made by an effect is called on the shop bar (m.private shop.rewardOffer.label; player report #6
 * after 0.1.0 — 凯瑟琳's three items came under the promotion reward's 晋升奖励 header): a strategy's effect name
 * (定向投放, 见者有份), an item's name (寻呼模块, 信标), the operator whose 特质 it is (松果), else null.
 * @param {import('./gamedata.js').GameData} gd
 * @param {object} source the dispatch source (kind band / item / garrison …)
 * @returns {string|null}
 */
export function offerLabel(gd, source) {
  if (!source || typeof source !== 'object') return null;
  if (source.kind === 'band') { const b = source.band || gd.band(source.bandId); return (b && (b.effectName || b.name)) || null; }
  if (source.kind === 'item') { const it = source.item || (source.piece ? gd.item(source.piece.id) : null); return (it && it.name) || null; }
  if (source.kind === 'garrison' && source.piece) { const c = gd.chess(source.piece.id); return (c && c.name) || null; }
  return null;
}

/** Who a grantChess toast names: the same speaker as an offer label, or the choice card's name. */
function grantSpeaker(gd, source) {
  return offerLabel(gd, source) || (source && source.kind === 'choice' && source.card && source.card.name) || '';
}

/**
 * @param {import('./Match.js').Match} m
 * @param {import('./PlayerState.js').PlayerState} ps
 * @param {object} source
 * @param {string} hook
 * @param {object|null} [ev] the event being dispatched (onPrice: ctx.modifyPrice / ctx.setPrice edit ev.price)
 */
export function makeCtx(m, ps, source, hook, ev = null) {
  // the player's view of the data: its slotted 自选 slots are its operators (0.2.0, player/diy.js) — chessRecord,
  // pieceBonds, a strategy's / 特质's bond and tier reads see the operator; the match's GameData for everyone else
  const gd = ps.gd || m.gd;
  const view = (p) => (p ? ps.pieceView(p) : null);
  const ctx = {
    hook,
    source,
    playerId: ps.playerId,
    seat: ps.seat,
    name: ps.name,
    get round() { return m.round; },
    get phase() { return m.phase; },
    modeId: m.modeId,
    difficulty: m.difficulty,
    isSolo: m.isSolo,
    isCoop: !m.isSolo,
    data: gd.raw,
    gd,
    rng: m.rngMeta,
    log: (msg) => m.log.info?.(`[meta ${m.roomCode}] ${ps.playerId}: ${msg}`),

    // ---- reads
    funds: () => ps.funds,
    lp: () => ps.lp,
    /**
     * ★ 惊变「恶魔契约」(owner 2026-10-16)：加/减目标生命。卡面「每回合战斗阶段开始时你会获得3目标生命」
     *   需要一个能写 lp 的口子 —— 原来 ctx 只有只读的 lp()。
     */
    addLp: (n) => { const v = Number(n); if (!Number.isFinite(v) || v === 0) return ps.lp; ps.lp = Math.max(0, ps.lp + Math.trunc(v)); ps.dirty(); return ps.lp; },
    alive: () => ps.alive,
    bandId: () => ps.bandId,
    /** 炸惊模拟 规则14 已经抽到的敌方惊变卡 id（Match.enemyJibianCards，只增不减）—— 鸭爵「神秘顾客」的换将读它。 */
    enemyJibian: () => (Array.isArray(m.enemyJibianCards) ? m.enemyJibianCards : []),
    shopLevel: () => ps.shop.level,
    bond: (id) => (ps.bonds[id] ? { ...ps.bonds[id] } : null),
    bonds: () => Object.fromEntries(Object.entries(ps.bonds).map(([k, v]) => [k, { ...v }])),
    bondActive: (id) => !!(ps.bonds[id] && ps.bonds[id].active),
    /**
     * ★ 2026-10-17（用户：惊变「层数大乱」不应该「把可叠加的盟约跟不可叠加的盟约替换」）：
     * 该盟约是否**不可叠加**（`data/bonds.json` 的 `noStack`）。
     * 不可叠加的 4 个（调和 / 协防干员 / 独行 / 绝技）的 `perStackParams` 与 `layerMilestones` 都是空的
     * ⇒ 层数对它们没有任何效果（前端 `bondStrip.js:186` 也直接显示「层数不显示」）。
     * 洗牌类效果读这个把「层数无意义」的盟约排除在交换之外。
     */
    bondNoStack: (id) => !!gd.bond(id)?.noStack,
    bondCount: (id) => (ps.bonds[id] ? ps.bonds[id].count : 0),
    layers: (id) => ps.layers[id] || 0,
    board: () => boardOrder(ps.board).map(({ r, c, piece }) => ps.pieceView(piece, [r, c])),
    hand: () => ps.hand.map(view),
    temp: () => ps.temp.map(view),
    /** View of an owned piece + `area` ('board'|'hand'|'temp'|'equipped'), `holderUid`, and `row`/`col` on the board. */
    piece: (uid) => {
      const l = ps.find(uid);
      if (!l) return null;
      const v = { ...(l.area === 'board' ? ps.pieceView(l.piece, parseKey(l.key)) : view(l.piece)), area: l.area, holderUid: l.holder ? l.holder.uid : null };
      if (l.area === 'hand' || l.area === 'temp') v.idx = l.idx;
      return v;
    },
    /**
     * Board piece standing on (row, col) (row/col included, and its `dir`), or null. "身前一格" of a piece is one step
     * along its facing: sim/dir.js frontOf(row, col, piece.dir) (content/support/meta.js frontPiece / behindPiece).
     */
    pieceAt: (row, col) => { const p = Number.isInteger(row) && Number.isInteger(col) ? ps.board.get(tileKey(row, col)) : null; return p ? ps.pieceView(p, [row, col]) : null; },
    chessRecord: (id) => gd.chess(id),
    /**
     * 炸惊模拟保留下来的原始自选 picks（`{ [slotBaseId]: { charId, skillIndex, uniEquipId } }`，无则 null）。
     * 本模式不启用自选编队，所以 `ps.diy` / `ps.diyStock` 恒为空；要发放自选干员的内容
     * （惊变「赤霄剑法」）读这个，并用 shared/diy.js 的 diyRecordOf 现场组装。
     */
    diyPicks: () => ps.diyPicks || null,
    /**
     * ★ 2026-10-16（owner）该玩家自己的 PlayerState。**只给"发放自选干员"这类必须直接触碰玩家状态的
     * 内容用**（惊变「赤霄剑法」要把现场组装的自选记录注册进 ps._diyRecords，gd.chess(slot) 才解析得到）。
     * 常规效果请继续用 ctx 上那些语义化接口（grantChess / shopSlots / addFunds…），不要从这里改状态。
     */
    ps,
    /** Bonds a chess piece counts for: its own + those granted by 变形同构体 pairings. */
    pieceBonds: (uid) => { const l = ps.find(uid); return l && l.piece.kind === 'chess' ? bondsOfPiece(gd, l.piece) : []; },
    /** 特质 of a chess piece: [{ garrisonId, effectKey, eventType, bb, bbStr, desc }]. */
    garrisonsOf: (uid) => {
      const l = ps.find(uid);
      const rec = l && l.piece.kind === 'chess' ? gd.chess(l.piece.id) : null;
      if (!rec || !Array.isArray(rec.garrisonIds)) return [];
      return rec.garrisonIds.map((gid) => gd.garrison(gid)).filter(Boolean)
        .map((g) => ({ garrisonId: g.garrisonId, effectKey: g.effectKey, eventType: g.eventType, bb: g.bb || {}, bbStr: g.bbStr || {}, desc: g.desc || '' }));
    },
    stats: () => ({ ...ps.stats }),
    roundStats: () => ({ ...ps.round }),
    shopSlots: () => ps.shop.slots.map((s) => (s ? { kind: s.kind, id: s.id, basePrice: s.basePrice, sold: !!s.sold, frozen: !!s.frozen } : null)),

    // ---- counters (player scope, persistent)
    counter: (k) => (Number.isFinite(ps.counters[k]) ? ps.counters[k] : 0),
    setCounter: (k, v) => { if (typeof k === 'string' && Number.isFinite(v)) ps.counters[k] = v; return ps.counters[k] ?? 0; },
    incCounter: (k, n = 1) => { if (typeof k !== 'string' || !Number.isFinite(n)) return 0; ps.counters[k] = (Number.isFinite(ps.counters[k]) ? ps.counters[k] : 0) + n; return ps.counters[k]; },
    /** Per-piece counter of the current round (0 in a new round / for a new piece, an elite merged this round included —
     *  PlayerState.pieceRoundCount). */
    pieceCounter: (uid, k) => { const l = ps.find(uid); return l ? ps.pieceRoundCount(l.piece, k) : 0; },
    incPieceCounter: (uid, k, n = 1) => { const l = ps.find(uid); return l ? ps.bumpPieceRoundCount(l.piece, k, n) : 0; },

    // ---- economy
    addFunds: (n, reason = '') => ps.addFunds(finiteInt(n), { reason }),
    addPendingFunds: (n) => { const v = finiteInt(n); if (v > 0) { ps.pendingFunds += v; ps.dirty(); } return v > 0 ? v : 0; },
    spendFunds: (n) => { const v = finiteInt(n); if (!ps.spend(v)) return false; ps._afterSpend(v, 'effect'); return true; },
    grantFreeRefresh: (n = 1) => { const v = finiteInt(n); if (v > 0) { ps.shop.freeRefreshes += v; ps.dirty(); } return ps.shop.freeRefreshes; },

    // ---- prices (onPrice only; the same as writing ev.price)
    modifyPrice: (delta) => { if (hook === 'onPrice' && ev && Number.isFinite(delta)) ev.price = Math.max(0, (Number(ev.price) || 0) + delta); return ev ? ev.price : null; },
    setPrice: (v) => { if (hook === 'onPrice' && ev && Number.isFinite(v)) ev.price = Math.max(0, v); return ev ? ev.price : null; },

    // ---- layers
    addLayers: (bondId, n, opts = {}) => ps.addLayers(bondId, n, { requireActive: !!opts.requireActive, reason: opts.reason || source.key || '' }),
    /** ★ 2026-10-26（owner）：记录「本局已用掉的一次性惊变」，抽卡时与已拥有的惊变一起排除（追忆用）。 */
    markJibianConsumed: (id) => {
      if (typeof id !== 'string' || !id) return;
      if (!(ps.jibianConsumed instanceof Set)) ps.jibianConsumed = new Set();
      ps.jibianConsumed.add(id);
      ps.dirty();
    },
    /** 本局已消耗的一次性惊变 id 集合。 */
    jibianConsumed: () => (ps.jibianConsumed instanceof Set ? new Set(ps.jibianConsumed) : new Set()),

    /** ★ 层数直接设值（可增可减）—— 惊变「层数打乱」用；addLayers 只加不减。 */
    setLayers: (bondId, n, opts = {}) => ps.setLayers(bondId, n, { reason: opts.reason || '' }),

    // ---- pieces
    grantChess: (chessId, opts = {}) => {
      if (!ps.alive) return null;
      // 用户 2026-10-22：数据里按 id 写死的发放（奖池、特质、道具…）可能给的是**普通**棋子，炸惊里要先换成本模式棋库的
      // 同一名干员 —— 否则玩家会拿到与炸惊同名卡 baseId 不同的棋子，永远合不了精锐（「三个灰毫没精锐」）。
      let id = gd.chessInRoster(chessId);
      if (opts.golden) id = gd.goldenIdOf(id) || id;
      try { dbg('[GRANT] in=%s → id=%s alive=%s recIsDiy=%s diyFor=%s golden=%s',
        String(chessId), String(id), String(ps.alive),
        String(!!(gd.chess(id) || {}).isDiy), String((gd.chess(id) || {}).diyFor), String((gd.chess(id) || {}).isGolden)); } catch { /* ignore */ }
      if (!gd.chess(id)) { try { dbg('[GRANT]   ✗ gd.chess(id) 为空 → return null'); } catch { /* ignore */ } return null; }
      const base = gd.baseIdOf(id);
      // "some effects fail when the cap is hit" (research 06 §7): by default a chess of the pool needs a free copy (a
      // 自选 piece: one of the player's own stock — player/diy.js poolOf)
      // 100-seat variant: every base chess belongs to THIS player's own pool (player/rules.js pool())
      const pool = (typeof ps.poolOf === 'function' ? ps.poolOf(base) : null) || (typeof ps.pool === 'function' ? ps.pool() : m.pool);
      try { dbg('[GRANT]   base=%s pool.has=%s pool.left=%s requirePool=%s',
        String(base), String(pool.has(base)), String(pool.left(base)), String(opts.requirePool !== false)); } catch { /* ignore */ }
      if (opts.requirePool !== false && pool.has(base) && pool.left(base) < 1) { try { dbg('[GRANT]   ✗ 池里没份数 → return null'); } catch { /* ignore */ } return null; }
      const p = ps.acquireChess(id, { source: opts.source || source.key || 'effect', toTemp: !!opts.toTemp, fromPool: opts.fromPool !== false });
      // 「歌蕾蒂娅：获得斯卡蒂」 — every silent grantChess (a 特质, 余 SERVER_MOST_BOND, a band, an item, a choice).
      // opts.toast === false skips it. A caller that already says the same thing should pass that.
      if (p && opts.toast !== false) {
        const got = gd.chess(p.id);
        const name = got && got.name;
        if (name) {
          const who = grantSpeaker(gd, source);
          m.toast(ps, 'info', who ? msg('{who}：获得{name}', { who: dn(who), name: dn(name) }) : msg('获得{name}', { name: dn(name) }));
        }
      }
      return p ? view(p) : null;
    },
    grantItem: (itemId, opts = {}) => {
      if (!ps.alive || !gd.item(itemId)) return null;
      const p = ps.acquireItem(itemId, {
        source: opts.source || source.key || 'effect',
        toTemp: !!opts.toTemp,
        deferMerge: ps._deferItemMerge > 0,
      });
      return p ? view(p) : null;
    },
    /**
     * Random chess id from the shared pool (copy-weighted) — and the player's own 自选 stock (player/diy.js
     * diyStockEntries, 0.2.0: 「自选干员放入后模拟中的补给池随机范围也将被相应扩大」). opts: { maxTier, tier, bond, filter(id) };
     * bonds are read through the player's data view (a slotted slot: its operator's).
     */
    /**
     * ★ 2026-10-16（owner）「无视商店等级」的正确实现：先在**可用阶层**里均匀抽一个，再在该阶层内抽一张。
     *
     * 为什么不能用 `rollChess({ maxTier: 6 })`：pool.roll 是**按剩余份数加权**的（pool.js `_eligible` /
     * `roll`），而低阶干员的份数远多于高阶 —— 1 阶几十份、6 阶几份 —— 所以 maxTier:6 只是"允许"高阶，
     * 实际抽出来几乎全是 1 阶（实测：三格全是 1 阶）。阶层均匀才是卡面写的"无视当前商店等级"。
     * @param {{ maxTier?: number, bond?: string, filter?: (id: string, e: object) => boolean }} [opts]
     * @returns {string|null}
     */
    rollChessAnyTier: (opts = {}) => {
      const maxTier = Number.isInteger(opts.maxTier) ? opts.maxTier : 6;
      const own = typeof ps.pool === 'function' ? ps.pool() : m.pool;
      // 可用阶层：该阶层里还有剩余份数、且能过 filter 的
      const ok = (id, e) => {
        if (e.left <= 0) return false;
        if (opts.bond) { const c = gd.chess(id); if (!c || !Array.isArray(c.bonds) || !c.bonds.includes(opts.bond)) return false; }
        return typeof opts.filter === 'function' ? !!opts.filter(id, e) : true;
      };
      const tiers = new Set([...own.entries].filter(([id, e]) => e.tier <= maxTier && ok(id, e)).map(([, e]) => e.tier));
      const list = [...tiers].sort((a, b) => a - b);
      if (!list.length) return null;
      const pickTier = list[m.rngMeta.int(list.length)];
      return own.roll(m.rngMeta, { tier: pickTier, filter: (id, e) => ok(id, e) }) || null;
    },
    rollChess: (opts = {}) => {
      const f = (id) => {
        if (opts.bond) { const c = gd.chess(id); if (!c || !Array.isArray(c.bonds) || !c.bonds.includes(opts.bond)) return false; }
        return typeof opts.filter === 'function' ? !!opts.filter(id) : true;
      };
      // 100-seat variant: this player's own pool; the upstream 自选 `extra` is no longer needed (its slots are
      // ordinary entries of that pool)
      const own = typeof ps.pool === 'function' ? ps.pool() : m.pool;
      return own.roll(m.rngMeta, { maxTier: Number.isInteger(opts.maxTier) ? opts.maxTier : 6, tier: Number.isInteger(opts.tier) ? opts.tier : null, filter: f });
    },
    rollItem: (opts = {}) => m.rollItemId(opts),
    /**
     * Roll a choices.json pool: equip pools → { kind: 'item', id }; chess pools (items / weighted / shopEligible with
     * tier, minTier, bond, golden) → { kind: 'chess', id, golden } (a pool chess needs a free copy). null when empty.
     */
    rollPool: (poolId, opts = {}) => m.rollPool(poolId, {
      shopLevel: ps.shop.level,
      // 100-seat variant: the draw reads THIS player's own pool (its 自选 slots are ordinary entries of it)
      pool: typeof ps.pool === 'function' ? ps.pool() : m.pool, chessOf: (id) => gd.chess(id),
      ...opts,
    }),
    /**
     * Run another owned chess's 特质 of `eventType` now (SERVER_GAIN / SERVER_PREP_START / SERVER_PREP_FIN /
     * SERVER_CHESS_SOLD / SERVER_REFRESH_SHOP). opts.asUid: run them as if they belonged to that piece. Returns the
     * number of handlers run (nesting is depth-capped).
     */
    triggerGarrisons: (uid, eventType, opts = {}) => {
      const l = ps.find(uid);
      if (!l || l.piece.kind !== 'chess' || typeof eventType !== 'string') return 0;
      const as = opts.asUid != null ? ps.find(opts.asUid) : null;
      if (opts.asUid != null && (!as || as.piece.kind !== 'chess')) return 0;
      return m.dispatcher.triggerGarrisons(ps, l.piece, eventType, { asPiece: as ? as.piece : null, triggeredBy: source.key || null });
    },
    promote: (uid) => { const l = ps.find(uid); return l ? ps.promote(l.piece) : false; },
    /** 突变细胞's transformation: destroy a chess piece wherever it stands (its equipment returns to the hand first), then
     *  gain `chessId` like any gained operator — hand, overflow temp, a completed merge as usual
     *  (PlayerState.transformChess). Returns the gained piece's view (the elite after a merge) or null. */
    transform: (uid, chessId) => { const l = ps.find(uid); if (!l || l.piece.kind !== 'chess') return null; const p = ps.transformChess(l.piece, chessId); return p ? view(p) : null; },
    /** Normal item piece → its golden version in place. */
    upgradeItem: (uid) => { const l = ps.find(uid); return l && l.piece.kind === 'item' ? ps.upgradeItem(l.piece) : false; },
    /** Attach an owned hand/temp item to an owned chess without equip effects (copies, restores). */
    equipDirect: (itemUid, chessUid) => {
      const il = ps.find(itemUid);
      const cl = ps.find(chessUid);
      if (!il || il.piece.kind !== 'item' || il.area === 'equipped' || !cl || cl.piece.kind !== 'chess' || cl.area === 'equipped') return false;
      ps._detach(il);
      ps._attach(cl.piece, il.piece);
      ps.checkItemMerges();
      ps.recompute();
      return true;
    },
    destroyPiece: (uid) => {
      const l = ps.find(uid);
      if (!l) return false;
      ps._detach(l);
      if (l.piece.kind === 'chess') {
        ps.removeTokensOf(l.piece.uid);
        for (const it of l.piece.items || []) ps.stow(it, { allowTemp: true });
        l.piece.items = [];
        ps.returnCopies(l.piece);
        ps.checkItemMerges(); // the returned equipment auto-merges like any gain
      }
      ps.recompute();
      return true;
    },
    /** Queue a free pick-one offer of chess (shop.rewardOffer; `label` defaults to offerLabel(source), the bar's header). */
    offerChess: (ids, opts = {}) => !!ps.pushRewardOffer(opts.source || source.key || 'effect', { ids, tier: opts.tier ?? null, label: opts.label ?? offerLabel(gd, source) }),
    /** Queue a free pick-one offer of items (shop.rewardOffer with slots of kind 'item'). */
    offerItems: (ids, opts = {}) => !!ps.pushItemOffer(ids, { source: opts.source || source.key || 'effect', tier: opts.tier ?? null, label: opts.label ?? offerLabel(gd, source) }),
    setShopSlot: (i, slot) => {
      if (!Number.isInteger(i) || i < 0 || i >= ps.shop.slots.length) return false;
      if (slot == null) { ps.shop.slots[i] = null; ps.dirty(); return true; }
      const kind = slot.kind === 'item' ? 'item' : 'chess';
      if (kind === 'chess' ? !gd.chess(slot.id) : !gd.item(slot.id)) return false;
      const basePrice = Number.isFinite(slot.price) ? Math.max(0, Math.trunc(slot.price)) : kind === 'chess' ? gd.chessPrice(slot.id) : gd.itemPrice(slot.id);
      ps.shop.slots[i] = { kind, id: slot.id, basePrice, frozen: !!slot.frozen, sold: false };
      ps.dirty();
      return true;
    },
    addDeployCap: (n) => { const v = finiteInt(n); ps.deployCapBonus += v; ps.dirty(); return ps.deployCap; },
    /**
     * 「最大可部署人数**变为** n」（人事部文档 equip_destory_deployment_cnt_change）—— 把**基线**抬到 n，
     * 而不是设成"下限"。区别很大：`get deployCap()` 是
     *   `Math.max(1, gd.deployCap + deployCapBonus, deployCapMin)`
     * 所以把 n 写进下限会被 `gd.deployCap + bonus` 顶掉、**吃掉加法**。
     *
     * ★ 2026-10-16 修 bug（玩家反馈「人事部文件夹和人事部文档无法叠加生效，叠加后应该能部署 11 个人」）：
     *   原来写 `deployCapMin = min(n, 12)`。基础 8 + 文件夹 +2 = 10，而 max(10, 9) = 10 ——
     *   文档那 1 点净增益被 max 吃掉了（文件夹的 +2 只得 1）。实测 10 而非卡面写的 11。
     *   现在是 `deployCapMin = gd.deployCap + (n - gd.deployCap) = n` 的**基线语义**：
     *   把 n 记成"基础之上要额外补多少"，于是 `gd.deployCap + (n - gd.deployCap) + bonus = n + bonus`。
     *   文档 9 + 文件夹 2 = **11** ✓；单独吃文档 = 9 ✓（与卡面「变为9」一致）。
     *   `Math.min(..., 12)` 这个上限保留（原样，防止把 cap 抬到离谱的值）。
     */
    setDeployCapAtLeast: (n) => {
      const v = finiteInt(n);
      const base = (gd && Number.isFinite(gd.deployCap)) ? gd.deployCap : 0;
      const want = Math.min(v, 12) - base;              // 相对基础要补的差额
      if (want > ps.deployCapMin) { ps.deployCapMin = want; ps.dirty(); }
      return ps.deployCap;
    },
    setBondCountBonus: (bondId, n) => { if (gd.bond(bondId) && Number.isInteger(n)) { ps.bondCountBonus[bondId] = n; ps.recompute(); } },
    setDeviceActive: (alias, on) => { if (typeof alias === 'string') { ps.deviceOverrides[alias] = !!on; ps.invalidateDeployMap(); ps.dirty(); } },
    setTileOverride: (r, c, cls) => { if (Number.isInteger(r) && Number.isInteger(c) && ['melee', 'ranged', 'none'].includes(cls)) { ps.tileOverrides[`${r},${c}`] = cls; ps.invalidateDeployMap(); ps.dirty(); } },

    // ---- effects (EffectRef: { id, key?, name, desc, iconKind, iconId, counter?, battle?, params?, data?, hidden? })
    addEffect: (ref) => {
      if (!ref || typeof ref.id !== 'string') return null;
      const existing = ps.effects.find((e) => e.id === ref.id);
      if (existing) { Object.assign(existing, ref); ps.dirty(); return existing; }
      const e = { iconKind: 'choice', battle: true, ...ref };
      ps.effects.push(e);
      ps.dirty();
      return e;
    },
    removeEffect: (id) => { const i = ps.effects.findIndex((e) => e.id === id); if (i < 0) return false; ps.effects.splice(i, 1); ps.dirty(); return true; },
    effect: (id) => ps.effects.find((e) => e.id === id) ?? null,
    /** Read-only snapshot of this player's EffectRefs (content that must enumerate them — 惊变「潘多拉魔盒」: 失去所有惊变). */
    effects: () => ps.effects.map((e) => ({ ...e })),
    setEffectCounter: (id, v) => { const e = ps.effects.find((x) => x.id === id); if (!e) return false; e.counter = v; ps.dirty(); return true; },

    // ---- bounties / choices
    addBounty: (card) => m.addBounty(ps, card),

    // ---- messaging
    // a string or a shared/i18n.js msg(msgid, params)
    toast: (text, kind = 'info') => m.toast(ps, kind, text && typeof text === 'object' ? text : String(text)),
    ticker: (text) => m.tickerText(text && typeof text === 'object' ? text : String(text)),
    /**
     * CHAR_GIFT broadcast to this player: "{0}博士给你赠送了{1}" — named as this player sees the gift (a chess it fields as
     * its 补位 stand-in by the stand-in's name: 0.2.0, the owner's recall of the official mode, 2026-10-06).
     */
    giftTicker: (fromName, chessId) => {
      const c = gd.chess(chessId);
      const shown = c && typeof ps.fieldRecord === 'function' ? ps.fieldRecord(c) || c : c;
      m.tickerFor('CHAR_GIFT', [String(fromName), shown ? shown.name : String(chessId)], { to: ps.playerId });
    },

    // ---- team
    teammates: () => m.alivePlayers().filter((p) => p !== ps).map((p) => makeCtx(m, p, source, hook, null)),
    player: (playerId) => { const p = m.players.get(playerId); return p && p.alive ? makeCtx(m, p, source, hook, null) : null; },
  };
  return ctx;
}
