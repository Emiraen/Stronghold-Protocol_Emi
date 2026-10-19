// server/rankedStore.js — 排位档案：内存 Map + JSON 落盘（项目唯一的持久层；无账号系统，
// 以公共名字选择的共享 profile aid 为键；设备 hello.aid 与独立会话凭据不是授权）。
//
// 档案字段：{ aid, name, points, mmr, placementPlayed, placementScore, placementDone,
//            wins, losses, matches, dominantStreak, dominantDivision, lastActive }
// 结算入口 settleMatch(row, ctx) 由 Match.finish 调用（见 server/match/Match.js），全部参数服务端权威。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StoreWriter } from './historyStore.js';
import {
  PLACEMENT_MATCHES, UNRANKED, isRankedMatch, isDominantWin,
  mmrUpdate, placementPoints, placementTotal, performanceScore, rankDelta, rankOf,
} from '../shared/ranks.js';

const DEFAULT_FILE = 'ranked-profiles.json';

// 特批名单（玩家名不区分大小写）：定级赛 1 场即落段（普通玩家 3 场），
// 落段总分 = 单场表现分 × 3（等价同水平打满 3 场）。
const FAST_PLACEMENT_NAMES = new Set(['emiraen']);
const isFastPlacement = (name, debugAuthorized = false) => {
  const key = String(name || '').trim().toLowerCase();
  return FAST_PLACEMENT_NAMES.has(key) || (key === 'root' && debugAuthorized === true);
};
const placementNeededFor = (name, debugAuthorized = false) => (isFastPlacement(name, debugAuthorized) ? 1 : PLACEMENT_MATCHES);

const num = (v, d = 0) => (Number.isFinite(v) ? Math.floor(v) : d);

/**
 * @param {{ file?: string|null, now?: () => number, log?: object }} [opts] file:null ⇒ 纯内存（测试）
 */
export class RankedStore {
  constructor({ file = null, now = Date.now, log = null } = {}) {
    this.file = file === null ? null : resolve(file);
    this.now = now;
    this.log = log;
    /** @type {Map<string, any>} aid → profile */
    this.profiles = new Map();
    this.writer = new StoreWriter(this.file, () => ({ version: 1, savedAt: this.now(),
      profiles: [...this.profiles.values()] }), this.log, 'ranked');
    if (this.file) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        if (raw && typeof raw === 'object' && Array.isArray(raw.profiles)) {
          for (const p of raw.profiles) {
            if (p && typeof p.aid === 'string' && p.aid.length >= 8) this.profiles.set(p.aid, this.sanitize(p));
          }
        }
      } catch (e) {
        this.log?.warn?.(`[ranked] cannot read ${this.file}: ${e.message}`);
      }
    }
  }

  sanitize(p) {
    return {
      aid: String(p.aid),
      name: typeof p.name === 'string' ? p.name.slice(0, 64) : '',
      points: Math.max(0, num(p.points)),
      mmr: Math.max(0, num(p.mmr, 1000)),
      placementPlayed: Math.max(0, num(p.placementPlayed)),
      placementScore: num(p.placementScore),
      placementDone: !!p.placementDone,
      wins: Math.max(0, num(p.wins)),
      losses: Math.max(0, num(p.losses)),
      matches: Math.max(0, num(p.matches)),
      dominantStreak: Math.max(0, num(p.dominantStreak)),
      dominantDivision: typeof p.dominantDivision === 'string' ? p.dominantDivision : null,
      lastActive: num(p.lastActive),
      // 档案内 aid 隐含在所属 Map 中，凭据不进入回执；重载后也不重复结算。
      settlements: Object.fromEntries(Object.entries(p.settlements || {}).filter(([key, value]) =>
        /^[0-9a-f]{32}:[A-Za-z0-9_-]{1,64}$/.test(key) && value && typeof value === 'object' && Number.isFinite(value.after))),
    };
  }

  /** 当前档案数（/healthz）。 */
  get size() { return this.profiles.size; }

  profile(aid) { return this.profiles.get(aid) || null; }

  ensure(aid, name = '') {
    let p = this.profiles.get(aid);
    if (!p) {
      p = this.sanitize({ aid, name, mmr: 1000 });
      this.profiles.set(aid, p);
    }
    if (name && p.name !== name) p.name = name;
    return p;
  }

  save() { this.writer.save(); }

  flush() { return this.writer.flush(); }

  /** 全服排名（≥神话区才有意义；1 = 最高）。 */
  globalRank(aid) {
    const me = this.profiles.get(aid);
    if (!me || !me.placementDone || me.points < 2100) return null;
    let ahead = 0;
    for (const p of this.profiles.values()) {
      if (p !== me && p.placementDone && (p.points > me.points
        || (p.points === me.points && p.lastActive > me.lastActive))) ahead++;
    }
    return ahead + 1;
  }

  /** 全量公开榜单；积分与活跃时间均相同才并列，名次与 globalRank 一致。 */
  leaderboard({ includeAid = false } = {}) {
    const profiles = [...this.profiles.values()]
      .filter((p) => p.placementDone && p.points >= 2100)
      .sort((a, b) => b.points - a.points || b.lastActive - a.lastActive);
    let position = 0;
    return profiles.map((p, i) => {
      const previous = profiles[i - 1];
      if (!previous || p.points !== previous.points || p.lastActive !== previous.lastActive) position = i + 1;
      const { icon, label } = rankOf(p.points);
      return { ...(includeAid ? { aid: p.aid } : {}), position, name: p.name, points: p.points,
        wins: p.wins || 0, rank: { icon, label } };
    });
  }

  /** rank.me 帧（客户端徽章）。`name` 仅用于无档案时判断特批定级场数。
   *  label：已落段 ⇒ rankOf 完整串（神话以上追加「#全服排名」）；未定级 ⇒「未定级 (已完成/总数)」。 */
  summary(aid, name = '', debugAuthorized = false, ranks = null) {
    const p = this.profiles.get(aid);
    if (!p) {
      const needed = placementNeededFor(name, debugAuthorized);
      return { ranked: false, placementPlayed: 0, placementMatches: needed,
        rank: { ...UNRANKED, label: `未定级 (0/${needed})` }, wins: 0, losses: 0, points: 0, globalRank: null };
    }
    const needed = placementNeededFor(p.name, debugAuthorized);
    if (!p.placementDone) {
      return {
        ranked: false,
        placementPlayed: p.placementPlayed,
        placementMatches: needed,
        rank: { ...UNRANKED, label: `未定级 (${p.placementPlayed}/${needed})` },
        wins: p.wins,
        losses: p.losses,
        points: 0,
        globalRank: null,
      };
    }
    const gr = ranks ? (ranks.get(aid) ?? null) : this.globalRank(aid);
    const rank = rankOf(p.points);
    if (gr != null) rank.label += ` #${gr}`; // 神话以上：小分后面跟 #全服排名
    return {
      ranked: p.placementDone,
      placementPlayed: p.placementPlayed,
      placementMatches: needed,
      rank,
      wins: p.wins,
      losses: p.losses,
      points: p.points,
      globalRank: gr,
    };
  }

  /**
   * 一场排位赛的某一玩家结算（Match.finish 调用；全部字段服务端计算）。
   * @param {{ aid: string, name: string }} who
   * @param {{ difficulty: string, mode?: string, startingParticipantCount?: number, teamWin: boolean, hiddenCleared: boolean }} match
   * @param {{ alive: boolean, eliminatedRound: number|null, roundsPassed: number, layers: number, assists: number }} row
   * @returns {null | { before: number, after: number, delta: number, skipBonus: number, kind: string,
   *             placementDone: boolean, placementPlayed: number, placementMatches: number,
   *             tierBefore: string, tierAfter: string, iconAfter: string, globalRank: number|null }}
   */
  settleMatch(who, match, row) {
    // 即使调用方误传标准局，也必须在建档、定级、奖励及隐藏分更新前退出。
    if (!isRankedMatch(true, match.difficulty)) return null;
    const p = this.ensure(who.aid, who.name);
    const key = /^[0-9a-f]{32}$/.test(match.matchId || '') && /^[A-Za-z0-9_-]{1,64}$/.test(who.playerId || '')
      ? `${match.matchId}:${who.playerId}` : null;
    if (key && p.settlements[key]) return structuredClone(p.settlements[key]);
    const before = p.placementDone ? p.points : 0;
    const perf = {
      difficulty: match.difficulty,
      roundsPassed: Math.max(0, num(row.roundsPassed)),
      layers: Math.max(0, num(row.layers)),
      assists: Math.max(0, num(row.assists)),
      win: !!match.teamWin,
    };
    const wasPlacement = !p.placementDone; // 本场是否定级赛（决定隐藏分走剧烈模式）
    const streakBefore = p.dominantStreak;
    // 定级连胜逻辑不变；常规局只有可获得胜利基础分的个人才延续统治级连胜。
    const dominant = isDominantWin({ ...perf, rankedDamage: row.rankedDamage })
      && (wasPlacement || (!!row.alive && performanceScore({ ...perf,
        pointsBefore: before, survivalRounds: row.survivalRounds }).eligible));

    let delta = 0;
    let kind = '';
    let skipBonus = 0;
    let baseGain = 0;
    let shortageBonus = 0;
    let rawLoss = 0;
    let actualLoss = 0;
    let performance = null;
    let calculatedPerformance = 0;
    let appliedPerformance = 0;
    const needed = placementNeededFor(p.name, who.debugAuthorized === true); // 调试特批只来自本设备授权
    if (!p.placementDone) {
      // 定级赛：累计表现分，第 3 场后落段（特批玩家第 1 场）
      kind = 'placement';
      p.placementPlayed += 1;
      p.placementScore += placementPoints(perf);
      if (p.placementPlayed >= needed) {
        p.placementDone = true;
        // 特批一把定级：单场表现分 ×3 折算总分（等价同水平打满 3 场）。
        const sum = needed < PLACEMENT_MATCHES ? p.placementScore * PLACEMENT_MATCHES : p.placementScore;
        p.points = placementTotal(sum);
      }
    } else {
      const r = rankDelta({
        difficulty: match.difficulty,
        pointsBefore: p.points,
        mmr: p.mmr,
        mode: match.mode,
        startingParticipantCount: match.startingParticipantCount,
        win: !!match.teamWin,
        alive: !!row.alive,
        eliminatedRound: row.eliminatedRound ?? null,
        roundsPassed: perf.roundsPassed,
        survivalRounds: row.survivalRounds,
        rankedDamage: row.rankedDamage,
        bossDamage: row.bossDamage,
        rankedPerfectRounds: row.rankedPerfectRounds,
        layers: perf.layers,
        assists: perf.assists,
        hiddenCleared: !!match.hiddenCleared,
        dominantStreakBefore: streakBefore,
      });
      delta = r.delta;
      kind = r.kind;
      skipBonus = r.skipBonus;
      baseGain = r.baseGain;
      shortageBonus = r.shortageBonus;
      rawLoss = r.rawLoss;
      actualLoss = r.actualLoss;
      performance = r.performance;
      calculatedPerformance = r.calculatedPerformance;
      appliedPerformance = r.appliedPerformance;
      p.points = Math.max(0, p.points + delta);
    }

    // DEV（root 专属福利）：首场排位（matches===0）额外+2000，定级规则保留。
    // 仅此一场，不论输赢；调试权限仍由独立授权会话提供。
    let bonus = 0;
    let requestedBonus = 0;
    if (who.debugAuthorized === true && String(p.name || '').trim().toLowerCase() === 'root' && p.matches === 0) {
      requestedBonus = 2000;
      bonus = requestedBonus;
      p.points = Math.max(0, p.points + bonus);
    }

    // 统计与隐藏分（定级赛隐藏分更剧烈：赢加更多、输扣更多）
    if (match.teamWin) p.wins += 1; else p.losses += 1;
    p.matches += 1;
    p.dominantStreak = dominant ? streakBefore + 1 : 0;
    p.mmr = mmrUpdate(p.mmr, perf, { placement: wasPlacement });
    p.lastActive = this.now();

    const after = p.placementDone ? p.points : 0;
    const rankAfter = p.placementDone ? rankOf(after) : { ...UNRANKED };
    const rankBefore = rankOf(before);
    const gr = this.globalRank(who.aid);
    const out = {
      before,
      after,
      delta,
      baseGain,
      calculatedPerformance,
      appliedPerformance,
      performance,
      shortageBonus,
      rawLoss,
      actualLoss,
      startingParticipantCount: Number.isInteger(match.startingParticipantCount) && match.startingParticipantCount >= 1
        ? match.startingParticipantCount : null,
      skipBonus,
      bonus,
      requestedBonus,
      cappedBonus: requestedBonus - bonus,
      totalDelta: after - before,
      kind,
      placementDone: p.placementDone,
      placementPlayed: p.placementPlayed,
      placementMatches: needed,
      tierBefore: wasPlacement
        ? (p.placementPlayed > 1 ? `未定级 (${p.placementPlayed - 1}/${needed})` : UNRANKED.label)
        : rankBefore.label,
      tierAfter: p.placementDone
        ? rankAfter.label + (gr != null ? ` #${gr}` : '') // 神话以上：小分后面跟 #全服排名
        : `未定级 (${p.placementPlayed}/${needed})`,
      iconAfter: rankAfter.icon,
      globalRank: gr,
    };
    if (key) p.settlements[key] = structuredClone(out);
    this.save();
    return out;
  }
}

/** 进程级默认实例：RANKED_FILE 覆盖路径，默认 <cwd>/ranked-profiles.json。 */
export function defaultRankedStore(log) {
  return new RankedStore({ file: process.env.RANKED_FILE || resolve(process.cwd(), DEFAULT_FILE), log });
}
