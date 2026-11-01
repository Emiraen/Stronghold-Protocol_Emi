// Project the server simulation counters into the existing Stronghold damage HUD.
// Read only eager counters and presentation fields: inspecting the HUD must never
// force lazy combat stats or serialize references back into the live battle.
const text = (value, fallback = null) => typeof value === 'string' && value ? value : fallback;
const amount = (value) => Number.isFinite(value) && value > 0 ? value : 0;

function displayRecord(unit) {
  const def = unit.def || {}, raw = def.raw || {};
  return {
    name: text(unit.name, text(raw.name, text(unit.defId, '单位'))),
    charId: text(def.charId, text(raw.charId)),
    tier: Number.isFinite(raw.tier ?? def.tier) ? raw.tier ?? def.tier : null,
    isGolden: !!(raw.isGolden ?? def.golden),
    ...(text(raw.standInFor ?? def.standInFor) ? { standInFor: text(raw.standInFor ?? def.standInFor) } : {}),
    ...(text(raw.diyFor ?? def.diyFor) ? { diyFor: text(raw.diyFor ?? def.diyFor) } : {}),
    assets: { avatar: text(def.avatar, text(raw.assets?.avatar, text(def.charId, text(unit.defId)))) },
  };
}

/** Same grouping and damage categories as battle/runner.roundDamage, including summons. */
export function mizukiBattleDamageRows(battle, { battleId = battle?.battleId } = {}) {
  const rows = new Map();
  for (const unit of battle?.allyUnits || []) {
    if (!unit || (unit.kind !== 'op' && unit.kind !== 'token')) continue;
    let owner = unit;
    const seen = new Set([unit]);
    while (owner.ownerUnit && !seen.has(owner.ownerUnit)) {
      owner = owner.ownerUnit;
      seen.add(owner);
    }
    if (owner.kind !== 'op') owner = unit;
    const kind = owner.kind === 'op' ? 'chess' : 'token';
    const ownerId = typeof owner.ownerId === 'string' || Number.isFinite(owner.ownerId) ? owner.ownerId : null;
    const id = text(owner.defId, text(owner.def?.id, 'unknown'));
    const uid = typeof owner.uid === 'string' || Number.isFinite(owner.uid) ? owner.uid : null;
    const key = `${ownerId}:${kind}:${kind === 'chess' ? uid ?? `${text(battleId, text(battle?.fieldId, 'mizuki'))}:${owner.id}` : id}`;
    let row = rows.get(key);
    if (!row) {
      const rec = displayRecord(owner);
      row = { key, ownerId, kind, id, name: rec.name, skin: text(owner.skin), rec,
        phys: 0, arts: 0, other: 0, total: 0 };
      rows.set(key, row);
    }
    const stats = unit.stats || {};
    const phys = amount(stats.dmgByType?.phys), arts = amount(stats.dmgByType?.arts);
    const other = Math.max(0, amount(stats.dmg) - phys - arts) + amount(stats.elem);
    row.phys += phys;
    row.arts += arts;
    row.other += other;
    row.total += phys + arts + other;
  }
  return [...rows.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}
