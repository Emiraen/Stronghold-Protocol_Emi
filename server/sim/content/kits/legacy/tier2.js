import { COLS, ELEMENT_GAUGE_MAX } from '../../../constants.js';
import { canTargetEnemy } from '../../../targeting.js';
import { bodyInKeys } from '../../../body.js';
import {
  num, talentBb, moduleBb, traitBb, up, cheb, byEnemyAttack, onHitBy, onHitOn, onDamagedOn, enemiesInGrid,
  alliesInGridOf, enemyInRange, statBuff, toggleBuff, installAura, spTimeBonus, freeTileAround, instantKind,
  tinmanKit, batMod,
} from './tier1.js';
import { releaseSkillSummon } from '../../tokens.js';
const GRAVEL_HITS = 2;
const GRAVEL_HIT_DMG_MUL = 0.5;
const elemLoad = (a) => Math.max(a.elem.burn, a.elem.neural, a.elem.necrosis, a.elem.apoptosis, a.elem.erosion ?? 0);
function onDefaultSkill(chess) {
  const d = (chess?.skills ?? []).find((s) => s && s.isDefault);
  return !d || !chess?.skill || d.skillId === chess.skill.skillId;
}
const LIFTOFF_FLAGS = Object.freeze({ blockFly: true, liftoff: true });
function tippiTakeOff({ battle, unit }) {
  battle.releaseBlocked(unit);
  battle.fx('takeoff', { x: unit.x, y: unit.y, id: unit.id });
}
function tippiLand({ battle, unit }) {
  battle.releaseBlocked(unit);
}
export { COLS, ELEMENT_GAUGE_MAX, canTargetEnemy, bodyInKeys, num, talentBb, moduleBb, traitBb, up, cheb, byEnemyAttack, onHitBy, onHitOn, onDamagedOn, enemiesInGrid, alliesInGridOf, enemyInRange, statBuff, toggleBuff, installAura, spTimeBonus, freeTileAround, instantKind, tinmanKit, batMod, releaseSkillSummon, GRAVEL_HITS, GRAVEL_HIT_DMG_MUL, elemLoad, onDefaultSkill, LIFTOFF_FLAGS, tippiTakeOff, tippiLand };
