// 湮灭专属数据视图；其他玩法继续使用 gamedata.js。
import { GameData } from './gamedata.js';
import { EROSION_MAX, EROSION_ENDLESS } from '../../shared/annihilation-constants.js';
const numOr=(v,d)=>typeof v==='number'&&Number.isFinite(v)?v:d;
const posIntOr=(v,d)=>Number.isInteger(v)&&v>0?v:d;
const DEFAULTS={equipPerChess:2,bans:{},bossWeights:[]};
const EROSION_ATK_EXP = [1, 2, 2, 3, 3, 3, 4, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21];
const EROSION_HP_EXP_COOP = [1, 2, 2, 3, 4, 4, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21];
/**
 * 第 30 回合之后（表尾之后）的指数：接着表尾的 21，**每 2 个回合 +1**，没有上限 ——
 *
 *   第 31、32 回合  e = 22     第 33、34 回合  e = 23     第 35、36 回合  e = 24   …
 *
 * 也就是「第一第二回合 1.2^n、第三第四回合 1.2^(n+1)」这条规律从表尾继续往下排；无尽档靠它无限延伸。
 * @param {number} i 回合 - 1
 */
const erosionTailExponent = (i) => EROSION_ATK_EXP[EROSION_ATK_EXP.length - 1] + Math.floor((i - EROSION_ATK_EXP.length) / 2) + 1;

/**
 * 湮灭蚀流第 `round` 回合的敌方指数 e：攻击力 1.2^e，生命 独立 1.25^e / 同盟 1.3^e。
 * 第 1~30 回合读原表（`EROSION_ATK_EXP` / `EROSION_HP_EXP_COOP`），之后交给 erosionTailExponent。
 * @param {number} round
 * @param {boolean} [coop] 同盟（1.3 的那张表）
 * @returns {number}
 */
export const erosionExponent = (round, coop = false) => {
  const i = Math.max(0, Math.floor((Number(round) || 1) - 1));
  // 独立模式的生命指数与攻击指数同表（截图里两者一致）
  const table = coop ? EROSION_HP_EXP_COOP : EROSION_ATK_EXP;
  return i < table.length ? table[i] : erosionTailExponent(i);
};

// 蚀流 6 = 无尽湮灭: the endless ladder (EROSION_MAX / EROSION_ENDLESS live in shared/constants.js — the client's
// protocol bound and the lobby read the same numbers); re-exported here for the match code.
export { EROSION_MAX, EROSION_ENDLESS };
/**
 * 无尽湮灭: after R30 (the last round of the 蚀流 5 table) the boss / hidden-core queue stops following the fixed
 * 5-round cadence and turns into "every 3rd round a Final Assault, its Hidden Core right behind it".
 */
/** 无尽湮灭: every 3rd round one boss + hidden-core pair (R33/34, R36/37, R39/40 …). */
const ENDLESS_BOSS_EVERY = 3;
/** 无尽湮灭: how far ahead the pair table is materialised (the run itself is unbounded; see isLastHidden). */
const ENDLESS_PAIR_HORIZON = 600;
/** 无尽湮灭: the rounds the pre-endless schedule already knows (蚀流 5), kept as they are. */
const ENDLESS_BASE_PAIRS = Object.freeze([[14, 15], [19, 20], [24, 25], [29, 30]]);
/**
 * 无尽湮灭: the decision (决策 / 机变) rounds. Up to R29 the mode's own rule stands (every even round), after it a
 * decision opens every 4th round (R32, R36, R40 …) — the round a decision is offered AT is the odd round after it.
 */
const ENDLESS_DECISION_UNTIL = 29;
const ENDLESS_DECISION_EVERY = 4;
/** 无尽湮灭: the decisions that hand out a random positive relic — R8 … R28, then every 4th round (R32, R36 …). */
const ENDLESS_RELIC_DECISIONS_UNTIL = 28;
const ENDLESS_RELIC_UNTIL_EVERY = 4;
/** 无尽湮灭: +20 % per decision once the relic catalogue is exhausted (ally ATK/HP, enemy HP/ATK/DEF). */
export const ENDLESS_ESCALATION_STEP = 0.2;


export class AnnihilationGameData extends GameData {
 constructor(data,modeId,opts={}) {
  super(data,modeId);
  this.erosion=Number.isInteger(opts.erosion)&&opts.erosion>=1&&opts.erosion<=EROSION_MAX?opts.erosion:1;
  this.config={...this.config,...Object.fromEntries(Object.keys(this.config).filter(k=>k!=='modes'&&Object.hasOwn(this.mode,k)).map(k=>[k,this.mode[k]]))};
  this.economy=this.config.economy||{};
 }
get equipPerChess() {
    if (this.endless) return Infinity;
    return posIntOr(this.economy.equipPerChess, DEFAULTS.equipPerChess);
  }
get unlimitedLayers() { return this.endless; }
get generation() {
    const g = this.mode.generation && typeof this.mode.generation === 'object' ? this.mode.generation : {};
    if (this.mode.difficulty !== 'ANNIHILATION') return g;
    // 无尽湮灭: 怪物种类增加至所有怪物种类 — every randomizable type, every round
    if (this.endless) {
      const types = this.factions && this.factions.types && typeof this.factions.types === 'object' ? this.factions.types : {};
      const all = Object.values(types).filter((t) => t && t.involveRandom).length;
      return { ...g, maxLevelCnt: 30, specialEnemyNum: Math.max(1, all) };
    }
    return { ...g, maxLevelCnt: this.erosion >= 5 ? 30 : 20, specialEnemyNum: this.erosion >= 5 ? 5 : 4 };
  }
get annihilation() {
    const a = this.mode.annihilation && typeof this.mode.annihilation === 'object' ? this.mode.annihilation : null;
    if (!a) return null;
    const fog = a.fog && typeof a.fog === 'object' ? a.fog : null;
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
    return {
      fog: fog ? {
        afterReal: 30, // 毒雾统一在战斗开始 30 秒后升起
        rampReal: num(fog.rampReal, 20),
        maxRatio: Math.min(1, num(fog.maxRatio, 0.2)),
      } : null,
      terrainLethal: num(a.terrainLethal, 1),
      chaosTargeting: a.chaosTargeting === true,
    };
  }
annihilationFlags(kind, round) {
    const a = this.annihilation;
    if (!a) return null;
    const out = { terrainLethal: a.terrainLethal, chaosTargeting: a.chaosTargeting };
    // 无尽湮灭: 战场不再释放毒雾 — no fog anywhere, whatever the kind or the round
    const fogOff = this.endless || kind === 'boss' || kind === 'hidden' || Number(round) >= this.bossRound;
    if (a.fog && !fogOff) {
      out.fog = {
        at: a.fog.afterReal * this.combatTimeScale,
        ramp: a.fog.rampReal * this.combatTimeScale,
        ratio: a.fog.maxRatio,
        targets: 'all', // 敌方单位同样受到毒雾伤害
      };
    }
    return out;
  }
get endless() { return this.mode.difficulty === 'ANNIHILATION' && this.erosion >= EROSION_ENDLESS; }
get lastRound() {
    if (this.testEndless) return null;
    if (this.endless) return null;
    if (this.mode.difficulty === 'ANNIHILATION' && this.erosion >= 5) return 30;
    if (Number.isInteger(this.mode.lastRound) && this.mode.lastRound > 0) return this.mode.lastRound;
    return this.modeId === 'mode_single_funny' ? 9 : 14;
  }
get bossRound() {
    // 测试模拟 (non-endless modes): no automatic Final Assault — the workbench adds the boss it wants to test
    if (this.testEndless && !this.endless) return null;
    // 无尽湮灭: there is no final assault to announce — the view publishes the round's own pair (bossRoundFor)
    if (this.endless) return ENDLESS_BASE_PAIRS[0][0];
    if (this.mode.difficulty === 'ANNIHILATION' && this.erosion >= 5) return 29;
    return Number.isInteger(this.mode.bossRound) && this.mode.bossRound > 0 ? this.mode.bossRound : this.lastRound;
  }
get hiddenRound() {
    if (this.testEndless && !this.endless) return null;
    if (this.endless) return ENDLESS_BASE_PAIRS[0][1];
    if (this.mode.difficulty === 'ANNIHILATION' && this.erosion >= 5) return 30;
    return Number.isInteger(this.mode.hiddenRound) && this.mode.hiddenRound > 0 ? this.mode.hiddenRound : null;
  }
bossHiddenPairs() {
    if (this.testEndless && !this.endless) return [];
    if (this.mode.difficulty === 'ANNIHILATION' && this.endless) return this._endlessPairs();
    if (this.mode.difficulty !== 'ANNIHILATION') return this.bossRound && this.hiddenRound ? [[this.bossRound, this.hiddenRound]] : [];
    if (this.erosion >= 5) return [[14, 15], [19, 20], [24, 25], [29, 30]];
    if (this.erosion >= 3) return [[14, 15], [19, 20]];
    return this.bossRound && this.hiddenRound ? [[this.bossRound, this.hiddenRound]] : [[19, 20]];
  }
_endlessPairs() {
    if (this._pairs) return this._pairs;
    const out = ENDLESS_BASE_PAIRS.map((p) => p.slice());
    // "30回合后每经过3个回合出boss、隐秘核心": R30 is the last hidden core of 蚀流 5, so the next Final Assault is R33
    // (its Hidden Core R34), then R36/37, R39/40 …
    const lastHidden = ENDLESS_BASE_PAIRS[ENDLESS_BASE_PAIRS.length - 1][1];
    for (let b = lastHidden + ENDLESS_BOSS_EVERY; b <= ENDLESS_PAIR_HORIZON; b += ENDLESS_BOSS_EVERY) out.push([b, b + 1]);
    this._pairs = out;
    return out;
  }
bossRounds() { return this.bossHiddenPairs().map((p) => p[0]); }
hiddenRounds() { return this.bossHiddenPairs().map((p) => p[1]).filter((n) => Number.isInteger(n)); }
isBossRound(r) {
    const n = Number(r);
    if (this.endless && Number.isInteger(n) && n > 30) return n % ENDLESS_BOSS_EVERY === 0;
    return this.bossRounds().includes(n);
  }
isHiddenRound(r) {
    const n = Number(r);
    if (this.endless && Number.isInteger(n) && n > 30) return n >= 34 && (n - 1) % ENDLESS_BOSS_EVERY === 0;
    return this.hiddenRounds().includes(n);
  }
hiddenAfter(bossRound) {
    const n = Number(bossRound);
    if (this.endless && this.isBossRound(n)) return n + 1;
    const p = this.bossHiddenPairs().find((x) => x[0] === n);
    return p ? p[1] : null;
  }
nextBossRound(hiddenRound) {
    const n = Number(hiddenRound);
    if (this.endless && n > 30 && this.isHiddenRound(n)) return n - 1 + ENDLESS_BOSS_EVERY;
    const pairs = this.bossHiddenPairs();
    const i = pairs.findIndex((p) => p[1] === Number(hiddenRound));
    if (i >= 0 && pairs[i + 1]) return pairs[i + 1][0];
    // 无尽湮灭: past the materialised table the cadence continues arithmetically (hidden h → the boss of the next pair)
    if (this.endless && i >= 0) return Number(hiddenRound) - 1 + ENDLESS_BOSS_EVERY;
    return null;
  }
isLastHidden(r) {
    if (this.endless) return false;
    const h = this.hiddenRounds();
    return h.length > 0 && Number(r) === h[h.length - 1];
  }
pairOfRound(r) {
    const n = Number(r) || 0;
    if (this.endless && n > 30) {
      const boss = this.isHiddenRound(n) ? n - 1 : Math.max(33, Math.ceil(n / ENDLESS_BOSS_EVERY) * ENDLESS_BOSS_EVERY);
      return { boss, hidden: boss + 1 };
    }
    const pairs = this.bossHiddenPairs();
    for (const [boss, hidden] of pairs) {
      if (n === boss || n === hidden) return { boss, hidden };
      if (n < boss) return { boss, hidden };
    }
    const last = pairs[pairs.length - 1];
    if (!last) return null;
    return { boss: last[0], hidden: last[1] };
  }
bossRoundFor(r) { const p = this.pairOfRound(r); return p ? p.boss : this.bossRound; }
hiddenRoundFor(r) { const p = this.pairOfRound(r); return p ? p.hidden : this.hiddenRound; }
_allBossTemplates(rounds) {
    const a = rounds && rounds['19'] && rounds['19'].bossTemplates && typeof rounds['19'].bossTemplates === 'object' ? rounds['19'].bossTemplates : {};
    const b = rounds && rounds['20'] && rounds['20'].bossTemplates && typeof rounds['20'].bossTemplates === 'object' ? rounds['20'].bossTemplates : {};
    return { ...a, ...b };
  }
roundCfg(r) {
    const rounds = this.mode.rounds;
    const base = rounds && typeof rounds === 'object' && rounds[String(r)] && typeof rounds[String(r)] === 'object' ? rounds[String(r)] : null;
    // 测试模拟: past the mode's table, keep playing a rotating tail of its rounds (normal waves only — no auto boss)
    if (this.testEndless && !this.endless && !base && rounds && typeof rounds === 'object') {
      const keys = Object.keys(rounds).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
      if (!keys.length) return null;
      const tail = keys.slice(-5);
      const last = keys[keys.length - 1];
      const pick = tail[(Math.max(1, Number(r) || 1) - last - 1) % tail.length] || tail[0];
      const rec = rounds[String(pick)];
      return rec && typeof rec === 'object' ? { ...rec, bossTemplates: null, isBoss: false, isHidden: false } : null;
    }
    if (this.mode.difficulty !== 'ANNIHILATION' || !rounds || typeof rounds !== 'object') return base;
    const bossCfg = rounds['19'];
    const hiddenCfg = rounds['20'];
    const all = this.endless ? this._allBossTemplates(rounds) : null;
    if (this.isBossRound(r)) {
      if (this.endless && bossCfg) return { ...bossCfg, bossTemplates: all, isBoss: true, isHidden: false };
      if (r === 19) return bossCfg || base;
      if (bossCfg) return { ...bossCfg, isBoss: true, isHidden: false };
    }
    if (this.isHiddenRound(r)) {
      if (this.endless && hiddenCfg) return { ...hiddenCfg, bossTemplates: all, isBoss: true, isHidden: true };
      if (r === 20) return hiddenCfg || base;
      if (hiddenCfg) return { ...hiddenCfg, isBoss: true, isHidden: true };
    }
    // normal rounds from R21 on cycle the R14-R18 level set (蚀流 5), endlessly for 无尽湮灭
    if (this.erosion >= 5 && r >= 21) {
      const pick = rounds[String(14 + ((r - 21) % 5))] || rounds['16'];
      return { ...pick, bossTemplates: null, isBoss: false, isHidden: false, combatTimeLimit: 115, levelMaxPlayTime: 115, isSpPrepare: false };
    }
    return base;
  }
isSpRound(r) {
    const n = Number(r) || 0;
    if (this.mode.difficulty !== 'ANNIHILATION') {
      return (Array.isArray(this.mode.spRounds) ? this.mode.spRounds : []).includes(n);
    }
    if (n < 3 || n % 2 !== 1) return false;
    // 无尽湮灭: 决策 at R3,5,...,29, then at R33, R37, R41 … — one per ENDLESS_DECISION_EVERY rounds after the last even one
    // (a Final Assault or Hidden Core round keeps its decision: the draft feeds that very battle)
    if (this.endless) {
      if (n <= ENDLESS_DECISION_UNTIL) return true;
      return n > ENDLESS_DECISION_UNTIL + 1 && (n - ENDLESS_DECISION_UNTIL) % ENDLESS_DECISION_EVERY === 0;
    }
    if (this.isHiddenRound(n)) return false;
    return n < (this.hiddenRound || this.lastRound + 1);
  }
spRounds() {
    // 湮灭模拟/蚀流: a 决策 after every even round (2,4,...,28) — the SP draft opens on the following odd round
    if (this.mode.difficulty === 'ANNIHILATION') {
      if (this.endless) {
        const out = [];
        for (let r = 3; r <= ENDLESS_DECISION_UNTIL; r += 2) out.push(r);
        for (let r = ENDLESS_DECISION_UNTIL + ENDLESS_DECISION_EVERY; r <= ENDLESS_PAIR_HORIZON; r += ENDLESS_DECISION_EVERY) out.push(r);
        return out;
      }
      const end = this.hiddenRound || this.lastRound + 1;
      const out = [];
      for (let r = 3; r < end; r += 2) out.push(r);
      return out;
    }
    return Array.isArray(this.mode.spRounds) ? this.mode.spRounds.filter((n) => Number.isInteger(n)) : [];
  }
enemyScale(r) {
    if (this.mode.difficulty === 'ANNIHILATION') {
      const atkE = erosionExponent(r);
      const hpE = erosionExponent(r, !this.isSolo);
      const boost = this.erosion >= 3 ? 1.2 : 1;
      return {
        hpMul: Math.pow(this.isSolo ? 1.25 : 1.3, hpE) * boost,
        atkMul: Math.pow(1.2, atkE) * boost,
        speedMul: Number(r) >= 3 ? 1.15 : 1,
      };
    }
    return this.baseEnemyScale(r);
  }
bans(difficulty) {
    // 无尽湮灭: 所有盟约干员不禁用 — no bond is switched off, so no operator is banned either
    if (this.endless) return { core: 0, addon: 0 };
    // 湮灭蚀流: the ban counts follow the mode's actual eligible bond pool, not a fixed 5 / 7:
    //   蚀流 1–4  核心/附加各 ceil(total / 3)，最少 5
    //   蚀流 5    核心/附加各 ceil(total / 2)（余数进 1）
    // Only weight > 0 bonds active in the mode count, exactly like pool.js drawDisabledBonds.
    if (this.mode.difficulty === 'ANNIHILATION') {
      // "核心盟约总数" = the whole core catalogue (13); "附加盟约总数" = every add-on bond except 绝技 (suntShip),
      // i.e. 15 in the current build (the three weight-0 helper bonds 投资人/调和/协防干员 still count, 绝技 does not).
      // drawDisabledBonds samples from its own eligible pool, so the fraction and the draw agree.
      const core = this.bondIds.filter((id) => {
        const bond = this.bond(id);
        return !!(bond && bond.isCore);
      }).length;
      const addon = this.bondIds.filter((id) => {
        const bond = this.bond(id);
        return !!(bond && !bond.isCore && id !== 'suntShip');
      }).length;
      const divisor = this.erosion >= 5 ? 2 : 3;
      const count = (n) => Math.max(divisor === 3 ? 5 : 0, Math.ceil(n / divisor));
      return { core: count(core), addon: count(addon) };
    }
    const b = this.config.bans && this.config.bans[difficulty];
    const d = DEFAULTS.bans[difficulty] || { core: 0, addon: 0 };
    if (!b || typeof b !== 'object') return { ...d };
    return { core: Number.isInteger(b.core) && b.core >= 0 ? b.core : d.core, addon: Number.isInteger(b.addon) && b.addon >= 0 ? b.addon : d.addon };
  }
bossWeights(hidden = false) {
    if (this.endless) {
      const rounds = this.mode.rounds && typeof this.mode.rounds === 'object' ? this.mode.rounds : null;
      const ids = rounds ? Object.keys(this._allBossTemplates(rounds)) : [];
      const list = ids.filter((id) => this.boss(id));
      return list.map((id) => [id, 1]);
    }
    const w = hidden ? this.mode.hiddenBossWeights : this.mode.bossWeights;
    return w && typeof w === 'object' ? Object.entries(w).filter(([id, v]) => this.boss(id) && Number(v) > 0) : [];
  }
}
