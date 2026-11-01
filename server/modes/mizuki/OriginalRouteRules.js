// RO2 regional structure: PRTS 水月肉鸽, 区域, revision 441598.
// Native IDs and presentation are from rogue2.json. Ordinary middle-column
// counts in the cited source are explicitly unknown, so they are not data here.
const floor = (id, depth, entries, maxBranches, terminalType) => Object.freeze({ id, depth, entries, maxBranches, terminalType });
export const MIZUKI_REGION_RULES = Object.freeze([
  floor('zone_1', 5, 1, 3, 'BATTLE_SHOP'), floor('zone_2', 5, 2, 3, 'WISH'),
  floor('zone_3', 6, 3, 4, 'BATTLE_BOSS'), floor('zone_4', 6, 3, 4, 'WISH'), floor('zone_5', 7, 3, 4, 'BATTLE_BOSS'),
]);
export const MIZUKI_ENDING_REGION_RULE = Object.freeze({
  ...floor('zone_6', 4, 1, 1, 'BATTLE_BOSS'), columns: Object.freeze(['BATTLE_SHOP', 'REST', 'BATTLE_NORMAL', 'BATTLE_BOSS']),
  stages: Object.freeze(['ro2_b_6', 'ro2_b_7']),
});
export const MIZUKI_PORTAL_REGION_RULE = Object.freeze({
  ...floor('zone_7', 4, 2, 2, 'BATTLE_BOSS'), widths: Object.freeze([2, 2, 2, 1]),
  columns: Object.freeze(['WISH', 'BATTLE_NORMAL', 'BATTLE_NORMAL', 'BATTLE_BOSS']),
  stages: Object.freeze(['ro2_b_8', 'ro2_b_9', 'ro2_b_10']), battleFloors: Object.freeze([5, 6]),
  entryChoiceId: 'choice_ro2_teleport_1', teleportChoiceId: 'choice_ro2_teleport_3', keyCost: 1,
});
export const MIZUKI_ENDING_ROUTE_RULES = Object.freeze({
  ro2_ending_1: Object.freeze({ floor: 5, stageId: 'ro2_b_4', zoneId: 'zone_5', bossEnemyId: 'enemy_2037_sygirl' }),
  ro2_ending_2: Object.freeze({ floor: 5, stageId: 'ro2_b_5', zoneId: 'zone_5', bossEnemyId: 'enemy_2038_sydonq' }),
  ro2_ending_3: Object.freeze({ floor: 6, stageId: 'ro2_b_6', zoneId: 'zone_6', bossEnemyId: 'enemy_2039_syskad' }),
  ro2_ending_4: Object.freeze({ floor: 6, stageId: 'ro2_b_7', zoneId: 'zone_6', bossEnemyId: 'enemy_2042_syboss' }),
});
