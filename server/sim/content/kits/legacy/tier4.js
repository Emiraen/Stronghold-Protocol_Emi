import { COLS } from '../../../constants.js';
import { bodyDist, bodyInKeys } from '../../../body.js';
import { absoluteRangeKeys, canTargetEnemy, sortEnemyTargets } from '../../../targeting.js';
import { normalizeChess } from '../../../simdata.js';
import { aggregateMods } from '../../../buffs.js';
import { CAT_SHIELD_KEY } from '../../tokens.js';
import { isHpLoss } from '../../../damage.js';
import { holdsUndying } from '../../items/battle.js';
import { byEnemyAttack } from './tier1.js';
const TICK_EPS = 0.01;
const AURA = 0.2;
const AURA_DUR = 0.25;
const ABYSSAL = new Set(['char_143_ghost', 'char_263_skadi', 'char_474_glady', 'char_4145_ulpia', 'char_1023_ghost2']);
const LINE = Object.freeze(Array.from({ length: COLS }, (_, i) => Object.freeze([0, i])));
const BILLRO_S3_RAMP = 20;
const BILLRO_MARK = 'billro:mark';
const AROMA_MARK = 'aroma:bubbled';
const BILLRO_MARK_MAX = 5;
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v !== '' && Number.isFinite(+v) ? +v : d));
const tbb = (def, i) => (def && def.talents && def.talents[i] && def.talents[i].bb) || {};
const moduleBb = (def) => (def?.talents || []).filter((t) => !t.name && t.bb && Object.keys(t.bb).length).reduce((o, t) => Object.assign(o, t.bb), {});
const grid = (g) => (Array.isArray(g) && g.length ? g.map((p) => [p[0], p[1]]) : null);
const batFlat = (def, v) => { const b = num(def?.stats?.bat, 1) || 1; return Math.max(-0.9, num(v, 0) / b); };
const tileKey = (u) => Math.round(u.y) * COLS + Math.round(u.x);
const nationOf = (u) => u?.def?.raw?.nationId ?? null;
const isAbyssal = (u) => u?.def?.raw?.groupId === 'abyssal' || ABYSSAL.has(u?.def?.charId ?? u?.def?.raw?.charId);
const enemyHasTag = (e, tag) => !!e && e.side === 'enemy' && Array.isArray(e.def?.tags) && e.def.tags.includes(tag);
const keySet = (unit) => unit.rangeKeySet || new Set(unit.rangeKeys || []);
function enemiesOnRange(battle, unit, keys = null) {
  const set = keys || keySet(unit);
  const out = [];
  for (const e of battle.enemies) if (e.alive && !e.hidden && bodyInKeys(e, set)) out.push(e);
  return out;
}
function targetsInRange(battle, unit, n = 0, keys = null) {
  const list = battle.enemiesInKeys(keys || unit.rangeKeys, unit, { canHitFly: true });
  sortEnemyTargets(battle, unit, list, unit.profile?.priority ?? null);
  return n > 0 && list.length > n ? list.slice(0, n) : list;
}
function targetsInGrid(battle, unit, g) {
  return battle.unitsInGrid(unit, g, { side: 'enemy' }).filter((e) => canTargetEnemy(unit, e, { canHitFly: true }));
}
const whileDeployed = (battle, unit, iv, fn) => battle.every(iv, () => { if (unit.alive && unit.deployed) fn(); }, { owner: unit });
const pulse = (battle, target, key, mods, extra = {}) => battle.addBuff(target, { key, mods, duration: AURA_DUR, ...extra });
function toggleBuff(battle, unit, key, on, mods) {
  const cur = unit.findBuff(key);
  if (on) {
    if (!cur || JSON.stringify(cur.mods) !== JSON.stringify(mods)) battle.addBuff(unit, { key, mods });
  } else if (cur) battle.removeBuff(unit, key);
}
function spAura(battle, source, value, filter) {
  whileDeployed(battle, source, AURA, () => {
    for (const a of battle.alliesFor(source, source.ownerId)) {
      if (!filter(a)) continue;
      const cur = a.findBuff('aura:spRecovery');
      if (cur && cur.source !== source && cur.source?.alive && (cur.data?.v ?? 0) > value) continue;
      battle.addBuff(a, { key: 'aura:spRecovery', mods: { spRecoveryFlat: value }, duration: AURA_DUR, source, data: { v: value } });
    }
  });
}
function inspire(battle, target, val, src, stat = 'atk') {
  if (!(val > 0) || !target || !target.alive || target.mem?.noInspire) return;
  const key = stat === 'hp' ? 'inspire:hp' : 'inspire';
  const cur = target.findBuff(key);
  if (cur && cur.data && cur.data.src !== src.id && cur.data.val > val && cur.timeLeft > 1e-6) return;
  const { add, mul } = aggregateMods(target.buffs.filter((b) => b.key !== key));
  const f = stat === 'hp' ? Math.max(0, 1 + (add.hpPct ?? 0)) * (mul.hpMul ?? 1) : Math.max(0, 1 + (add.atkPct ?? 0)) * (mul.atkMul ?? 1);
  const flat = f > 1e-6 ? val / f : val;
  battle.addBuff(target, { key, mods: stat === 'hp' ? { hpFlat: flat } : { atkFlat: flat }, duration: AURA_DUR, source: src, visible: true, data: { src: src.id, val } });
}
const resCut = (v) => (Math.abs(v) < 1 ? { resMul: Math.max(0, 1 + v) } : { resFlat: v });
const reveal = (battle, enemies) => { for (const e of enemies) if (e.s.flags.stealth) pulse(battle, e, 'aura:reveal', null, { flags: { reveal: true } }); };
function shove(battle, e, from, force) {
  return e && e.alive ? battle.push(e, num(force, 0), { from }) : 0;
}
function freeTile(battle, r, c, { ranged = false, ground = false } = {}) {
  if (!Number.isInteger(r) || !Number.isInteger(c) || !battle.grid.inRect(r, c)) return false;
  if (battle.isReservedTile(r, c)) return false;
  if (!battle.grid.canStand(r, c, { ranged })) return false;
  if (ground && !battle.grid.groundPassable(r, c)) return false;
  for (const u of battle.allyUnits) if (!u.removed && u.homeR === r && u.homeC === c && u.kind !== 'device') return false;
  return true;
}
const skillActive = (u) => !!(u.skill && u.skill.active && u.skill.kind !== 'passive');
const downed = (u) => (u.bossPool ? !(u.bossPool.hp > 0) : !(u.hp > 0));
const selId = (def) => def?.skill?.id ?? def?.raw?.skill?.skillId ?? null;
const isSel = (def, id) => selId(def) === id;
function alt(def, builders) {
  const id = selId(def);
  return id && typeof builders[id] === 'function' ? { [id]: builders[id]() } : {};
}
const moduleIs = (def, id) => !!(def?.raw?.module?.active && def.raw.module.id === id);
const instantKind = (def) => ((def?.skill?.maxCharges ?? 1) > 1 ? 'charges' : 'instant');
const isEliteEnemy = (e) => !!e && (e.isBoss || e.def?.rank === 'ELITE' || e.def?.rank === 'BOSS');
function lonely(battle, unit, diag = false) {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if ((!dr && !dc) || (!diag && dr && dc)) continue;
      const r = unit.tileR + dr, c = unit.tileC + dc;
      if (!battle.grid.inBounds(r, c)) continue;
      const o = battle.unitAt(r, c);
      if (o && o !== unit && o.side === 'ally' && o.kind !== 'device') return false;
    }
  }
  return true;
}
const rangeUp = (battle, unit, n = 1) => battle.addBuff(unit, { key: 'module:range', mods: { rangeExtend: n }, persist: true, allowDead: true });
function moduleRangeGrid(def) {
  const m = def?.raw?.module;
  if (!m || !m.active || !m.id) return null;
  const rec = (def.raw.modules || []).find((x) => x && x.uniEquipId === m.id);
  for (const t of rec?.talentChanges || []) { const g = grid(t?.rangeGrid); if (g) return g; }
  return null;
}
const applyModuleRange = (battle, unit, def) => { const g = moduleRangeGrid(def); if (g) { unit.rangeGrid = g; battle.refreshRange(unit); } };
function pullToFront(battle, unit, e, force) {
  return e && e.alive ? battle.pullToFront(e, unit, num(force, 0)) : 0;
}
function installLowHpHealBonus(battle, unit, tb, { atOrBelow = false } = {}) {
  const s = num(tb.heal_scale, 0), r = num(tb.hp_ratio, 0);
  if (!(s > 0) || !(r > 0)) return;
  const low = atOrBelow ? (t) => t.hpRatio <= r + 1e-9 : (t) => t.hpRatio < r;
  battle.on('heal', (c) => { if (c.source === unit && c.target !== unit && low(c.target)) c.amount *= s; }, { owner: unit });
}
export { COLS, bodyDist, bodyInKeys, absoluteRangeKeys, canTargetEnemy, sortEnemyTargets, normalizeChess, aggregateMods, CAT_SHIELD_KEY, isHpLoss, holdsUndying, byEnemyAttack, TICK_EPS, AURA, AURA_DUR, ABYSSAL, LINE, BILLRO_S3_RAMP, BILLRO_MARK, AROMA_MARK, BILLRO_MARK_MAX, num, tbb, moduleBb, grid, batFlat, tileKey, nationOf, isAbyssal, enemyHasTag, keySet, enemiesOnRange, targetsInRange, targetsInGrid, whileDeployed, pulse, toggleBuff, spAura, inspire, resCut, reveal, shove, freeTile, skillActive, downed, selId, isSel, alt, moduleIs, instantKind, isEliteEnemy, lonely, rangeUp, moduleRangeGrid, applyModuleRange, pullToFront, installLowHpHealBonus };
