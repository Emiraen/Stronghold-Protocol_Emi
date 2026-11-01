// Original trap_057_wpnsts and sktok_wpnsts_1 / sktok_wpnsts_2.
// Native wpnsts_change_side runs ON_BEFORE_TRY_SET_HP_ZERO: old-side
// x-1 blast, then SwitchSide. RebornState waits BB.duration before mode swap.
import { absoluteRangeKeys, tileKeyOf } from '../../sim/targeting.js';

export const OFFICIAL_WEAPON_STATION_KEY = 'trap_057_wpnsts';
const SIDE_LOOP = { ally: 'trap_latelan_char_01_start', enemy: 'trap_latelan_enemy_01_start' };
// These are MapEffects owned by the original mode's passive blast buff,
// not finite explosion effects. Entity.RemoveBuffEffect calls FinishMe when
// RebornTalent detaches that buff; MapEffect has no automatic lifetime.
const SIDE_RANGE = { ally: 'trap_latelan_char_01', enemy: 'trap_latelan_enemy_01' };
const REBORN = {
  ally: [{ key: 'trap_latelan_char_charging_01', loop: true }, { key: 'trap_latelan_char_attack_01', loop: false }],
  enemy: [{ key: 'trap_latelan_enemy_attack_01', loop: false }, { key: 'trap_latelan_enemy_charging_01', loop: true }],
};
// Decoded from Torappu.AbnormalFlag compressed enum constants, not field order.
const IMMUNES = new Set(['stun', 'freeze', 'silence', 'cold', 'disarm', 'sleep']);
const RETAINED = new Set(['wpnsts_abnormalimmunes', 'wpnsts_s_hp', 'mpctrl_tower_point_wpnsts']);
const present = (u) => u.alive && u.deployed && !u.hidden && !u.removed;

export function spawnOfficialWeaponStation(battle, instance, def, { effect, log } = {}) {
  if (instance?.inst?.characterKey !== OFFICIAL_WEAPON_STATION_KEY || def?.key !== OFFICIAL_WEAPON_STATION_KEY
      || !['sktok_wpnsts_1', 'sktok_wpnsts_2'].includes(def.skill?.prefabId)) {
    throw new TypeError('Original weapon-station instance and resolved definition required');
  }
  const bb = def.talents, initialSide = def.skill.prefabId === 'sktok_wpnsts_2' ? 'enemy' : 'ally';
  if (!(bb.duration > 0) || !(bb.stun > 0) || !(bb.blast_damage > 0) || !(def.bb.hp_recovery_per_sec > 0)) {
    throw new TypeError('Original weapon-station blackboards required');
  }
  for (const side of ['ally', 'enemy']) if (!(bb['wpnsts_t_1[' + side + '].sp'] > 0)
      || !(bb['wpnsts_t_1[' + side + '].interval'] > 0)) {
    throw new TypeError('Original weapon-station aura blackboards required');
  }
  const s = def.stats;
  const unit = battle.spawnDevice(def.key, instance.position.row, instance.position.col, {
    name: def.name, hp: s.maxHp, atk: s.atk, def: s.def, res: s.magicResistance,
    bat: s.baseAttackTime, aspd: s.attackSpeed, blockCnt: s.blockCnt, dir: instance.direction || 'RIGHT',
  });
  if (!unit) return null;
  // DEFAULT-category facility: ordinary enemy attacks may select it. It has no
  // movement / attacks; both side arrays are kept authoritative on capture.
  unit.kind = 'token';
  unit._officialFacility = true;
  unit._mizukiSourceSide = def.raw.originalSide;
  unit._mizukiSourceCategory = def.raw.originalCategory;
  unit.mem.mizukiFacilityAlias = instance.alias || def.key;
  unit.mem.mizukiFilterTags = ['TAG_TRAP_WPNSTS'];
  unit.mem.mizukiNotWithdrawable = true;
  unit.mem.noLeak = true;
  unit.motion = 'WALK';
  unit.counted = false; unit.inTotal = false; unit.lpr = 0; unit.blockWeight = 0;
  unit.route = { legs: [], legIdx: 0, pts: null, ptIdx: 0, suffix: null, version: -1, waitLeft: null };
  unit.pauseUntil = Infinity; unit.atkStandUntil = -Infinity; unit.unbalanceUntil = -Infinity;
  unit.base.tauntLevel = s.tauntLevel;
  unit.base.moveSpeed = s.moveSpeed; unit.base.spRecovery = s.spRecoveryPerSec;
  const state = unit.mem.mizukiWeaponStation = { side: initialSide, mode: initialSide === 'ally' ? 0 : 1,
    reborn: false, captures: 0, rebornUntil: null, auraTargets: new Map() };
  const loop = (key, active = true, options = {}) => effect?.(unit, key, active, { loop: true, ...options });
  const modeEffects = (side, active = true) => {
    loop(SIDE_LOOP[side], active);
    loop(SIDE_RANGE[side], active);
  };
  const setSide = (side) => {
    battle._unblock(unit);
    battle.allyUnits = battle.allyUnits.filter((u) => u !== unit);
    battle.enemies = battle.enemies.filter((u) => u !== unit);
    unit.side = state.side = side;
    (side === 'ally' ? battle.allyUnits : battle.enemies).push(unit);
    battle._buildEnemyIndex();
  };
  const stationary = () => battle.addBuff(unit, { key: 'mizuki:wpnsts:stationary', persist: true,
    flags: { noMove: true, noBlock: true, unblockable: true } });
  stationary();
  battle.addBuff(unit, { key: 'wpnsts_abnormalimmunes', persist: true,
    flags: { noDisplace: true, healFree: true, allyTargetFree: true, elementFreeAll: true } });
  battle.addBuff(unit, { key: 'wpnsts_s_hp', persist: true, mods: { hpRegen: def.bb.hp_recovery_per_sec } });
  unit.markDirty();
  setSide(initialSide); modeEffects(initialSide);
  log?.(initialSide + '_default', 1, unit);

  battle.on('beforeStatus', (c) => {
    if (c.target === unit && IMMUNES.has(c.status)) c.cancel = true;
  }, { owner: unit, priority: 20000 });
  battle.on('elementHit', (c) => { if (c.target === unit) c.dmg.cancel = true; },
    { owner: unit, priority: 20000 });
  battle.on('hit', (c) => {
    // immu_environment_damage filters IS_ENVIRONMENT_DAMAGE only. Native
    // volcano/ore/ballista are ordinary damage despite being stage hazards.
    if (c.target === unit && (c.dmg.environment === true || c.dmg.tags?.includes('IS_ENVIRONMENT_DAMAGE'))) {
      c.dmg.cancel = true;
    }
  }, { owner: unit, priority: 20000 });

  battle.on('fatal', (c) => {
    if (c.unit !== unit || c.prevented) return;
    c.prevented = true;
    if (state.reborn) return;
    const oldSide = unit.side, nextSide = oldSide === 'ally' ? 'enemy' : 'ally';
    const keys = new Set(absoluteRangeKeys(def.grid, unit.tileR, unit.tileC, unit.dir));
    state.reborn = true; state.captures++; state.rebornUntil = battle.time + bb.duration;
    state.auraTargets.clear();
    // Native LogExtraBattleInfo is DETAILED, key from this old mode's BB.
    log?.(nextSide, 1, unit);
    for (const target of battle.units.slice()) {
      if (target === unit || !present(target) || target.side !== oldSide || target.kind === 'device'
          || !keys.has(tileKeyOf(target))) continue;
      const f = target.s.flags;
      // Original ALLY selector does not ignore these same-side exclusions.
      if (f.untargetable || f.allyTargetFree || f.sleep) continue;
      battle.dealDamage(unit, target, { amount: bb.blast_damage, type: 'arts', canDodge: false,
        tags: ['mizuki:wpnsts:blast'] });
      if (target.alive) battle.applyStatus(target, 'stun', { duration: bb.stun, source: unit });
    }
    modeEffects(oldSide, false);
    setSide(nextSide);
    // RebornTalent retains exactly these native buffs. The static shell has
    // no combat/movement even while its old mode abilities are detached.
    for (const buff of unit.buffs.slice()) if (!RETAINED.has(buff.key)) battle.removeBuff(unit, buff);
    stationary();
    // Native RebornState abnormal mask 0x28: BLOCK_FREE and INVINCIBLE.
    // Entity.isTargetFreeWithImmuneFlag derives target-free from flag 5
    // (INVINCIBLE); this scoped flag preserves that native selection result.
    battle.addBuff(unit, { key: 'mizuki:wpnsts:reborn', persist: true,
      flags: { invulnerable: true, untargetable: true, noBlock: true, unblockable: true } });
    for (const item of REBORN[nextSide]) loop(item.key, true, { loop: item.loop });
    battle.after(bb.duration, () => {
      if (!present(unit) || !state.reborn) return;
      state.reborn = false; state.rebornUntil = null; state.mode = nextSide === 'ally' ? 0 : 1;
      battle.removeBuff(unit, 'mizuki:wpnsts:reborn');
      unit.hp = unit.s.maxHp;
      for (const item of REBORN[nextSide]) loop(item.key, false, { loop: item.loop });
      modeEffects(nextSide);
    }, { owner: unit });
  }, { owner: unit, priority: 20000 });

  battle.on('tick', ({ dt }) => {
    if (!present(unit) || state.reborn) return;
    const prefix = 'wpnsts_t_1[' + unit.side + ']';
    const amount = bb[prefix + '.sp'], interval = bb[prefix + '.interval'];
    const keys = new Set(absoluteRangeKeys(def.grid, unit.tileR, unit.tileC, unit.dir));
    const selected = new Set();
    for (const target of battle.units) {
      if (target === unit || !present(target) || target.side !== unit.side || target.kind === 'device'
          || !keys.has(tileKeyOf(target)) || target.s.flags.allyTargetFree) continue;
      // Native _VerifyAdvanced applies professionMask 639 to Characters;
      // it includes all eight operator professions, excludes TOKEN/TRAP.
      // Non-character enemies are accepted without a profession test.
      if (target.side === 'ally' && ['TOKEN', 'DEVICE', 'TRAP'].includes(target.def?.profession)) continue;
      selected.add(target.id);
      // The original aura removes the buff upon leaving; a new entrance
      // starts that target's own two-second trigger timer from zero.
      const elapsed = (state.auraTargets.get(target.id) || 0) + dt;
      if (elapsed + 1e-9 >= interval) {
        if (target.skill?.gainSp) target.skill.gainSp(amount, 'wpnsts');
        else target.mem.mizukiGainSp?.(amount, { reason: 'wpnsts', source: unit });
        state.auraTargets.set(target.id, elapsed - interval);
      } else state.auraTargets.set(target.id, elapsed);
    }
    for (const id of state.auraTargets.keys()) if (!selected.has(id)) state.auraTargets.delete(id);
  }, { owner: unit });
  return unit;
}
