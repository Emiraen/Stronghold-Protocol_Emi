import { num, enemiesInGrid as gridEnemies, talentBb, moduleBb } from './tier1.js';
import { COLS } from '../../../constants.js';
import { dirVec } from '../../../dir.js';
import { aggregateMods } from '../../../buffs.js';
import { isMujica, ensureMujica } from '../../mujica.js';
export { num, talentBb, moduleBb, isMujica, ensureMujica };
export function enemiesInGrid(b, u, grid = null, options = {}) {
  const found = gridEnemies(b, u, grid, { ...options, n: 0 });
  const blocked = b.blockedTargets(u, { ...u.profile, ...options });
  const targets = [...blocked, ...found.filter((e) => !blocked.includes(e))];
  return options.n > 0 ? targets.slice(0, options.n) : targets;
}
export const live = (u) => !!(u?.alive && u.deployed && !u.hidden);
export const mates = (b, u) => b.allyUnits.filter((a) => live(a) && a.ownerId === u.ownerId && isMujica(a));
export const charId = (u) => u?.def?.charId;
export const skillId = (chess) => chess.skill?.skillId;
export const skillData = (chess, id) => (chess.skills || []).find((s) => s.skillId === id) || (chess.skill?.skillId === id ? chess.skill : {});
export const bbOf = (chess, id) => skillData(chess, id).bb || {};
export function aura(b, source, key, targets, mods) {
  for (const target of targets) b.addBuff(target, { key: `${key}:${source.id}`, source, mods, duration: 0.35, refresh: 'replace' });
}
export function inspire(b, source, target, value, stat = 'atk') {
  if (!(value > 0) || !live(target) || target.mem.noInspire) return;
  const key = stat === 'atk' ? 'inspire' : 'inspire:def';
  const current = target.findBuff(key);
  if (current?.data?.src !== source.id && current?.data?.val > value && current.timeLeft > 0.1) return;
  const { add, mul } = aggregateMods(target.buffs.filter((x) => x.key !== key));
  const factor = Math.max(0, 1 + (add[`${stat}Pct`] ?? 0)) * (mul[`${stat}Mul`] ?? 1);
  b.addBuff(target, { key, source, duration: 0.35, refresh: 'replace', mods: { [`${stat}Flat`]: factor > 1e-6 ? value / factor : value }, data: { src: source.id, val: value } });
}
export function canAttack(u) { return live(u) && u.canAct && !u.s.flags.disarm && !u.trait.dollSwitching; }
export function attackEvent(b, u, targets, fn, isSkill = !!u.skill?.active) {
  const c = { attacker: u, targets, isSkill, profile: u.profile };
  b.emit('beforeAttack', c);
  if (!live(u)) return;
  u.lastAttackAt = b.time; u.stats.attacks++;
  const attackId = ++b._attackSeq;
  const selected = (c.targets || []).filter(live);
  if (selected.length && !u.mem.engaged) { u.mem.engaged = true; b._ev(['engage', u.id]); }
  b._ev(['atk', u.id, selected[0]?.id || u.id, 'none']);
  fn(selected, attackId);
  b.emit('attack', { attacker: u, targets: selected, isSkill, attackId });
  u.skill?.onAttackPerformed(selected, isSkill);
}
export function strike(b, u, target, scale, { type = 'phys', attackId, skill = !!u.skill?.active, splash = 0, splashScale = 0.5, point = null, projectile = null } = {}) {
  const amount = u.s.atk * u.s.atkScaleMul * scale;
  const pos = target || point || (() => { const [dr, dc] = dirVec(u.dir); return { x: u.x + dc, y: u.y + dr }; })();
  if (target) b.dealDamage(u, target, { amount, type, isAttack: true, isSkill: skill, attackId, tags: ['mujica'] });
  if (splash > 0) for (const e of b.enemiesInRadius(pos.x, pos.y, splash)) {
    if (e === target || e.isFlying) continue;
    b.dealDamage(u, e, { amount: amount * splashScale, type, isAttack: true, isSkill: skill, isSplash: true, attackId, tags: ['mujica'] });
  }
  b.emit('mujicaStrike', { unit: u, attackId });
  // A simulated tile strike carries its original projectile to the renderer even
  // when no enemy was hit. Other users retain the existing area-effect path.
  b.fx(projectile ? 'mujicaImpact' : 'aoe', { x: pos.x, y: pos.y, radius: splash || 0.3, id: u.id, skill: u.skill?.id, ...(projectile ? { projectile } : {}) });
}
export function fixedLoop(b, u, interval, action) {
  let cooldown = 0;
  b.on('tick', ({ dt }) => {
    if (!live(u)) { cooldown = 0; return; }
    if (u.mem.mujicaAttackReset) { cooldown = 0; u.mem.mujicaAttackReset = false; }
    if (!canAttack(u)) return;
    if (cooldown > 0) cooldown -= dt;
    if (cooldown > 1e-9) return;
    if (action() !== false) cooldown += Math.max(0.05, typeof interval === 'function' ? interval() : interval);
    else cooldown = 0;
  }, { owner: u });
}
export function inRange(u, target) { return !!u.rangeKeySet?.has(target.tileR * COLS + target.tileC); }
export function healTarget(b, u, preferSakiko = false) {
  const candidates = b.alliesInGrid(u).filter((a) => a.hp < a.s.maxHp - 1e-9 && !a.s.flags.healFree && (a === u || !a.profile?.noHeal && !a.s.flags.noHeal));
  candidates.sort((a, z) => (preferSakiko ? Number(charId(z) === 'char_4182_oblvns') - Number(charId(a) === 'char_4182_oblvns') : 0) || a.hpRatio - z.hpRatio || z.aggroSeq - a.aggroSeq);
  return candidates[0] || null;
}
