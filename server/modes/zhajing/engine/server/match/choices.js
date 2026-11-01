// server/match/choices.js — 机变 (SP draft) card generation and application (DESIGN §6.1, research 01 A4,
// data/choices.json).
//
// Generation (generateDraft): the family is a weighted pick from choices.schedule[modeId].rounds[r].families; the card
// count is `cards` (co-op 6, solo 3):
//   bounty  悬赏决策  six distinct cards.bounty entries (solo: 3 of them) built like the official draft of the round
//                     (`bountyDraftCards`; player feedback after 0.1.0, report #2 — late bounty enemies in the early
//                     drafts; 66 official screenshots of 22 matches, tools/build-data.mjs BOUNTY_INITIAL_SETS): schedule
//                     `bountyDraft` names the kind and choices.json `bountyDrafts[kind]` its card lists — the event is a
//                     fixed list and the draft shows 6 different cards of it, each drawn with its weight (1 + the
//                     official drafts of the group it showed in):
//                       initial (R3, 险境 R6 [ASSUMED]): one of the 10 official sets of six "接下来两场作战" cards (all
//                               six) — 9 seen, the 10th built by `rule` (I I I II II III) [ASSUMED];
//                       boss (R9): one of the 6 groups (9, 9, 9, 9, 8 and 6 cards) of boss bounties / 源石虫·特训,
//                               picked by the matches it came in [ASSUMED];
//                       hunter (R11): one of the 7 seen lists of 7 "下场战斗" cards, uniform, so no list is invented
//                               [ASSUMED: which of the 15 bounty_hunter events R11 fires is open — by the data's blocks
//                               8..15]; a list seen with 6 cards gets its 7th (`open`) by `rule`
//                               (one 特异III giant, else a tier I / II card of a free faction series) [ASSUMED];
//                     only `draft` cards of that `draftPool` (never 战术特训 — 法术教鞭 only —, the 鸭爵 set, the 7
//                     multi-round cards or the pre-series cards: no official draft shows them); positions shuffled; the
//                     mode's inactive enemy list does not apply (PRTS 卫戍协议：盟约 11/18 note "以上调整仅针对战术特训敌人，
//                     不影响悬赏决策出场"); each card carries its official rich text `descRaw` (the battles in blue
//                     "下场作战" / "两场作战"); a multi-round card (教鞭's 法术大师A2·多轮战术特训) lasts
//                     MULTI_ROUND_BOUNTY_BATTLES battles and says so (`bountyBattles` / `bountyText`: the user's call
//                     after playtest #6 — "我不记得有过多轮悬赏")
//   supply  道具补给  random normal EQUIP shop items with tier in supplyTiers [lo, hi] (duplicates allowed)
//   shop    机密商店  at the rounds of choices.json `shopDraft` (R11: the 4 official 机密商店; the user: "机密商店按官方改
//                     成可以重复吧"): six slots, each drawn on its own — with replacement, so the same item can be
//                     offered twice (official: 盟约之币 ×2, 变形同构体 ×2): VI, VI, V, 盟约之币 and twice V / IV / III /
//                     盟约之币, an item within its tier by `itemWeights` (solo: 3 of the 6 slots [ASSUMED]); other rounds
//                     (标准 / 险境, no screenshot) and without `shopDraft`: random normal EQUIP shop items of any tier I–VI,
//                     each card on its own (duplicates allowed) [ASSUMED]. FREE — the official card text is "无需消耗资金，获得装备
//                     补给" (research 01 A4/04 addendum), so the price is 0. Two identical cards are two cards: picks,
//                     `taken` and the client go by the card's `idx`
//   tactic  战术决策  cards.tactic entries, each card drawn on its own — with replacement, so the same card can be
//                     offered twice (the 4 official 战术决策, R11 of matches 7 / 9 / 18 / 20: 补给 ×2 in match 7; the
//                     user: "战术决策也按官方改成可以重复吧"; `tacticDraftCards`): at the rounds of choices.json
//                     `tacticDraft` (R11) only its `kinds` (the ally cards — the official 24 cards hold no debuff and
//                     no terrain card), a card by `weights` (1 + the official cards it showed on) [ASSUMED: the
//                     weights]; other rounds (标准 / 险境, no screenshot) every card uniform, terrain cards only for
//                     the match stage [ASSUMED]; a 驰援 card (single_special_choice_gain_bond_chess) or a 盟誓 card
//                     (global_special_choice_bond_addlayer) only while at least one of its bonds is live in this match
//                     (opts.bondAvailable = Match.bondLive: not in the mode's static inactive list — 标准 turns off
//                     拉特兰 / 阿戈尔 / 卡西米尔 / 奥术 … — and still with chess in the pool); a card acting only on dead
//                     bonds would do nothing. Two identical cards are two cards: picks, `taken` and the client go by
//                     the card's `idx`, and each pick applies its own card once (two picks of one team card stack)
// Application (applyCard): a registered `choice:<effectId>` handler (content) wins; otherwise the family default:
//   bounty → the picker's bounty list (waves.js adds the enemies to the next `rounds` battles; kill payout to the
//            killer via the Battle, perfect payout at settlement when the picker's own battle was perfect)
//   supply / shop → the item goes to the picker's hand (overflow temp)
//   tactic → by effect buff key (data/effects.json):
//     global_special_choice_gain_equip {count,pool}     `count` items from the server pool
//     global_special_choice_bond_addlayer {count,bond_list} layers +count to each bond (无需激活)
//     global_special_choice_gain_coin {count}           funds
//     global_special_choice_refresh_free {count}        free refreshes (stack)
//     single_special_choice_gloden_equip_chess {count}  next `count` bought items become golden   (EffectRef)
//     single_special_choice_gloden_char_chess {count}   next `count` bought operators become elite (EffectRef)
//     single_special_choice_gain_bond_chess {count,bond} `count` random chess of the bond (≤ shop level)
//     auto_chess_change_map {alias: 0|1}                device toggles on the picker's board (deploy legality) + battle
//     anything else (env_gbuff…, enemy_attribute_mul…)  a battle EffectRef for the sim content (playerEffects)
//   cards with `team: true` apply to the picker AND every alive teammate ("若存在其他队友则他们也获得").

import { weightedPick } from './waves.js';
import { bondHintsFor, activeBonds as jibianBondsActive } from '../sim/content/jibianBonds.js';

export const FAMILY_NAMES = { bounty: '悬赏决策', supply: '道具补给', shop: '机密商店', tactic: '战术决策', express: '企鹅物流的快递', jibian: '惊变阶段' }; // i18n-ignore: = choices.json families (the client shows the localized record)

/**
 * Battles a multi-round bounty card lasts (data `rounds` 99, official text "之后 / 后续的<@ba.vdown>每场</>作战":
 * 山海众头目·多轮悬赏, 多轮悬赏·假想敌 ×6, 法术大师A2·多轮战术特训). The user does not remember any multi-round bounty
 * (playtest #6 answer, "我不记得有过多轮悬赏"): until that is confirmed otherwise every such card lasts two battles,
 * exactly like the "接下来两场作战" cards, and its text says so in the same blue (`bountyText`). `null` restores the
 * official "每场" (every later battle, red text) everywhere: the draft, 教鞭 / 神秘顾客, the bounty list and the effects
 * column (DESIGN §20).
 */
export const MULTI_ROUND_BOUNTY_BATTLES = 2;
/** A multi-round bounty card ("之后 / 后续的每场作战"; choices.json `multiRound`, or data `rounds` ≥ 90). */
export const isMultiRoundBounty = (c) => !!c && (c.multiRound === true || Number(c.rounds) >= 90);
/** The battles a bounty card's enemies come for (MULTI_ROUND_BOUNTY_BATTLES for a multi-round card), 1–99. */
export function bountyBattles(c) {
  if (isMultiRoundBounty(c) && Number.isInteger(MULTI_ROUND_BOUNTY_BATTLES)) return MULTI_ROUND_BOUNTY_BATTLES;
  const r = Number(c && c.rounds);
  return Math.max(1, Math.min(99, Number.isInteger(r) ? r : 1));
}
const N_ZH = ['', '一', '两', '三', '四', '五']; // i18n-ignore: rewrites the official Chinese bounty text
/**
 * A bounty text as the card lasts: a multi-round card's "之后的 / 后续每场作战" (rich `<@ba.vdown>每场</>` or plain) reads
 * "接下来<@ba.vup>两场作战</>" like the official two-battle cards while MULTI_ROUND_BOUNTY_BATTLES is set; any other
 * text is returned as is.
 */
export function bountyText(text, c) {
  if (typeof text !== 'string' || !text || !isMultiRoundBounty(c) || !Number.isInteger(MULTI_ROUND_BOUNTY_BATTLES)) return text;
  const n = MULTI_ROUND_BOUNTY_BATTLES;
  const battles = `${N_ZH[n] || n}场作战`; // i18n-ignore
  return text
    .replace(/(?:之后的|后续的?)<@ba\.vdown>每场<\/>作战/g, `接下来<@ba.vup>${battles}</>`)
    .replace(/(?:之后的|后续的?)每场作战/g, `接下来${battles}`);
}

function scheduleFor(gd, round) {
  const sch = gd.choices.schedule && gd.choices.schedule[gd.modeId];
  const r = sch && sch.rounds && sch.rounds[String(round)];
  if (r && typeof r === 'object') return r;
  // fallback: a supply draft
  return { families: [{ family: 'supply', weight: 1 }], cards: gd.isSolo ? 3 : 6, supplyTiers: [1, Math.min(6, 1 + Math.floor(round / 3))] };
}

/**
 * The kind of official 悬赏决策 a round has when its schedule does not say (`bountyDraft`): R3 'initial', R9 'boss',
 * R11 'hunter' (choices.json bountyDrafts; player feedback after 0.1.0, report #2).
 */
export function bountyDraftKind(round) {
  const r = Number(round);
  return r < 8 ? 'initial' : r < 11 ? 'boss' : 'hunter';
}

function formatCount(gd) {
  const f = gd.choices.format || {};
  const multi = f.multi && Number.isInteger(f.multi.cards) ? f.multi.cards : 6;
  const solo = f.solo && Number.isInteger(f.solo.cards) ? f.solo.cards : 3;
  return gd.isSolo ? solo : multi;
}

function eligibleItems(gd, lo, hi) {
  const out = [];
  for (let t = lo; t <= hi; t++) for (const id of gd.shopItemsByTier[t] || []) out.push(id);
  return out;
}

function itemCard(gd, id) {
  const it = gd.item(id);
  return { kind: 'item', id, name: it ? it.name : id, desc: it ? it.desc || '' : '', tier: it && Number.isInteger(it.tier) ? it.tier : 1, price: 0 };
}

/**
 * Build the draft cards for an SP round.
 * `minCards`: how many cards this SQUAD must be able to offer — one per alive member, so nobody ends the phase empty
 * (enterSpDraft passes its member count; the 惊变 phase's own 3 cards are fewer than a 4-member squad, which left the
 * last member without any 惊变 at all — server sweep 2026-10-11, audit 「ends 机变 without a card」).
 * @returns {{ family: string, name: string, desc: string, eventId: string|null, cards: object[] } | null}
 */
export function generateDraft(gd, rng, round, { stageId = null, bondAvailable = null, minCards = 0, exclude = null, onlyHighRarity = false, noCoreBond = false, forceFamily = null, owned = null } = {}) {
  const sch = scheduleFor(gd, round);
  // 炸惊模拟 规则5/6: a round with a phase kind of its own ignores the weighted family draw and the schedule's count —
  // 惊变阶段 (1 and 7) offers `jibian.cards` 惊变 cards, 企鹅物流的快递 (3/6/9, in place of 悬赏决策) `expressCards` equips.
  const forced = gd.spPhaseKind(round);
  const jb = forced === 'jibian' ? gd.jibian() : null;
  let family;
  let n;
  // 追加阶段（炸惊 bountyAfterPhase）：调用方直接指定 family（如 'bounty'），优先于强制的惊变/快递与加权抽卡
  if (forceFamily) { family = forceFamily; n = Number.isInteger(sch.cards) && sch.cards > 0 ? Math.min(sch.cards, 6) : formatCount(gd); }
  // ★ 2026-10-13（用户）：悬赏高阶段（spPhaseKinds 里的 'bountyHigh'）走悬赏家族，牌面按赏金加权。
  else if (forced === 'bountyHigh') { family = 'bounty'; n = Number.isInteger(sch.cards) && sch.cards > 0 ? Math.min(sch.cards, 6) : formatCount(gd); }
  else if (forced === 'express') { family = 'express'; n = gd.expressCards(); }
  else if (forced === 'jibian') { family = 'jibian'; n = jb ? jb.cards : 3; }
  else {
    const fams = Array.isArray(sch.families) && sch.families.length ? sch.families.map((f) => [f.family, f.weight]) : [['supply', 1]];
    family = weightedPick(rng, fams) || 'supply';
    n = Number.isInteger(sch.cards) && sch.cards > 0 ? Math.min(sch.cards, 6) : formatCount(gd);
  }
  const opts = { stageId, bondAvailable, round, exclude, noCoreBond, onlyHighRarity, owned };
  // 每个存活成员都得有牌可拿（见 minCards 的说明）；上限 6 是官方卡池尺寸，只有惊变那种"小池子"会被它抬高
  const want = Math.max(1, Math.trunc(Number(minCards) || 0));
  if (want > n) n = Math.min(6, want);
  let cards = buildCards(gd, rng, family, n, sch, opts) || [];
  // a forced phase never falls back to 道具补给: nothing to offer (an empty 惊变 pool) skips the phase instead
  if (!cards.length && !forced && family !== 'supply') { family = 'supply'; cards = buildCards(gd, rng, family, n, sch, opts) || []; }
  if (!cards.length) return null;
  cards.forEach((c, i) => { c.idx = i; c.family = family; });
  const famInfo = gd.choices.families && gd.choices.families[family];
  const events = sch.events && Array.isArray(sch.events[family]) ? sch.events[family] : [];
  const eventId = events.length ? events[Math.floor(rng() * events.length)] : null;
  return { family, name: famInfo && famInfo.name ? famInfo.name : FAMILY_NAMES[family] || family, desc: famInfo && famInfo.desc ? famInfo.desc : '', eventId, cards };
}

/** Bond granted by a 驰援 tactic card (effect buff single_special_choice_gain_bond_chess), else null. */
export function reinforcementBond(gd, effectId) {
  const eff = gd.effect(effectId);
  const buffs = eff && Array.isArray(eff.buffs) ? eff.buffs : [];
  const b = buffs.find((x) => x && x.key === 'single_special_choice_gain_bond_chess');
  return b && b.bbStr && typeof b.bbStr.bond === 'string' ? b.bbStr.bond : null;
}

/**
 * Bonds a tactic card only acts on: the 驰援 bond (single_special_choice_gain_bond_chess) and the bonds of a 盟誓 card
 * (global_special_choice_bond_addlayer bond_list). null when the card does anything else (it is always useful).
 */
export function cardTargetBonds(gd, effectId) {
  const eff = gd.effect(effectId);
  const buffs = eff && Array.isArray(eff.buffs) ? eff.buffs.filter(Boolean) : [];
  if (!buffs.length) return null;
  const out = [];
  for (const b of buffs) {
    const bs = b.bbStr || {};
    if (b.key === 'single_special_choice_gain_bond_chess' && typeof bs.bond === 'string') out.push(bs.bond);
    else if (b.key === 'global_special_choice_bond_addlayer') out.push(...String(bs.bond_list || '').split(',').map((x) => x.trim()).filter(Boolean));
    else return null;
  }
  return out.length ? out : null;
}

/**
 * A bounty card the 悬赏决策 draft may offer (choices.json cards.bounty `draft`, tools/build-data.mjs
 * bountyDraftExclusion: no 战术特训, no 鸭爵 set — user playtest #6 item 4 —, nothing no official draft showed — player
 * feedback #2). Data without the flag (older builds, test fixtures) falls back to the kill bounties. With `kind`
 * ('initial' | 'boss' | 'hunter') the card must also belong to that kind of draft (choices.json `draftPool`; a card
 * without one — test fixtures — fits every kind).
 */
export function draftBounty(c, kind = null, zhajing = false) {
  if (!c) return false;
  // ★ 2026-10-17（用户：「悬赏怪卡池我只要炸惊的改成那样啊 怎么普通也改了」）：
  //   击杀金币 `coin` < 3 的悬赏卡**只在炸惊模式**完全剔除；普通难度保持原样（全部悬赏都能出现）。
  //   第一版漏了这个限定，普通模式也被筛掉了，用户当场发现。
  if (zhajing) {
    const coin = Number(c.coin);
    if (Number.isFinite(coin) && coin < 3) return false;
  }
  if (kind != null && typeof c.draftPool === 'string' && c.draftPool !== kind) return false;
  if (typeof c.draft === 'boolean') return c.draft;
  return c.payout !== 'perfect';
}

/** The draft card of a cards.bounty entry (the official rich text, a multi-round card's battles and text rewritten). */
export function bountyCard(gd, c) {
  const eff = typeof gd.effect === 'function' ? gd.effect(c.effectId) : null;
  return {
    kind: 'bounty', id: c.effectId, name: c.name, desc: bountyText(c.desc || '', c), descRaw: bountyText((eff && eff.descRaw) || null, c), tier: c.tier, coin: c.coin,
    payout: c.payout, rounds: bountyBattles(c), enemyKey: c.enemyKey, count: c.count,
  };
}

/** Up to `k` cards of `list` not in `taken`, in a shuffled order. */
function drawDistinct(rng, list, k, taken) {
  const out = [];
  for (const c of rng.shuffle(list.slice())) {
    if (out.length >= k) break;
    if (taken.has(c)) continue;
    out.push(c);
    taken.add(c);
  }
  return out;
}

/** `k` different entries of `list` drawn one by one with weights `weights` (missing / bad weights count 1). */
function drawWeighted(rng, list, weights, k) {
  const pool = list.map((c, i) => [c, Math.max(0, Number(weights && weights[i]) || 1)]);
  const out = [];
  while (out.length < k && pool.length) {
    const c = weightedPick(rng, pool);
    out.push(c);
    pool.splice(pool.findIndex(([x]) => x === c), 1);
  }
  return out;
}

/**
 * The cards of an unseen R3 set (`spec.rule`, [ASSUMED]): one card per tier of `tiers` from the two-battle cards of
 * `series`, at most `perSeries` of one series; a tier the `prefer` cards have is filled first, by one of them.
 */
function initialRuleSet(rng, rule, all) {
  const out = [];
  const perSeries = Number.isInteger(rule.perSeries) ? rule.perSeries : 1;
  const ofSeries = (s) => out.filter((c) => c.series === s).length;
  const prefer = new Set(Array.isArray(rule.prefer) ? rule.prefer : []);
  const series = new Set(Array.isArray(rule.series) ? rule.series : []);
  // the tiers a preferred card has go first, so that it still fits its series
  const prefTiers = new Set(all.filter((c) => prefer.has(c.effectId)).map((c) => c.tier));
  const tiers = rng.shuffle((Array.isArray(rule.tiers) ? rule.tiers : []).slice());
  for (const tier of [...tiers.filter((t) => prefTiers.has(t)), ...tiers.filter((t) => !prefTiers.has(t))]) {
    const ok = (c) => !out.includes(c) && c.tier === tier && series.has(c.series) && ofSeries(c.series) < perSeries;
    const pref = all.filter((c) => prefer.has(c.effectId) && ok(c));
    const c = rng.pick(pref.length ? pref : all.filter(ok));
    if (c) out.push(c);
  }
  return out;
}

/**
 * Fill an R11 list up to `rule.size` (an unseen event: from nothing; a seen group: its `open` cards) [ASSUMED]: a list
 * without a 特异III giant gets one, the rest are tier I / II cards, at most one per `onePerSeries` series and
 * `maxSeries16` of series 16.
 */
function hunterFill(rng, rule, list, byId) {
  const out = list.slice();
  const size = Number.isInteger(rule.size) ? rule.size : 7;
  const giants = (Array.isArray(rule.giants) ? rule.giants : []).map((id) => byId.get(id)).filter(Boolean);
  const onePer = new Set(Array.isArray(rule.onePerSeries) ? rule.onePerSeries : []);
  const max16 = Number.isInteger(rule.maxSeries16) ? rule.maxSeries16 : 2;
  if (out.length < size && !out.some((c) => giants.includes(c))) { const g = rng.pick(giants.filter((c) => !out.includes(c))); if (g) out.push(g); }
  const fits = (c) => !out.includes(c) && (onePer.has(c.series) ? !out.some((x) => x.series === c.series) : c.series !== 16 || out.filter((x) => x.series === 16 && !giants.includes(x)).length < max16);
  for (const c of rng.shuffle((Array.isArray(rule.cards) ? rule.cards : []).map((id) => byId.get(id)).filter(Boolean))) {
    if (out.length >= size) break;
    if (fits(c)) out.push(c);
  }
  return out;
}

/**
 * The cards of a 悬赏决策 of kind `kind` after its official card lists (choices.json `bountyDrafts[kind]`, see the module
 * header), over the eligible cards `byId` (effectId → cards.bounty entry). Ids the eligible list lacks are skipped.
 *   pick 'slot': one of `slots` events, uniform — a seen group, or for an unseen event a list built by `rule` (R3's
 *               10th set; R11 has `slots` = its 7 seen lists, so none is built);
 *   pick 'seen': a group by the number of official matches it came in.
 * The draft is `count` different cards of the list drawn by the group's `weights` (a rule-built card weighs 1).
 */
function structuredBounty(rng, kind, spec, byId) {
  const count = Number.isInteger(spec.count) ? spec.count : 6;
  const groups = Array.isArray(spec.groups) ? spec.groups : [];
  let group = null;
  if (spec.pick === 'seen') {
    group = weightedPick(rng, groups.map((g) => [g, (Array.isArray(g.seen) ? g.seen.filter((x) => Number.isInteger(x)).length : 0) || 1]));
  } else {
    const slots = Math.max(groups.length, Number.isInteger(spec.slots) ? spec.slots : 0);
    const slot = slots > 0 ? rng.int(slots) : 0;
    group = slot < groups.length ? groups[slot] : null;
  }
  const rule = spec.rule || {};
  let list;
  let weights;
  if (group) {
    const ids = Array.isArray(group.cards) ? group.cards : [];
    list = [];
    weights = [];
    ids.forEach((id, i) => { const c = byId.get(id); if (c) { list.push(c); weights.push(Array.isArray(group.weights) ? group.weights[i] : 1); } });
    if (kind === 'hunter' && Number(group.open) > 0) list = hunterFill(rng, { ...rule, size: list.length + Number(group.open) }, list, byId);
  } else if (kind === 'initial') {
    list = initialRuleSet(rng, rule, [...byId.values()]);
  } else if (kind === 'hunter') {
    list = hunterFill(rng, rule, [], byId);
  } else {
    list = [];
  }
  return drawWeighted(rng, list, weights, count);
}

/**
 * Build `n` 悬赏决策 cards for `round` (module header): the official structure of the round's kind, topped up with other
 * eligible cards of that kind when it falls short (test fixtures with a restricted card list), shuffled into place —
 * the official card positions vary — and cut to `n` (solo 3 [ASSUMED]).
 */
function bountyDraftCards(gd, rng, n, sch, round) {
  const kind = typeof sch.bountyDraft === 'string' ? sch.bountyDraft : bountyDraftKind(round);
  const all = Array.isArray(gd.choices.cards && gd.choices.cards.bounty) ? gd.choices.cards.bounty : [];
  const eligible = all.filter((c) => c && draftBounty(c, kind, !!gd.zhajing) && gd.enemy(c.enemyKey));
  const byId = new Map(eligible.map((c) => [c.effectId, c]));
  const spec = gd.choices.bountyDrafts && gd.choices.bountyDrafts[kind];
  const out = spec ? structuredBounty(rng, kind, spec, byId) : [];
  const taken = new Set(out);
  if (out.length < n) out.push(...drawDistinct(rng, eligible, n - out.length, taken));
  return rng.shuffle(out).slice(0, n).map((c) => bountyCard(gd, c));
}

/**
 * The 机密商店 cards (choices.json `shopDraft`, module header): every slot drawn on its own — a tier (or `coin`, the
 * 盟约之币) by the slot's weights, then an item of that tier by `itemWeights` (1 when unlisted; an empty tier falls back to
 * the nearest lower one, then any) — so one item can fill two slots. Positions shuffled; `n` < the slots (solo) keeps
 * `n` of them. Null without a usable `shopDraft` or at a round its `rounds` (when given) does not list.
 */
export function shopDraftCards(gd, rng, n, round = null) {
  const spec = gd.choices.shopDraft;
  const slots = spec && Array.isArray(spec.slots) ? spec.slots.filter((x) => x && typeof x === 'object') : [];
  if (!slots.length) return null;
  if (Array.isArray(spec.rounds) && !spec.rounds.includes(round)) return null;
  const w = spec.itemWeights && typeof spec.itemWeights === 'object' ? spec.itemWeights : {};
  const coin = typeof spec.coin === 'string' && gd.item(spec.coin) ? spec.coin : null;
  const ofTier = (t) => {
    for (let k = t; k >= 1; k--) if ((gd.shopItemsByTier[k] || []).length) return gd.shopItemsByTier[k];
    return eligibleItems(gd, 1, 6);
  };
  const out = [];
  for (const slot of slots) {
    const kinds = Object.entries(slot).filter(([k]) => k === 'coin' ? !!coin : Number.isInteger(Number(k)));
    const kind = weightedPick(rng, kinds);
    if (kind == null) continue;
    const list = kind === 'coin' ? [coin] : ofTier(Number(kind));
    const id = weightedPick(rng, list.map((x) => [x, Object.hasOwn(w, x) ? w[x] : 1]));
    if (id) out.push(itemCard(gd, id));
  }
  return rng.shuffle(out).slice(0, Math.max(0, n));
}

/** The draft card of a cards.tactic entry. */
export function tacticCard(c) {
  return { kind: 'tactic', id: c.effectId, name: c.name, desc: c.desc || '', tier: null, team: !!c.team, tacticKind: c.kind };
}

/**
 * The 战术决策 cards (module header): `n` cards, each drawn on its own — with replacement, so one card can fill two places
 * (official R11 of match 7: 补给 ×2). At the rounds of choices.json `tacticDraft` (`rounds`; R11) only the cards of its
 * `kinds` (ally), each by `weights` (1 when unlisted); elsewhere — or when those kinds leave nothing — every card, uniform.
 * Terrain cards only for the match stage; a card whose every target bond is dead in this match (mode-inactive, or no
 * chess left in the pool: `bondAvailable`) is never offered.
 */
export function tacticDraftCards(gd, rng, n, { stageId = null, bondAvailable = null, round = null } = {}) {
  const bondOk = (c) => {
    if (typeof bondAvailable !== 'function') return true;
    const bonds = cardTargetBonds(gd, c.effectId);
    return !bonds || bonds.some((b) => !!bondAvailable(b));
  };
  const list = Array.isArray(gd.choices.cards && gd.choices.cards.tactic) ? gd.choices.cards.tactic : [];
  const pool = list.filter((c) => c && (c.kind !== 'terrain' || (stageId && c.stageId === stageId)) && gd.effect(c.effectId) && bondOk(c));
  const spec = gd.choices.tacticDraft && typeof gd.choices.tacticDraft === 'object' ? gd.choices.tacticDraft : null;
  const official = !!spec && (!Array.isArray(spec.rounds) || spec.rounds.includes(round));
  const kinds = official && Array.isArray(spec.kinds) && spec.kinds.length ? spec.kinds : null;
  const w = official && spec.weights && typeof spec.weights === 'object' ? spec.weights : {};
  const ofKinds = kinds ? pool.filter((c) => kinds.includes(c.kind)) : pool;
  const pairs = (ofKinds.length ? ofKinds : pool).map((c) => [c, Object.hasOwn(w, c.effectId) ? w[c.effectId] : 1]);
  const out = [];
  for (let i = 0; i < n && pairs.length; i++) out.push(tacticCard(weightedPick(rng, pairs)));
  return out;
}

/**
 * 炸惊模拟 规则6 — 企鹅物流的快递 (rounds 3/6/9, in place of 悬赏决策): `n` equips drawn WITH replacement from the mode's
 * `expressPool` — the items carrying a `giveBondId`, i.e. the ones that turn a 变形同构体 wearer into a member of their
 * bond (转职). Repeatable on purpose (one item may fill two of the six places); choices.json `shopDraft.itemWeights`
 * gives the weights when it lists one, 1 otherwise. Null without a pool, so the round falls through to the prep.
 */
export function expressDraftCards(gd, rng, n) {
  // ★ 2026-10-11（用户）：每格 5% 概率直接放【变形同构体】chess_item_6_09_e_a ——
  //   它给被变形的干员授予一条随机盟约，按纯权重抽太罕见。
  const GUISE_ITEM = 'chess_item_6_09_e_a';
  const pool = gd.expressPool();
  if (!pool.length) return null;
  const spec = gd.choices.shopDraft;
  const w = spec && spec.itemWeights && typeof spec.itemWeights === 'object' ? spec.itemWeights : {};
  const pairs = pool.map((id) => [id, Object.hasOwn(w, id) ? w[id] : 1]);
  const groups = typeof gd.expressGroups === 'function' ? gd.expressGroups() : {};
  const out = [];
  for (let i = 0; i < n && pairs.length; i++) {
    const picked = weightedPick(rng, pairs);

    if (rng() < 0.05 && pool.includes(GUISE_ITEM)) {
      out.push(GUISE_ITEM);
      continue;
    }
    // 用户 2026-10-11：维多利亚战锤合并成一格 —— 抽中这一格之后再在几种战锤里随机一种投放到前台，
    // 于是「抽到战锤」的总概率和其它单件装备（炎国短刀等）完全一致（以前 5/18 ≈ 28%，现在 1/17 ≈ 6%）。
    const g = Array.isArray(groups[picked]) ? groups[picked] : null;
    const id = g && g.length ? g[Math.min(g.length - 1, Math.floor(rng() * g.length))] : picked;
    out.push(itemCard(gd, id));
  }
  return out;
}

/**
 * The draft card of one 惊变 entry of config `modes[*].jibian.pool`. The entry may carry its own `kind`; otherwise the
 * id decides — an effectId (an effect the pick applies, the 机变 card pipeline) or an item id (granted to the picker).
 * @param {any} gd
 * @param {{ id?: string, effectId?: string, key?: string, name?: string, desc?: string, rarity?: string, tier?: number, kind?: string }} c
 * @param {string|null} rarity the rarity rolled for this place (rules 5: rolled first, then the card of that rarity) —
 *   used **only as a fallback** when the pool entry carries no `rarity` of its own (see below).
 *
 * ★ 2026-10-16 修 bug（玩家反馈「敌方惊变的稀有度会显示错误」）：
 *   原来是 `rarity: rarity || c.rarity || null` —— **抽到的品质压过了卡自己的品质**。
 *   而"先 roll 品质、再取该品质的卡"这一步在**该品质已被抽空**时会回落到整池
 *   （`list = ofRarity.length ? ofRarity : pool`，见本文件下方的玩家侧抽取与 match/phases.js enterEnemyJibian）。
 *   池子里**根本没有 `rare` 卡**，所以旧权重下每次 roll 到 `rare`（25%）都会回落抽出一张史诗/传说，
 *   却被贴上 `rare` 标签 —— 卡面就成了「稀有的传说卡」。
 *   现在**卡自己的 `c.rarity` 优先**（卡的真实品质才是显示口径），roll 出来的品质只在池子条目没写品质时兜底。
 *   本文件 493-495 行那段注释（为「投资未来」收窄权重）描述的就是这个现象，这里从根源上修掉它。
 */
export function jibianCard(gd, c, rarity = null, bonds = null) {
  const id = c.id || c.effectId || c.key || null;
  const eff = id ? gd.effect(id) : null;
  const it = id ? gd.item(id) : null;
  return {
    kind: c.kind || (eff ? 'tactic' : it ? 'item' : 'jibian'),
    id,
    name: c.name || (eff && eff.name) || (it && it.name) || String(id || '惊变'),
    desc: c.desc || (eff && eff.desc) || (it && it.desc) || '',
    tier: Number.isInteger(c.tier) ? c.tier : (it && Number.isInteger(it.tier) ? it.tier : null),
    // ★ 卡自己的品质优先（见上方 2026-10-16 的说明）：池子条目没写品质时才用 roll 出来的兜底。
    rarity: (typeof c.rarity === 'string' && c.rarity) ? c.rarity : (rarity || null),
    // 惊变: the grey flavour line printed at the card's bottom (config modes[*].jibian.pool `flavor`)
    flavor: c.flavor || (eff && eff.flavor) || null,
    // 盟约惊变 (用户 2026-10-12): 卡面图标用对应盟约的头像（config pool `bond` → ui/choiceOverlay.js bondIconUrl）
    bond: c.bond || null,
    // Presentation-only glyph: does not impose a gameplay bond restriction.
    iconBond: c.iconBond || null,
    // 惊变羁绊：卡面底部显示「羁绊名 已有/阈值」（owner 2026-10-19 的 UI 要求）
    bonds: Array.isArray(bonds) && bonds.length ? bonds : null,
  };
}

/**
 * 炸惊模拟 规则5 — 惊变阶段 (rounds 1 and 7): `n` 惊变 cards. The rarity is rolled FIRST (mode.jibian.rarityWeights:
 * 普通 45 / 稀有 25 / 史诗 20 / 传说 10) and a card of that rarity is then drawn from the mode's own pool; a rarity the pool has
 * nothing left of falls back to the pool as a whole (never an empty card). An empty pool returns null: the card list is
 * supplied separately from this mechanism, and until it is, the phase falls through to the prep.
 */
export function jibianDraftCards(gd, rng, n, exclude = null, { noCoreBond = false, onlyHighRarity = false, owned = null } = {}) {
  // ★ 2026-10-19：羁绊进度要用「真正拥有」的集合；exclude 里还包含被刷新掉/摆在三选一里的卡。
  const ownedSet = owned instanceof Set ? owned : Array.isArray(owned) ? new Set(owned) : (exclude instanceof Set ? exclude : new Set(exclude || []));
  const j = gd.jibian();
  if (!j || !j.pool.length) return null;
  // 隐藏规则（用户 2026-10-12，不上界面）：没有激活任何核心盟约的玩家，**「带核心盟约的传说惊变」**的抽取概率
  // 提升到 gd.jibian().noCoreBondLegendWeight（默认 30%）。**只对这一类生效**——其余卡照 rarityWeights 抽。
  // 为了让这一类的总概率正好是目标值，正常口径里的传说档会排除掉带核心盟约的那几张（它们由这条专门负责）；
  // 非核心的传说（超大杯、捐赠、潘多拉魔盒…）仍然抽得到，只是份额变成 (1-p)×原权重。
  const boost = noCoreBond ? Math.max(0, Math.min(100, Number(j.noCoreBondLegendWeight) || 0)) : 0;
  const isCoreLegend = (c) => {
    if (!c || c.rarity !== 'legend' || typeof c.bond !== 'string') return false;
    const rec = gd.bond(c.bond);
    return !!(rec && rec.isCore === true);
  };
  // 用户 2026-10-11：惊变牌库里每张卡只有一张 —— 这名玩家已经抽到过（或被重投掉）的卡不再出现；
  // 同一批三张之间也不重复（以前是 with replacement，会抽出重复的卡）。
  const banned = exclude instanceof Set ? exclude : new Set(Array.isArray(exclude) ? exclude : []);
  const keyOf = (c) => (c && (c.effectId || c.id || c.key)) || null;
  let pool = j.pool.filter((c) => c && !banned.has(keyOf(c)));
  // ★ 2026-10-14 惊变「投资未来」(jibian_touziweilai)：本阶段的可选卡只生成史诗/传说品质。
  //   直接过滤池子（而不是把 normal/rare 的权重置 0）—— 权重为 0 时 weightedPick 仍可能落到
  //   别的档、再被 `list = ofRarity.length ? ofRarity : pool` 回落成全池，过滤池子才是硬保证。
  //   池子里这两档被抽空时保持"只剩 epic/legend"，不会回落出低品质卡。
  // ★ 2026-10-25：我方惊变新增「隐秘」档 —— 投资未来（只看史诗/传说）也要把隐秘算进高档位
  if (onlyHighRarity) pool = pool.filter((c) => c && (c.rarity === 'epic' || c.rarity === 'legend' || c.rarity === 'hidden'));
  // 权重也要同步收窄：只过滤池子的话，roll 到 normal/rare 时 ofRarity 为空 → 回落 pool 抽到一张
  // 史诗/传说卡，却被 jibianCard 标上 roll 出来的 normal/rare（规则5 的品质是"先 roll 再取卡"），
  // 卡面品质标签就会和卡本身不符。收窄后 roll 与卡一致。
  const weights = onlyHighRarity
    ? j.rarityWeights.filter(([r]) => r === 'epic' || r === 'legend' || r === 'hidden')
    : j.rarityWeights;
  const useWeights = weights.length ? weights : j.rarityWeights;
  const out = [];
  // ★ 2026-10-19 本地验证用：SP_JIBIAN_FORCE=<effectId> 时把这张惊变卡强制放进这一批草稿的第一位。
  //   只在设了环境变量时生效（线上不设 → 行为与以前完全一致），方便本地立刻看到新卡。
  const forcedId = String(process.env.SP_JIBIAN_FORCE || '').trim();
  if (forcedId) {
    const hit = pool.find((c) => c && (c.effectId || c.id || c.key) === forcedId);
    if (hit) {
      out.push(jibianCard(gd, hit, hit.rarity || 'rare'));
      pool = pool.filter((c) => c !== hit);
    }
  }
  for (let i = out.length; i < n && pool.length; i++) {
    // ① 隐藏规则：带核心盟约的传说惊变 —— 概率直接给到 boost%（池子里还有这类卡时）
    if (boost > 0 && rng() * 100 < boost) {
      const list = pool.filter(isCoreLegend);
      if (list.length) {
        const card = list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
        pool = pool.filter((c) => c !== card);
        out.push(jibianCard(gd, card, 'legend', bondHintsFor(keyOf(card), ownedSet)));
        continue;
      }
    }
    // ② 正常口径：四档权重；规则生效时传说档排除「带核心盟约的」那几张（避免这一类被重复计算）
    const rarity = weightedPick(rng, useWeights);
    let ofRarity = pool.filter((c) => c && c.rarity === rarity);
    if (boost > 0 && rarity === 'legend') {
      const rest = ofRarity.filter((c) => !isCoreLegend(c));
      if (rest.length) ofRarity = rest;
    }
    const list = ofRarity.length ? ofRarity : pool;
    const card = list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
    pool = pool.filter((c) => c !== card);
    out.push(jibianCard(gd, card, rarity, bondHintsFor(keyOf(card), ownedSet)));
  }
  return out.length ? out : null;
}

function buildCards(gd, rng, family, n, sch, { stageId = null, bondAvailable = null, round = 1, exclude = null, onlyHighRarity = false, noCoreBond = false, owned = null } = {}) {
  if (family === 'bounty') return bountyDraftCards(gd, rng, n, sch, round);
  if (family === 'express') return expressDraftCards(gd, rng, n);
  if (family === 'jibian') return jibianDraftCards(gd, rng, n, exclude, { noCoreBond, onlyHighRarity, owned });
  if (family === 'shop') {
    const cards = shopDraftCards(gd, rng, n, round);
    if (cards) return cards;
  }
  if (family === 'supply' || family === 'shop') {
    let lo = 1;
    let hi = 6;
    if (family === 'supply' && Array.isArray(sch.supplyTiers) && sch.supplyTiers.length === 2) [lo, hi] = sch.supplyTiers;
    let list = eligibleItems(gd, lo, hi);
    if (!list.length) list = eligibleItems(gd, 1, 6);
    const out = [];
    for (let i = 0; i < n && list.length; i++) out.push(itemCard(gd, list[Math.floor(rng() * list.length)]));
    return out;
  }
  if (family === 'tactic') return tacticDraftCards(gd, rng, n, { stageId, bondAvailable, round });
  return [];
}

/** Public card view. */
export function cardView(c) {
  const v = { idx: c.idx, kind: c.kind, id: c.id, name: c.name, desc: c.desc, tier: c.tier ?? null };
  if (c.kind === 'bounty') Object.assign(v, { descRaw: c.descRaw ?? null, coin: c.coin, payout: c.payout, rounds: c.rounds, enemyKey: c.enemyKey, count: c.count });
  if (c.kind === 'item') v.price = 0;
  if (c.kind === 'tactic') Object.assign(v, { team: c.team, tacticKind: c.tacticKind });
  if (c.rarity) v.rarity = c.rarity; // 规则5: the 惊变 card's rarity (rolled before the card itself)
  if (c.flavor) v.flavor = c.flavor; // 惊变: the grey flavour line
  if (c.bond) v.bond = c.bond;       // 盟约惊变: 卡面图标用这个盟约的头像 (jibianCard → choiceOverlay)
  if (c.iconBond) v.iconBond = c.iconBond;
  if (Array.isArray(c.bonds) && c.bonds.length) v.bonds = c.bonds;
  if (c.rerolled) v.rerolled = true;   // ★ 2026-10-19 刷新改为每卡一次   // ★ 2026-10-19 惊变羁绊：卡面底部「羁绊名 已有/阈值」
  return v;
}


/** 玩家当前拥有的惊变 effectId 集合。 */
function ownedJibianIds(ps) {
  const out = new Set();
  const refs = Array.isArray(ps?.effects) ? ps.effects : ps?.playerEffects || [];
  for (const ref of refs) {
    const k = ref && ref.key;
    if (typeof k === 'string' && k.startsWith('jibian:')) out.add(k.slice(7));
  }
  return out;
}

/** 羁绊刚凑齐时发卡的对照表（owner 的「叙拉古人的愤怒 / 惊动军方」）。 */
const BOND_GRANTS = Object.freeze({
  siracusa_wrath: ['chess_zj_90_b', 'chess_zj_57_b'],   // 精锐荒芜拉普兰德 + 精锐缄默德克萨斯
  army_alert: ['chess_zj_74_b'],                        // 精锐望
  // 集成战略爱好者：每次达到一个新档位，发一张未拥有的藏品类惊变。
  roguelike_fan: [],
});

/**
 * 抽卡结算后调用：把「这一抽刚刚凑齐」的羁绊对应的卡发下去。
 * @param {any} ps
 * @param {Map<string, number>} before 抽卡前已激活的羁绊及阈值
 */
function jibianGrantForBond(m, ps, before) {
  try {
    const seen = new Map(before);
    // 奖励卡也可能凑齐其它羁绊，继续结算，且同一档只发放一次。
    for (let pass = 0; pass < 40; pass++) {
      const now = jibianBondsActive(ownedJibianIds(ps)).filter(a => a.tier > (seen.get(a.def.id) || 0));
      if (!now.length) break;
      for (const a of now) seen.set(a.def.id, a.tier);
      for (const a of now) {
        const ids = BOND_GRANTS[a.def.id];
        for (const id of ids || []) {
          try { ps.acquireChess(id, { source: 'bond', fromPool: false }); } catch { /* 池子/手牌满：跳过 */ }
        }
        // ★ 2026-10-21（owner）：真·投资人 —— 「返还触发前消耗的所有资金」。
        //   凑齐羁绊的那一刻，把本局已经花掉的钱一次性退回（stats.gold 就是「挥金如土」统计的累计支出）。
        //   羁绊只会激活一次（before/after 差集），所以天然不会重复返还。
        if (a.def.id === 'true_investor') {
          try {
            const refund = Math.max(0, Math.floor(Number(ps.stats && ps.stats.gold) || 0));
            if (refund > 0) {
              ps.addFunds(refund, { reason: 'jibian:true_investor' });
              try { m.toast(ps, 'info', `“真·投资人”：返还本局消耗的 ${refund} 资金`); } catch { /* toast 失败不影响 */ }
            }
          } catch { /* 返还失败不影响抽卡 */ }
        }
        // 集成战略爱好者：随机发未获得过的「藏品类」惊变（成员即藏品）
        if (a.def.id === 'roguelike_fan') {
          try {
            const owned = ownedJibianIds(ps);
            // ★ 2026-10-23（owner）：「羁绊之力」属于所有羁绊，但不能被这张羁绊的奖励抽出来
            //   （否则它自己又会给所有羁绊 +1 人，滚雪球）。
            const pool = a.def.members.filter((id) => id !== 'jibian_jibangzhili' && !owned.has(id));
            // ★ 2026-10-28（owner）：二档（6 张）也只给一张，不是两张
            for (let k = 0; k < 1 && pool.length; k++) {
              const pick = pool.splice(Math.floor(m.rngDraft() * pool.length), 1)[0];
              // ★ 2026-10-22（owner）：带上卡面数据（name/desc/rarity/flavor）。
              //   原来只传 id，effectsView 的兜底 `name: e.name || e.id` 会把内部 id（如 jibian_xxx#4）
              //   直接显示在「已选惊变」卡面上，品质也退化成普通。
              let full = null;
              try {
                const jb = typeof m.gd.jibian === 'function' ? m.gd.jibian() : null;
                const c = jb && Array.isArray(jb.pool)
                  ? jb.pool.find((x) => x && (x.effectId === pick || x.id === pick || x.key === pick))
                  : null;
                if (c) full = jibianCard(m.gd, c);
              } catch { /* 拿不到就用裸 id */ }
              const card = full
                ? { ...full, kind: 'jibian', id: pick, effectId: pick, family: 'jibian' }
                : { kind: 'jibian', id: pick, effectId: pick, family: 'jibian', name: pick, rarity: null, flavor: null, note: null };
              applyDefault(m, ps, card);
              // ★ 2026-10-23（owner 反馈「投资未来不生效」）：羁绊奖励发的卡也要跑一次 onChoicePick，
              //   否则「投资未来」这种**即时**效果通过「集成战略爱好者」发出来时永远不会种下计数器。
              //   口径与 applyCard 一致：跳过 choice:<id> 键，只跑该玩家 refs 上的钩子。
              try {
                const ev = { card: { ...card }, family: 'jibian', picker: ps.playerId, forTeammate: false };
                m.dispatch(ps, 'onChoicePick', ev, { skipKey: `choice:${card.id}` });
                ps.recompute();
              } catch { /* 即时效果失败不影响发卡 */ }
            }
          } catch { /* 发惊变失败不影响抽卡 */ }
        }
      }
    }
  } catch { /* 羁绊发卡绝不能拖垮抽卡 */ }
}

/**
 * Apply a picked card to a player (registry override → family default). Team tactic cards are applied to every
 * alive teammate as well.
 * @param {import('./Match.js').Match} m
 * @param {import('./PlayerState.js').PlayerState} ps
 */
export function applyCard(m, ps, card) {
  const targets = card.kind === 'tactic' && card.team ? [ps, ...m.alivePlayers().filter((p) => p !== ps)] : [ps];
  for (const p of targets) {
    const bondBefore = new Map(jibianBondsActive(ownedJibianIds(p)).map(a => [a.def.id, a.tier]));
    const ev = { card: { ...card }, family: card.family, picker: ps.playerId, forTeammate: p !== ps };
    const handled = m.dispatcher.runKey(p, `choice:${card.id}`, 'onChoicePick', { kind: 'choice', card }, ev);
    if (!handled) applyDefault(m, p, card);
    // every other source observes the pick (the card's own key already ran above)
    m.dispatch(p, 'onChoicePick', ev, { skipKey: `choice:${card.id}` });
    p.recompute();
    jibianGrantForBond(m, p, bondBefore);   // ★ 羁绊刚凑齐 → 发精锐卡
  }
}

function applyDefault(m, ps, card) {
  const gd = m.gd;
  // 炸惊模拟 惊变阶段: a 惊变 card carries no effects.json record — it is its own mechanic. It lands in the player's
  // effects column (so 已选惊变 and the battle side can both read it) under the `jibian:` key prefix, which
  // server/sim/content/jibian.js resolves. Re-picking stacks (each ref has its own uid).
  if (card.kind === 'jibian') {
    addRef(ps, card, null, `jibian:${card.id}`, {
      battle: true,
      extra: { jibian: true, rarity: card.rarity ?? null, flavor: card.flavor ?? null, note: card.note ?? null,
        ...(card.iconBond ? { iconBond: card.iconBond } : {}) },
    });
    return;
  }
  if (card.kind === 'bounty') {
    const src = (gd.choices.cards && Array.isArray(gd.choices.cards.bounty) ? gd.choices.cards.bounty : []).find((c) => c.effectId === card.id) || card;
    m.addBounty(ps, src);
    return;
  }
  if (card.kind === 'item') {
    ps.acquireItem(card.id, { source: 'choice' });
    return;
  }
  if (card.kind !== 'tactic') return;
  const eff = gd.effect(card.id);
  const buffs = eff && Array.isArray(eff.buffs) ? eff.buffs : [];
  let handled = false;
  let battle = false;
  for (const b of buffs) {
    const bb = b.bb || {};
    const bs = b.bbStr || {};
    const count = Number.isInteger(bb.count) ? bb.count : 1;
    switch (b.key) {
      case 'global_special_choice_gain_equip': {
        for (let i = 0; i < count; i++) {
          const id = m.rollItemId({ pool: bs.pool });
          if (id) ps.acquireItem(id, { source: 'choice' });
        }
        handled = true;
        break;
      }
      case 'global_special_choice_bond_addlayer': {
        const bonds = String(bs.bond_list || '').split(',').map((s) => s.trim()).filter(Boolean);
        for (const bid of bonds) ps.addLayers(bid, count, { requireActive: false, reason: 'choice' });
        handled = true;
        break;
      }
      case 'global_special_choice_gain_coin':
        ps.addFunds(count, { reason: 'choice' });
        handled = true;
        break;
      case 'global_special_choice_refresh_free':
        ps.shop.freeRefreshes += count;
        ps.dirty();
        handled = true;
        break;
      case 'single_special_choice_gloden_equip_chess':
        addRef(ps, card, eff, 'effect:builtin_next_buy_golden_item', { counter: count, battle: false });
        handled = true;
        break;
      case 'single_special_choice_gloden_char_chess':
        addRef(ps, card, eff, 'effect:builtin_next_buy_elite', { counter: count, battle: false });
        handled = true;
        break;
      case 'single_special_choice_gain_bond_chess': {
        // the player's 自选 stock joins the draw, its bonds read through the player's view (player/diy.js diyStockEntries)
        const pgd = ps.gd || gd;
        const hasBond = (cid) => { const c = pgd.chess(cid); return !!(c && Array.isArray(c.bonds) && c.bonds.includes(bs.bond)); };
        for (let i = 0; i < count; i++) {
          // 100-seat variant: this player's own pool (its 自选 slots are ordinary entries, so no `extra`).
          const own = typeof ps.pool === 'function' ? ps.pool() : m.pool;
          const id = own.roll(m.rngMeta, { maxTier: Math.max(1, ps.shop.level), filter: hasBond })
            || own.roll(m.rngMeta, { maxTier: 6, filter: hasBond });
          if (id) ps.acquireChess(id, { source: 'choice' });
        }
        handled = true;
        break;
      }
      case 'auto_chess_change_map': {
        for (const [alias, v] of Object.entries(bb)) if (alias.includes('#')) ps.deviceOverrides[alias] = Number(v) !== 0;
        ps.invalidateDeployMap();
        battle = true;
        break;
      }
      case 'global_special_choice_all_activated':
        break;
      default:
        battle = true;
    }
  }
  if (battle || !handled) addRef(ps, card, eff, `choice:${card.id}`, { battle: true });
}

function addRef(ps, card, eff, key, { counter = null, battle = true, extra = null } = {}) {
  const id = `${card.id}#${ps.m.nextUid()}`;
  ps.effects.push({
    id, key, name: card.name, desc: card.desc, iconKind: card.team ? 'team' : 'choice', iconId: eff && eff.decoIconId ? eff.decoIconId : card.id,
    counter, battle, params: eff && eff.params ? { ...eff.params } : {}, data: { effectId: card.id, tacticKind: card.tacticKind ?? null },
    ...(extra || {}),
  });
  ps.dirty();
}
