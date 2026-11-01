// server/sim/content/garrisons/battle.js — IN_BATTLE 特质 (garrisons) of the operators on the field.
//
// Each operator carries `unit.def.raw.garrisonIds` (elite chess carry the `_b` garrisons); the IN_BATTLE ones are
// dispatched here by their effectKey (bbStr.key for battle runes, else effectType — docs/DATA.md §4):
//
//   ADD_BOND            grants `give_garrison_id` to other operators before the first deployment (targets parsed from
//                       the text: 身前一格 / 身前一格【X】/ 自身和身前一格 / 同一行最右边 / 所有【X】). A unit owns a garrison id
//                       at most once (耀骑士临光 already carries the 144/159 it grants to itself). A granted trait keeps
//                       its data cap like a native one: 华法琳's garrison_95 stops at 7 / 14 layers per battle (PRTS 下半
//                       3月27日更新#2: 「从 初始12/精锐24 降低至 初始7/精锐14」; GitHub #175, PR #192 by @kukiC).
//   layer events        act1autochess_gar_event_useskill (skillStart) · _selfkillenemy (kill, every check_cnt) ·
//                       _selfdead (death 'killed'; texts with 替身 also on every substitute ⇄ body swap, read from the
//                       dollkeeper flag unit.trait.doll) · _consume_ammo (ammoUsed; range_id 0-1 self, 1-1 front tile,
//                       x-5 self + 4 adjacent, pooled counter) · _enemy_abflag_inrange (an enemy in range ENTERS
//                       'freeze', × prob) · act2autochess_gar_event_onstart (every deploy) ·
//                       act2autochess_gar_event_allyenemy_sleepstun_inrange (an enemy or operator in range ENTERS
//                       sleep / stun). "进入…时": re-applying a running status (a refresh) is not a new entry
//                       (engine statusApplied ctx.entered) — except a pulse that re-applies its own short status as a
//                       fresh one (applyStatus `reenter`: 缇缇 S2's sleep ward, DESIGN §24.8).
//                       Targets: bond_by_id / bond_self (own active bonds) / bond_actived_maxstack;
//                       amounts: by_count / by_charcount_samerow / by_charlevel; conditions character_same_row /
//                       character_same_col (≥ check_count incl. self). Gains go through support.gainLayers with
//                       reason 'garrison', source = the trait's owner, cap = max_add_count_per_battle per (instance, bond)
//                       — per instance for bond_actived_maxstack (塑心: the highest bond may change, the cap does not).
//   act1autochess_gar_event_addition_cnt (魔王)  layerGain: a 'garrison' gain whose source stands on the tile in front
//                       of 魔王 (range_id 1-1) — or was knocked out there this instant (幽灵鲨 "被击倒时"; engine ctx.tile)
//                       — gets +extra_cnt per bond (the extra does not count toward the source's per-battle cap).
//   stat traits         GAIN_BUFF (battleRuneKey char_attribute_mul "攻击力和生命值+20%": a rune on the chess's base
//                       attributes, so atkMul / hpMul), attr_common_global_buff (spRecoveryFlat; "+X%" ATK / HP would be
//                       直接乘算), attrByBond ("每叠加N层…+X%": 直接乘算, support directMods),
//                       respawnTimeByBond, attrByBond_add_onstart, ab_damageScaleByBond — layer readers use
//                       floor(Σ layers of the listed ACTIVE bonds / divide_num) and are recomputed after every layer
//                       gain (research 02 §5 [ASSUMED] only active bonds count).
//   hit modifiers       act1autochess_gar_eff_attack_enemy (dmg.amount × atk vs check_tag enemies),
//                       ab_damageScaleByBond (bound / sluggish targets), _chaos (弱点伤害, research 04 glossary:
//                       phys/arts → whichever deals MORE after the engine's mitigation incl. the attacker's DEF/RES
//                       ignore and dealt/taken multipliers; a tie keeps the type).
//   NONE                风丸 "2 copies merge" — prep rule (chess.upgradeNum 2), nothing in battle.
//
// Hooks: priority 0, except 弱点伤害 (hit, WEAKNESS_PRIORITY −10: decided on the final amount after the ATK
// multipliers). install() registers nothing when no operator carries an IN_BATTLE garrison.

import * as S from '../support/index.js';
import { mitigate } from '../../damage.js';
import { frontOf } from '../../dir.js';
import { activeBonds as jibianActiveBonds } from '../jibianBonds.js';

const ids = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const EMPTY = Object.freeze([]);
/** Status keys for check_ab_flag values used by the data (16 = 冻结). */
const AB_FLAG_STATUS = Object.freeze({ 16: 'freeze', 17: 'cold' });   // 17 = 寒冷（2026-10-13 用户 #6-B：寒冷类特质真正触发于寒冷 ✓）

function garrisonIdsOf(u) {
  const list = u?.def?.raw?.garrisonIds ?? u?.def?.garrisonIds;
  return Array.isArray(list) ? list : EMPTY;
}

/** 惊变「二极管」翻倍的概率（其余为「不生效」）。★ 与 match 侧的 DIODE_DOUBLE_CHANCE
 *  （server/match/effectsMeta.js）保持一致 —— 两处要一起改。 */
const DIODE_DOUBLE_CHANCE = 0.5;

/**
 * 该玩家是否持有惊变「二极管」(jibian_erjiguan)。数据就在 `battle.players[].playerEffects`
 * （jibian.js 的 picksOf 也是从这里读的），所以本文件不需要 import 惊变模块。
 */
function diodeOn(battle, pid) {
  if (pid == null) return false;
  for (const ps of (battle && battle.players) || []) {
    if (!ps || ps.playerId !== pid) continue;
    for (const ref of ps.playerEffects || []) {
      if (ref && ref.key === 'jibian:jibian_erjiguan') return true;
    }
  }
  return false;
}

/**
 * 该玩家是否已激活惊变羁绊「出老千」(cheat)：凑齐后二极管**只会翻倍**，不再掷「不生效」。
 * match 侧的 effectsMeta.diodeRepeat 有同样的判断；这里（卫戍特质触发）是另一条链路，
 * 之前漏了 —— owner 2026-10-20 反馈「凑齐出老千还是会不触发」。
 */
function cheatOn(battle, pid) {
  if (pid == null) return false;
  for (const ps of (battle && battle.players) || []) {
    if (!ps || ps.playerId !== pid) continue;
    const owned = new Set();
    for (const ref of ps.playerEffects || []) {
      const k = ref && ref.key;
      if (typeof k === 'string' && k.startsWith('jibian:')) owned.add(k.slice(7));
    }
    return jibianActiveBonds(owned).some((a) => a.def.id === 'cheat');
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// install

export function install(battle) {
  const all = [];
  const owned = new Map(); // unit → Set(garrisonId)
  const add = (unit, g, grantedBy = null) => {
    let set = owned.get(unit);
    if (!set) { set = new Set(); owned.set(unit, set); }
    if (set.has(g.garrisonId)) return null;
    set.add(g.garrisonId);
    const bb = g.bb || {};
    const cap = S.num(bb.max_add_count_per_battle, 0) > 0 ? S.num(bb.max_add_count_per_battle) : Infinity;
    const it = {
      unit, g, gid: g.garrisonId, key: g.effectKey, bb, bbStr: g.bbStr || {}, grantedBy,
      cap, capKey: `gar:${g.garrisonId}:${unit.id}`, cnt: 0, k: -1,
    };
    all.push(it);
    return it;
  };
  for (const u of battle.allyUnits) {
    if (!S.isOp(u)) continue;
    for (const gid of garrisonIdsOf(u)) {
      const g = S.garrisonRecord(gid);
      if (g && g.eventType === 'IN_BATTLE') add(u, g);
    }
  }
  if (!all.length) return;

  const grants = [];
  for (const it of all.slice()) {
    if (it.key !== 'ADD_BOND') continue;
    const g2 = S.garrisonRecord(it.bbStr.give_garrison_id);
    if (!g2 || g2.eventType !== 'IN_BATTLE') continue;
    for (const t of grantTargets(battle, it)) {
      const got = add(t, g2, it);
      if (got) grants.push(got);
    }
  }

  const by = new Map();
  for (const it of all) {
    let arr = by.get(it.key);
    if (!arr) { arr = []; by.set(it.key, arr); }
    arr.push(it);
  }
  // ★ 2026-10-15（用户，炸惊·卡西米尔）焰尾：`garrison_zj_60_2_a`
  //   「<战斗中>使『红松骑士团』成员的卫戍特质效果翻倍」—— 必须在派发【之前】跑，
  //   这样所有 INSTALLERS / READERS 读到的 bb 已经是翻倍后的值。
  scalePinusGarrisons(by);
  for (const [key, list] of by) {
    const inst = INSTALLERS[key];
    if (inst) inst(battle, list);
  }
  installHitMods(battle, by);
  installReaders(battle, by);

  if (grants.length) {
    battle.on('battleStart', () => {
      for (const it of grants) S.fxOn(battle, 'garrisonGrant', it.unit, `gar:${it.grantedBy.gid}`, it.gid, { from: it.grantedBy.unit.id });
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// ADD_BOND targets (before deployment: home tiles)

function opsOf(battle, pid) {
  const out = [];
  for (const u of battle.allyUnits) if (S.isOp(u) && u.ownerId === pid && !u.removed) out.push(u);
  return out;
}
function opAtHome(battle, pid, r, c) {
  for (const u of battle.allyUnits) if (S.isOp(u) && u.ownerId === pid && !u.removed && u.homeR === r && u.homeC === c) return u;
  return null;
}

function grantTargets(battle, it) {
  const u = it.unit;
  const desc = it.g.desc || '';
  const need = it.bbStr.check_bond_id || null;
  const ok = (t) => !!t && (!need || S.isMember(battle, t, need));
  const front = () => { const [fr, fc] = frontOf(u.homeR, u.homeC, u.dir); return opAtHome(battle, u.ownerId, fr, fc); };
  if (desc.includes('所有')) return opsOf(battle, u.ownerId).filter(ok);
  if (desc.includes('同一行最右边')) {
    let best = null;
    for (const t of opsOf(battle, u.ownerId)) {
      if (t.homeR !== u.homeR) continue;
      // a board position ("最右边" of the player's own board: the mirrored Final Assault right side counts from the left)
      const col = (x) => (x.player && x.player.mirror ? -x.homeC : x.homeC);
      if (!best || col(t) > col(best)) best = t;
    }
    return ok(best) ? [best] : [];
  }
  const out = [];
  // "自身和身前" (耀骑士临光) and 寒芒克洛丝's "身前一格干员和自身" — same target set, the wording differs
  if ((desc.includes('自身和身前') || desc.includes('身前一格干员和自身')) && ok(u)) out.push(u);
  const f = front();
  if (ok(f)) out.push(f);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// layer gains

function targetBonds(battle, it) {
  const u = it.unit;
  switch (it.bbStr.bond_type) {
    case 'bond_self': return S.unitBonds(u).filter((b) => S.bondActive(battle, u.ownerId, b));
    case 'bond_actived_maxstack': {
      const b = S.topActiveBond(battle, u.ownerId);
      const out = b ? [b] : [];
      // ★ 2026-10-15（用户）：塑心 zj 版改成「当前已激活且层数最多的盟约【和自身已激活的【拉特兰】】层数+1」——
      //   `also_bond_id` 点名一个（或多个，逗号分隔）盟约：只有持有者自己带着它、并且它已激活时才加。
      //   这里先跑，`also_self_bond` 保持原样（目前没有记录在用它，留作将来「自身已激活的盟约」那种写法）。
      const named = ids(it.bbStr.also_bond_id);
      if (named.length) {
        const own = S.unitBonds(u);
        for (const x of named) {
          if (x && x !== b && own.includes(x) && S.bondActive(battle, u.ownerId, x) && !out.includes(x)) out.push(x);
        }
      }
      // 塑心（旧写法）"当前已激活且层数最多的盟约和自身已激活的盟约层数+1": the top bond plus every bond the holder itself carries
      if (it.bbStr.also_self_bond) for (const x of S.unitBonds(u)) if (x !== b && S.bondActive(battle, u.ownerId, x)) out.push(x);
      return out.length ? out : EMPTY;
    }
    default: return ids(it.bbStr.bond_id);
  }
}

function amountOf(battle, it) {
  const bb = it.bb;
  const bonus = S.num(it.bonus, 0); // per-trigger extra (贝洛内's 伺夜在场时额外+1)
  switch (it.bbStr.bond_add_type) {
    case 'by_charcount_samerow': return S.rowMates(battle, it.unit).length * S.num(bb.bond_add_count_multi, S.num(bb.bond_add_count, 1)) + bonus;
    case 'by_charlevel': return S.tierOf(it.unit) * S.num(bb.bond_add_count, 1) + bonus;
    default: return S.num(bb.bond_add_count, 0) + bonus;
  }
}

function conditionMet(battle, it) {
  const ck = it.bbStr.conditionkey;
  const need = S.num(it.bb.check_count, 0);
  if (ck === 'character_same_row') return S.rowMates(battle, it.unit).length >= need;
  if (ck === 'character_same_col') {
    let n = 0;
    for (const a of battle.allyUnits) if (S.isOp(a) && a.ownerId === it.unit.ownerId && S.onField(a) && a.tileC === it.unit.tileC) n++;
    return n >= need;
  }
  return true;
}

/** Fire a layer-gain garrison instance. Returns the layers added. */
export function fireGain(battle, it, { mult = null, skipDiode = false } = {}) {
  if (!conditionMet(battle, it)) return 0;
  const bonds = targetBonds(battle, it);
  if (!bonds.length) return 0;
  let n = amountOf(battle, it);
  // ★ 2026-10-14 惊变「二极管」(jibian_erjiguan)：叠层类卫戍特质【每次触发】各掷一次 50/50 ——
  //   翻倍（本次层数 ×2）/ 不生效（本次不加层）。这是叠层类唯一的出口（9 个钩子都走 fireGain），
  //   所以一处接线即可覆盖 useskill / selfkillenemy / onstart / selfdead / consume_ammo /
  //   enemy_abflag_inrange / knockback / allyenemy_sleepstun_inrange / enemy_status_consumed。
  //   翻倍发生在下文的 per-battle cap 之前，所以"每场至多 N 层"仍然有效。
  //
  // ★ 2026-10-18（owner）：一次触发要产出**多笔**加层时（`act1autochess_gar_levitate_once`：自身已激活盟约 +
  //   S.E.E.S 两笔），由调用方掷**一次**骰子并把结果传进来（`skipDiode + mult`），否则两笔会各掷一次 ——
  //   那不是"每次触发各掷一次"。mult = 2（翻倍）或 0（本次触发整次不生效，调用方直接跳过第二笔）。
  if (skipDiode) {
    if (!(mult > 0)) return 0;
    n *= mult;
  } else if (diodeOn(battle, it.unit.ownerId)) {
    // ★ 出老千：只会翻倍
    if (cheatOn(battle, it.unit.ownerId) || battle.rng() < DIODE_DOUBLE_CHANCE) n *= 2;
    else return 0;
  }
  // bond_actived_maxstack (塑心 garrison_90 "当前已激活且层数最多的盟约层数+1（每场作战至多10层）"): the cap is the instance's
  // own over the battle, whichever bond is the highest at each gain — per (instance, bond) a change of the highest bond
  // granted a fresh 10 (PR #178 review). The base amount counts toward it (魔王's extra does not, as in gainLayers).
  const whole = it.bbStr.bond_type === 'bond_actived_maxstack' && Number.isFinite(it.cap);
  if (whole) {
    n = Math.min(Math.floor(n), Math.max(0, Math.floor(it.cap) - (it.wholeUsed ?? 0)));
    if (!(n > 0)) return 0;
  }
  const added = S.gainLayers(battle, {
    playerId: it.unit.ownerId, bonds, n, requireActive: true, source: it.unit, reason: 'garrison',
    cap: whole ? Infinity : it.cap, capKey: whole ? null : it.capKey,
  });
  if (whole && added > 0) it.wholeUsed = (it.wholeUsed ?? 0) + n;
  if (added > 0) S.fxOn(battle, 'garrison', it.unit, `gar:${it.gid}`, it.key, { n: added });
  return added;
}

/**
 * ★ 2026-10-15（用户，炸惊·卡西米尔）焰尾：`garrison_zj_60_2_a`
 *   「<战斗中>使『红松骑士团』成员的卫戍特质效果翻倍」。
 *
 * 数据（`data/garrisons.json` 的 `bbStr`）：
 *   · `pinus_chars` —— 逗号分隔的 charId 名单（★ 红松骑士团在 chess 记录里【没有】势力标记，
 *     `nationId` 一律是 `kazimierz`，所以只能靠名单；放在数据里 ⇒ 以后改名单不用动代码）；
 *   · `mult` —— 倍率，缺省 2。
 *
 * 只放大【效果数值】这几个键；`max_add_count_per_battle`（每场上限）与 `divide_num`（每几层触发）
 * 属于**门限**而不是效果，不放大 —— 否则「效果翻倍」会被自己的上限吃掉、或者变成触发更慢。
 * 在派发前就地改 `it.bb`，所以每个 INSTALLERS / READERS 都吃翻倍，一处接线覆盖全部效果。
 */
const PINUS_DOUBLE_KEY = 'act2autochess_gar_eff_pinusDouble';
/** 会被「效果翻倍」放大的数值键。 */
const PINUS_SCALE_KEYS = Object.freeze(new Set([
  'bond_add_count', 'bond_add_count_multi', 'count',
  'atk', 'max_hp', 'def', 'attack_speed', 'hp_recovery_per_sec', 'sp_recovery_per_sec',
]));

function scalePinusGarrisons(by) {
  const doublers = by.get(PINUS_DOUBLE_KEY);
  if (!doublers || !doublers.length) return;
  const wanted = new Set();
  let mult = 2;
  for (const d of doublers) {
    mult = Math.max(mult, S.num(d.bb.mult, 2));
    for (const s of String(d.bbStr.pinus_chars || '').split(',')) {
      const v = s.trim();
      if (v) wanted.add(v);
    }
  }
  if (!(mult > 1) || !wanted.size) return;
  for (const list of by.values()) {
    for (const it of list) {
      if (it.key === PINUS_DOUBLE_KEY) continue;
      const ch = (it.unit.def && it.unit.def.raw && it.unit.def.raw.charId)
        || (it.unit.def && it.unit.def.charId) || null;
      if (!ch || !wanted.has(ch)) continue;
      // ★ 2026-10-16 修 bug（同一类，香港 server.err.log 里成对出现）：
      //   原来是 `it.bb[k] = it.bb[k] * mult` —— `it.bb` 来自 data/garrisons.json，被 data.js
      //   **deepFreeze** 冻住，所以改**已有属性**会抛
      //     TypeError: Cannot assign to read only property 'bond_add_count' of object '#<Object>'
      //   （上面 installReaders 那处是"加新属性"→ not extensible；这里是"改已有属性"→ read only）。
      //   两处都在 `install()` 的路径上，任一处抛出都会让**整个 `content:garrisons` 安装失败**，
      //   于是所有卫戍特质在战斗里都不生效。
      //   修法同上：**克隆一份 bb**，在克隆上做全部缩放，最后整体替换引用；绝不改冻结对象。
      const scaled = { ...it.bb };
      let changed = false;
      for (const k of PINUS_SCALE_KEYS) {
        if (typeof scaled[k] === 'number' && Number.isFinite(scaled[k])) {
          scaled[k] = scaled[k] * mult;
          changed = true;
        }
      }
      if (changed) it.bb = scaled;
    }
  }
}

const byUnit = (list) => {
  const m = new Map();
  for (const it of list) {
    let a = m.get(it.unit);
    if (!a) { a = []; m.set(it.unit, a); }
    a.push(it);
  }
  return m;
};

function isFrontOf(holder, u) {
  if (!u || u === holder || u.ownerId !== holder.ownerId || !S.onField(u)) return false;
  const [fr, fc] = frontOf(holder.tileR, holder.tileC, holder.dir);
  return u.tileR === fr && u.tileC === fc;
}
/**
 * 魔王: the gain's source (an operator of the holder's player) stands in front of it. `tile` = the engine's layerGain
 * ctx.tile: where the source stands, or where it was knocked out this very instant (幽灵鲨 "被击倒时" gains fire on death).
 */
function sourceInFront(holder, u, tile) {
  if (!u || u === holder || u.ownerId !== holder.ownerId || !S.isOp(u) || !Array.isArray(tile)) return false;
  const [fr, fc] = frontOf(holder.tileR, holder.tileC, holder.dir);
  return tile[0] === fr && tile[1] === fc;
}
function ammoScope(it, u) {
  const h = it.unit;
  switch (it.bbStr.range_id) {
    case '1-1': return S.onField(h) && isFrontOf(h, u);
    case 'x-5': return u === h || (S.onField(h) && S.onField(u) && u.ownerId === h.ownerId && S.isOp(u) && Math.abs(u.tileR - h.tileR) + Math.abs(u.tileC - h.tileC) === 1);
    default: return u === h;
  }
}

const INSTALLERS = {
  act1autochess_gar_event_useskill(battle, list) {
    const m = byUnit(list);
    // 纯烬艾雅法拉's "全场每有一名干员开启技能时": every operator of the holder's player counts, not only the holder
    const all = list.filter((it) => it.bbStr.watch_all);
    battle.on('skillStart', ({ unit }) => {
      const arr = m.get(unit);
      if (arr) for (const it of arr) fireGain(battle, it);
      if (!all.length || !unit || !S.isOp(unit)) return;
      for (const it of all) {
        if (it.unit === unit) continue; // the holder's own cast is already counted above
        if (unit.ownerId !== it.unit.ownerId) continue;
        fireGain(battle, it);
      }
    });
  },

  /**
   * ★ 2026-10-15（用户，炸惊·卡西米尔）砾：`garrison_zj_25_3_a`
   *   「<部署时>扣除当前生命上限的 `hp_cost_pct`（可叠加，持续到回合结束）」。
   *   · 每次触发按**当前**生命上限算（复利），累加成一个 `hpFlat` 负数；
   *   · `passiveBuff` 是 persist（不消失）⇒ 天然「持续到回合结束（战斗结束）」；
   *   · 只在持有者的部署事件上跑，且只对干员（S.isOp）。
   */
  /** @deprecated 2026-10-15：扣血已合并进 `act2autochess_gar_event_onstart`（用户要求「改原特质、不加新条」）。
   *   这个独立 key 保留着，以防将来需要「只扣血、不叠层」的特质；数据里目前没有引用。 */
  act2autochess_gar_eff_hpCostOnDeploy(battle, list) {
    const m = byUnit(list);
    battle.on('deploy', ({ unit }) => {
      if (!unit || !S.isOp(unit)) return;
      const arr = m.get(unit);
      if (!arr) return;
      for (const it of arr) {
        const pct = S.num(it.bb.hp_cost_pct, 0);
        if (!(pct > 0)) continue;
        const cur = Math.max(1, Math.round(S.num(unit.s && unit.s.maxHp, 0)
          || S.num(unit.base && unit.base.maxHp, 0) || 1));
        const cut = Math.max(1, Math.round(cur * pct));
        if (!unit.mem) unit.mem = {};
        unit.mem.hpCost = (unit.mem.hpCost || 0) + cut;
        S.passiveBuff(battle, unit, 'gar:hpcost', { hpFlat: -unit.mem.hpCost });
        S.fxOn(battle, 'garrison', unit, `gar:${it.gid}`, it.key, { n: unit.mem.hpCost });
      }
    });
  },

  act1autochess_gar_event_selfkillenemy(battle, list) {
    const m = byUnit(list);
    for (const it of list) it.allies = /我方干员/.test(it.g.desc || '');
    battle.on('kill', ({ killer, victim }) => {
      const arr = killer ? m.get(killer) : null;
      if (!arr || !victim) return;
      for (const it of arr) {
        if (!(victim.side === 'enemy' || (it.allies && victim.side === 'ally' && victim.kind === 'op'))) continue;
        it.cnt++;
        if (it.cnt % Math.max(1, S.num(it.bb.check_cnt, 1)) === 0) fireGain(battle, it);
      }
    });
  },

  act1autochess_gar_event_selfdead(battle, list) {
    const m = byUnit(list);
    battle.on('death', ({ unit, reason }) => {
      if (reason !== 'killed') return;
      const arr = m.get(unit);
      if (arr) for (const it of arr) fireGain(battle, it);
    });
    const swaps = list.filter((it) => /替身/.test(it.g.desc || ''));
    if (!swaps.length) return;
    for (const it of swaps) it.doll = false;
    battle.on('tick', () => {
      for (let i = 0; i < swaps.length; i++) {
        const it = swaps[i];
        const u = it.unit;
        const doll = !!(u.trait && u.trait.doll);
        if (doll === it.doll) continue;
        it.doll = doll;
        if (u.alive && u.deployed) fireGain(battle, it);
      }
    });
  },

  act1autochess_gar_event_consume_ammo(battle, list) {
    battle.on('ammoUsed', ({ unit }) => {
      if (!unit) return;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (!ammoScope(it, unit)) continue;
        it.cnt++;
        if (it.cnt % Math.max(1, S.num(it.bb.consume_count, 1)) === 0) fireGain(battle, it);
      }
    });
  },

  act1autochess_gar_event_enemy_abflag_inrange(battle, list) {
    const watched = new Set(list.map((it) => AB_FLAG_STATUS[S.num(it.bb.check_ab_flag, 16)] ?? 'freeze'));
    // "进入冻结时": only a new entry (engine ctx.entered — a refresh of a running freeze is not one)
    battle.on('statusApplied', ({ target, status, entered }) => {
      if (!target || !watched.has(status) || !entered || target.side !== 'enemy') return;
      for (const it of list) {
        if (status !== (AB_FLAG_STATUS[S.num(it.bb.check_ab_flag, 16)] ?? 'freeze')) continue;
        if (!S.onField(it.unit) || !S.inRange(it.unit, target)) continue;
        if (battle.rng() < S.num(it.bb.prob, 1)) fireGain(battle, it);
      }
    });
  },

  act2autochess_gar_event_onstart(battle, list) {
    const m = byUnit(list);
    battle.on('deploy', ({ unit }) => {
      const arr = m.get(unit);
      if (!arr) return;
      for (const it of arr) {
        // ★ 2026-10-18（owner）：`bb.max_fires_per_battle` —— 这条特质本场最多触发几次。
        //   砾的炸惊卫戍特质用它实现「每回合最多再部署 20 次」（本作一个回合 = 一场战斗）：
        //   第 21 次部署起既不叠层、也不扣生命上限，但人仍然可以正常再部署。
        const maxF = S.num(it.bb.max_fires_per_battle, 0);
        if (maxF > 0) {
          // ★ 2026-10-18（owner）：这条给的是**部署上限**，不是不叠层——
          //   写进 unit.mem.redeployCap，由 sim/battle/deploy.js 的 _deploy 拒绝超限的部署（之后不再复活）。
          if (!(unit.mem && unit.mem.redeployCap >= maxF)) {
            if (!unit.mem) unit.mem = {};
            unit.mem.redeployCap = maxF;
          }
        }
        // ★ 2026-10-15（用户：「我的想法不是新加一条，而是在原卫戍特质上改动」）：
        //   同一条特质可以【既叠层、又在部署时扣生命上限】—— 砾的 `garrison_zj_25_a` 就是这种。
        //   只有 bb 里配了 `hp_cost_pct` 的特质走这条分支，其余 25 条 onstart 行为逐字节不变。
        const pct = S.num(it.bb.hp_cost_pct, 0);
        if (pct > 0 && S.isOp(unit)) {
          const cur = Math.max(1, Math.round(S.num(unit.s && unit.s.maxHp, 0)
            || S.num(unit.base && unit.base.maxHp, 0) || 1));
          const cut = Math.max(1, Math.round(cur * pct));
          if (!unit.mem) unit.mem = {};
          unit.mem.hpCost = (unit.mem.hpCost || 0) + cut;
          S.passiveBuff(battle, unit, 'gar:hpcost', { hpFlat: -unit.mem.hpCost });
          S.fxOn(battle, 'garrison', unit, `gar:${it.gid}`, it.key, { n: unit.mem.hpCost });
        }
        // 贝洛内's "伺夜在场时额外+1": a snapshot at the deploy that triggered the gain
        const want = it.bbStr.extra_char;
        const extra = want && S.num(it.bb.extra_with_char, 0)
          ? (opsOf(battle, it.unit.ownerId).some((o) => o.backup && o.backup.charId === want) ? S.num(it.bb.extra_with_char, 0) : 0)
          : 0;
        it.bonus = extra;
        try { fireGain(battle, it); } finally { it.bonus = 0; }
      }
    });
    // Player-confirmed: 远牙's granted trait also gains on each body / substitute switch (DESIGN §28.5).
    // Restrict this extra trigger to that trait; use its existing amounts, active-bond checks and battle cap.
    const farTooth = byUnit(list.filter((it) => it.gid === 'garrison_108_a' || it.gid === 'garrison_108_b'));
    if (farTooth.size) battle.on('dollSwap', ({ unit }) => {
      const arr = farTooth.get(unit);
      if (arr) for (const it of arr) fireGain(battle, it);
    });
  },

  /** 莫斯提马: "对敌方单位施加击退时" — a push that actually moved an enemy (displacement.js push emits `knockback`). */
  act1autochess_gar_event_knockback(battle, list) {
    battle.on('knockback', ({ target }) => {
      if (!target || target.side !== 'enemy') return;
      for (const it of list) if (S.onField(it.unit)) fireGain(battle, it);
    });
  },

  /**
   * 酒神: "每有一名敌人触发麻痹时" — `bbStr.status` names the status (palsy), new entries only. `range_id` is optional:
   * without it the whole field counts (the roster's wording has no range condition).
   */
  act1autochess_gar_event_enemy_status_inrange(battle, list) {
    battle.on('statusApplied', ({ target, status, entered }) => {
      if (!target || target.side !== 'enemy' || !entered) return;
      for (const it of list) {
        if (!it.bbStr.status || status !== it.bbStr.status) continue;
        if (!S.onField(it.unit)) continue;
        if (it.bbStr.range_id && !S.inRange(it.unit, target)) continue;
        if (battle.rng() < S.num(it.bb.prob, 1)) fireGain(battle, it);
      }
    });
  },

  /**
   * ★ 2026-10-18（owner 改的岳羽由加莉 `garrison_zj_60_4_c/_d`）：
   *   「〈战斗中〉每对敌方施加一次浮空，使自身已激活盟约 +1（**每名敌人仅触发一次**）；
   *     每对敌方施加一次浮空，使自身已激活的【S.E.E.S】盟约层数 +2。」精锐翻倍（+2 / +4），次数限制不变。
   *
   * 和上面的 `..._enemy_status_inrange` 的区别只有两点：
   *   ① 那个每次"重新进入"都算，这个**整场每名敌人只算一次**（`it.seen` 按 unit id 记账）；
   *   ② 额外点名一个盟约（`bbStr.also_bond_id`，这里是 seesShip = S.E.E.S）单独加 `bb.also_bond_add_count` 层，
   *      且要求它**已激活**（requireActive）—— 和"自身已激活盟约"那一份是两笔独立的加层。
   * 一次触发产出两笔加层，所以**二极管由这里掷一次骰子**（翻倍 / 本次整次不生效），两笔共用同一个结果；
   * 第一部分走 fireGain 的 `skipDiode + mult` 跳过它自己的那次骰子（否则两笔会各掷一次）。
   */
  act1autochess_gar_levitate_once(battle, list) {
    battle.on('statusApplied', ({ target, status, entered }) => {
      if (!target || target.side !== 'enemy' || !entered) return;
      for (const it of list) {
        if (it.bbStr.status && status !== it.bbStr.status) continue;
        if (!S.onField(it.unit)) continue;
        // ★ 2026-10-20（owner 澄清设计原意）：
        //   「每名敌人仅触发一次」**只约束第一笔**（自身已激活盟约 +N）；
        //   第二笔（点名的 S.E.E.S 层数 +M）**不受次数限制** —— 每次施加浮空都给。
        const seen = it.seen ?? (it.seen = new Set());
        const uid = target.id ?? target.uid;
        const first = uid != null && !seen.has(uid);
        if (first) seen.add(uid);
        // ★ 惊变「二极管」：整次触发掷一次 50/50 —— 翻倍(×2) / 本次不生效(整笔跳过，两笔都不加)
        let mult = 1;
        if (diodeOn(battle, it.unit.ownerId)) {
          // ★ 出老千：只会翻倍（不再可能「整次不生效」）
          if (cheatOn(battle, it.unit.ownerId) || battle.rng() < DIODE_DOUBLE_CHANCE) mult = 2;
          else continue;
        }
        // ① 自身已激活盟约 +bond_add_count（每名敌人仅一次；跳过 fireGain 自己那次骰子）
        if (first) fireGain(battle, it, { skipDiode: true, mult });
        // ② 点名的盟约（S.E.E.S）+also_bond_add_count（同一份 mult）
        const extra = S.num(it.bb.also_bond_add_count, 0) * mult;
        const bond = String(it.bbStr.also_bond_id || '');
        if (extra > 0 && bond) {
          const added = S.gainLayers(battle, {
            playerId: it.unit.ownerId, bonds: [bond], n: extra, requireActive: true,
            source: it.unit, reason: 'garrison', cap: it.cap, capKey: `${it.capKey}:${bond}`,
          });
          if (added > 0) S.fxOn(battle, 'garrison', it.unit, `gar:${it.gid}`, it.key, { n: added });
        }
      }
    });
  },

  /**
   * 酒神 (owner's clarification): the intended trigger is "每当敌人消耗麻痹次数时，维多利亚层数加一" — the moment one
   * 麻痹 stack is really spent to interrupt an enemy's normal attack (the engine hook `palsyConsumed`, ai.js; PRTS 真言
   * 备注: "触发麻痹时" = the attack interrupted by 麻痹, not a stack gained). The earlier wiring used
   * `..._enemy_status_inrange`, which fires when the enemy *gains* 麻痹. Each spent stack counts once; 真言's 噤声限域
   * ("触发麻痹时有N%概率不消耗麻痹层数") keeps the stack and therefore earns nothing. `bbStr.status` names the status
   * (palsy) so the key can serve other statuses later; `bb.prob` is an optional chance, `bbStr.range_id` an optional
   * range condition (the roster's wording has none).
   */
  act1autochess_gar_event_enemy_status_consumed(battle, list) {
    battle.on('palsyConsumed', ({ enemy }) => {
      if (!enemy || enemy.side !== 'enemy') return;
      for (const it of list) {
        if (it.bbStr.status && it.bbStr.status !== 'palsy') continue;
        if (!S.onField(it.unit)) continue;
        if (it.bbStr.range_id && !S.inRange(it.unit, enemy)) continue;
        if (battle.rng() < S.num(it.bb.prob, 1)) fireGain(battle, it);
      }
    });
  },

  /**
   * ★ 2026-10-17（S.E.E.S 版本，埃癸斯 `garrison_zj_60_3_c/_d`）：
   *   「<战斗中>**陷入异常状态时**，使自身已激活盟约+`bond_add_count`」。
   *   既有 14 个 installer 里没有「持有者自己吃到状态」这一条（`enemy_status_inrange` 只管敌人、
   *   `allyenemy_sleepstun_inrange` 只认睡眠/眩晕且要求目标在范围内），所以在这里补一个。
   *   · `bbStr.status` 不写 = **任何**异常状态都算（眩晕/冻结/恐惧/浮空…）；
   *     写了就只认那一个状态名（与 `enemy_status_inrange` 的判定方式一致）。
   *   · `entered` 为真才算新进入（同状态刷新不重复触发）—— `statusApplied` 的既有语义。
   *   · 目标必须是持有者本人（`byUnit` 的键就是 it.unit）。
   */
  act2autochess_gar_event_self_status(battle, list) {
    const m = byUnit(list);
    battle.on('statusApplied', ({ target, status, entered }) => {
      if (!target || !entered) return;
      const arr = m.get(target);
      if (!arr) return;
      for (const it of arr) {
        if (it.bbStr.status && status !== it.bbStr.status) continue;
        fireGain(battle, it);
      }
    });
  },

  act2autochess_gar_event_allyenemy_sleepstun_inrange(battle, list) {
    battle.on('statusApplied', ({ target, status, entered }) => { // "进入沉睡/晕眩时": new entries only (ctx.entered)
      if (!target || (status !== 'sleep' && status !== 'stun') || !entered) return;
      if (!(target.side === 'enemy' || (target.side === 'ally' && target.kind === 'op'))) return;
      for (const it of list) if (S.onField(it.unit) && S.inRange(it.unit, target)) fireGain(battle, it);
    });
  },

  act1autochess_gar_event_addition_cnt(battle, list) {
    battle.on('layerGain', (ctx) => {
      if (ctx.reason !== 'garrison' || !ctx.source) return;
      for (const it of list) {
        const h = it.unit;
        if (h.ownerId !== ctx.playerId || !S.onField(h)) continue;
        if (it.bbStr.range_id && it.bbStr.range_id !== '1-1') continue;
        if (sourceInFront(h, ctx.source, ctx.tile)) ctx.n += S.num(it.bb.extra_cnt, 0);
      }
    });
  },

  GAIN_BUFF(battle, list) {
    for (const it of list) {
      const mods = {};
      if (S.num(it.bb.atk, 0) > 0) mods.atkMul = S.num(it.bb.atk);
      if (S.num(it.bb.max_hp, 0) > 0) mods.hpMul = S.num(it.bb.max_hp);
      if (S.num(it.bb.def, 0) > 0) mods.defMul = S.num(it.bb.def);
      S.passiveBuff(battle, it.unit, `gar:${it.gid}`, mods);
    }
  },

  attr_common_global_buff(battle, list) {
    for (const it of list) {
      const mods = {};
      if (S.num(it.bb.sp_recovery_per_sec, 0)) mods.spRecoveryFlat = S.num(it.bb.sp_recovery_per_sec);
      Object.assign(mods, S.directMods({ atk: S.num(it.bb.atk, 0), hp: S.num(it.bb.max_hp, 0) }));
      if (S.num(it.bb.attack_speed, 0)) mods.aspd = S.num(it.bb.attack_speed);
      S.passiveBuff(battle, it.unit, `gar:${it.gid}`, mods);
    }
  },

  // grants are resolved in install(); 风丸's rule lives in the prep economy
  ADD_BOND() {},
  NONE() {},
};

// ---------------------------------------------------------------------------------------------------------------------
// layer readers (每叠加N层)

const READERS = new Set([
  'act1autochess_gar_eff_attrByBond', 'act1autochess_gar_eff_respawnTimeByBond',
  'act2autochess_gar_eff_attrByBond_add_onstart', 'act2autochess_gar_eff_ab_damageScaleByBond',
  'act1autochess_gar_eff_blockByBond',
]);

/** floor(Σ layers of the listed active bonds / divide_num). */
export function stepsOf(battle, it) {
  const div = Math.max(1, S.num(it.bb.divide_num, 1));
  let sum = 0;
  for (const b of it.bonds ?? (it.bonds = ids(it.bbStr.bond_id))) if (S.bondActive(battle, it.unit.ownerId, b)) sum += S.bondLayers(battle, it.unit.ownerId, b);
  return Math.floor(sum / div);
}

function attrMods(bb, k) {
  // "每叠加N层，本干员攻击力+X%": a 直接乘算 bonus like every other "+X%" of the 卫戍 systems (support directMods)
  const m = S.directMods({ atk: S.num(bb.atk, 0) * k, hp: S.num(bb.max_hp, 0) * k, def: S.num(bb.def, 0) * k });
  if (S.num(bb.attack_speed, 0)) m.aspd = S.num(bb.attack_speed) * k;
  if (S.num(bb.hp_recovery_per_sec, 0)) m.hpRegen = S.num(bb.hp_recovery_per_sec) * k;
  if (S.num(bb.sp_recovery_per_sec, 0)) m.spRecoveryFlat = S.num(bb.sp_recovery_per_sec) * k;
  return m;
}

function applyReader(battle, it) {
  const k = stepsOf(battle, it);
  if (k === it.k) return;
  it.k = k;
  const u = it.unit;
  const key = `gar:${it.gid}`;
  switch (it.key) {
    case 'act1autochess_gar_eff_attrByBond':
      if (k > 0) S.passiveBuff(battle, u, key, attrMods(it.bb, k));
      else battle.removeBuff(u, key);
      break;
    case 'act1autochess_gar_eff_respawnTimeByBond':
      // 耀骑士临光's 144: −1.5 % / −3 % per 3 卡西米尔 layers with no minimum in the blackboard (divide_num, respawn_time
      // only) — clamped at 0 like every other redeploy multiplier, so a knock-out timer can reach 0 s (GitHub #370;
      // until 0.2.1 a 0.05 floor kept it at 5 % of the base time from 192 layers, 96 for the elite)
      if (k > 0) S.passiveBuff(battle, u, key, { redeployMul: Math.max(0, 1 + S.num(it.bb.respawn_time, 0) * k) });
      else battle.removeBuff(u, key);
      break;
    case 'act1autochess_gar_eff_blockByBond':
      // 泡泡 / 信仰搅拌机's "【萨尔贡】【坚守】每叠加50层，本干员阻挡数+1" (bb: divide_num 50, block 1)
      if (k > 0) S.passiveBuff(battle, u, key, { blockCnt: S.num(it.bb.block, 0) * k });
      else battle.removeBuff(u, key);
      break;
    case 'act2autochess_gar_eff_attrByBond_add_onstart': {
      const b = u.findBuff(key);
      if (b && b.timeLeft > 0) onstartBuff(battle, it, b.timeLeft);
      break;
    }
    default: break; // damageScale reads it.k in the hit hook
  }
}

function onstartBuff(battle, it, duration) {
  const k = Math.max(0, it.k);
  const key = `gar:${it.gid}`;
  if (!(k > 0) || !(duration > 0)) { battle.removeBuff(it.unit, key); return; }
  battle.addBuff(it.unit, { key, duration, refresh: 'replace', mods: { atkFlat: S.num(it.bb.atk, 0) * k, hpFlat: S.num(it.bb.max_hp, 0) * k } });
}

function installReaders(battle, by) {
  const list = [];
  for (const key of READERS) for (const it of by.get(key) ?? EMPTY) list.push(it);
  if (!list.length) return;
  const recompute = () => { for (const it of list) applyReader(battle, it); };
  recompute();
  let pending = false;
  battle.on('layerGain', () => {
    if (pending) return;
    pending = true;
    battle.after(0, () => { pending = false; recompute(); });
  });
  const onstart = by.get('act2autochess_gar_eff_attrByBond_add_onstart');
  if (onstart) {
    const m = byUnit(onstart);
    battle.on('deploy', ({ unit }) => {
      const arr = m.get(unit);
      if (!arr) return;
      for (const it of arr) { it.k = stepsOf(battle, it); onstartBuff(battle, it, S.num(it.bb.duration, 0)); }
    });
    // ★ 2026-10-15（用户：「我的想法不是新加一条，而是在原卫戍特质上改动」）：
    //   玛恩纳的 `garrison_zj_75_a` 同时要「每 4 层 +10 攻 / +50 血」和「每击倒 1 名敌人【卡西米尔】+2」。
    //   只有 bb 里配了 `kill_bond_add_count` 的特质装这条钩子（其余 3 条同名 reader 行为不变）。
    //   把数值搬到 `bond_add_count` 上，好让通用的 fireGain 直接读（它的取数口径就是那个键）。
    //
    // ★ 2026-10-16 修 bug（香港公开服 server.err.log 被这条刷满，玩家侧表现为「卫戍特质整套失效」）：
    //   原来是 `it.bb.bond_add_count = …` —— **往 `it.bb` 上写新属性**。而 `it.bb` 来自
    //   data/garrisons.json，被 server/data.js 的 **deepFreeze** 冻住了（本对象不可扩展），
    //   严格模式下抛 `TypeError: Cannot add property bond_add_count, object is not extensible`。
    //   那一抛发生在 `install()` 里 ⇒ **整个 `content:garrisons` 战斗内容安装失败**（不是只坏这一条），
    //   于是所有卫戍特质在战斗里都不生效。日志里是：
    //     [sim] content:garrisons failed: TypeError: Cannot add property bond_add_count, object is not extensible
    //         at installReaders (…/garrisons/battle.js:666:30)
    //   修法：**替换掉 `it.bb` 这个引用**（换成浅拷贝 + 新键），绝不改冻结对象本身。
    //   只动从 `kill_bond_add_count` 构造出来的那一份，data 里的原始记录保持不变。
    const killers = onstart.filter((it) => S.num(it.bb.kill_bond_add_count, 0) > 0);
    if (killers.length) {
      const km = byUnit(killers);
      for (const it of killers) {
        it.bb = { ...it.bb, bond_add_count: S.num(it.bb.kill_bond_add_count, 0) };
        it.cnt = 0;
      }
      battle.on('kill', ({ killer, victim }) => {
        const arr = killer ? km.get(killer) : null;
        if (!arr || !victim || victim.side !== 'enemy') return;
        for (const it of arr) {
          it.cnt++;
          if (it.cnt % Math.max(1, S.num(it.bb.check_cnt, 1)) === 0) fireGain(battle, it);
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// hit modifiers

/**
 * 弱点伤害 (research 04 §glossary: "each hit is dealt as whichever of physical/arts yields MORE damage against that
 * target's DEF/RES"): the engine's own mitigation formula incl. the attacker's DEF/RES ignore stats; a tie keeps the
 * original type.
 */
export function weaknessType(source, target, dmg) {
  const ss = source && source.s ? source.s : null;
  const ign = {
    defIgnorePct: S.num(dmg.defIgnorePct, 0) + (ss ? S.num(ss.defIgnorePct, 0) : 0),
    defIgnoreFlat: S.num(dmg.defIgnoreFlat, 0) + (ss ? S.num(ss.defIgnoreFlat, 0) : 0),
    resIgnorePct: S.num(dmg.resIgnorePct, 0) + (ss ? S.num(ss.resIgnorePct, 0) : 0),
    resIgnoreFlat: S.num(dmg.resIgnoreFlat, 0) + (ss ? S.num(ss.resIgnoreFlat, 0) : 0),
  };
  const ph = mitigate(dmg.amount, 'phys', target.s, ign) * (ss ? S.num(ss.physDealtMul, 1) : 1) * S.num(target.s.physTakenMul, 1);
  const ar = mitigate(dmg.amount, 'arts', target.s, ign) * (ss ? S.num(ss.artsDealtMul, 1) : 1) * S.num(target.s.artsTakenMul, 1);
  if (ar > ph + 1e-9) return 'arts';
  if (ph > ar + 1e-9) return 'phys';
  return dmg.type;
}
const bound = (t) => !!(t.s && t.s.flags && t.s.flags.bind) || !!t.findBuff('bind');

/** Priority of the 弱点伤害 conversion: after every default-priority hit modifier, so the final amount decides. */
export const WEAKNESS_PRIORITY = -10;

function installHitMods(battle, by) {
  const m = new Map();
  const push = (it, kind) => {
    let a = m.get(it.unit);
    if (!a) { a = []; m.set(it.unit, a); }
    a.push({ it, kind });
  };
  for (const it of by.get('act1autochess_gar_eff_attack_enemy') ?? EMPTY) push(it, 'tag');
  for (const it of by.get('act2autochess_gar_eff_ab_damageScaleByBond') ?? EMPTY) push(it, 'ab');
  for (const it of by.get('act1autochess_gar_eff_attack_enemy_def_down') ?? EMPTY) push(it, 'defdown');
  if (m.size) {
    battle.on('hit', ({ source, target, dmg }) => {
      const arr = source ? m.get(source) : null;
      if (!arr || !target || target.side !== 'enemy' || !dmg || dmg.type === 'element') return;
      for (let i = 0; i < arr.length; i++) {
        const { it, kind } = arr[i];
        if (kind === 'tag') {
          // an ATK multiplier: fixed-value DoT ticks are not ATK-based
          if (Array.isArray(dmg.tags) && dmg.tags.includes('dot')) continue;
          const tags = target.def && target.def.tags;
          if (Array.isArray(tags) && tags.includes(it.bbStr.check_tag)) dmg.amount *= S.num(it.bb.atk, 1);
        } else if (kind === 'defdown') {
          // 黑's "攻击敌人时敌人防御力降低30%，持续5秒": the catalogue's 同名效果取最高 defDown debuff on the target
          const tags = target.def && target.def.tags;
          if (it.bbStr.check_tag && !(Array.isArray(tags) && tags.includes(it.bbStr.check_tag))) continue;
          battle.applyStatus(target, 'defDown', {
            duration: S.num(it.bb.duration, 0), source, value: Math.abs(S.num(it.bb.def_scale, 0.3)),
          });
        } else if (it.k > 0) {
          const hit = (S.num(it.bb.check_ab_flag, 0) && bound(target)) || (S.num(it.bb.check_sluggish, 0) && !!target.findBuff('sluggish'));
          if (hit) dmg.mul = S.num(dmg.mul, 1) * (1 + S.num(it.bb.damage_scale_per_stack, 0) * it.k);
        }
      }
    });
  }
  const chaos = new Set((by.get('act1autochess_gar_eff_chaos') ?? EMPTY).map((it) => it.unit));
  if (chaos.size) {
    battle.on('hit', ({ source, target, dmg }) => {
      if (!source || !chaos.has(source) || !target || target.side !== 'enemy' || !dmg) return;
      if (dmg.type === 'phys' || dmg.type === 'arts') dmg.type = weaknessType(source, target, dmg);
    }, { priority: WEAKNESS_PRIORITY });
  }
}
