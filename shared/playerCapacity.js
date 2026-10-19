import { ENTERTAINMENT_MAX_SEATS, CYCLOPS_MAX_SEATS } from './constants.js';

export const GROUPED_POOL_MIN_PLAYERS = 6;
export const MAX_UNITE_ROUNDS = 5;
export const MAX_UNITE_HELPERS = MAX_UNITE_ROUNDS * 2;
export const coopDraftCardCount = () => 6;

/**
 * 独眼巨人冲锋的分组：每 4 人一组共享池（1–8 人；不足 4 人单独一组）。
 * @param {number} players 1..8
 */
export function cyclopsGroupSizes(players) {
  if (!Number.isInteger(players) || players < 1 || players > CYCLOPS_MAX_SEATS) throw new RangeError('invalid cyclops player count');
  return players <= 4 ? [players] : [4, players - 4];
}
const POOL_GROUP_LAYOUTS = {
  6: [3, 3], 7: [4, 3], 8: [4, 4], 9: [4, 5], 10: [4, 3, 3],
  11: [4, 4, 3], 12: [4, 4, 4], 13: [5, 4, 4], 14: [4, 4, 3, 3],
  15: [4, 4, 4, 3], 16: [4, 4, 4, 4], 17: [5, 4, 4, 4],
  18: [4, 4, 4, 3, 3], 19: [4, 4, 4, 4, 3], 20: [4, 4, 4, 4, 4],
};
export function poolGroupSizes(players) {
  if (!Number.isInteger(players) || players < 1 || players > ENTERTAINMENT_MAX_SEATS) throw new RangeError('invalid player count');
  return players < GROUPED_POOL_MIN_PLAYERS ? [players] : POOL_GROUP_LAYOUTS[players].slice();
}
export const poolCopyScale = (size) => Math.max(1, size / 4);
export const uniteRoundLimit = (count) => Number.isInteger(count) ? Math.max(1, Math.min(MAX_UNITE_ROUNDS, count)) : 1;
export const coopHiddenLayerThreshold = (baseline, players) => Math.ceil(baseline * Math.max(1, players / 4));
