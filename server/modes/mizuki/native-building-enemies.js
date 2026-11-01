// Original RO2 building-targeting attack. Its Category DEFAULT farm target is
// deliberately resolved here; shared automatic-mode targeting is unchanged.
import { T } from '../../sim/content/enemies.js';
import { attackStand, attackWindup } from '../../sim/ai.js';
import { ALLY_COLLIDER_RADIUS, ATTACK_PAUSE } from '../../sim/constants.js';
import { canTargetAlly, evadesGround, aggroCmp } from '../../sim/targeting.js';

const RANGE = 2.0999999046325684;
const WINDUP = 'mizuki:buster:windup';
const building = (unit) => unit.tags?.has('building') === true;
const category = (unit) => unit._mizukiSourceCategory ?? (unit.kind === 'device' ? 2 : 1);
const able = (b, e) => e.alive && e.deployed && !e.hidden && !e.mem.carrier
  && !e.s.flags.stun && !e.s.flags.freeze && !e.s.flags.sleep && !e.s.flags.levitate
  && !e.s.flags.fear && !e.s.flags.disarm && !(e.s.flags.tremble && e.blockedBy)
  && b.time >= e.unbalanceUntil - 1e-9;

function selectable(e, unit) {
  if (!unit?.alive || !unit.deployed || unit.hidden || category(unit) !== 1) return false;
  if (e.blockedBy === unit) return true;
  if (unit.kind !== 'device') return canTargetAlly(e, unit, true);
  const flags = unit.s.flags;
  return !flags.untargetable && !flags.sleep && !flags.stealth && !flags.camou && !evadesGround(e, unit);
}

function targets(b, e) {
  const blocker = e.blockedBy;
  // CombatWrapper supplies the blocker as inputTarget; alwaysIncludeTarget
  // replaces the last selected item after post-filtering (maxNum=1).
  if (blocker && selectable(e, blocker)) return [blocker];
  const units = b.alliesInRadius(e.x, e.y, RANGE + ALLY_COLLIDER_RADIUS, null, { includeDevices: true })
    .filter((unit) => selectable(e, unit));
  // The original selector is SecondaryFilterAdvancedSelector(HATRED_DES,
  // SPECIFIED_FILTER_TAG='building', sortByTauntAtLast=true).
  units.sort(aggroCmp);
  let first = 0;
  for (let i = 0; i < units.length; i++) {
    if (!building(units[i])) continue;
    [units[first], units[i]] = [units[i], units[first]]; first++;
  }
  // Original b__15_0 compares ONLY tauntLevel across the whole list. Higher
  // taunt can therefore override the building partition, unlike a generic
  // special-priority-before-taunt enemy rule.
  units.sort((a, z) => (z.s.taunt || 0) - (a.s.taunt || 0));
  return units.slice(0, 1);
}

function clearSwing(b, e, a) {
  a.swing = null;
  b.removeBuff(e, WINDUP);
  e.swing = false; e.swingTargets = null;
}

function strike(b, e, a) {
  const swing = a.swing;
  clearSwing(b, e, a);
  let selected = swing.targets.filter((unit) => unit.deploySeq === swing.seq.get(unit) && selectable(e, unit));
  b.emit('enemyAttackStart', { enemy: e, targets: selected });
  if (!able(b, e)) return;
  const palsy = e.findBuff('palsy');
  if (palsy) {
    const keep = !!b.emit('palsyTrigger', { enemy: e, buff: palsy, keep: false }).keep;
    if (!e.alive) return;
    if (!keep) { if (--palsy.stacks <= 0) b.removeBuff(e, palsy); else e.markDirty(); }
    e.atkCd = e.s.interval;
    if (!e.blockedBy) e.atkStandUntil = b.time + ATTACK_PAUSE;
    b.fx('palsy', { x: e.x, y: e.y, id: e.id });
    return;
  }
  const ctx = { attacker: e, targets: selected.length ? selected : swing.targets,
    isSkill: false, profile: { ...e.profile, noAttack: false } };
  b.emit('beforeAttack', ctx);
  if (!e.alive || !ctx.targets?.length) return;
  selected = ctx.targets.filter((unit) => unit.deploySeq === swing.seq.get(unit) && selectable(e, unit));
  e.lastAttackAt = b.time; e.stats.attacks++;
  const attackId = ++b._attackSeq;
  const targetDeployments = new Map(selected.map((unit) => [unit, unit.deploySeq]));
  for (const unit of selected) {
    b._ev(['atk', e.id, unit.id, 'none']);
    b.fx('mizuki:effect', { key: 'demonk_attack_01_hit', unitId: unit.id, x: unit.x, y: unit.y });
    b.dealDamage(e, unit, { amount: e.s.atk, type: 'phys', isAttack: true, isProjectile: false, attackId });
  }
  b.emit('attack', { attacker: e, targets: selected, targetDeployments, isSkill: false });
  e.atkCd = e.s.interval;
  e.atkStandUntil = b.time + attackStand(e).rest;
}

export const MIZUKI_BUILDING_KITS = {
  enemy_1059_buster_2: (ab) => [{
    spawn(_b, e, _a, runtime) {
      runtime.atkType = 'phys'; e.profile.noAttack = true; e.profile.melee = false;
      e.base.rangeRadius = RANGE; e.markDirty();
      // EasyToStartAbility waits ON_ATTACK when waitForAttackEvent=true;
      // the prefab's preDelay=1.134 belongs only to its alternative timer path.
      e.def = { ...e.def, attackAnim: { dur: 2.7, hit: 1.433 } };
    },
    tick(b, e, a) {
      if (!able(b, e)) { clearSwing(b, e, a); a.prevCd = e.atkCd; return; }
      const wind = attackWindup(e);
      if (!a.swing && e.atkCd <= wind + 1e-9) {
        const selected = targets(b, e);
        if (selected.length) {
          a.swing = { targets: selected, seq: new Map(selected.map((u) => [u, u.deploySeq])) };
          if ((a.prevCd ?? 0) < wind) e.atkCd = wind;
          b.addBuff(e, { key: WINDUP, flags: { noMove: true } });
          b.fx('mizuki:effect', { key: 'demonk_attack_01_start', unitId: e.id, x: e.x, y: e.y });
        }
      }
      if (a.swing) {
        e.swing = true; e.swingTargets = a.swing.targets;
        if (e.atkCd <= 1e-9) strike(b, e, a);
      }
      a.prevCd = e.atkCd;
    },
    status(_c, b, e, a) { if (!able(b, e)) clearSwing(b, e, a); },
    death(_c, b, e, a) { clearSwing(b, e, a); },
  }, {
    sil: true,
    hitOut(c) {
      // Native filtertag_enhance AtkScaleUp applies before DEF, not final damage.
      if (c.dmg.isAttack && building(c.target)) c.dmg.amount *= T(ab, 'atkup.atk_scale');
    },
  }],
};
