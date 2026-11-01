// server/match/finalAssault.js — 最终攻势 (R14 / solo FUNNY R9) and 隐秘核心 (R15) helpers (DESIGN §6.1, research
// 00-INDEX §5, 06 §10).
//
//   * Merged LP: teamLp = Σ LP of the alive players at the start of the Final Assault (no cap); the Hidden Core
//     continues with what is left.
//   * Pairing: alive players by seat → (1,2), (3,4); an odd player is alone on its own field with the `_s` template
//     (solo modes always use `_s`). Field ids 'b1', 'b2'. In a pair the first player is the LEFT side, the second the
//     RIGHT side (the sim mirrors the right side: board col c → field col 20 − c with the piece direction RIGHT ↔
//     LEFT, UP / DOWN unchanged (DESIGN §3, research 09 §1.2 ConvertChessPositionInfoToBossMap); board rows 9–12 →
//     boss rows 2–5, sim/constants BOSS_ROW_OFFSET). `bossFieldPlacement` gives that mapping for UIs / tools.
//   * Shared boss HP pool (DESIGN §20.10, §25.13.4, gamedata.js bossPoolShareOf): one pool shared by every boss field
//     (official tip "所有人将一起对敌方领袖造成伤害"; notice 5114's "敌方领袖的总生命值不变" is about the mirrored copies of
//     a pair field sharing it) = bloodPoint[difficulty] × the players alive when the fight starts (bots and AI 托管 seats
//     count, eliminated and departed seats do not; solo × 1) — the owner's decision of 2026-10-06, adopting PR #209 by
//     @qingjingshenghuo, which replaces the fixed pool of 「保持固定血量」 (config bossHpScale perPlayer false / solo 0.25
//     restores it); × the tuning bossHpMul when data/tuning.json still has one (docs/BALANCE.md); bosses are never scaled
//     by enemyScale and their parts / escorts keep their own HP.
//   * Overtime: bossTurnHpReduceTime counts REAL seconds like the level's 120 s maxPlayTime (which runs out first; the
//     battle goes on): from 150 real s (300 game s on the 2× field clock) the team loses bossOvertimeDrainPerSec (1) LP
//     per real second (gamedata.js bossOvertimeDue); m.public.deadline = the 120 s countdown, m.public.overtimeAt = the
//     drain start. Minion / boss leaks cost their `lpr`; team LP 0 ⇒ defeat (all fields force-ended; PRTS 卫戍协议：盟约 下半
//     "…使目标生命值扣除至0，则无视倒计时直接失败"); pool 0 ⇒ victory. The first of the two the server registers decides
//     (Match._finalEnding): a report that arrives after the team LP ran out credits nothing (user playtest #6 item 5).
//   * Pool HP is a float that never keeps float dust: the hit that would leave less than BOSS_POOL_MIN_HP (1) takes the
//     rest, so the pool is 0 or ≥ 1 and a leader shown at 0 HP is down (sim/constants.js; the browser's LocalBossPool
//     follows the same rule, server/sim/spec.js). Before, the per-player crediting of a report could leave 3.6e-12 that
//     the browser could never deal (user playtest #6 item 5).
//   * No IN_BATTLE layer gains (flags.layerGainsEnabled = false).
//   * BOSS_HIT tickers (BOSS_HIT_STEPS 20 / 50 / 80 %): a player's damage to the round's pool (SharedBossPool.byPlayer)
//     over its size, each threshold once per boss round — the Hidden Core never counts the Final Assault's damage
//     (player report after 0.1.0: "隐藏boss还没打就出了造成50%伤害播报").
//   * Hidden Core eligibility (after an R14 win): difficulty in hiddenCore.difficulties, the mode has a hidden round,
//     Σ activated layers of the alive players measured at the end of the boss round's prep > threshold (solo 350 /
//     co-op 1200) and team LP > minTeamLpExclusive (1).

import { BOSS_ROW_OFFSET, COLS, BOSS_POOL_MIN_HP } from '../sim/constants.js';
import { mirrorDir, normDir } from '../sim/dir.js';
import { bossPoolShareOf } from './gamedata.js';

/**
 * BOSS_HIT ticker thresholds (activity_table autoChessData.broadcastList comment_boss_hit_1..3, paramList 0.2 / 0.5 /
 * 0.8: "{0}博士对敌方领袖造成的伤害超过20%!"): a player's damage to the current leader's pool over that pool
 * (SharedBossPool.byPlayer — one pool per boss round, so the Final Assault and the Hidden Core count apart).
 */
export const BOSS_HIT_STEPS = [0.2, 0.5, 0.8];

/**
 * Where a board piece (board row / col / dir) stands on a boss field for side 'L' | 'R' — the same mapping as the
 * sim (Battle.mapTile / mapDir): rows 9–12 → 2–5; the right side mirrored col c → 20 − c, RIGHT ↔ LEFT.
 * @returns {{ row: number, col: number, dir: 'UP'|'RIGHT'|'DOWN'|'LEFT' }}
 */
export function bossFieldPlacement(side, row, col, dir = 'RIGHT') {
  const d = normDir(dir);
  const r = row >= 7 ? row + BOSS_ROW_OFFSET : row;
  return side === 'R' ? { row: r, col: COLS - 1 - col, dir: mirrorDir(d) } : { row: r, col, dir: d };
}

/** Pair alive players by seat: [[a, b], [c, d]] / [[a, b], [c]] / [[a]]. */
export function pairPlayers(alive) {
  const sorted = alive.slice().sort((a, b) => a.seat - b.seat);
  const groups = [];
  for (let i = 0; i < sorted.length; i += 2) groups.push(sorted.slice(i, i + 2));
  return groups;
}

/**
 * Shared boss HP for a boss id with `aliveCount` alive players (GameData.bossPoolShare / bossPoolShareOf; omitted ⇒ a
 * full team). 炸惊模拟 规则3 raises the table value first (`gd.bossPoolHpMul`, ×5), so the per-player co-op share is
 * taken of the already-increased HP.
 *
 * 炸惊（用户 2026-10-11 定稿）不走上面那套：`mode.bossHpScale.baseHp` + `ladder` 直接给出「基础血量 × 人数阶梯」，
 * 见 bossLadderHp（基础 1000 万，每多一人 +150%，>4 人每人再 +200%，>10 人每人 ×2）。
 * @param {{ hidden?: boolean }} [opts] `hidden` = 隐秘核心（第 15 回合）的血量倍率（mode.hiddenBossHpMul，默认 2）
 */
export function bossPoolHp(gd, bossId, aliveCount, opts = {}) {
  const modeScale = gd && gd.mode && gd.mode.bossHpScale;
  const baseHp = modeScale ? Number(modeScale.baseHp) : NaN;
  // ★ 2026-10-23（owner）：隐秘核心的 Boss 血量单独翻倍（默认 ×2，可用 mode.hiddenBossHpMul 调）。
  const hiddenMul = opts && opts.hidden ? Math.max(0, Number((gd && gd.mode && gd.mode.hiddenBossHpMul) ?? 2) || 2) : 1;
  // ★ 2026-10-26（反馈：「敌方隐秘惊变改变血量后结算还是原血量」）：共享血池也必须吃敌方隐秘惊变的
  //   Boss 血量修正（目前是「搞定他们的头儿」−50%），否则结算/血条都按原血量。
  const ejMul = Array.isArray(opts && opts.enemyJibian) && opts.enemyJibian.includes('ejibian_gaodingtouer') ? 0.5 : 1;
  if (modeScale && modeScale.ladder && Number.isFinite(baseHp) && baseHp > 0) {
    return Math.max(1, Math.round(bossLadderHp(baseHp, modeScale.ladder, aliveCount) * hiddenMul * ejMul));
  }
  const boss = gd.boss(bossId);
  const diff = gd.difficulty;
  let base = boss && boss.bloodPoint && Number.isFinite(boss.bloodPoint[diff]) ? boss.bloodPoint[diff] : null;
  if (base == null && boss && boss.bloodPoint) base = Object.values(boss.bloodPoint).find((v) => Number.isFinite(v)) ?? null;
  if (base == null) base = 500000;
  const tune = typeof gd.bossHpMul === 'function' ? gd.bossHpMul(bossId) : 1;
  const modeMul = typeof gd.bossPoolHpMul === 'number' && gd.bossPoolHpMul > 0 ? gd.bossPoolHpMul : 1;
  const share = typeof gd.bossPoolShare === 'function' ? gd.bossPoolShare(aliveCount)
    : bossPoolShareOf(gd.mode && gd.mode.bossHpScale, gd.config && gd.config.bossHpScale, !!gd.isSolo, aliveCount);
  return Math.max(1, Math.round(base * modeMul * share * tune * hiddenMul * ejMul));
}

/**
 * 炸惊 boss 血量阶梯（用户 2026-10-11 定稿，2026-10-23 改）：基础 `baseHp`；联机每多一名玩家 +`perExtra`（1 = +100%），
 * 超过 4 人后每名再 +`after4`（1 = +100%），**不再有 10 人上限**（owner 2026-10-23「加算逻辑不变，但没有上限了」）；
 * `doubleAfter10` 仍可叠一个 10 人后的 ×2 指数（当前配置是 false）。
 * @param {number} baseHp @param {{ perExtra?: number, after4?: number, doubleAfter10?: boolean }} ladder
 * @param {number} aliveCount @returns {number}
 */
export function bossLadderHp(baseHp, ladder, aliveCount) {
  const n = Math.max(1, Math.min(100, Math.trunc(Number(aliveCount) || 1)));
  const per = Number(ladder && ladder.perExtra) || 0;
  const after4 = Number(ladder && ladder.after4) || 0;
  const lin = 1 + per * Math.max(0, Math.min(n, 4) - 1) + after4 * Math.max(0, n - 4);
  const exp = ladder && ladder.doubleAfter10 === false ? 1 : 2 ** Math.max(0, n - 10);
  return baseHp * lin * exp;
}

/**
 * The one HP pool every boss field damages. `damage(playerId, amount)` is called by the sim (server-run fields) and by
 * Match._creditBoss (client reports, per player); the hit that would leave less than BOSS_POOL_MIN_HP takes the rest.
 */
export class SharedBossPool {
  constructor(hp, { onHit = null } = {}) {
    this.maxHp = Math.max(1, hp);
    this.hp = this.maxHp;
    /** playerId → damage dealt to this pool (this boss round only; the BOSS_HIT tickers' share) */
    this.byPlayer = new Map();
    this.onHit = onHit;
  }

  damage(playerId, amount) {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0 || this.hp <= 0) return 0;
    const dealt = this.hp - a < BOSS_POOL_MIN_HP ? this.hp : a;
    this.hp -= dealt; // exactly 0 when the rest is taken (x − x): no float dust
    if (playerId != null) this.byPlayer.set(playerId, (this.byPlayer.get(playerId) || 0) + dealt);
    if (this.onHit) {
      try { this.onHit(playerId, dealt); } catch { /* reported by the caller */ }
    }
    return dealt;
  }
}

/**
 * Hidden-core eligibility.
 * @param {import('./gamedata.js').GameData} gd
 * @param {{ layerSum: number, teamLp: number }} s
 */
export function hiddenEligible(gd, { layerSum, teamLp }) {
  const hc = gd.hiddenCore;
  if (!gd.hiddenRound || !hc.difficulties.includes(gd.difficulty)) return false;
  const threshold = gd.isSolo ? hc.single : hc.multi;
  return layerSum > threshold && teamLp > hc.minTeamLpExclusive;
}

/**
 * A boss field the server takes over mid-fight (its client left, DESIGN §14) re-simulates its spec from t = 0. The
 * damage its client already reported (`acked`, cumulative, per player in `ackedBy`) is in the shared pool, so this
 * wrapper credits the real pool only with what the re-simulation deals beyond it. Reads (hp, maxHp) go to the pool.
 */
export class CreditPool {
  /**
   * @param {SharedBossPool} pool
   * @param {{ acked?: number, ackedBy?: Record<string, number>, onCredit?: (playerId: string|null, amount: number) => void }} [o]
   */
  constructor(pool, { acked = 0, ackedBy = {}, onCredit = null } = {}) {
    this.pool = pool;
    this.acked = Math.max(0, Number(acked) || 0);
    this.ackedBy = { ...ackedBy };
    this.cum = 0;
    this.onCredit = onCredit;
  }

  get hp() { return this.pool.hp; }
  set hp(v) { /* the sim's fallback path writes hp only when damage() threw; the real pool is never written here */ void v; }
  get maxHp() { return this.pool.maxHp; }

  damage(playerId, amount) {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return 0;
    const before = this.cum;
    this.cum += a;
    const credit = Math.max(0, this.cum - Math.max(before, this.acked));
    if (credit <= 0) return 0;
    const dealt = this.pool.damage(playerId, credit);
    if (dealt > 0 && this.onCredit) { try { this.onCredit(playerId, dealt); } catch { /* reported by the caller */ } }
    return dealt;
  }
}
