/** One-time assignments are attached to the resolved aid, never evaluated during selection. */
export const GOOD_BOY_LEGACY_GRANTS = Object.freeze([
  { name: '味精', migration: 'good-boy-legacy-v1:weijing' },
  { name: '迷路', migration: 'good-boy-legacy-v1:milu' },
  { name: 'Emiraen', migration: 'good-boy-legacy-v1:emiraen' },
]);
export const isGoodBoyGrantMigration = (value) => GOOD_BOY_LEGACY_GRANTS.some((entry) => entry.migration === value);
import { SPECIAL_GOOD_BOY_CARD, SPECIAL_TRICKSTER_CARD, EVORI_RANK_NAME_CARDS } from '../shared/nameCards.js';
import { isRankDivisionAtLeast, rankOf } from '../shared/ranks.js';

/** Only server-owned current rank and the already recorded peak may award a milestone. */
export function earnedRankNameCards(profile) {
  if (!profile) return [];
  const current = profile.placementDone === true ? rankOf(profile.points).division : null;
  // Profiles are sanitized at the store boundary; avoid re-sorting all pyramid cells on every room read.
  const best = profile.rankPyramid?.version === 1 ? profile.rankPyramid.best?.division : null;
  return EVORI_RANK_NAME_CARDS.filter((reward) => isRankDivisionAtLeast(current, reward.minimumDivision)
    || isRankDivisionAtLeast(best, reward.minimumDivision)).map((reward) => reward.card);
}

/** A frozen existing-player cohort, created once by the primary before accepting logins. */
export const TRICKSTER_GRANT_MIGRATION = 'trickster-existing-v1:20261021';
export const isNameCardGrantMigration = (value) => isGoodBoyGrantMigration(value) || value === TRICKSTER_GRANT_MIGRATION
  || value === 'paintbrush-first-v1:20261022';
export const cardForGrantMigration = (value) => value === 'paintbrush-first-v1:20261022' ? 'special_paintbrush_tactics'
  : value === TRICKSTER_GRANT_MIGRATION ? SPECIAL_TRICKSTER_CARD : SPECIAL_GOOD_BOY_CARD;
