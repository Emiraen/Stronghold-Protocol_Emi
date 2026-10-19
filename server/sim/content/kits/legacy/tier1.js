import { COLS, CHAIN_RADIUS, TICK } from '../../../constants.js';
import { isHpLoss } from '../../../damage.js';
import { absoluteRangeKeys, sortEnemyTargets } from '../../../targeting.js';
import { frontOf, offsetTile } from '../../../dir.js';
import { bodyInKeys, bodyOnTile, bodyTileReach } from '../../../body.js';
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : d));
function talentAt(chess, i) {
  const list = (chess?.talents ?? []).filter((t) => t && t.index !== -1);
  return list[i] ?? null;
}
const talentBb = (chess, i = 0) => talentAt(chess, i)?.bb ?? {};
const talentGrid = (chess, i = 0) => talentAt(chess, i)?.rangeGrid ?? null;
function moduleBb(chess) {
  const o = {};
  for (const t of chess?.talents ?? []) if (t && t.index === -1 && t.bb) Object.assign(o, t.bb);
  return o;
}
const traitBb = (chess) => chess?.trait?.bb ?? {};
const moduleOn = (chess) => !!(chess?.module && chess.module.active);
const up = (u) => !!u && u.alive && u.deployed;
const posKey = (u) => Math.round(u.y) * COLS + Math.round(u.x);
const cheb = (a, b) => (b.hitArea ? bodyTileReach(b, Math.round(a.y), Math.round(a.x))
  : a.hitArea ? bodyTileReach(a, Math.round(b.y), Math.round(b.x))
    : Math.max(Math.abs(Math.round(a.y) - Math.round(b.y)), Math.abs(Math.round(a.x) - Math.round(b.x))));
const isMainHit = (dmg) => !!dmg && dmg.isAttack && !dmg.isSplash && !(dmg.tags && dmg.tags.includes('chain'));
const byEnemyAttack = (ctx) => {
  const s = ctx.source, d = ctx.dmg;
  if (!s || s.side !== 'enemy' || !d || d.sourceless || ctx.type === 'element' || isHpLoss(d)) return false;
  return !(Array.isArray(d.tags) && (d.tags.includes('counter') || d.tags.includes('reflect')));
};
const PROTECT = 'protect';
const protectMods = (v) => ({ physTakenMul: 1 - v, artsTakenMul: 1 - v });
const PROTECT_TICK_HOLD = 1.5 * TICK;
function holdProtect(battle, target, value, duration, source = null) {
  if (value > 0) battle.applyStrongest(target, PROTECT, { duration, value, mods: protectMods, source });
}
const hurtSpDamage = (ctx) => !!ctx.dmg && !ctx.dmg.noSp && ctx.type !== 'element' && ctx.amount > 0;
const skillBusy = (u) => !!(u.skill && u.skill.active && u.skill.isTimed);
function giveSp(u, n, reason = 'talent') {
  if (!u || !u.skill || u.skill.noSkill || skillBusy(u) || !(n > 0)) return 0;
  return u.skill.gainSp(n, reason);
}
function onHitBy(battle, unit, fn, priority = 0) {
  return battle.on('hit', (ctx) => { if (ctx.source === unit && ctx.target && ctx.target.side === 'enemy') fn(ctx); }, { owner: unit, priority });
}
function onHitOn(battle, unit, fn, priority = 0) {
  return battle.on('hit', (ctx) => { if (ctx.target === unit) fn(ctx); }, { owner: unit, priority });
}
function onDamagedOn(battle, unit, fn, priority = 0) {
  return battle.on('damaged', (ctx) => { if (ctx.target === unit) fn(ctx); }, { owner: unit, priority });
}
function enemiesInGrid(battle, unit, grid, { n = 0, priority = null, canHitFly = true, groundOnly = false } = {}) {
  const keys = grid ? absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0) : unit.rangeKeys;
  const list = battle.enemiesInKeys(keys, unit, { canHitFly, groundOnly });
  sortEnemyTargets(battle, unit, list, priority ?? unit.profile?.priority ?? null);
  return n > 0 && list.length > n ? list.slice(0, n) : list;
}
function alliesInGridOf(battle, unit, grid = null) {
  const set = grid ? new Set(absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0)) : (unit.rangeKeySet || new Set(unit.rangeKeys || []));
  return battle.allyUnits.filter((a) => a.alive && a.deployed && !a.hidden && a.kind !== 'device' && set.has(a.tileR * COLS + a.tileC) && battle.allySelectable(a, unit));
}
const enemyInRange = (battle, unit) => battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true }).length > 0;
const ONCE = new WeakMap();
function once(battle, key, fn) {
  let s = ONCE.get(battle);
  if (!s) ONCE.set(battle, (s = new Set()));
  if (s.has(key)) return;
  s.add(key);
  fn();
}
function statBuff(battle, unit, key, mods) {
  const m = {};
  for (const [k, v] of Object.entries(mods)) if (Number.isFinite(v) && v !== 0 && !(k.endsWith('Mul') && v === 1)) m[k] = v;
  if (Object.keys(m).length) battle.addBuff(unit, { key, mods: m, persist: true, allowDead: true, tags: ['talent'] });
}
function toggleBuff(battle, unit, key, cond, mods, extra = {}) {
  const check = () => {
    const want = up(unit) && !!cond();
    const has = unit.findBuff(key);
    if (want && !has) battle.addBuff(unit, { key, mods: typeof mods === 'function' ? mods() : mods, tags: ['talent'], ...extra });
    else if (!want && has) battle.removeBuff(unit, key);
  };
  battle.on('tick', check, { owner: unit });
  battle.on('battleStart', check, { owner: unit });
  battle.on('deploy', (ctx) => { if (ctx.unit === unit && battle.started) check(); }, { owner: unit });
}
function installAura(battle, unit, { key, select, mods, value = 0, interval = 0.5 }) {
  battle.every(interval, () => {
    if (!up(unit)) return;
    for (const a of battle.alliesFor(unit)) {
      if (!select(a)) continue;
      const cur = a.findBuff(key);
      if (cur && cur.source !== unit && (cur.data?.v ?? 0) > value && cur.timeLeft > 0.05) continue;
      battle.addBuff(a, { key, duration: interval + 0.1, mods: typeof mods === 'function' ? mods(a) : mods, source: unit, data: { v: value }, tags: ['aura'] });
    }
  }, { owner: unit, immediate: true });
}
function spTimeBonus(battle, unit, perSec, cond) {
  if (!(perSec > 0)) return;
  battle.on('spGain', (ctx) => {
    if (ctx.unit === unit && ctx.reason === 'time' && cond()) ctx.amount += perSec * battle.dt;
  }, { owner: unit });
}
function installReveal(battle, unit, interval = 0.2) {
  battle.every(interval, () => {
    if (!up(unit) || !unit.rangeKeySet) return;
    for (const e of battle.enemies) {
      if (!e.alive || e.hidden || !e.s.flags.stealth || !bodyInKeys(e, unit.rangeKeySet)) continue;
      const was = !!e.s.flags.reveal;
      if (battle.applyStatus(e, 'reveal', { duration: interval + 0.1, source: unit }) && !was) battle.fx('reveal', { x: e.x, y: e.y, id: e.id });
    }
  }, { owner: unit });
}
function makeZone(battle, caster, { x, y, radius, duration, interval = 1, skill, onPulse, onEnd }) {
  const total = Math.max(1, Math.round(duration / interval));
  let n = 0;
  battle.fx('zone', { x, y, radius, dur: duration, id: caster.id, skill });
  return battle.every(interval, (b, sc) => {
    onPulse(b);
    if (++n >= total) { sc.cancel(); if (onEnd) onEnd(b); }
  }, { immediate: true });
}
function summonTileFree(battle, r, c) {
  return Number.isInteger(r) && Number.isInteger(c) && battle.grid.inRect(r, c) && !battle.isReservedTile(r, c);
}
function freeTileAround(battle, unit, ok) {
  const order = [[0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0], [0, -1], [1, -1], [-1, -1]];
  for (const [dr, dc] of order) {
    const [r, c] = offsetTile(unit.tileR, unit.tileC, dr, dc, unit.dir);
    if (!summonTileFree(battle, r, c)) continue;
    if (ok(r, c)) return [r, c];
  }
  return null;
}
const instantKind = (def) => ((def?.skill?.maxCharges ?? 1) > 1 ? 'charges' : 'instant');
function skillRec(chess, skillId) {
  if (chess?.skill && (chess.skill.skillId ?? chess.skill.id) === skillId) return chess.skill;
  return (chess?.skills ?? []).find((s) => s && s.skillId === skillId) ?? null;
}
const skillBbOf = (chess, skillId) => skillRec(chess, skillId)?.bb ?? {};
function batMod(v, chess = null, desc = '') {
  const x = num(v, 0);
  if (!x) return 0;
  if (x > 0 && x < 1 && /间隔[^，。；]*缩短/.test(desc)) return x - 1;
  const bat = num(chess?.stats?.bat, 1) || 1;
  return Math.max(-0.9, x / bat);
}
const SPORE_RADIUS = 0.9;
const RING1 = 1.5;
const PROVE_S2_MAX_HP = 0.8;
function tinmanKit(bb, chess, def) {
  const dur = num(bb.projectile_delay_time, 10);
  const radius = num(bb.projectile_range, 1.5);
  const dmgScale = num(bb.atk_scale);
  const healRatio = num(bb.hp_recovery_per_sec_ratio);
  const wither = num(talentBb(chess, 1)['skill@damage_scale'], 1);
  const spBonus = num(moduleBb(chess).sp_recovery_per_sec);
  const witherKey = 'tinman:wither';
  return {
    skill: {
      kind: instantKind(def),
      onStart({ battle, unit }) {
        const tgt = enemiesInGrid(battle, unit, null, { n: 1, groundOnly: true })[0] ?? enemiesInGrid(battle, unit, null, { n: 1 })[0];
        const x = tgt ? tgt.x : unit.x + unit.fwd[1], y = tgt ? tgt.y : unit.y + unit.fwd[0];
        const atk = unit.s.atk;
        unit.mem.tinZones = (unit.mem.tinZones ?? 0) + 1;
        const regenKey = `tinman:zone:${unit.id}:${unit.mem.tinZoneSeq = (unit.mem.tinZoneSeq ?? 0) + 1}`;
        makeZone(battle, unit, {
          x, y, radius, duration: dur, skill: 'tinman', onPulse(b) {
            for (const e of b.foesInRadius(x, y, radius)) {
              if (e.isFlying || e.s.flags.untargetable) continue;
              if (wither > 1) b.addBuff(e, { key: witherKey, duration: 1.05, data: { mul: wither }, source: unit });
              b.dealDamage(unit, e, { amount: atk * dmgScale, type: 'arts', isSkill: true, canDodge: false, tags: ['dot', 'zone'] });
            }
            // pulses every second: the buff bridges to the next pulse (two ticks over), the last one ends with the unit
            if (healRatio > 0) {
              for (const a of b.alliesInRadius(x, y, radius, null)) {
                if (b.allySelectable(a, unit)) b.addBuff(a, { key: regenKey, duration: 1 + 2 * b.dt, source: unit, mods: { hpRegen: atk * healRatio } });
              }
            }
          },
          onEnd() { unit.mem.tinZones = Math.max(0, (unit.mem.tinZones ?? 1) - 1); },
        });
      },
    },
    talents: [{ install(battle, unit) {
      if (wither > 1) {
        // "持续伤害" = damage over time only: 'dot'-tagged ticks and the per-second ticks of a necrosis / apoptosis
        // burst — never instantaneous bursts (burn/neural bursts, skill/summon bursts are also tagged 'burst')
        once(battle, witherKey, () => battle.on('hit', (ctx) => {
          if (!ctx.target || ctx.target.side !== 'enemy') return;
          const tags = ctx.dmg.tags || [];
          if (!(tags.includes('dot') || tags.includes('necrosis') || tags.includes('apoptosis'))) return;
          const w = ctx.target.findBuff(witherKey);
          if (w) ctx.dmg.amount *= w.data?.mul ?? 1;
        }));
      }
      spTimeBonus(battle, unit, spBonus, () => (unit.mem.tinZones ?? 0) > 0);
    } }],
  };
}
export { COLS, CHAIN_RADIUS, TICK, isHpLoss, absoluteRangeKeys, sortEnemyTargets, frontOf, offsetTile, bodyInKeys, bodyOnTile, bodyTileReach, num, talentAt, talentBb, talentGrid, moduleBb, traitBb, moduleOn, up, posKey, cheb, isMainHit, byEnemyAttack, PROTECT, protectMods, PROTECT_TICK_HOLD, holdProtect, hurtSpDamage, skillBusy, giveSp, onHitBy, onHitOn, onDamagedOn, enemiesInGrid, alliesInGridOf, enemyInRange, ONCE, once, statBuff, toggleBuff, installAura, spTimeBonus, installReveal, makeZone, summonTileFree, freeTileAround, instantKind, skillRec, skillBbOf, batMod, SPORE_RADIUS, RING1, PROVE_S2_MAX_HP, tinmanKit };
