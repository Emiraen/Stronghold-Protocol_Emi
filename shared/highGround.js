// shared/highGround.js — which MELEE chess may stand on a 高台 (a ranged deploy tile).
//
// 钩索师 (hookmaster) may deploy on both ground and high-ground tiles, normal and elite alike.
// This branch trait does not depend on the equipped module. Other melee branches retain their
// existing ground-only deployment rule; this does not grant high-ground deployment to 推击手.

/** char_474_glady — 歌蕾蒂娅. */
export const GLADIIA_CHAR_ID = 'char_474_glady';
/** HOK-Y 淡金坠饰 (data/chess.json chess_char_4_12_b.modules, typeName HOK-Y). */
export const GLADIIA_HOK_Y = 'uniequip_003_glady';

/**
 * @param {object|null} rec a chess record (normal or golden)
 * @param {string|null|undefined} moduleId retained for caller compatibility; deployment is module-independent
 * @returns {boolean}
 */
export const PLACE_ON_RANGED = '可以放置于远程位';
export function baseTraitText(rec) {
  const t = rec ? rec.traitBase || rec.trait : null;
  return t && typeof t.desc === 'string' ? t.desc : '';
}

export function meleeOnHighGround(rec, moduleId) {
  return !!rec && (rec.subProfessionId === 'hookmaster' || (rec.position === 'MELEE' && rec.placeOnRanged === true)
    || (!!rec.diyFor && rec.position === 'MELEE' && baseTraitText(rec).includes(PLACE_ON_RANGED))); 
}
