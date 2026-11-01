// unite100.mjs — the 100-seat 联防 (unite) rule layer, and its focused verification.
//
// The design (owner's rules, docs/FINDINGS-100.md):
//   阶段 1 队内兜底: within a squad of 4, the members that did NOT leak ("完美作战") cover their own squad's leaked
//     enemies. At most 2 helpers per squad (the escaped map has two lanes), ranked by the upstream order
//     `unitsOnField > activeBond > standingUnits > seat`. "状态良好" (standing units) is a RANKING term, not a gate.
//   阶段 2 跨队兜底: whatever phase 1 did not stop is handed to ONE other squad picked by remaining strength; if that
//     squad fails too, the leaked enemies settle as LP loss and are NOT relayed again.
//
// This module implements phase 1's planning (splitting a match's combat results into one plan per squad). The battle
// execution (one 联防 field per squad, run concurrently) and phase 2 layer on top of it.
//
// Pure functions over the match's PlayerStates — no phase state is touched, so it is unit-testable on synthetic results.

import { squadIndex, squadMembers } from '../../shared/squads.js';
import { helperOrder, uniteSurvivors } from './unite.js';
import { loadData } from '../data.js';
import { GameData } from './gamedata.js';
import { Match } from './Match.js';

/** Players per squad (shared/squads.js). */
export { SQUAD_SIZE } from '../../shared/squads.js';

/**
 * Group the alive players by squad.
 * @param {import('./Match.js').Match} m
 * @returns {Map<number, any[]>} squad index → its alive players (seat order)
 */
export function squadsOf(m) {
  /** @type {Map<number, any[]>} */
  const out = new Map();
  for (const ps of m.alivePlayers()) {
    const k = squadIndex(ps.seat);
    if (k < 0) continue;
    const list = out.get(k);
    if (list) list.push(ps); else out.set(k, [ps]);
  }
  for (const list of out.values()) list.sort((a, b) => a.seat - b.seat);
  return out;
}

/**
 * Phase 1: one 联防 plan per squad that both leaked and still has a perfect member to send.
 *
 * Same trigger as upstream (unite.js planUnite) but scoped to the squad: a squad unites iff ≥ 1 of ITS members leaked
 * and ≥ 1 of its members was perfect. Helpers are ITS perfect members only (≤ gd.unite.maxHelpers), ranked by the
 * upstream order — so no squad ever defends another squad's leaks in this phase.
 *
 * @param {import('./Match.js').Match} m
 * @param {Map<string, object>} results playerId → BattleResult.perPlayer entry
 * @returns {Array<{ squad: number, helpers: any[], leakers: any[], leaked: object[], notReentered: Map<string, number> }>}
 */
/**
 * The bounty a leak still owes, in the shape `waves.js` reads (`spec.bounty = { coins, ownerPlayerId }` — it is the ONLY
 * reader): the leaker's own 悬赏卡 for this enemy, else the inline `mods.bountyCoins` an 机变 / content bounty carries.
 * `null` when the leak carries no bounty at all.
 *
 * Shared by BOTH branches of planUniteBySquad and (via the leak entry) by takeUnhandled's relay, because the payout was
 * silently lost when they disagreed: the bare relay case hard-coded `bounty: null`, and the relay rebuilt every entry
 * through `relayLeak`, whose `bounty` defaults to null — so a bounty enemy finished off by the 跨队兜底 squad paid
 * nothing even when 阶段 1 had worked the coins out correctly (owner's report 「兜底玩家打掉的带赏金的怪不结算赏金」).
 * @param {object} l a leak entry (`enemyKey`, `mods`)
 * @param {object} ps the PlayerState of the player that let it through (its `bounties` hold the 悬赏卡)
 * @returns {{ coins: number, ownerPlayerId: string }|null}
 */
export function bountyOfLeak(l, ps) {
  if (!l || !ps) return null;
  const bountyId = l.mods && l.mods.bountyId;
  const b = bountyId ? (ps.bounties || []).find((x) => x.id === bountyId) : null;
  const card = b && b.card;
  if (card && card.payout !== 'perfect' && Number(card.coin) > 0 && l.enemyKey === card.enemyKey) {
    return { coins: Math.trunc(Number(card.coin)), ownerPlayerId: ps.playerId };
  }
  const extra = !bountyId && l.mods ? Math.trunc(Number(l.mods.bountyCoins) || 0) : 0;
  return extra > 0 ? { coins: extra, ownerPlayerId: ps.playerId } : null;
}

export function planUniteBySquad(m, results) {
  if (m.isSolo) return [];
  const plans = [];
  for (const [squad, members] of squadsOf(m)) {
    const leakers = [];
    const perfects = [];
    for (const ps of members) {
      const r = results.get(ps.playerId);
      if (!r) continue;
      const counted = (r.leaked || []).filter((l) => l && l.counted !== false);
      if (counted.length > 0) leakers.push(ps);
      else if (r.perfect !== false) perfects.push(ps);
    }
    // A squad that leaked but fields NOBODY (not one perfect member) must still hand its leftovers to 阶段 2 — that is
    // the whole point of the cross-squad stage, and it is exactly the case the old `continue` dropped: the squad
    // produced no 阶段 1 field, so no plan, so its leaks never entered the relay at all. It now yields a BARE relay case
    // (`relayCase`) carrying what 阶段 2 needs — the squad, its leakers and their leaks, `helpers: []` — which
    // `takeUnhandled` turns into a relay plan whose enemies all survive (nothing was sent to hold them).
    if (!leakers.length) continue;
    if (!perfects.length) {
      const bare = [];
      // `notReentered` is what settlement reads (unite.js uniteSurvivors walks plan.notReentered + the battle result, and
      // there is NO result here). A bare case sent nothing to hold its enemies, so every one of its counted leaks really
      // is "a leak that never re-entered" — the map's exact meaning. Without it the plan looked like it had no leaks at
      // all: 阶段 2 relayed them fine, but the LP they cost was silently dropped (a free leak). takeUnhandled has its own
      // fallback for the same case; this makes the plan itself honest for every other reader (_uniteLeft's ×N badge,
      // settlement, and a relay round that never happens because no receiver was found).
      const notReentered = new Map();
      for (const ps of leakers) {
        const r = results.get(ps.playerId);
        for (const l of r.leaked || []) {
          if (!l || l.counted === false) continue;
          notReentered.set(ps.playerId, (notReentered.get(ps.playerId) || 0) + 1);
          bare.push({ enemyKey: l.enemyKey, mods: l.mods ? { ...l.mods } : null, lpr: l.lpr ?? 1, sourcePlayerId: ps.playerId, tag: l.tag ?? null, bounty: bountyOfLeak(l, ps) });
        }
      }
      plans.push({ relayCase: true, squad, helpers: [], leakers, leaked: bare, notReentered });
      continue;
    }
    const helpers = helperOrder(m, perfects, results);
    const leaked = [];
    const notReentered = new Map();
    for (const ps of leakers) {
      const r = results.get(ps.playerId);
      for (const l of r.leaked || []) {
        if (!l || l.counted === false) continue;
        if (!m.gd.enemy(l.enemyKey)) { notReentered.set(ps.playerId, (notReentered.get(ps.playerId) || 0) + 1); continue; }
        const bounty = bountyOfLeak(l, ps);
        leaked.push({ enemyKey: l.enemyKey, mods: l.mods ? { ...l.mods } : null, lpr: l.lpr ?? 1, sourcePlayerId: ps.playerId, tag: l.tag ?? null, bounty });
      }
    }
    plans.push({ squad, helpers, leakers, leaked, notReentered });
  }
  return plans.sort((a, b) => a.squad - b.squad);
}

/** Whether a squad has anything to defend at all (used by the phase to decide whether it starts a field). */
export function squadHasLeaks(plan) {
  return !!plan && (plan.leaked.length > 0 || plan.notReentered.size > 0);
}

// ---------------------------------------------------------------------------------------------------
// 阶段 2 跨队兜底 (cross-squad relay)

/**
 * Remaining strength of a squad — the key for picking the squad that takes over another squad's unhandled leaks
 * ("按剩余实力挑一个队接手"). Upstream already computes a per-player strength triple for ranking 联防 helpers
 * (unite.js helperStats): board units, whether a bond is active, and the operators still standing at the end of the
 * round's own combat. A squad's strength sums that over its ALIVE members; `standing` weighs most because a board that
 * survived the round is what can still hold a line.
 *
 * @param {import('./Match.js').Match} m
 * @param {any[]} members the squad's players
 * @param {Map<string, object>} results playerId → BattleResult.perPlayer entry
 * @returns {{ squad: number, units: number, standing: number, active: number, score: number }}
 */
export function squadStrength(m, members, results) {
  let units = 0;
  let standing = 0;
  let active = 0;
  for (const ps of members) {
    const r = results.get(ps.playerId);
    const board = ps.board ? ps.board.size : 0;
    units += board;
    const opUids = new Set();
    if (ps.board) for (const p of ps.board.values()) if (p && p.kind === 'chess') opUids.add(p.uid);
    if (r && Array.isArray(r.unitsEnd) && r.unitsEnd.length) {
      for (const u of r.unitsEnd) if (u && opUids.has(u.uid) && u.alive) standing++;
    } else {
      standing += board;      // no end state recorded: fall back to the board as it stands
    }
    if (Object.keys(ps.layers || {}).length) active++;
  }
  const score = standing * 1e6 + units * 1e3 + active;   // standing dominates, then the full board, then an active bond
  return { squad: members.length ? squadIndex(members[0].seat) : -1, units, standing, active, score };
}

/**
 * Whether an enemy instance can be RELAYED to another squad's 联防. Relaying re-spawns it on another field, so it needs
 * an enemy record and a spawn spec; whatever `planUnite` refused to route (an unknown enemy key — its `notReentered`
 * bucket) cannot be relayed either and settles directly.
 * @param {import('./gamedata.js').GameData} gd
 * @param {object} leak a plan's `leaked[]` entry
 */
export function canRelay(gd, leak) {
  return !!(leak && typeof leak.enemyKey === 'string' && gd.enemy(leak.enemyKey));
}

/** A fresh leak entry for `enemyKey` from `sourcePlayerId`, in the shape buildUniteWave consumes. */
export function relayLeak(enemyKey, sourcePlayerId, { mods = null, lpr = 1, tag = null, squad = null, bounty = null } = {}) {
  return { enemyKey, mods: mods ? { ...mods } : null, lpr, sourcePlayerId, tag, bounty, squad };
}

/**
 * Carve the UNHANDLED part out of phase 1's outcome: the enemies that squad's own 联防 did not stop.
 *
 * `uniteSurvivors(plan, result)` counts, per leaker, exactly what settlement would charge — survivors still on the
 * field plus the leaks that never re-entered. Those are the enemies that got through, i.e. what 阶段 2 hands to another
 * squad. They are re-created as fresh leak entries (buildUniteWave only reads `enemyKey`, `mods`, `sourcePlayerId`,
 * `lpr`, `tag`), keeping `sourcePlayerId` so settlement still bills the player who originally let them through.
 *
 * @param {import('./gamedata.js').GameData} gd
 * @param {object} plan the squad's phase-1 plan (unite.js shape)
 * @param {object|null} result its battle result
 * @returns {{ plan: object, relayable: number, settled: number }}
 */
export function takeUnhandled(gd, plan, result) {
  // A BARE relay case (plan.relayCase, from planUniteBySquad) carries no `notReentered`: give it one so uniteSurvivors
  // can walk it, and remember that NOTHING was sent to hold its enemies — with no field started there is no result, so
  // `uniteSurvivors` reports zero and every counted leak survives.
  const safePlan = plan && !plan.notReentered ? { ...plan, notReentered: new Map() } : plan;
  let unhandled = uniteSurvivors(safePlan, result);
  if (safePlan && safePlan.relayCase && !unhandled.size) {
    unhandled = new Map();
    for (const l of safePlan.leaked || []) {
      if (!l || l.counted === false || !l.sourcePlayerId) continue;
      unhandled.set(l.sourcePlayerId, (unhandled.get(l.sourcePlayerId) || 0) + 1);
    }
  }
  const leaked = [];
  // The relaying set is the players that ACTUALLY have unhandled enemies left — not the squad's whole leaker list.
  // Settlement charges a plan's `leakers` against `uniteSurvivors`, so a leaker wrongly listed here would be charged
  // another player's survivors (observed: a receiver's plan listed seats of a different squad).
  const relayLeakers = new Set();
  let settled = 0;
  /** pid → 无法转交（没有可 relay 的模板）的漏怪数：这些必须直接结算，不能指望阶段2 */
  const settledBy = new Map();
  for (const [pid, n] of unhandled) {
    const got = Math.max(0, Math.floor(Number(n) || 0));
    if (!(got > 0)) continue;
    relayLeakers.add(pid);
    const templates = (safePlan.leaked || []).filter((l) => l.sourcePlayerId === pid && canRelay(gd, l));
    if (!templates.length) { settled += got; settledBy.set(pid, (settledBy.get(pid) || 0) + got); continue; }   // nothing relayable (unknown keys): settle directly
    for (let i = 0; i < got; i++) {
      const t = templates[i % templates.length];
      // `bounty` MUST travel: relayLeak's default is null, and waves.js is the only reader of a leak's bounty, so
      // dropping it here silently voided the payout for every enemy the cross-squad stage finished off (owner's
      // report 「兜底玩家打掉的带赏金的怪不结算赏金」). `t.bounty` was worked out by planUniteBySquad for this entry.
      leaked.push(relayLeak(t.enemyKey, pid, { mods: t.mods, lpr: t.lpr ?? 1, tag: t.tag ?? null, squad: safePlan.squad, bounty: t.bounty ?? null }));
    }
  }
  // The relayed enemies are built from each player's OWN template (a leak of that player), never by cycling over
  // another player's entries: an enemy must be attributed to the player that actually let it through.
  const leakers = [...relayLeakers]
    .map((pid) => (safePlan.leakers || []).find((p) => p.playerId === pid))
    .filter(Boolean);
  return {
    plan: { squad: safePlan.squad, helpers: safePlan.helpers || [], leakers, leaked, notReentered: new Map(), relayFrom: safePlan.squad },
    relayable: leaked.length,
    settled,
    settledBy,
    leakers: [...relayLeakers],
  };
}

/**
 * Pick the squad that takes over `fromSquad`'s unhandled leaks: the ALIVE squad with the highest remaining strength
 * (squadStrength) that is neither the relaying squad nor already taking over someone else this round. Ties break by
 * squad order, so a fixed seed reproduces the same relay.
 *
 * @param {import('./Match.js').Match} m
 * @param {number} fromSquad
 * @param {Map<string, object>} results
 * @param {Set<number>} taken squads already assigned a relay this round
 * @returns {number|null}
 */
export function pickRelaySquad(m, fromSquad, results, taken = new Set()) {
  let best = null;
  let bestScore = -Infinity;
  for (const [squad, members] of squadsOf(m)) {
    if (squad === fromSquad || taken.has(squad) || !members.length) continue;
    const s = squadStrength(m, members, results);
    if (s.score > bestScore) { bestScore = s.score; best = squad; }
  }
  return best;
}

/**
 * 阶段 2 跨队串联兜底 — the helpers are chosen ROOM-WIDE, not per squad (owner's rule): 「第二轮把全房间所有玩家漏的
 * 怪,交给两名干员存活数最多且自己无漏怪的玩家」. Returns up to `maxHelpers` players that
 *   * are alive and still seated,
 *   * leaked NOTHING this round (`counted === 0`) — a receiver that leaked is not eligible (owner's rule),
 *   * ranked by SURVIVING OPERATORS first (`standing`), then the full board, then an active bond — so the two best
 *     remaining boards take the whole line.
 * @param {import('./Match.js').Match} m
 * @param {Map<string, object>} results
 * @param {number} [maxHelpers] defaults to gd.unite.maxHelpers (2 on this build)
 * @returns {any[]} at most `maxHelpers` player states, strongest first
 */
export function pickRelayHelpers(m, results, maxHelpers = null) {
  const cap = Number.isInteger(maxHelpers) && maxHelpers > 0
    ? maxHelpers
    : (Number.isInteger(m.gd.unite.maxHelpers) && m.gd.unite.maxHelpers > 0 ? m.gd.unite.maxHelpers : 2);
  const eligible = [];
  for (const ps of m.alivePlayers()) {
    if (!ps || ps.left || ps.alive === false) continue;
    const r = results.get(ps.playerId);
    if (!r) continue;
    const counted = (r.leaked || []).filter((l) => l && l.counted !== false);
    if (counted.length > 0 || r.perfect === false) continue;      // 无漏怪 only
    const s = squadStrength(m, [ps], results);
    eligible.push({ ps, standing: s.standing, units: s.units, active: s.active, score: s.score });
  }
  eligible.sort((a, b) => (b.standing - a.standing) || (b.units - a.units) || (b.active - a.active) || (b.score - a.score));
  return eligible.slice(0, cap).map((e) => e.ps);
}

/**
 * 阶段 2: hand EVERY squad's unhandled leaks to the room-wide helpers as ONE relay (owner's rule). The merged plan is
 * marked `combined` because its leaks legitimately span squads — `audit.js` recognises that marker and skips the
 * per-squad isolation checks that a 阶段 1 plan must satisfy.
 *
 * @param {import('./Match.js').Match} m
 * @param {Array<{ plan: object, unhandled: { plan: object, relayable: number } }>} phase1 phase-1 outcomes
 * @param {Map<string, object>} results
 * @returns {Array<{ plan: object }>} empty when there is nothing to relay, or nobody left to relay it
 */
export function planRelayBySquad(m, phase1, results) {
  const parts = [];
  for (const p of phase1) {
    if (!p || !p.unhandled || !p.plan || !(p.unhandled.relayable > 0)) continue;
    parts.push(p.unhandled.plan);              // already carved by takeUnhandled; one per relaying unit
  }
  if (!parts.length) return [];
  const helpers = pickRelayHelpers(m, results);
  if (!helpers.length) return [];
  const plan = relayPlanFor(m, helpers, parts, results);
  return plan ? [{ plan }] : [];
}

/**
 * Build the 阶段 2 (relay) plan: the room-wide `helpers` against EVERY relaying part's enemies, merged into ONE plan.
 *
 * Owner's rule: the second round hands the whole room's leftovers to the best (up to) two leak-free boards, which fight
 * them on a single shared battlefield. The earlier implementation picked one receiving SQUAD per relaying squad and
 * started one field each; that is why a squad with no perfect member (and therefore no plan of its own) never took part.
 *
 * @param {import('./Match.js').Match} m
 * @param {any[]} helpers already chosen (pickRelayHelpers) — the receivers, strongest first
 * @param {any[]|any} parts one 阶段 1 unhandled plan, or several to merge into this single relay
 * @param {Map<string, object>} results
 */
export function relayPlanFor(m, helpers, parts, results) {
  const list = (Array.isArray(parts) ? parts : [parts]).filter(Boolean);
  const hs = (Array.isArray(helpers) ? helpers : [helpers]).filter((ps) => ps && ps.alive && !ps.left);
  if (!hs.length || !list.length) return null;
  // Every leak keeps its own `sourcePlayerId`, so settle() bills the player who let it past — never a helper.
  // `leakers` is DERIVED from the enemies being relayed, never taken from an incoming plan: settle() charges a plan's
  // `leakers` against `uniteSurvivors`, so a list that disagrees with `leaked` would bill the wrong players.
  const leaked = list.flatMap((p) => (p.leaked || []).map((l) => ({ ...l, mods: l.mods ? { ...l.mods } : null })));
  if (!leaked.length) return null;
  const leakers = [...new Set(leaked.map((l) => l.sourcePlayerId))]
    .map((pid) => m.players.get(pid) || m.order.find((ps) => ps.playerId === pid))
    .filter(Boolean);
  const sources = [...new Set(leaked.map((l) => l.squad).filter((sq) => Number.isInteger(sq)))];
  return {
    // A phase-2 plan is not scoped to a squad: its leaks deliberately come from several. `combined` is the marker
    // audit.js uses to skip the per-squad isolation checks (the same one combineUniteResults sets).
    helpers: hs,
    leakers,
    leaked,
    notReentered: new Map(),
    combined: list.length,
    relayFrom: sources.length === 1 ? sources[0] : null,
    relaySources: sources,
  };
}

// ---------------------------------------------------------------------------------------------------
// focused verification: --test
// The full match nearly always ends with every round perfect (no leaker) or nobody perfect, so the squad split
// cannot be exercised by running matches. These synthetic cases drive planUniteBySquad directly.

if (process.argv[2] === '--test') runFocusedTests();

function runFocusedTests() {

  const data = loadData();
  const mkMatch = (seatCount) => {
    const seats = [];
    for (let i = 0; i < seatCount; i++) {
      seats.push({ seat: i, playerId: `ai_${i}`, name: `AI${i}`, isBot: true, connected: true, left: false });
    }
    const sched = {
      virtual: true, instant: true, now: () => 1700000000000,
      setTimeout: () => null, clearTimeout: () => {}, setInterval: () => null, clearInterval: () => {},
      dispose: () => {},
    };
    return new Match({
      roomCode: 'TEST', mode: 'coop', difficulty: 'NORMAL', seats, seed: 7, data,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      now: () => 1, scheduler: sched, send: () => true, broadcast: () => {}, onEnd: () => {},
    });
  };

  /** A BattleResult.perPlayer-shaped entry. */
  const result = ({ leaked = 0, perfect = true } = {}) => ({
    leaked: Array.from({ length: leaked }, (_, i) => ({ enemyKey: 'enemy_1000_gopro_2', lpr: 1, counted: true, tag: null, mods: null })),
    perfect,
  });
  // an unspawnable enemy key: those never re-enter and are counted, not routed (exercises notReentered)
  const resultBadKey = () => ({ leaked: [{ enemyKey: 'enemy_does_not_exist', lpr: 1, counted: true, tag: null, mods: null }], perfect: false });

  let pass = 0;
  const fail = [];
  const check = (name, cond, detail = '') => { if (cond) pass++; else fail.push(`${name}${detail ? ' — ' + detail : ''}`); };

  // --- case A: squad 0 (seats 0..3) leaks, squad 1 (seats 4..7) all perfect -----------------------------
  {
    const m = mkMatch(8);
    const results = new Map([
      ['ai_0', result({ leaked: 2, perfect: false })],
      ['ai_1', result({})], ['ai_2', result({})], ['ai_3', result({})],
      ['ai_4', result({})], ['ai_5', result({})], ['ai_6', result({})], ['ai_7', result({})],
    ]);
    const plans = planUniteBySquad(m, results);
    check('A: only the leaking squad plans a 联防', plans.length === 1, `got ${plans.length}`);
    check('A: it is squad 0', plans[0]?.squad === 0);
    check('A: helpers come from squad 0 only', plans[0]?.helpers.every((p) => p.seat < 4), JSON.stringify(plans[0]?.helpers.map((p) => p.seat)));
    check('A: at most 2 helpers', (plans[0]?.helpers.length ?? 9) <= m.gd.unite.maxHelpers);
    check('A: the leaker is in leakers', plans[0]?.leakers.some((p) => p.playerId === 'ai_0'));
    check('A: leaked enemies carry their source player', plans[0]?.leaked.every((l) => l.sourcePlayerId === 'ai_0'));
    check('A: 2 leaked enemies routed', plans[0]?.leaked.length === 2, String(plans[0]?.leaked.length));
  }

  // --- case B: both squads leak → one plan EACH, never mixed ---------------------------------------------
  {
    const m = mkMatch(8);
    const results = new Map([
      ['ai_0', result({ leaked: 1, perfect: false })], ['ai_1', result({})], ['ai_2', result({})], ['ai_3', result({})],
      ['ai_4', result({ leaked: 3, perfect: false })], ['ai_5', result({})], ['ai_6', result({})], ['ai_7', result({})],
    ]);
    const plans = planUniteBySquad(m, results);
    check('B: two squads plan', plans.length === 2, `got ${plans.length}`);
    const bySquad = new Map(plans.map((p) => [p.squad, p]));
    check('B: squad 0 helpers are seats 0..3', (bySquad.get(0)?.helpers ?? []).every((p) => p.seat < 4));
    check('B: squad 1 helpers are seats 4..7', (bySquad.get(1)?.helpers ?? []).every((p) => p.seat >= 4));
    check('B: squad 0 sees only its own leak', (bySquad.get(0)?.leaked ?? []).every((l) => l.sourcePlayerId === 'ai_0'));
    check('B: squad 1 sees only its own leaks', (bySquad.get(1)?.leaked ?? []).every((l) => l.sourcePlayerId === 'ai_4'));
    check('B: squad 1 routed 3', bySquad.get(1)?.leaked.length === 3, String(bySquad.get(1)?.leaked.length));
  }

  // --- case C: a squad with a leaker but NO perfect member does not unite (nothing to send) ---------------
  {
    const m = mkMatch(4);
    const results = new Map([
      ['ai_0', result({ leaked: 1, perfect: false })], ['ai_1', result({ leaked: 1, perfect: false })],
      ['ai_2', result({ leaked: 1, perfect: false })], ['ai_3', result({ leaked: 1, perfect: false })],
    ]);
    // C: a squad where EVERYONE leaked still hands its leftovers to 阶段 2 — it yields a bare relay case, not nothing.
  // (This assertion used to read `length === 0`; the cross-squad stage cannot work if such a squad is dropped.)
  {
    const cp = planUniteBySquad(m, results);
    check('C: no perfect member ⇒ a bare relay case (not a field)', cp.length === 1 && cp[0].relayCase === true,
      JSON.stringify(cp.map((x) => ({ squad: x.squad, relayCase: !!x.relayCase }))));
    check('C: the bare case carries the squad\'s leaks', cp[0].leaked.length === 4, String(cp[0].leaked.length));
    check('C: the bare case fields nobody', cp[0].helpers.length === 0);
  }
  }

  // --- case D: every member perfect ⇒ nothing to defend ---------------------------------------------------
  {
    const m = mkMatch(4);
    const results = new Map([['ai_0', result({})], ['ai_1', result({})], ['ai_2', result({})], ['ai_3', result({})]]);
    check('D: all perfect ⇒ no plan', planUniteBySquad(m, results).length === 0);
  }

  // --- case E: unknown enemy keys are counted as not-reentered, not routed --------------------------------
  {
    const m = mkMatch(4);
    const results = new Map([
      ['ai_0', resultBadKey()], ['ai_1', result({})], ['ai_2', result({})], ['ai_3', result({})],
    ]);
    const plans = planUniteBySquad(m, results);
    check('E: a plan exists', plans.length === 1);
    check('E: nothing leaked into the wave', (plans[0]?.leaked.length ?? 9) === 0, String(plans[0]?.leaked.length));
    check('E: counted as notReentered for the source', plans[0]?.notReentered.get('ai_0') === 1);
  }

  // --- case F: 100 seats → 25 squads, each independent ---------------------------------------------------
  {
    const m = mkMatch(100);
    const results = new Map();
    for (let i = 0; i < 100; i++) {
      // squads 0..3 leak (their seat 0), the rest are perfect
      const leaks = i < 16 && i % 4 === 0 ? 1 : 0;
      results.set(`ai_${i}`, result({ leaked: leaks, perfect: leaks === 0 }));
    }
    const plans = planUniteBySquad(m, results);
    check('F: exactly the 4 leaking squads plan', plans.length === 4, `got ${plans.length}`);
    check('F: squads are 0..3', JSON.stringify(plans.map((p) => p.squad)) === '[0,1,2,3]', JSON.stringify(plans.map((p) => p.squad)));
    for (const p of plans) {
      const seats = squadMembers(p.squad * 4);
      check(`F: squad ${p.squad} helpers are its own members`, p.helpers.every((x) => seats.includes(x.seat)));
      check(`F: squad ${p.squad} ≤ 2 helpers`, p.helpers.length <= 2, String(p.helpers.length));
    }
  }

  // --- case G: 阶段 2 — unhandled leaks are carved out and keep their source player ------------------------
  {
    const m = mkMatch(8);
    const plan = { squad: 0, helpers: [], leakers: [], leaked: [], notReentered: new Map() };
    const p0 = m.players.get('ai_0');
    plan.leakers = [p0];
    plan.leaked = [
      { enemyKey: 'enemy_1000_gopro_2', mods: null, lpr: 1, sourcePlayerId: 'ai_0', tag: null, bounty: null },
      { enemyKey: 'enemy_1005_yokai', mods: null, lpr: 1, sourcePlayerId: 'ai_0', tag: null, bounty: null },
    ];
    // uniteSurvivors counts perPlayer[*].leaked (survivors still on the field) + unspawned (never re-entered):
    // 3 survivors + 1 unspawned → 4 unhandled enemies for ai_0
    const res = {
      perPlayer: { ai_0: { leaked: [
        { enemyKey: 'enemy_1000_gopro_2', sourcePlayerId: 'ai_0', counted: true },
        { enemyKey: 'enemy_1000_gopro_2', sourcePlayerId: 'ai_0', counted: true },
        { enemyKey: 'enemy_1005_yokai', sourcePlayerId: 'ai_0', counted: true },
      ] } },
      unspawned: [{ enemyKey: 'enemy_1000_gopro_2', lpr: 1, sourcePlayerId: 'ai_0' }],
    };
    const got = takeUnhandled(m.gd, plan, res);
    check('G: all unhandled enemies are relayable', got.relayable === 4, `relayable=${got.relayable} settled=${got.settled}`);
    check('G: nothing settled early', got.settled === 0);
    check('G: relay plan keeps the source player', got.plan.leaked.every((l) => l.sourcePlayerId === 'ai_0'));
    check('G: relay plan is tagged with the relaying squad', got.plan.leaked.every((l) => l.squad === 0));
    check('G: relay plan carries no notReentered', got.plan.notReentered.size === 0);
  }

  // --- case H: unknown enemy keys cannot be relayed — they settle directly --------------------------------
  {
    const m = mkMatch(4);
    const plan = { squad: 0, helpers: [], leakers: [m.players.get('ai_0')], leaked: [], notReentered: new Map([['ai_0', 2]]) };
    const got = takeUnhandled(m.gd, plan, { perPlayer: {}, unspawned: [] });
    check('H: nothing relayable', got.relayable === 0, String(got.relayable));
    check('H: the 2 unknown leaks settle', got.settled === 2, String(got.settled));
  }

  // --- case I: relay target = strongest other squad, one relay per receiver, no self-relay ----------------
  {
    const m = mkMatch(12);   // squads 0,1,2
    const results = new Map();
    for (let i = 0; i < 12; i++) results.set(`ai_${i}`, result({}));
    // squad 1 strongest (most units), squad 2 next, squad 0 weakest
    const s0 = m.players.get('ai_0'), s1 = m.players.get('ai_4'), s2 = m.players.get('ai_8');
    for (let i = 0; i < 1; i++) s0.board.set(`${9},${3 + i}`, { uid: 100 + i, kind: 'chess', id: 'chess_char_1_01_a' });
    for (let i = 0; i < 5; i++) s1.board.set(`${9},${3 + i}`, { uid: 200 + i, kind: 'chess', id: 'chess_char_1_01_a' });
    for (let i = 0; i < 3; i++) s2.board.set(`${9},${3 + i}`, { uid: 300 + i, kind: 'chess', id: 'chess_char_1_01_a' });

    const st1 = squadStrength(m, [s1], results);
    const st2 = squadStrength(m, [s2], results);
    check('I: squad 1 outranks squad 2 by strength', st1.score > st2.score, `${st1.score} vs ${st2.score}`);

    const pick = pickRelaySquad(m, 0, results, new Set());
    check('I: squad 0 relays to the strongest other squad (1)', pick === 1, String(pick));
    const pickTaken = pickRelaySquad(m, 0, results, new Set([1]));
    check('I: an already-taken receiver is skipped (→ 2)', pickTaken === 2, String(pickTaken));
    check('I: never relays to itself', pickRelaySquad(m, 1, results, new Set([2])) !== 1);
  }

  // --- case J: two relaying squads never share a receiver -------------------------------------------------
  {
    const m = mkMatch(16);   // squads 0..3
    const results = new Map();
    for (let i = 0; i < 16; i++) results.set(`ai_${i}`, result({}));
    // the two relaying squads' leakers must ALSO show a leak in `results` — otherwise they would look leak-free and
    // could legitimately be picked as helpers (a player's own results and the relayed plan always agree in a real round)
    results.set('ai_0', result({ leaked: 1, perfect: false }));
    results.set('ai_4', result({ leaked: 1, perfect: false }));
    for (const ps of m.players.values()) ps.board.set('9,3', { uid: ps.seat + 1, kind: 'chess', id: 'chess_char_1_01_a' });
    const mkUnhandled = (squad) => ({
      plan: { squad, helpers: [], leakers: [], leaked: [relayLeak('enemy_1000_gopro_2', `ai_${squad * 4}`, { squad })], notReentered: new Map() },
      relayable: 1,
    });
    const relays = planRelayBySquad(m, [{ plan: { squad: 0 }, unhandled: mkUnhandled(0) }, { plan: { squad: 1 }, unhandled: mkUnhandled(1) }], results);
    check('J: one merged relay planned (room-wide helpers)', relays.length === 1, String(relays.length));
    check('J: the merged relay has helpers', relays[0] && relays[0].plan.helpers.length > 0, JSON.stringify(relays.map((r) => r.plan && r.plan.helpers.length)));
    check('J: no helper is one of the leakers', relays[0] && relays[0].plan.helpers.every((h) => !relays[0].plan.leakers.includes(h)));
  }

  // --- case K: the 阶段 2 helpers are chosen ROOM-WIDE, from leak-free boards, best survivors first ---------------
  {
    const m = mkMatch(8);
    const results = new Map();
    for (let i = 0; i < 8; i++) results.set(`ai_${i}`, result({}));
    const helpers = pickRelayHelpers(m, results);
    check('K: helpers are picked', helpers.length > 0);
    check('K: at most maxHelpers are picked', helpers.length <= m.gd.unite.maxHelpers, String(helpers.length));
    check('K: helpers are leak-free only', helpers.every((p) => (results.get(p.playerId).leaked || []).length === 0));
    const relayPlan = { squad: 0, leaked: [relayLeak('enemy_1000_gopro_2', 'ai_0', { squad: 0 })], leakers: [m.players.get('ai_0')] };
    const rp = relayPlanFor(m, helpers, relayPlan, results);
    check('K: a relay plan is built', !!rp);
    check('K: it carries the room-wide helpers', JSON.stringify(rp?.helpers.map((p) => p.playerId)) === JSON.stringify(helpers.map((p) => p.playerId)));
    check('K: the charge stays with the relaying squad\'s leaker', JSON.stringify(rp?.leakers.map((p) => p.playerId)) === JSON.stringify(['ai_0']));
    check('K: the enemies are the relayed ones', rp?.leaked.length === 1 && rp?.leaked[0].sourcePlayerId === 'ai_0');
    check('K: a one-squad relay still records its source', rp?.relayFrom === 0);
    // a helper that leaked is NOT eligible (owner's rule: 接受方不允许漏怪)
    const leaky = new Map(results);
    leaky.set(helpers[0].playerId, result({ leaked: 1, perfect: false }));
    const again = pickRelayHelpers(m, leaky);
    check('K: a player who leaked is not a helper', !again.includes(helpers[0]), JSON.stringify(again.map((p) => p.playerId)));
  }

  // --- case L: 阶段 1 → 阶段 2 hands the WHOLE ROOM's leftovers to ONE merged relay --------------------------------
  // Regression for the reported defect: a squad with no perfect member produced no plan, so its leaks never reached the
  // relay. Now every squad's carved leftovers merge into a single plan whose helpers are the room-wide best boards.
  {
    const m = mkMatch(16);   // squads 0..3
    const results = new Map();
    // squad 0: players 0,1 leak; 2,3 perfect     squad 1: 4 leaks; 5,6,7 perfect
    // squad 2: 8,9 leak; 10,11 perfect           squad 3: 12 leaks; 13,14,15 perfect
    const leakCount = { ai_0: 2, ai_1: 1, ai_4: 3, ai_8: 2, ai_9: 2, ai_12: 1 };
    for (let i = 0; i < 16; i++) {
      const pid = `ai_${i}`;
      results.set(pid, result({ leaked: leakCount[pid] || 0, perfect: !leakCount[pid] }));
    }
    const plans = planUniteBySquad(m, results);
    check('L: four squads plan a 联防', plans.length === 4, String(plans.length));

    // each squad's 联防 leaves some enemies unhandled (one survivor per leaker, say)
    const phase1 = plans.map((p) => {
      const res = { perPlayer: {}, unspawned: [] };
      for (const lk of p.leakers) {
        res.perPlayer[lk.playerId] = { leaked: [{ enemyKey: 'enemy_1000_gopro_2', sourcePlayerId: lk.playerId, counted: true }] };
      }
      return { plan: p, result: res, unhandled: takeUnhandled(m.gd, p, res) };
    });
    check('L: every squad has something unhandled', phase1.every((x) => x.unhandled.relayable > 0), JSON.stringify(phase1.map((x) => x.unhandled.relayable)));

    const relays = planRelayBySquad(m, phase1, results);
    check('L: ONE relay is planned for the whole room', relays.length === 1, String(relays.length));
    const rp = relays[0] && relays[0].plan;
    check('L: the relay plan exists', !!rp);
    if (rp) {
      // every relaying squad's leftovers are in it — this is what the old per-squad pick dropped
      const sources = new Set(rp.leaked.map((l) => m.players.get(l.sourcePlayerId)?.seat ?? -1).map((seat) => Math.floor(seat / 4)));
      check('L: it carries leaks from every relaying squad', sources.size === 4, JSON.stringify([...sources]));
      check('L: it is marked combined (audit skips per-squad isolation)', Number.isInteger(rp.combined) && rp.combined > 0, String(rp.combined));
      check('L: helpers are leak-free', rp.helpers.every((p) => (results.get(p.playerId).leaked || []).length === 0));
      check('L: helpers are at most maxHelpers', rp.helpers.length <= m.gd.unite.maxHelpers, String(rp.helpers.length));
      check('L: helpers are the best leak-free boards', rp.helpers.length > 0
        && rp.helpers[0] === pickRelayHelpers(m, results)[0], JSON.stringify(rp.helpers.map((p) => p.playerId)));
      check('L: nobody is billed outside the leakers', rp.leakers.every((p) => (results.get(p.playerId).leaked || []).length > 0),
        JSON.stringify(rp.leakers.map((p) => p.playerId)));
    }

    // --- case M: a squad with NO perfect member still reaches the relay (the reported defect) ----------------------
    {
      const mm = mkMatch(8);   // squads 0 and 1
      const res = new Map();
      // squad 0: EVERYONE leaks → no plan of its own (this is the case the old code dropped)
      for (let i = 0; i < 4; i++) res.set(`ai_${i}`, result({ leaked: 1, perfect: false }));
      // squad 1: nobody leaks → the leak-free helpers
      for (let i = 4; i < 8; i++) res.set(`ai_${i}`, result({}));
      const bare = planUniteBySquad(mm, res);
      check('M: the all-leaking squad yields a bare relay case', bare.some((p) => p.relayCase === true), JSON.stringify(bare.map((p) => p.squad)));
      const ph1 = bare.map((p) => {
        const r = p.relayCase ? null : { perPlayer: {}, unspawned: [] };
        return { plan: p, result: r, unhandled: takeUnhandled(mm.gd, p, r) };
      });
      const rl = planRelayBySquad(mm, ph1, res);
      check('M: its leaks DO reach the relay', rl.length === 1 && rl[0].plan.leaked.length > 0,
        JSON.stringify(rl.map((x) => x.plan.leaked.length)));
      if (rl.length) {
        check('M: the helpers come from the leak-free squad', rl[0].plan.helpers.every((p) => Math.floor(p.seat / 4) === 1),
          JSON.stringify(rl[0].plan.helpers.map((p) => p.seat)));
        check('M: the leakers are the squad that leaked', rl[0].plan.leakers.every((p) => Math.floor(p.seat / 4) === 0),
          JSON.stringify(rl[0].plan.leakers.map((p) => p.seat)));
      }
    }
  }

  console.log(`unite100 focused tests: ${pass} passed, ${fail.length} failed`);
  if (fail.length) { for (const f of fail) console.log('  ✗ ' + f); process.exit(1); }
  else console.log('  ✅ phase-1 per-squad 兜底 planning behaves as specified');
  process.exit(0);
}
