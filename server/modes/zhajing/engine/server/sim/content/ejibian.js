// server/sim/content/ejibian.js — 炸惊模拟 规则14「敌方惊变」(ejibian_*) 的实际效果。
//
// 抽卡本身在 Match 里（match/match/phases.js 的 enterEnemyJibian：按 jibian.rarityWeights 摇稀有度 → 从
// modes[*].enemyJibian.pool 里抽一张 → 播 flickerMs + resultMs 的揭示动画）；本文件负责「抽到之后到底发生什么」。
// 牌面/卡 id 由 _garrison-list/jibian-data.mjs 生成进 data/config.json，这里按卡 id 认牌。
//
// 传递路径：Match 每抽到一张就把卡 id 追加进 this.enemyJibianCards（抽到之后一直留着），各处在建 battle spec 时把它
// 放进 flags.enemyJibian（字符串数组），于是从抽到那一轮起的每一场战斗都带着它 —— 和牌面的「接下来每回合」一致。
//
// 15 张牌的分工：
//   * 战场侧（本文件，出怪时逐只结算）
//       ejibian_qiangqiang        ？！强强？！    所有敌方单位（含领袖）基础数值 +20%
//       ejibian_liangbianzhibian  量变→质变      基础数值 −60%（出怪量 +40% 在 Match 侧）
//       ejibian_zhibianliangbian  质变→量变      基础数值 +40%（出怪量 −20% 在 Match 侧）
//       ejibian_jixingjun         急行军        移动速度 +40%
//       ejibian_longren           龙刃          近战伤害 +200%、失去远程攻击能力（领袖不受影响）
//       ejibian_xianfazhiren      先发制人      攻速 +90
//       ejibian_zhendejiade       真的假的      0.1% 概率三项基础数值变 1（并跳过其它数值惊变）
//       ejibian_tongxingzheng     通行证        获得两层次数盾（shieldHits：整次伤害被吃掉）
//       ejibian_shenweinancanglei 神威难藏泪    10% 物理 / 法术闪避
//       ejibian_jiban             羁绊          同名敌人同时在场上两只 → 双方基础数值 +50%，直到其中一只死亡 / 进蓝门
//       ejibian_douququ           斗蛐蛐        10% 概率复刻我方随机单位的数值
//       ejibian_gaodingtouer      搞定他们的头儿 领袖生命 −50%，道中敌人基础数值 +30%
//       ejibian_sakaziwushu       萨卡兹巫术      所有敌人造成伤害时，附带该次伤害 10% 的凋亡损伤（owner 2026-10-18）
//       ejibian_jiangshiweicheng  丧尸围城        出怪量 +100%（Match 侧：countMul ×2，owner 2026-10-24）
//   * Match 侧（出怪表 / 波次：入职测试把小怪换成源石虫、鸭爵的第 7/8 回合、强行顶吗的同时进场，以及量变/质变的
//     出怪量增减 —— 这几张要改的是「出什么、出几只、什么时候出」，改在 sim 里已经太晚。本文件只负责「算什么」
//     （下面的 MATCH 段：matchJibianPlan / jibianDuckParams），「怎么改」落在 match/waves.js 的 templateSpawns
//     （小怪换源石虫、出怪量乘区、同一时间进场）与 content/bands/meta.js 的 duckGlobal（鸭爵参数）里）。
//
// 数值口径：基础数值 = unit.base.X，乘区走 mods（atkMul / defMul / hpMul / moveMul / dmgDealtMul 是乘算，
// aspd / dodgePhys / dodgeArts 是加算 —— 见 sim/units.js 的 _recalc）。所有加成都是 persist 的被动 buff，随单位
// 一生有效；领袖用 unit.isBoss（units.js）或 def.rank === 'BOSS' 认。

import { passiveBuff } from './support/index.js';
import { applyElement } from '../damage.js';
import { createRng, deriveSeed } from '../rng.js';
// 次数怪（TIMES / 频次）判定：口径见 enemies/helpers.js 的 isHitCount（'ab:hitCount' buff，
// 由 helpers.setHits / archetypes.times 在建怪时装上，见 archetypes.js 的 times()）。
import { isHitCount } from './enemies.js';

const P = 'ejibian:';

/** 卡 id 列表（也接受单张卡的字符串写法）。 */
export function cardsOf(battle) {
  const v = battle && battle.flags ? battle.flags.enemyJibian : null;
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return new Set(list.filter((x) => typeof x === 'string' && x));
}

/** 领袖（数据 rank BOSS / bosses.json 的 enemyKey，spawns.js 会置 unit.isBoss）。 */
const isBoss = (e) => !!(e && (e.isBoss === true || String(e.def && e.def.rank).toUpperCase() === 'BOSS'));

/** 远程单位（simdata 归一化后的 def.applyWay / rangeRadius）。 */
const isRanged = (e) => {
  const d = e && e.def;
  if (!d) return false;
  // ★ 2026-10-14 修 bug（玩家反馈「龙刃触发了但敌方依旧远程攻击」）：
  //   data/enemies.json 的 applyWay 有四种取值 MELEE 128 / RANGED 65 / NONE 40 / **ALL 16**，
  //   而 rangeRadius 在这些记录里【根本不存在】（全为 undefined）→ 下面那条永远为 false。
  //   原先只认 'RANGED'，于是 applyWay='ALL' 的 16 个敌人（守墓石像 / 萨卡兹枯朽战车 /
  //   掠海漂移体 / 节日爵士乐手 …）判不出远程，龙刃就不会给它们 disarm，它们照样远程开火。
  //   'ALL' 本来就该算远程 —— 这是项目自己的约定：op-nasti.js `RANGED_WAYS = new Set(['RANGED','ALL'])`、
  //   op-thorns.js「攻击方式包含远程: applyWay RANGED or ALL」、op-wang.js「RANGED || ALL」。
  const way = String(d.applyWay || '').toUpperCase();
  if (way === 'RANGED' || way === 'ALL') return true;
  return Number(d.rangeRadius) > 0;
};

/** 会攻击的单位（转译基底一类 applyWay NONE / profile.noAttack 的不算）。 */
const canAttack = (e) => {
  const d = e && e.def;
  if (!d) return false;
  if (String(d.applyWay || '').toUpperCase() === 'NONE') return false;
  return !(e.profile && e.profile.noAttack);
};

/** 三项基础数值 ×mul（乘区，hp 会按比例重算当前血量 —— units.js 的 _recalc）。 */
const triple = (battle, e, tag, mul, extra = null) => passiveBuff(battle, e, P + tag, { atkMul: mul, defMul: mul, hpMul: mul }, extra || {});

/** 把 base 上的数值改成定值（真的假的 / 斗蛐蛐复刻用）：写完要 markDirty 让 e.s 重算，血量跟着走。 */
function pinBase(e, { atk, def, maxHp, res, aspd, bat }) {
  const b = e.base;
  if (Number.isFinite(atk)) b.atk = Math.max(0, atk);
  if (Number.isFinite(def)) b.def = Math.max(0, def);
  if (Number.isFinite(res)) b.res = res;
  if (Number.isFinite(aspd)) b.aspd = aspd;
  if (Number.isFinite(bat)) b.bat = bat;
  // 【次数怪】需要被攻击的次数 = 它的「血量」（每段伤害只扣 1 点，见 enemies/helpers.js 的 setHits / hitCount）。
  // 这个次数【不随任何数值膨胀变化】：hpMul / 复刻（斗蛐蛐 ejibian_douququ）/ 百分比乘区都不能改它，
  // 改掉 = 玩家要打几千下。所以次数怪的 base.maxHp 一律不在这里改写（只动它的 atk / def / res / aspd / bat）。
  if (Number.isFinite(maxHp) && !isHitCount(e)) b.maxHp = Math.max(1, maxHp);
  e.markDirty();
  void e.s;
  e.hp = e.s.maxHp;
}

export function install(battle) {
  const cards = cardsOf(battle);
  if (!cards.size) return;
  const has = (id) => cards.has(id);
  const mem = (e) => (e.mem || (e.mem = {}));
  /** 异戒神将：新怪进场时的初始化（安装段里赋值，出怪回调在它之后才可能触发）。 */
  let adaptInit = null;

  // ---------------------------------------------------------------------------------------------------------------
  // 萨卡兹巫术（史诗，owner 2026-10-18）：「所有敌人造成伤害时会携带此次伤害 10% 的凋亡损伤。」
  //   · 敌人打我方（干员 / 召唤物）的每一次 `hit` 之后，按**这一跳实际伤害**给目标补一笔凋亡元素损伤；
  //   · 走 damage.js 的 applyElement：元素损伤倍率 / 损伤抵抗 / 爆发冷却都由引擎自己算，
  //     所以「10%」是元素值的**基础量**，实际进条的量和游戏里别的元素伤害同一口径；
  //   · 领袖（boss）也算「所有敌人」，卡面没有排除；
  //   · 目标已被这一击打死时 applyElement 自己会跳过（header：killing blow 的 rider 不填条）。
  if (has('ejibian_sakaziwushu')) {
    const RATIO = 0.1;
    battle.on('hit', (ctx) => {
      const dmg = ctx && ctx.dmg;
      const src = (ctx && (ctx.credit ?? ctx.source)) || null;
      const t = ctx && ctx.target;
      if (!dmg || !src || !t) return;
      if (src.side !== 'enemy' || t.side !== 'ally') return;
      const amount = Number(dmg.amount) || 0;
      if (!(amount > 0)) return;
      try {
        applyElement(battle, src, t, { element: 'apoptosis', amount: amount * RATIO, mul: 1, type: 'element' });
      } catch { /* 目标已离场 / 数据缺元素表：跳过 */ }
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 羁绊：同名敌人在场两只 → 双方 +50%，一只走了就散
  // ---------------------------------------------------------------------------------------------------------------
  const JIBAN = P + 'jiban';
  const live = new Map(); // 名字 → Set<敌人>
  const jibanRefresh = (name) => {
    const set = live.get(name);
    if (!set || !set.size) { live.delete(name); return; }
    const pair = set.size === 2;
    for (const e of [...set]) {
      if (!pair || !e.alive) { if (e.findBuff && e.findBuff(JIBAN)) battle.removeBuff(e, JIBAN); continue; }
      if (!e.findBuff(JIBAN)) {
        passiveBuff(battle, e, JIBAN, { atkMul: 1.5, defMul: 1.5, hpMul: 1.5 });
        battle.fx('link', { x: e.x, y: e.y, id: e.id });
      }
    }
    // 注意：只有「一只都不剩」才清表 —— 剩一只时留着，后面再出同名怪还要跟它配对
  };
  const jibanDrop = (e) => {
    if (!e || !e.def) return;
    const name = e.def.name || e.defId;
    const set = live.get(name);
    if (!set) return;
    set.delete(e);
    jibanRefresh(name);
  };

  // =============================================================================================================
  // 隐秘惊变（boss 专属，owner 2026-10-24）—— 只在「隐秘核心」前抽到，全部围绕 boss。
  // =============================================================================================================
  const HIDDEN_CARDS = Object.freeze({
    snap: 'ejibian_hidden_snap',            // 打个响指：所有盟约层数 -50%（Match 侧）
    absolute: 'ejibian_hidden_absolute',    // 绝对数值：boss 生命 +1000%、攻击 +100%
    song: 'ejibian_hidden_song',            // 甜美歌喉：每 15 s 全场干员吃 boss 30% 攻击的神经损伤
    sacrifice: 'ejibian_hidden_sacrifice',  // 献祭：玩家每 100 层盟约 → boss 生命 +1%
    purge: 'ejibian_hidden_purge',          // 诛伏赐死：所有玩家某个（同一个）盟约层数变 0（Match 侧）
    cannon: 'ejibian_hidden_cannon',        // 钢铁大炮：boss 防 +300%、攻 +200%、法抗 70
    dps: 'ejibian_hidden_dps',              // dps 检测器：每 50 s boss 回复 10% 最大生命
    puppet: 'ejibian_hidden_puppet',        // 傀儡把戏：血量降到 1% 时满血复活并强化（一次）
    random: 'ejibian_hidden_random',        // 脚填数值：boss 基础数值随机 50%–999%
  });

  /** 该玩家所有盟约层数之和（献祭用）。 */
  const totalLayers = () => {
    let n = 0;
    for (const ps of battle.players || []) {
      const bonds = (ps && ps.bonds) || {};
      for (const id of Object.keys(bonds)) n += Math.max(0, Number(bonds[id] && bonds[id].layers) || 0);
    }
    return n;
  };
  const liveBoss = () => (battle.enemies || []).find((e) => e && e.alive && isBoss(e)) || null;

  // 出怪结算（boss 出场时定数值）：priority 20，跑在原有 enemySpawn 之后，乘区才盖得住
  battle.on('enemySpawn', ({ enemy: e }) => {
    if (!e || !e.alive || !isBoss(e)) return;
    // 傀儡把戏换出来的新 boss：数值惊变不重复叠加（否则绝对数值 ×11 会再来一次）
    if (battle._puppetSpawning) return;
    if (has(HIDDEN_CARDS.absolute)) {
      passiveBuff(battle, e, P + 'hidden:absolute', { hpMul: 11, atkMul: 2 });
      battle.fx('grow', { x: e.x, y: e.y, id: e.id });
    }
    if (has(HIDDEN_CARDS.cannon)) {
      // 法抗「变为 70」= 直接定基础值（不是乘区）
      pinBase(e, { res: 70 });
      passiveBuff(battle, e, P + 'hidden:cannon', { defMul: 4, atkMul: 3 });
      battle.fx('grow', { x: e.x, y: e.y, id: e.id });
    }
    if (has(HIDDEN_CARDS.sacrifice)) {
      const mul = 1 + Math.floor(totalLayers() / 100) * 0.01;
      passiveBuff(battle, e, P + 'hidden:sacrifice', { hpMul: mul });
    }
    if (has(HIDDEN_CARDS.random)) {
      const m = battle.rng.range(0.5, 9.99);
      passiveBuff(battle, e, P + 'hidden:random', { hpMul: m, atkMul: m, defMul: m });
      battle.fx('grow', { x: e.x, y: e.y, id: e.id });
    }
  }, { priority: 20 });

  // 甜美歌喉：每 15 游戏秒，全场干员吃一次神经损伤（数值按当前 boss 攻击的 30%）
  if (has(HIDDEN_CARDS.song)) {
    battle.every(15, () => {
      const boss = liveBoss();
      if (!boss) return;
      const amount = (Number(boss.s && boss.s.atk) || 0) * 0.3;
      if (!(amount > 0)) return;
      for (const op of battle.allyUnits || []) {
        if (!op || !op.alive || op.side !== 'ally' || op.kind !== 'op') continue;
        try { applyElement(battle, boss, op, { element: 'neural', amount, mul: 1, type: 'element' }); } catch { /* 目标离场 */ }
      }
    });
  }

  // dps 检测器：每 50 游戏秒，boss 回复 10% 最大生命
  if (has(HIDDEN_CARDS.dps)) {
    battle.every(50, () => {
      const boss = liveBoss();
      if (!boss) return;
      // ★ 2026-10-24：共享血池的 boss 由 Match 侧统一回血（battle._syncBossHp 每跳都会按血池覆盖单位血量，
      //   在这里 heal 下一帧就被抹掉，表现就是完全不回血）。无血池的普通场景仍走本地治疗。
      if (boss.bossPool) return;
      const heal = (Number(boss.s && boss.s.maxHp) || 0) * 0.1;
      if (heal > 0) battle.heal(boss, boss, heal, { self: true, tags: ['ejibian'] });
    });
  }

  // 傀儡把戏：血量掉到 1% 及以下 → 立刻换成另一只随机 boss 并恢复满血（一次）。
  //   ★ 2026-10-24 新引擎做法：真正 spawn 一只新 boss（同位置、继承血池），旧 boss 静默移除
  //   （不走 death / leak，避免被当成"boss 被击杀"结算）；换 boss 期间给 battle 打标记，
  //   让本文件自己的 boss 数值惊变（绝对数值 / 钢铁大炮 / 脚填数值 …）不要给新 boss 再叠一次。
  if (has(HIDDEN_CARDS.puppet)) {
    const swapBoss = (target) => {
      // 候选领袖：优先用 Match 随 flags 下发的完整表（战场数据可能被裁剪到"本场用到的敌人"）
      const raw = (battle.data && battle.data.raw && battle.data.raw.enemies) || {};
      const all = (battle.flags && Array.isArray(battle.flags.bossKeys) && battle.flags.bossKeys.length)
        ? battle.flags.bossKeys
        : Object.keys(raw).filter((k) => raw[k] && String(raw[k].rank || '').toUpperCase() === 'BOSS');
      const skip = new Set([target.defId, target.def && target.def.key, target.name]);
      const keys = all.filter((k) => !skip.has(k) && !skip.has('enemy_' + k));
      if (!keys.length) return false;
      const key = keys[Math.floor(battle.rng() * keys.length)];
      const pool = target.bossPool || null;
      const pos = [target.y, target.x];
      battle._puppetSpawning = true;
      let nb = null;
      try { nb = battle.spawnEnemy(key, { pos, tag: 'boss', mods: target.mods || undefined }); } finally { battle._puppetSpawning = false; }
      if (!nb) return false;
      if (pool) {
        nb.bossPool = pool;
        // ★ 共享血池：这刀伤害的记账可能在本回调之后才落账，所以回满要做两次（立即 + 下一帧补一次），
        //   否则血池会被本跳的扣血再拉回 1%。
        pool.hp = pool.maxHp;
        if (nb.base) { nb.base.maxHp = pool.maxHp; nb.markDirty(); }
        nb.hp = nb.s ? nb.s.maxHp : nb.hp;
      }
      // 静默移除旧 boss：不触发 death / leak，也不让它再被同步/计数
      target.alive = false;
      target.hp = 0;
      target.bossPool = null;
      battle.enemies = (battle.enemies || []).filter((x) => x !== target);
      battle.units = (battle.units || []).filter((x) => x !== target);
      battle._enemiesDirty = true;
      battle.fx('appear', { x: nb.x, y: nb.y, id: nb.id });
      return true;
    };
    let puppetUsed = false;
    battle.on('damaged', ({ target }) => {
      if (puppetUsed || !target || !target.alive || !isBoss(target)) return;
      const max = Number(target.s && target.s.maxHp) || 0;
      if (!(max > 0) || target.hp / max > 0.01) return;
      puppetUsed = true;
      const poolRef = target.bossPool || null;
      // 换 boss（等这一跳伤害的账记完），随后把共享血池补满 —— 这几个 after 全部注册在外层，
      //   不嵌套在另一个 after 里（嵌套注册会在外层回调结束时被一起清掉）。
      battle.after(0, () => { if (!swapBoss(target)) puppetUsed = false; });
      const fill = () => {
        if (!poolRef || !(poolRef.maxHp > 0)) return;
        poolRef.hp = poolRef.maxHp;
        const nb = (battle.enemies || []).find((x) => x && x.alive && isBoss(x));
        if (!nb) return;
        if (nb.base) { nb.base.maxHp = poolRef.maxHp; nb.markDirty(); }
        nb.hp = nb.s ? nb.s.maxHp : nb.hp;
      };
      battle.after(0.05, fill);
      battle.after(0.3, fill);
      battle.after(0.8, fill);
    });
  }
  // ---------------------------------------------------------------------------------------------------------------
  // 出怪结算：priority 10 —— 在 enemies.js(100) / bosses.js(90) 的建怪之后跑，数值才盖得住
  // ---------------------------------------------------------------------------------------------------------------
  battle.on('enemySpawn', ({ enemy: e }) => {
    if (!e || !e.def) return;
    const boss = isBoss(e);

    // 真的假的（0.1%）：先摇，摇中就定值 1 并跳过其它数值惊变（否则 20%/40% 的乘区会把它乘回去）
    if (has('ejibian_zhendejiade') && battle.rng.chance(0.001)) {
      mem(e).ejibianFx = 'rainbow';
      pinBase(e, { atk: 1, def: 1, maxHp: 1 });
      battle.fx('appear', { x: e.x, y: e.y, id: e.id, jibianFx: 'rainbow' });
      return;
    }

    // 斗蛐蛐（10%）：复刻我方随机单位的数值（先复刻再吃下面的百分比，和「复刻的是我方面板」一致）
    if (has('ejibian_douququ') && battle.rng.chance(0.1)) {
      const pool = (battle.allyUnits || []).filter((u) => u.alive && u.s);
      const src = pool.length ? battle.rng.pick(pool) : null;
      if (src) {
        mem(e).ejibianFx = 'golden';
        mem(e).ejibianCopy = { uid: src.id, name: src.def && src.def.name };
        pinBase(e, { atk: src.s.atk, def: src.s.def, maxHp: src.s.maxHp, res: src.s.res, aspd: src.s.aspd, bat: src.s.bat });
        battle.fx('goldenCopy', { x: e.x, y: e.y, id: e.id, src: src.id });   // 2026-10-17：金色特效（原 'copy' 是紫色通用）
      }
    }

    // 强强 / 量变→质变 / 质变→量变：三项基础数值
    if (has('ejibian_qiangqiang')) { triple(battle, e, 'qiangqiang', 1.2); battle.fx('grow', { x: e.x, y: e.y, id: e.id }); }
    if (has('ejibian_liangbianzhibian')) triple(battle, e, 'liangbianzhibian', 0.4);
    // 2026-10-17（用户：质变→量变的数值增强从 40% 改成 30%）—— 原来写 1.32（名义 +40% 的旧值）。
    if (has('ejibian_zhibianliangbian')) triple(battle, e, 'zhibianliangbian', 1.30);

    // 搞定他们的头儿：领袖生命 −50%（领袖的血量池由 Match 记账，这里改的是战场上这只的血条），道中 +30%
    if (has('ejibian_gaodingtouer')) {
      if (boss) passiveBuff(battle, e, P + 'gaodingtouer:boss', { hpMul: 0.5 });
      else triple(battle, e, 'gaodingtouer:normal', 1.3);
    }

    // 急行军 / 先发制人 / 神威难藏泪
    if (has('ejibian_jixingjun')) passiveBuff(battle, e, P + 'jixingjun', { moveMul: 1.4 });
    if (has('ejibian_xianfazhiren')) passiveBuff(battle, e, P + 'xianfazhiren', { aspd: 90 });
    if (has('ejibian_shenweinancanglei')) passiveBuff(battle, e, P + 'shenweinancanglei', { dodgePhys: 0.1, dodgeArts: 0.1 });

    // 通行证：两层次数盾（damage.js 的 absorbShields 认 shieldHits —— 一层吃掉一整次伤害）
    if (has('ejibian_tongxingzheng')) {
      battle.addBuff(e, { key: P + 'tongxingzheng', shieldHits: 2, persist: true, allowDead: true, refresh: 'replace' });
      battle.fx('shield', { x: e.x, y: e.y, id: e.id });
    }

    // 龙刃：领袖不受影响；其余近战伤害 +200%，本来就远程的直接失去远程攻击能力（flags.disarm：ai.js 不再起手）
    if (has('ejibian_longren') && !boss) {
      passiveBuff(battle, e, P + 'longren', { dmgDealtMul: 3 });
      if (isRanged(e) && canAttack(e)) passiveBuff(battle, e, P + 'longren:meleeOnly', {}, { flags: { disarm: true } });
    }

    // 羁绊：登记进同名表，凑够两只就一起加
    if (has('ejibian_jiban')) {
      const name = e.def.name || e.defId;
      if (!live.has(name)) live.set(name, new Set());
      live.get(name).add(e);
      jibanRefresh(name);
    }

    // 异戒神将：每次受到攻击 → 伤害减免 +0.25%（上限 90%）
    if (adaptInit) adaptInit(e);
  }, { priority: 10 });

  // ---------------------------------------------------------------------------------------------------------------
  // 异戒神将（传说，owner 2026-10-16；2026-10-20 改为每次 0.025%）：「敌人获得效果：每次受到攻击增加对应
  // 伤害减免 0.025%，上限 90%。」
  //
  // 口径（按牌面 + 与 owner 确认的实现方式）：
  //   · 计数点 = `damaged`（damage.js 每**结算一次伤害**派发一次）—— 与「受到攻击」同义；MISS / 闪避 /
  //     被次数盾吃掉的那次不算（没有结算伤害）。
  //   · 减免是**乘区**：`dmgTakenMul`。第 n 次结算后总额 = 1/(1+0.0025n)，n 次各自恰好是"再 +0.25%"，
  //     n = 360 时 = 1/1.9 ≈ 0.526 ⇒ 减免 47.4%…不等 —— **不是**线性 0.9。
  //     所以按"每次 +0.25%、上限 90%"直译成绝对值：**减免 = min(0.9, 0.0025n)**，
  //     即 `dmgTakenMul = 1 − min(0.9, 0.0025n)`（n = 360 次时正好 90% 封顶，之后不再涨）。
  //   · 只在**同一只怪**自己身上累计（每只敌人都有一套，牌面写的是"敌人获得效果"）。
  //   · 叠满 90% 的那一刻派发 fx `adapt`（客户端画个标记）+ 置 `battle.yijieAdapted`，
  //     Match 层读这个标记播报「注意！有敌人适应了你的攻击」并放 owner 给的那段音频。
  // ---------------------------------------------------------------------------------------------------------------
  if (has('ejibian_yijieshenjiang')) {
    const KEY = P + 'yijieshenjiang';
    const HITS_FULL = 3600;                // 0.025% × 3600 = 90%（上限）
    const initAdapt = (e) => {
      if (!e || !e.def) return;
      mem(e).yijieHits = 0;
      passiveBuff(battle, e, KEY, { dmgTakenMul: 1 });
    };
    adaptInit = initAdapt;                 // 让 enemySpawn 回调调用（它定义在上面）
    battle.on('damaged', ({ target }) => {
      if (!target || target.side !== 'enemy' || !target.alive) return;
      const m = mem(target);
      const n = (m.yijieHits = (Number(m.yijieHits) || 0) + 1);
      const cut = Math.min(0.9, 0.00025 * n);
      const buff = target.findBuff && target.findBuff(KEY);
      if (buff && buff.mods) buff.mods.dmgTakenMul = Math.max(0.1, 1 - cut);
      if (typeof target.markDirty === 'function') target.markDirty();
      if (n === HITS_FULL) {
        battle.yijieAdapted = true;        // Match 层读它去播报（见 match/combat.js）
        battle.fx('adapt', { x: target.x, y: target.y, id: target.id });
      }
    }, { priority: 10 });
  }

  if (has('ejibian_jiban')) {
    battle.on('death', ({ unit }) => jibanDrop(unit), { priority: 10 });
    battle.on('enemyLeak', ({ enemy }) => jibanDrop(enemy), { priority: 10 });
  }
}

/** 敌方惊变只在 炸惊模拟 里抽（其余模式池子为空），所以这里不做模式判断 —— 有卡才有事发生。 */
export function registerMeta() { /* 敌方惊变没有 prep 侧效果 */ }

// ---------------------------------------------------------------------------------------------------------------
// Match 侧：出怪表 / 波次（本文件只算，改写落在 match/waves.js 的 templateSpawns 与 bands/meta.js 的 duckGlobal）
//
// 抽到的卡在 Match.enemyJibianCards 里只增不减，所以「每回合」= 抽到之后的每一轮；Match 在 startRound 里用
// matchJibianPlan 算一份本轮的计划，两个 boss 半场共用（同一轮两个半场必须换得一样），再交给 buildNormalWave /
// buildBossWave → templateSpawns：
//   * 量变→质变 ejibian_liangbianzhibian  出怪量 ×1.4（叠在规则8 的 ×1.2 之上；数值 −60% 在战场侧）
//   * 质变→量变 ejibian_zhibianliangbian  出怪量 ×0.8（同上；数值 +40% 在战场侧）
//   * 强行顶吗   ejibian_qiangxingdingma  所有怪同一时间进场（spawns 的 time 压到最早一个、interval 归零）
//   * 入职测试   ejibian_ruzhiceshi       每回合 15% 概率把这一轮的小怪全换成源石虫
//   * 谁选的鸭爵？？ ejibian_yajue         第 7/8 回合把盟约「神秘顾客」的替换概率拉满（jibianDuckParams）
// 15% 的摇号走 rng.state() 派生的独立流（和 setupMatchWaves 的 schedule 流同一个套路），既不消耗本轮的波次随机数，
// 也让同一个 round 每次摇出同一个答案。

/** Match 侧惊变的卡 id（= 抽卡用的 effectId）。 */
export const MATCH_CARDS = Object.freeze({
  countUp: 'ejibian_liangbianzhibian',   // 量变→质变
  countDown: 'ejibian_zhibianliangbian', // 质变→量变
  sameTime: 'ejibian_qiangxingdingma',   // 强行顶吗
  slime: 'ejibian_ruzhiceshi',           // 入职测试
  duck: 'ejibian_yajue',                 // 谁选的鸭爵？？
  horde: 'ejibian_jiangshiweicheng',      // 丧尸围城（owner 2026-10-24）：出怪量 +100%
});

/** 源石虫（入职测试把小怪换成它；enemies.json 的基础款）。 */
export const SLIME_KEY = 'enemy_1007_slime';
/** 入职测试每回合的触发概率（牌面「15% 的概率」）。 */
export const RUZHI_CHANCE = 0.15;
/**
 * 入职测试把小怪换成【几只】源石虫（牌面「使所有小怪变成 100 只加强版源石虫」）。
 * ★ 2026-10-15 修正：原来只是把 key 换掉、数量保持原样，玩家实测「生成数不是 100」，与牌面不符。
 * 现在按【这一轮可替换小怪的总数】折算成恰好 100 只（最大余数法，每组至少 1）。
 */
export const RUZHI_SLIME_TOTAL = 100;
/** 出怪量乘区（牌面「增加 40%」/「减少 40%」——后者 2026-10-17 用户从 20% 改成 40%）。 */
export const LIANGBIAN_COUNT_MUL = 1.4;
export const ZHIBIAN_COUNT_MUL = 0.6;
/** 丧尸围城（传奇，owner 2026-10-24）：出怪量 +100% ⇒ ×2，与量变/质变的乘区相乘。 */
export const HORDE_COUNT_MUL = 2;
/** 鸭爵「神秘顾客」被拉满的回合（牌面「第 7.8 回合时」）。 */
export const YAJUE_ROUNDS = Object.freeze([7, 8]);
/**
 * 天堂制造（稀有，owner 2026-10-16）：战斗阶段 −40s。数值是**游戏秒**（= 客户端倒计时看到的 20 个真实秒，
 * 因为战斗按 2× 速度推进且 `combatTimeLimit = real × combatTimeScale`）。
 * `HEAVEN_MIN_LIMIT_GAME_S`：时限的下限 —— 第 1/2 轮只有 130 游戏秒、第 3~5 轮 150，减 80 会只剩 50~70，
 * 连出怪都排不下；给个保底让这张卡"很难"而不是"没法打"。
 */
export const HEAVEN_CUT_GAME_S = 80;
export const HEAVEN_MIN_LIMIT_GAME_S = 20;

/** 卡 id 集合（Set / 数组 / 单张卡的字符串都收）。 */
function cardSet(cards) {
  if (cards instanceof Set) return cards;
  const list = Array.isArray(cards) ? cards : cards ? [cards] : [];
  return new Set(list.filter((x) => typeof x === 'string' && x));
}

/**
 * 一轮抽签（0..1）。同一个 rng 状态 + 同一个 round ⇒ 同一个结果：摇号流由 `rng.state()` 派生，不动主流的随机数序列，
 * 所以两个半场 / 预览与实际战斗不会摇出两个答案。没有 rng 时返回 1（不触发，保守）。
 */
export function jibianRoll(rng, round, tag = 'ruzhiceshi') {
  const seed = rng && typeof rng.state === 'function' ? deriveSeed(rng.state(), `jibian:${tag}:${round}`) : null;
  const r = seed == null ? (typeof rng === 'function' ? rng : null) : createRng(seed);
  return r ? r() : 1;
}

/**
 * 本轮匹配「天堂制造」(ejibian_tiantangzhizao) 的战斗时限（游戏秒）。
 * 没这张卡 = 原值；有 = 减 80 游戏秒（= 牌面「战斗阶段 −40s」），并不低于保底。
 * @param {{ flags?: { enemyJibian?: any } }} battle
 * @param {number} base 原时限（游戏秒）
 */
export function heavenTimeLimit(battle, base) {
  const b = Number(base);
  if (!Number.isFinite(b) || b <= 0) return base;
  if (!cardsOf(battle).has('ejibian_tiantangzhizao')) return b;
  return Math.max(HEAVEN_MIN_LIMIT_GAME_S, b - HEAVEN_CUT_GAME_S);
}

/**
 * 本轮 Match 侧的出怪改动（null = 没有要改的，waves.js 走原来的路）。
 * @param {Function|null} rng 波次随机数流（Match.rngWaves）
 * @param {number} round 本轮回合数
 * @param {Set<string>|string[]|null} cards Match.enemyJibianCards
 * @returns {null | { countMul: number, sameTime: boolean, slime: boolean }}
 */
export function matchJibianPlan(rng, round, cards) {
  const has = cardSet(cards);
  if (!has.size) return null;
  const countMul = (has.has(MATCH_CARDS.countUp) ? LIANGBIAN_COUNT_MUL : 1)
    * (has.has(MATCH_CARDS.countDown) ? ZHIBIAN_COUNT_MUL : 1)
    * (has.has(MATCH_CARDS.horde) ? HORDE_COUNT_MUL : 1);
  const sameTime = has.has(MATCH_CARDS.sameTime);
  const slime = has.has(MATCH_CARDS.slime) && jibianRoll(rng, round) < RUZHI_CHANCE;
  if (countMul === 1 && !sameTime && !slime) return null;
  return { countMul, sameTime, slime };
}

/**
 * 鸭爵「神秘顾客」的参数调整：第 7/8 回合且场上有这张惊变时，替换「概率」拉满 —— 权重窗口放到整轮（minweight 0 →
 * maxweight 1，官方是 0.6–0.99 的窗口），替换数取满（min = max = 上限，官方 0–2）。
 * [ASSUMED] 牌面只说「概率提升至 100%」：官方 bb 里称得上「概率」的只有 minweight/maxweight 这一段（PRTS 备注
 * 「每回合将有 0~2 名敌人被替换」），拉满即整轮都是候选、且必定换满上限只数。盟约本身没被选就什么都不会发生
 * （duckGlobal 先查 `held`）。
 * @param {object} p 官方 bb 参数（content/bands/meta.js duckParams()）
 * @param {{ round: number, cards: Set<string>|string[]|null }} opts
 */
export function jibianDuckParams(p, { round, cards } = {}) {
  if (!p) return p;
  if (!YAJUE_ROUNDS.includes(round)) return p;
  if (!cardSet(cards).has(MATCH_CARDS.duck)) return p;
  const lo = Math.max(0, Math.floor(Number(p.min) || 0));
  const hi = Math.max(lo, Math.floor(Number(p.max) || lo));
  // ★ 2026-10-13（用户）：不是"换满上限"（官方上限只有 2 ✗，所以第 7/8 回合也最多换 2 只 ✗），
  //   而是【换掉全部候选】—— `replaceAll` 由 duckReplace 读取（候选定义不变：非领袖 / 非飞行 / 非器物 / 未换过）。
  return { ...p, min: hi, max: hi, minweight: 0, maxweight: 1, replaceAll: true };
}

/**
 * 隐秘惊变的 **Match 侧**结算（抽到即发生，作用于玩家的盟约层数）：
 *   · 打个响指：所有玩家的所有盟约层数 ×0.5（向下取整）
 *   · 诛伏赐死：选一个「总和最高」的盟约，把所有玩家在该盟约上的层数清零（全场同一个）
 * @param {any} match @param {string[]} ids 抽到的卡 id
 */
export function applyHiddenMatchCards(match, ids) {
  if (!match || !Array.isArray(ids) || !ids.length) return;
  const set = new Set(ids);
  const players = match.players ? [...match.players.values()] : [];
  if (set.has('ejibian_hidden_snap')) {
    for (const ps of players) {
      if (!ps || !ps.layers) continue;
      for (const id of Object.keys(ps.layers)) {
        const v = Math.max(0, Math.floor((Number(ps.layers[id]) || 0) * 0.5));
        try { ps.setLayers(id, v, { reason: 'ejibian' }); } catch { ps.layers[id] = v; }
      }
    }
  }
  if (set.has('ejibian_hidden_purge')) {
    const totals = new Map();
    for (const ps of players) {
      for (const [id, v] of Object.entries((ps && ps.layers) || {})) totals.set(id, (totals.get(id) || 0) + Math.max(0, Number(v) || 0));
    }
    // ★ 2026-10-24（owner）：「某个盟约」改为**随机抽一个**（原来取全场总和最高的，太恶心）。
    //   仍然全场同一个盟约；候选只取场上真的有人持有的（总和 > 0）。
    //   用 deriveSeed(seed, 'hiddenPurge') 的独立随机流：不消耗 rngDraft / rngWaves，同一 seed 可复现。
    const candidates = [...totals.entries()].filter(([, v]) => v > 0).map(([id]) => id).sort();
    if (candidates.length) {
      const rng = match._purgeRng || (match._purgeRng = createRng(deriveSeed(Number.isFinite(match.seed) ? match.seed : 1, 'hiddenPurge')));
      const r = typeof rng === 'function' ? rng() : Math.random();
      const idx = Math.min(candidates.length - 1, Math.floor(Math.max(0, Math.min(0.999999, Number(r) || 0)) * candidates.length));
      const pick = candidates[idx];
      if (pick) {
        for (const ps of players) {
          if (!ps || !ps.layers || !(Number(ps.layers[pick]) > 0)) continue;
          try { ps.setLayers(pick, 0, { reason: 'ejibian' }); } catch { ps.layers[pick] = 0; }
        }
      }
    }
  }
}
