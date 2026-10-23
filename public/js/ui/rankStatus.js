/** Unresolved economic receipts must not look like a confirmed global ranking. */
export function rankingPending(rank) {
  return !!(rank && typeof rank === 'object' &&
    (rank.rankUnavailable === true || rank.rankingPending === true));
}
