// 从 A 原正文按职责拆分；保持原有行为。
import { fxForm } from '../../../../shared/protocol.js';

export const STATE_EV = new Set(['spawn', 'die', 'deploy', 'status', 'skill']);

export const keepEarly = (e) => Array.isArray(e) && (STATE_EV.has(e[0]) || fxForm(e) !== undefined);

// b.start / 本地 m.field 可能先于 COMBAT 的公开视图到达。只有相同回合、相同战斗阶段的
// 明确 metadata 可以越过旧对象屏障；上一回合及准备区侦察画面仍须被挡住。
export function currentBattleField(field, pub, stale) {
  if (!field || field.prep) return false;
  if (field !== stale) return true;
  const kind = { COMBAT: 'normal', UNITE: 'unite', FINAL_ASSAULT: 'boss', HIDDEN_CORE: 'hidden' }[pub?.phase];
  return !!kind && Number.isInteger(field.round) && field.round === pub?.round && field.kind === kind;
}
