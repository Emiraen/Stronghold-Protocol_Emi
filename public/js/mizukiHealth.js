const amount = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const same = (left, right) => left != null && right != null && String(left) === String(right);

export function mizukiHealthTip(health) {
  if (!(health.pending > 0 || health.shieldPending > 0)) return null;
  const rescue = health.unite ? '联防中，你漏过的敌人还剩 ' + health.left + ' 个；' : '';
  const shield = health.shieldPending > 0 ? '护盾抵消 ' + health.shieldPending + ' 点；' : '';
  return '目标生命值 ' + health.lp + '：' + rescue + shield + '按当前实际目标伤害，结算时扣除 ' + (health.pending - health.shieldPending) + ' 点生命。';
}

// Presentation of authoritative objective damage. Reuse the ordinary LP tower's
// pending-loss animation without altering saved life or charging it a second time.
export function mizukiLiveHealth({ fields = [], playerId, health = {}, phase, finishing = false }) {
  const lp = Number.isFinite(health.life) ? Math.max(0, health.life) : null;
  const shield = amount(health.shield), total = lp == null ? null : lp + shield;
  const empty = { lp: total, pending: 0, unite: false, left: null, shown: total, shieldPending: 0 };
  if (phase !== 'COMBAT' || finishing || lp == null) return empty;
  const list = Array.isArray(fields) ? fields : [];
  const owns = field => (field.players || []).some(id => same(id, playerId))
    || Object.hasOwn(field.rosters || {}, playerId);
  const own = list.find(field => field.kind !== 'unite' && owns(field)) || list.find(owns);
  const party = own?.partyId;
  const rescue = list.find(field => field.kind === 'unite' && field.active !== false
    && (party != null ? same(field.partyId, party) : owns(field)
      || Object.hasOwn(field.objectiveRemainingByPlayer || {}, playerId)
      || Object.hasOwn(field.objectiveUnrescuedByPlayer || {}, playerId)));
  let direct = amount(own?.objectiveDirectLossByPlayer?.[playerId]);
  let loss = amount(own?.objectiveLossByPlayer?.[playerId]);
  if (rescue) {
    loss = amount(rescue.objectiveRemainingByPlayer?.[playerId]) + amount(rescue.objectiveUnrescuedByPlayer?.[playerId]);
    direct = 0;
    for (const field of list) if (party != null ? same(field.partyId, party) : field === own || field === rescue) {
      direct += amount(field.objectiveDirectLossByPlayer?.[playerId]);
    }
    loss += direct;
  }
  const shieldPending = Math.min(shield, Math.max(0, loss - direct));
  const lifePending = Math.min(lp, Math.max(0, loss - shieldPending));
  const pending = shieldPending + lifePending;
  return { lp: total, pending, unite: !!rescue, left: rescue ? amount(rescue.objectiveEnemiesLeftByPlayer?.[playerId]) : null,
    shown: Math.max(0, total - pending), shieldPending };
}
