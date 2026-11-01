// server/match/player/cheat.js — 作弊模式(仅本地测试用)。
//
// 开关:`SP_CHEAT=1` 环境变量。**默认关闭**,所以生产服务器与任何分发包都不受影响 ——
// 想开只在本地启动脚本里设这一个变量,不必改任何代码。
//
// 两个效果:
//   1. 无限资金  —— 买东西/刷新/升级都不扣钱(spend 恒成功,funds 不下减)
//   2. 商店只出「外援」—— 即【本局自选编队选的 4 个干员】(自选槽位),不刷共享池里的普通干员
//
// 为什么走 filter 而不是另写一套 roll:
//   `SharedPool.roll(rng, { filter, extra })` 的 `filter` 在 `_eligible` 里对【池内每一项】逐个调用,
//   但在此之前没有任何调用方传过它。于是 `filter: () => false` 就能一次性把共享池全部排除,
//   只留下 `extra`(该玩家自己的自选库存)—— 正好就是"外援"。不复制抽卡逻辑,规则不会走样。

/**
 * 测试模式是否对这个玩家开启。两种来源:
 *   1. `SP_CHEAT=1` 环境变量 —— 整台服务器一个开关,仍然保留(本地起服时最省事,且生产永不带);
 *   2. 该玩家自己的 `ps.testMode` —— 从设置里的「外援测试模式」来,由服务端用解锁码校验后写进座位
 *      (`server/lobby.js testMode`)。**按玩家**,所以同房间里只有开的人资金不减、商店只出外援。
 *
 * 不传 ps 时只看环境变量(`/healthz` 就是这样如实报告"服务器级开关"的)。
 * @param {{ testMode?: boolean }|null} [ps]
 */
export function cheatEnabled(ps) {
  if (ps && ps.testMode === true) return true;
  const v = String(process.env.SP_CHEAT ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** `SP_ZHAJING_CONFINE` 的干员白名单（charId），空 = 未限定。启动时读一次。 */
const CONFINE_CHARS = (() => {
  const raw = String(process.env.SP_ZHAJING_CONFINE || '').trim();
  if (!raw) return null;
  const set = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return set.size ? set : null;
})();

/** 这批干员的商店档位：按池内出现的最高阶给，否则 5 阶干员会被 `shop.level` 门槛挡掉。 */
function confineMaxTier(chessOf) {
  let tier = 0;
  for (const id of CONFINE_CHARS) {
    tier = Math.max(tier, Number(chessOf(id)?.tier) || 0);
  }
  return tier > 0 ? tier : undefined;
}

/**
 * 限定卡池的判定：该记录是否是白名单干员的**基础**棋子（非精锐 —— 商店只刷基础形态，合成才出精锐）。
 *
 * 用 `rec.charId` 而不是 id 前缀匹配：同一个干员在普通/炸惊两套棋库里 id 不同
 * （`chess_char_*` vs `chess_zj_*`），只有 charId 是两边共用的键。
 * @param {(id: string) => any} chessOf
 */
export function confineFilter(chessOf) {
  if (!CONFINE_CHARS || !chessOf) return null;
  return (id) => {
    const rec = chessOf(id);
    return !!(rec && !rec.isGolden && CONFINE_CHARS.has(rec.charId));
  };
}

/**
 * 这一掷要用的池参数。关闭时返回空对象(调用方原样使用,行为与作弊模式不存在时完全一致)。
 *
 * 开启时:
 *   filter   —— 只排除【共享池里的普通干员】,放行自选槽位
 *   extra    —— 交给调用方填自己的自选库存(diyRollEntries)
 *   maxTier 6 —— 自选槽位本身有 shopLevel 门槛(5 阶槽在第 5 级才上架),这里不再卡等级
 *
 * ⚠️ 不要用 `tier`:`_eligible` 里 `tier != null ? e.tier !== tier : e.tier > maxTier` 是【精确等于】,
 * 传 tier:6 会把 5 阶的两个槽位一起滤掉(实测只剩 2 种外援)。用 maxTier 才是"≤ 6"。
 *
 * ⚠️ filter 必须放行 extra:`SharedPool._eligible` 的 scan 对【池内条目】和 `extra` 一视同仁,
 * 所以 `filter: () => false` 会把外援也一起排除掉,结果是每次抽到 null(踩过这个坑)。
 * 判据用记录自带的 `isDiy` —— 与 economy.js `buy()` 里区分自选卡的方式一致,不靠 id 前缀猜。
 *
 * @param {null | Array<[string, { left: number, tier: number }]>} extra 自选库存(可能为 null)
 * @param {(id: string) => any} chessOf 取棋库记录的函数(用于判 isDiy)
 * @param {{ testMode?: boolean }|null} [ps] 该玩家(决定"按玩家"开关是否生效)
 * @returns {{ filter?: Function, extra?: any, maxTier?: number }}
 */
export function cheatRollOpts(extra, chessOf = null, ps = null) {
  const confine = confineFilter(chessOf);
  if (confine) {
    // 限定卡池（SP_ZHAJING_CONFINE）：无论该玩家有没有开测试模式，商店都只刷这几位干员。
    // `tier` 仍走调用方的值（economy.js 传 shop.level）—— 那正是"升级调度中心能刷出更高阶"的正常规则，
    // 不该被这里绕过；`maxTier` 只用来兜住"白名单里最高阶"这一层，免得白名单整体被档位门挡死。
    const o = { filter: confine };
    const mt = confineMaxTier(chessOf);
    if (mt !== undefined) o.maxTier = mt;
    return o;
  }
  if (!cheatEnabled(ps) || !extra || !extra.length) return {};
  return {
    filter: (id) => {
      const rec = chessOf ? chessOf(id) : null;
      return !!(rec && rec.isDiy);
    },
    extra,
    maxTier: 6,
  };
}

/**
 * 作弊模式下的自选库存:不过 `shopLevel` 这一关,只要还有剩货就算数。
 *
 * 正常的 `diyRollEntries` 要求 `this.shop.level >= e.shopLevel`,于是刚开局(调度中心 1 级)时
 * 一张外援都刷不出来 —— 测试就没法立刻看到效果。作弊模式下把这道门去掉,
 * 但仍然要求 `left > 0`,好让"买了就少一张、卖回就多一张"的库存账目保持诚实。
 *
 * @param {Map<string, { left: number, tier: number, shopLevel: number }>} stock
 * @param {{ testMode?: boolean }|null} [ps] 该玩家("按玩家"开关)
 * @returns {Array<[string, object]> | null}
 */
export function cheatDiyEntries(stock, ps = null) {
  if (!cheatEnabled(ps) || !stock || !stock.size) return null;
  const out = [];
  for (const [id, e] of stock) if (e.left > 0) out.push([id, { ...e, shopLevel: 0 }]);
  return out.length ? out : null;
}

/** 作弊模式的资金上限:把 funds 一直垫在这个数上。 */
export const CHEAT_FUNDS = 999;

/**
 * 把资金垫到 CHEAT_FUNDS。
 *
 * 为什么光靠 `spend()` 不扣钱还不够:客户端 affordability 用的是 `priv.funds`
 * (ui/gameLogic/shop.js shopBlockReason:「资金不足」),所以 funds 停在 4 时,
 * 任何 ≥5 的开销(把调度中心升到 5 级是 5)在**点下去之前**就被前端拒了,
 * 而 5 级正是 5 阶自选干员进商店的门槛(economy.js `_rollChessSlot` 的 maxTier=shop.level)。
 * 每 prep income(label)也只有 3~12,单局内等不到。
 *
 * @param {{ funds: number, dirty: Function, testMode?: boolean }} ps
 */
export function cheatFunds(ps) {
  if (!cheatEnabled(ps) || !ps) return;
  if (Number(ps.funds) < CHEAT_FUNDS) {
    ps.funds = CHEAT_FUNDS;
    // `dirty()` reaches Match.markPrivate → `this._privDirty.add(ps)`, and the Match creates its players (Match.js:296)
    // BEFORE it builds those sets (Match.js:348-353). So during `new PlayerState` — which is where this is called from
    // (PlayerState.js:157) — `_privDirty` does not exist yet and the unguarded call threw
    // `TypeError: Cannot read properties of undefined (reading 'add')`, failing the whole match start
    // (`[lobby] … match failed to start`, 「服务器内部错误」 ×N). Same idiom as basics.js: only mark when there is
    // something to mark; the funds themselves still land, and match start sends the first m.private anyway.
    if (ps.m?._privDirty) ps.dirty();
  }
}

/** 测试模式给的锻造器数量（用户 2026-10-14：「让我的外援测试模式拥有999个锻造器」）。 */
export const CHEAT_FORGE = 999;

/**
 * 测试模式: 把该玩家的锻造器垫到 CHEAT_FORGE —— 和 cheatFunds 同一个风格，**关闭时是 no-op**，
 * 所以生产服务器与任何分发包行为完全不变。
 *
 * 来源同 cheatEnabled：`ps.testMode`（设置里的「外援测试模式」）或 `SP_CHEAT=1`。
 * 调用点：PlayerState 构造里 `this.forge = {…}` 之后一次；acquire.js 的 forgeRoll() 里再补一次
 * （花掉一个就立刻回满，所以在测试模式里永远显示 999）。
 * @param {any} ps
 */
export function cheatForge(ps) {
  if (!ps || !ps.forge || !cheatEnabled(ps)) return;
  if (!(ps.forge.count >= CHEAT_FORGE)) ps.forge.count = CHEAT_FORGE;
}
