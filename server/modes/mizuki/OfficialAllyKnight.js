// Source: trap_079_allydonq / sktok_allydonq from btl_pfb_tokens_*.ab,
// trap_allydonq_logkilled and knockback[relative] from buff_template_data.
// The caller owns the original ACTIVATE_PREDEFINED / hidden-group decision.
export const OFFICIAL_ALLY_KNIGHT_KEY = 'trap_079_allydonq';

/** Spawn exactly the original predefined ally, without inventing route rewards.
 * `def` is resolveOfficialFacility(instance); `log` receives the native SIMPLE
 * extra-battle-info keys (born/killed), their addition and the source character.
 */
export function spawnOfficialAllyKnight(battle, instance, def, { log } = {}) {
  if (instance?.inst?.characterKey !== OFFICIAL_ALLY_KNIGHT_KEY || def?.key !== OFFICIAL_ALLY_KNIGHT_KEY) {
    throw new TypeError('Original ally-knight instance and resolved definition required');
  }
  const data = def.skill, sp = data?.spData;
  if (data?.prefabId !== 'sktok_allydonq' || sp?.spType !== 'INCREASE_WHEN_ATTACK'
      || !(def.bb.atk_scale > 0) || !Number.isFinite(def.bb.force)) {
    throw new TypeError('Original ally-knight skill data is incomplete');
  }
  const kit = {
    trait: { attack: 'melee', dmgType: 'phys', canHitFly: false, maxTargets: 1 },
    skill: { kind: 'instant', spType: 'attack', spCost: sp.spCost, initSp: sp.initSp,
      trigger: 'DEFAULT', attack: { atkScale: def.bb.atk_scale },
      onHit({ battle: b, unit, target }) {
        if (target?.alive) b.push(target, def.bb.force, { from: unit });
      },
    },
    install(b, unit) {
      unit._officialFacility = true;
      unit.mem.mizukiFacilityAlias = instance.alias || OFFICIAL_ALLY_KNIGHT_KEY;
      unit.mem.mizukiAllyKnight = { born: 0, killed: 0 };
      // The native passive is HEAL_FREE, not noHeal: the original allydonq
      // aid-kit action can explicitly ignore this flag.
      b.addBuff(unit, { key: 'allydonq_passive', flags: { healFree: true }, persist: true, allowDead: true });
      b.on('deploy', ({ unit: deployed }) => {
        if (deployed !== unit) return;
        unit.mem.mizukiAllyKnight.born++; log?.('born', 1, unit);
      }, { owner: unit });
      b.on('death', ({ unit: dead, reason }) => {
        if (dead !== unit || reason !== 'killed') return;
        unit.mem.mizukiAllyKnight.killed++; log?.('killed', 1, unit);
      }, { owner: unit });
    },
  };
  return battle.spawnToken(null, OFFICIAL_ALLY_KNIGHT_KEY, instance.position.row, instance.position.col, {
    dir: instance.direction, kit,
    def: { name: def.name, stats: def.stats, profession: 'TOKEN', position: 'MELEE',
      rangeGrid: def.grid, attackKind: 'melee', dmgType: 'phys', canHitFly: false,
      skill: { ...data, spType: 'attack', spCost: sp.spCost, initSp: sp.initSp, bb: def.bb },
      spine: OFFICIAL_ALLY_KNIGHT_KEY,
    },
  });
}
