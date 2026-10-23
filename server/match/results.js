// server/match/results.js — settlement (RESULT): per-player results, titles (评语), trophies and rewards
// (DESIGN §6.1, research 06 §10.4–§10.6, data/config.json titles/titleRule/trophies/rewards).
//
// roundsPassed (per player): eliminated in round k ⇒ k − 1; alive at the end ⇒ bossRound on a win (+1 when the
// Hidden Core was cleared), bossRound − 1 when the Final Assault was lost. Rewards and trophies follow each player's
// OWN rounds passed (research 06 §6 / §10.4): the Hidden-Core trophy row and a row's `victory` only for the players
// still in at the end — a teammate eliminated (or departed) earlier keeps the table value of its own rounds.
// Titles: every config.titles entry (with data/tuning.json `titles` overrides, gamedata.js) has { stat, rule:
// 'max'|'min', onlyOnWin? }. 'max' titles: candidates are the players with a positive stat, ranked high → low.
// 'min' titles (坚若磐石 "目标生命值损失最少" = least LP lost): every player still alive at the end is a candidate,
// ranked low → high (the eliminated lost everything). Candidates are ranked by the player's rank for that stat
// (0 = best), then by closeness to the best value, then title order, then seat; greedy assignment gives each player
// ≤ 1 title and uses each title ≤ once (config.titleRule [ASSUMED]).

import { resultSnapshot } from './resultSnapshot.js';

const STAT_OF = {
  bossDamage: (ps) => ps.stats.bossDamage,
  activatedLayers: (ps) => ps.activatedLayers(),
  lpRemaining: (ps) => (ps.alive ? Math.max(0, ps.lpAtFinal ?? ps.lp) : 0),
  lpLost: (ps) => Math.max(0, Number(ps.stats.lpLost) || 0),
  merges: (ps) => ps.stats.merges,
  itemsEquipped: (ps) => ps.stats.itemsEquipped,
  fundsSpent: (ps) => ps.stats.gold,
};

export function assignTitles(gd, players, victory, onError = () => {}) {
  const titles = Array.isArray(gd.titles) ? gd.titles : Array.isArray(gd.config.titles) ? gd.config.titles : [];
  const cands = [];
  const titleValues = (t, candidates) => candidates.flatMap((ps) => {
    try {
      const v = Number(STAT_OF[t.stat](ps)) || 0;
      if (!Number.isFinite(v)) throw new TypeError(`invalid title stat ${t.stat}`);
      return [{ ps, v }];
    } catch (error) { onError(ps, t.stat, error); return []; }
  });
  titles.forEach((t, ti) => {
    if (!t || typeof t.stat !== 'string' || !Object.hasOwn(STAT_OF, t.stat)) return;
    if (t.onlyOnWin && !victory) return;
    if (t.rule === 'min') {
      const vals = titleValues(t, players.filter((ps) => ps.alive)).map(({ ps, v }) => ({ ps, v: Math.max(0, v) }));
      if (!vals.length) return;
      const best = Math.min(...vals.map((x) => x.v));
      const sorted = vals.slice().sort((a, b) => a.v - b.v);
      for (const { ps, v } of vals) cands.push({ ps, t, ti, rank: sorted.findIndex((x) => x.v === v), rel: (best + 1) / (v + 1) });
      return;
    }
    const vals = titleValues(t, players);
    const best = Math.max(0, ...vals.map((x) => x.v));
    if (best <= 0) return;
    const sorted = vals.slice().sort((a, b) => b.v - a.v);
    for (const { ps, v } of vals) {
      if (v <= 0) continue;
      const rank = sorted.findIndex((x) => x.v === v);
      cands.push({ ps, t, ti, rank, rel: v / best });
    }
  });
  cands.sort((a, b) => a.rank - b.rank || b.rel - a.rel || a.ti - b.ti || a.ps.seat - b.ps.seat);
  const out = new Map();
  const used = new Set();
  for (const c of cands) {
    if (out.has(c.ps.playerId) || used.has(c.t.id)) continue;
    out.set(c.ps.playerId, { id: c.t.id, name: c.t.name, picId: c.t.picId, text: c.t.text });
    used.add(c.t.id);
  }
  return out;
}

function trophiesFor(gd, roundsPassed, hiddenCleared) {
  const tr = gd.config.trophies;
  if (!tr || gd.isSolo) return 0;
  let n = 0;
  if (Array.isArray(tr.byRoundsPassed)) {
    for (const row of tr.byRoundsPassed) {
      if (roundsPassed <= row.maxRound) { n = Number(row[gd.difficulty]) || 0; break; }
    }
  }
  if (hiddenCleared && tr.hiddenCore && Number.isFinite(tr.hiddenCore[gd.difficulty])) n = tr.hiddenCore[gd.difficulty];
  return n;
}

function rewardFor(gd, roundsPassed) {
  const rw = gd.config.rewards;
  if (!rw || !Array.isArray(rw.baseByRoundsPassed)) return 0;
  const row = rw.baseByRoundsPassed.filter((r) => r.round <= roundsPassed).pop();
  if (!row) return 0;
  const df = (rw.difficultyFactor && rw.difficultyFactor[gd.difficulty]) || 1;
  const mf = (rw.modeFactor && rw.modeFactor[gd.isSolo ? 'SINGLE' : 'MULTI']) || 1;
  return Math.round(row.count * df * mf);
}

/**
 * @param {import('./Match.js').Match} m
 * @param {{ victory: boolean, hiddenReached: boolean, hiddenCleared: boolean, reason: string }} outcome
 */
export function buildResult(m, outcome) {
  const gd = m.gd;
  const { victory, hiddenReached, hiddenCleared } = outcome;
  const players = [...m.players.values()].sort((a, b) => a.seat - b.seat);
  const displayErrors = [], settlementErrors = [];
  const report = (ps, stage, error, list, code) => {
    const diagnostic = { playerId: ps.playerId, stage, code };
    list.push(diagnostic);
    m.reportError?.(`result ${stage} player ${ps.playerId}`, error);
    return diagnostic;
  };
  const titles = assignTitles(gd, players, victory, (ps, stat, error) =>
    report(ps, `title:${stat}`, error, displayErrors, 'RESULT_DISPLAY_UNAVAILABLE'));
  const teamRounds = victory ? gd.bossRound + (hiddenCleared ? 1 : 0) : Math.max(0, Math.min(m.round, gd.bossRound) - 1);
  const rows = players.map((ps) => {
    let display = { lineup: [], bonds: [] };
    try {
      display = !ps.alive && ps._resultSnapshot ? ps._resultSnapshot : resultSnapshot(ps);
      if (!Array.isArray(display.lineup) || !Array.isArray(display.bonds)) throw new TypeError('invalid result display');
    } catch (error) {
      display = { lineup: [], bonds: [] };
      report(ps, 'display', error, displayErrors, 'RESULT_DISPLAY_UNAVAILABLE');
    }
    const identity = { playerId: ps.playerId, seat: ps.seat, name: ps.name, isBot: ps.isBot, left: ps.left, alive: ps.alive, bandId: ps.bandId };
    try {
      const roundsPassed = !ps.alive && ps.eliminatedRound != null ? Math.max(0, ps.eliminatedRound - 1) : teamRounds;
      const stats = {
        dmgDealt: Math.round(ps.stats.dmgDealt), kills: ps.stats.kills, leaks: ps.stats.leaks, gold: ps.stats.gold,
        refreshes: ps.stats.refreshes, merges: ps.stats.merges, itemsEquipped: ps.stats.itemsEquipped,
        bossDamage: ps.stats.bossDamage, activatedLayers: ps.activatedLayers(), lpLost: ps.stats.lpLost,
        perfectRounds: ps.stats.perfectRounds, assists: ps.stats.assists || 0,
        survivalRounds: ps.stats.survivalRounds, rankedDamage: ps.stats.rankedDamage,
        rankedPerfectRounds: ps.stats.rankedPerfectRounds, rankedStatsVersion: 1,
      };
      if (!Number.isFinite(roundsPassed) || !Number.isFinite(ps.lp)
        || (ps.eliminatedRound != null && !Number.isFinite(ps.eliminatedRound))
        || (ps.stats.assists != null && !Number.isFinite(ps.stats.assists))
        || Object.values(stats).some((v) => !Number.isFinite(v))) throw new TypeError('invalid result settlement stats');
      // the team's clear counts for the players still in; an eliminated / departed teammate did not pass the boss round
      const cleared = victory && ps.alive;
      const trophies = trophiesFor(gd, roundsPassed, cleared && hiddenCleared);
      const reward = rewardFor(gd, roundsPassed);
      if (!Number.isFinite(trophies) || !Number.isFinite(reward)) throw new TypeError('invalid result reward');
      return {
        ...identity,
        victory: cleared,
        roundsPassed,
        eliminatedRound: ps.eliminatedRound,
        lp: Math.max(0, ps.lp),
        lineup: display.lineup,
        bonds: display.bonds,
        stats,
        title: titles.get(ps.playerId) ?? null,
        trophies,
        reward,
      };
    } catch (error) {
      const settlementError = report(ps, 'stats', error, settlementErrors, 'RESULT_STATS_UNAVAILABLE');
      return { ...identity, lineup: display.lineup, bonds: display.bonds, title: titles.get(ps.playerId) ?? null, stats: null, settlementError };
    }
  });
  return {
    t: 'm.result',
    ...(m.cs ? {cs:m.cs} : {}),
    ...(m.vs ? {vs:m.vs} : {}),
    ...(m.requireCs === true ? {unofficial:true} : {}),
    victory,
    roundsPassed: teamRounds,
    hiddenReached,
    hiddenCleared,
    reason: outcome.reason,
    // the merged Final Assault pool (null before round 14); players[].lp are the alive players' shares of it
    teamLp: m.teamLp != null ? Math.max(0, Math.round(m.teamLp)) : null,
    modeId: m.modeId,
    mode: m.mode,
    variant: m.variant ?? null,
    difficulty: m.difficulty,
    stageId: m.stageId,
    bossId: m.bossId,
    hiddenBossId: m.hiddenBossId,
    seed: m.seed,
    durationMs: Math.max(0, m.sched.now() - m.startedAt),
    players: rows,
    ...(displayErrors.length ? { displayErrors } : {}),
    ...(settlementErrors.length ? { incomplete: true, settlementErrors } : {}),
  };
}
