// Original database enemies with ordinary attacks, plus explicit native combat
// flags that are not talent blackboards. Never used by any other game mode.
import { unblockable, blockWeight, maxTargets, resist } from '../../sim/content/enemies/archetypes.js';

const physical = [
  'enemy_1147_dshond', 'enemy_1147_dshond_2', 'enemy_1002_nsabr', 'enemy_1000_gopro_3',
  'enemy_1016_diaman', 'enemy_1027_mob', 'enemy_1035_haxe', 'enemy_1013_airdrp_2',
  'enemy_1001_bigbo_2', 'enemy_1055_ganman', 'enemy_1055_ganman_2', 'enemy_1056_ganwar',
  'enemy_1056_ganwar_2', 'enemy_1140_merhd', 'enemy_1140_merhd_2', 'enemy_1212_mtrfol',
  'enemy_1134_diamd_2', 'enemy_1014_rogue_2', 'enemy_1012_dcross', 'enemy_1012_dcross_2',
  'enemy_1099_nbkght_2', 'enemy_1003_ncbow_2', 'enemy_1015_litamr_2', 'enemy_1071_dftman_2',
  'enemy_1094_ccspm_2',
];
const arts = ['enemy_1031_mrogue', 'enemy_1031_mrogue_2', 'enemy_1038_lunmag'];
const attackType = (type) => ({ spawn(_b, _e, _a, ab) { ab.atkType = type; } });

export const MIZUKI_ORDINARY_KITS = {
  ...Object.fromEntries(physical.map((id) => [id, () => [attackType('phys')]])),
  ...Object.fromEntries(arts.map((id) => [id, () => [attackType('arts')]])),
  enemy_1038_lunmag_2: () => [attackType('arts'), maxTargets(2)],
  enemy_1008_ghost: () => [unblockable()],
  enemy_1058_traink: () => [blockWeight(3)],
  enemy_1058_traink_2: () => [blockWeight(3)],
  enemy_1187_krghd: () => [resist()],
};
