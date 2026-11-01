// 炸惊模拟 is an isolated entertainment ruleset. Ordinary mode lists stay unchanged.
export const ZHAJING_VARIANT = 'entertainment_zhajing';
export const ZHAJING_DIFFICULTY = 'ZHAJING';
export const ZHAJING_CAPACITIES = Object.freeze([1, 2, 3, 4]);
export function isZhajing(value) {
  return value?.variant === ZHAJING_VARIANT || value?.difficulty === ZHAJING_DIFFICULTY
    || value?.modeId === 'mode_single_zhajing' || value?.modeId === 'mode_multi_zhajing';
}
