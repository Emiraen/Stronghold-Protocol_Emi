// Pure rank-pyramid state and presentation shared by server settlement and browser UI.
const VERSION = 1;
const MAX_WINS = 49;
const ROW_LENGTHS = [1, 3, 5, 7, 9, 11, 13];
const DIVISION_ORDER = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'ascendant', 'immortal', 'radiant'];
const DIVISIONS = new Set(DIVISION_ORDER);
const DIVISION_NAMES = {
  iron: '黑铁', bronze: '青铜', silver: '白银', gold: '黄金', platinum: '白金',
  diamond: '钻石', ascendant: '超凡', immortal: '神话', radiant: '源能战魂',
};
const CN_NUM = { 1: '一', 2: '二', 3: '三' };
const whole = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

function rankSnapshot(rank, fallbackPoints = 0, fallbackGlobalRank = null) {
  const division = DIVISIONS.has(rank?.division) ? rank.division : null;
  const icon = typeof rank?.icon === 'string' && /^(?:iron|bronze|silver|gold|platinum|diamond|ascendant|immortal)_[123]$/.test(rank.icon)
    ? rank.icon : rank?.icon === 'radiant' ? 'radiant' : 'unranked';
  const rawGlobalRank = rank?.globalRank ?? fallbackGlobalRank;
  const globalRank = Number.isSafeInteger(rawGlobalRank) && rawGlobalRank > 0 ? rawGlobalRank : null;
  return {
    division,
    divisionName: division === 'radiant' ? DIVISION_NAMES.radiant : division ? (String(rank?.divisionName || '').slice(0, 16) || DIVISION_NAMES[division]) : '未定级',
    tier: Number.isInteger(rank?.tier) && rank.tier >= 1 && rank.tier <= 3 ? rank.tier
      : /_[123]$/.test(icon) ? Number(icon.at(-1)) : null,
    icon, points: whole(rank?.points ?? fallbackPoints), globalRank,
  };
}

function validSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const rank = rankSnapshot(value, value.points);
  return rank.icon === 'unranked' ? null : rank;
}

function cleanState(value) {
  if (!value || value.version !== VERSION) return null;
  const lastWins = Number.isSafeInteger(value.lastWins) && value.lastWins >= 0 ? value.lastWins : null;
  const snapshots = Array.isArray(value.earned) ? value.earned.map(entry => {
    const rank = rankSnapshot(entry, entry?.points);
    return { division: rank.division, tier: rank.tier, icon: rank.icon };
  }) : [];
  // Unranked victories leave slots empty; older placeholders must not occupy them.
  const earned = snapshots.filter(entry => entry.division && entry.icon !== 'unranked');
  const unfilled = snapshots.length - earned.length;
  return { version: VERSION, startedAt: whole(value.startedAt), lastWins,
    earned: orderedWins({ earned }).slice(0, MAX_WINS),
    totalWins: Math.max(earned.length, whole(value.totalWins) - unfilled),
    best: validSnapshot(value.best), wasRanked: value.wasRanked === true };
}

export function cleanRankPyramid(value) { return cleanState(value); }

function compareRanks(a, b) {
  const division = DIVISION_ORDER.indexOf(a?.division) - DIVISION_ORDER.indexOf(b?.division);
  return division || (a?.tier || 0) - (b?.tier || 0);
}

function isBetterPeak(current, best) {
  if (!current.division || current.icon === 'unranked') return false;
  if (!best) return true;
  const rank = compareRanks(current, best);
  if (rank) return rank > 0;
  // Keep a single observed snapshot instead of mixing rank/placement from different dates.
  if (['immortal', 'radiant'].includes(current.division)) {
    if (current.globalRank && !best.globalRank) return true;
    if (!current.globalRank && best.globalRank) return false;
    if (current.globalRank !== best.globalRank) return current.globalRank < best.globalRank;
  }
  return current.points > best.points;
}

function highestRankLabel(rank) {
  if (!rank || !['immortal', 'radiant'].includes(rank.division) || !rank.globalRank) return '';
  const tier = rank.division === 'immortal' && rank.tier ? CN_NUM[rank.tier] : '';
  return `${rank.divisionName}${tier} #${rank.globalRank}`;
}

/** First observation establishes a baseline; historic lifetime wins are never imported. */
export function observeRankProgress(previous, profile) {
  const wins = whole(profile?.wins);
  const wasRanked = profile?.ranked === true;
  const current = rankSnapshot(profile?.rank, profile?.points, profile?.globalRank);
  const state = cleanState(previous);
  if (!state || state.lastWins === null) {
    return { version: VERSION, startedAt: whole(profile?.startedAt), lastWins: wins, earned: [], totalWins: 0,
      best: wasRanked ? validSnapshot(current) : null, wasRanked };
  }
  // Only authoritative positive-score settlements earn a cell. Lifetime wins and
  // snapshot reads never backfill progress; a loss with a positive net score counts.
  const added = wasRanked && current.division && current.icon !== 'unranked'
    && Number.isFinite(profile?.scoreDelta) && profile.scoreDelta > 0 ? 1 : 0;
  const earned = [...state.earned];
  if (added > 0) {
    const cell = { division: current.division, tier: current.tier, icon: current.icon };
    for (let i = 0, count = Math.min(added, MAX_WINS); i < count; i++) earned.push(cell);
  }
  const best = wasRanked && isBetterPeak(current, state.best) ? current : state.best;
  return { version: VERSION, startedAt: state.startedAt || whole(profile?.startedAt), lastWins: Math.max(state.lastWins, wins),
    earned: orderedWins({ earned }).slice(0, MAX_WINS), totalWins: state.totalWins + added, best, wasRanked };
}

function orderedWins(state) { return [...state.earned].sort((a, b) => compareRanks(b, a)); }
function pyramidRows(earned) {
  let index = 0;
  return ROW_LENGTHS.map(length => Array.from({ length }, () => earned[index++] || null));
}

/** Seven rows retain the best 49 ranks; empty slots remain visible before nine qualifying matches. */
export function rankPyramidView(value) {
  const state = cleanState(value);
  const totalWins = state?.totalWins || 0;
  const filledWins = state?.earned.length || 0;
  let threshold = 0;
  let nextLayer = null;
  let winsToNextLayer = 0;
  for (let index = 0; index < ROW_LENGTHS.length; index++) {
    threshold += ROW_LENGTHS[index];
    if (filledWins < threshold) {
      nextLayer = index + 1;
      winsToNextLayer = threshold - filledWins;
      break;
    }
  }
  return { rows: pyramidRows(state ? orderedWins(state) : []), best: state?.best || null,
    bestLabel: highestRankLabel(state?.best), totalWins, filledWins,
    nextLayer, winsToNextLayer };
}

/** Waiting-room cards show three rows only after nine newly recorded qualifying matches. */
export function rankPyramidMiniView(value) {
  const view = rankPyramidView(value);
  return view.filledWins >= 9 ? { ...view, rows: view.rows.slice(0, 3) } : null;
}
