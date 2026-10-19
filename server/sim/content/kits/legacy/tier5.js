import { hypot } from '../../../detmath.js';
import { COLS } from '../../../constants.js';
import { bodyInKeys, bodyInRadius, bodyKeys } from '../../../body.js';
import { absoluteRangeKeys, sortEnemyTargets } from '../../../targeting.js';
import { frontOf, rotateOffset, toLocal } from '../../../dir.js';
import { mitigate, hasHp, isHpLoss } from '../../../damage.js';
import { byEnemyAttack } from './tier1.js';
const HALF_HP = 0.5;
const DUSK_SPLASH_RADIUS = 1.7;
const CANDLE_MIN_ATK = 0.35;
const CANDLE_KEY = 'enemy_5601_entlec';
const NEARBY_RADIUS = 1.7;
const BLAZE_S3_SPLASH = 1.7;
const AROUND_RADIUS = 1.5;
const WEIGHTLESS_MASS = 1;
const ICICLE_RADIUS = 1.5;
const ICICLE_DELAY = 0.3;
const ICICLE_ROWS = [1, -1, 0];
const MOTE_HIT_RADIUS = 0.4;
const ABYSSAL = new Set(['char_143_ghost', 'char_263_skadi', 'char_474_glady', 'char_4145_ulpia', 'char_1023_ghost2']);
const NEVER = Object.freeze({ rule: 'CUSTOM_RANGE', grid: Object.freeze([]) });
const AURA_IV = 0.25;
const AURA_DUR = 0.5;
const RING1 = 1.5;
const DUSK_S3_SPLASH = DUSK_SPLASH_RADIUS;
const HORN_S2_OVERLOAD_AT = 0.5;
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const on = (u) => !!u && u.alive && u.deployed && !u.removed;
const inRange = (unit, x) => !!unit.rangeKeySet && bodyInKeys(x, unit.rangeKeySet);
const talent = (chess, i) => (chess?.talents || []).find((t) => t && t.index === i)?.bb ?? {};
const talentRec = (chess, i) => (chess?.talents || []).find((t) => t && t.index === i) ?? null;
const traitBb = (chess) => chess?.trait?.bb ?? {};
const skillGrid = (chess, def) => def?.skill?.rangeGrid ?? chess?.skill?.rangeGrid ?? null;
const maxCharges = (chess, def) => num(def?.skill?.maxCharges, num(chess?.skill?.maxChargeTime, 1));
const batPct = (sec, chess) => { const b = num(chess?.stats?.bat, 1) || 1; const v = num(sec) / b; return v ? Math.max(-0.9, v) : 0; };
const mods = (m) => { const o = {}; for (const k of Object.keys(m)) { const v = m[k]; if (typeof v === 'number' && Number.isFinite(v) && v !== 0) o[k] = v; } return o; };
const dist = (a, b) => hypot(a.x - b.x, a.y - b.y);
const nationOf = (u) => u?.def?.raw?.nationId ?? null;
const inFaction = (u, bond, nations) => !!u?.def && ((u.def.bonds || []).includes(bond) || nations.includes(nationOf(u)));
const isLaterano = (u) => inFaction(u, 'lateranoShip', ['laterano']);
const isKazimierz = (u) => inFaction(u, 'kazimierzShip', ['kazimierz']);
const isKjerag = (u) => inFaction(u, 'kjeragShip', ['kjerag']);
const isSargonMinos = (u) => inFaction(u, 'sargonShip', ['sargon', 'minos']);
const isAbyssal = (u) => u?.def?.raw?.groupId === 'abyssal' || ABYSSAL.has(u?.def?.charId);
const isOp = (u) => u && u.kind === 'op';
const selectedId = (chess, def) => chess?.skill?.skillId ?? def?.skill?.id ?? null;
function lazySkills(builders) {
  const o = {};
  for (const [id, build] of Object.entries(builders)) Object.defineProperty(o, id, { enumerable: true, get: build });
  return o;
}
const instantKind = (chess, def) => (maxCharges(chess, def) > 1 ? 'charges' : 'instant');
const skillRange = (chess, def, extra = null) => {
  const g = skillGrid(chess, def);
  return g || extra ? { ...(g ? { rangeGrid: g } : {}), ...(extra || {}) } : undefined;
};
function crowdAspd(battle, unit, key, aspd, cnt) {
  if (!aspd || !(cnt > 0)) return;
  whileOn(battle, unit, 0.2, () => {
    if (battle.enemiesInKeys(unit.rangeKeys, unit, unit.profile).length >= cnt) battle.addBuff(unit, { key, duration: 0.3, mods: { aspd } });
  });
}
function burstSpUp(battle, unit, key, sp) {
  if (!(sp > 0)) return;
  whileOn(battle, unit, AURA_IV, () => {
    if (battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true }).some((e) => e.s.flags.burstLock)) battle.addBuff(unit, { key, duration: AURA_DUR, mods: { spRecoveryFlat: sp } });
  });
}
function enemySpUp(battle, unit, key, sp) {
  if (!(sp > 0)) return;
  whileOn(battle, unit, AURA_IV, () => {
    if (battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true }).length) battle.addBuff(unit, { key, duration: AURA_DUR, mods: { spRecoveryFlat: sp } });
  });
}
function leaderOf(battle, unit) {
  const cid = unit.def?.charId;
  for (const a of battle.allyUnits) if (on(a) && a.def?.charId === cid) return a;
  return null;
}
function meleeAttacker(e, t) {
  const melee = e.profile?.melee ?? e.def?.applyWay === 'MELEE';
  const r = num(e.base?.rangeRadius, 0);
  return melee || !(r > 0) || (e.blockedBy === t && r < 1);
}
const isStill = (e) => !!(e.blockedBy || !e.moving || e.s.flags.stun || e.s.flags.noMove || !(e.s.moveSpeed > 0));
function elementHit(battle, src, tgt, amount, tag, element = null) {
  if (!tgt || !tgt.alive || !(amount > 0)) return 0;
  return battle.dealDamage(src, tgt, { amount, type: 'elemental', element, canDodge: false, tags: ['element', tag] });
}
function autoCast(battle, unit, cond) {
  battle.on('tick', () => {
    const sk = unit.skill;
    if (!sk || sk.noSkill || !on(unit) || !unit.canAct || !sk.ready || unit.s.flags.silence) return;
    if (sk.active && sk.isTimed) return;
    if (battle.time - sk.lastStart < unit.s.interval - 1e-9) return;
    if (cond()) sk.activate('DEFAULT');
  }, { owner: unit });
}
function whileOn(battle, unit, sec, fn) {
  battle.every(sec, () => { if (on(unit)) fn(); }, { owner: unit });
}
function spAura(battle, unit, value, filter) {
  if (!(value > 0)) return;
  whileOn(battle, unit, AURA_IV, () => {
    for (const a of battle.alliesFor(unit)) {
      if (!filter(a)) continue;
      const cur = a.findBuff('aura:spRecovery');
      if (cur && num(cur.mods?.spRecoveryFlat) > value + 1e-9) continue;
      battle.addBuff(a, { key: 'aura:spRecovery', duration: AURA_DUR, mods: { spRecoveryFlat: value } });
    }
  });
}
function burstDamageUp(battle, unit, mul) {
  if (!(mul > 1)) return;
  battle.on('hit', (c) => {
    if (c.source !== unit || !c.target || c.target.side !== 'enemy' || c.dmg.type === 'element') return;
    if (c.target.s.flags.burstLock) c.dmg.mul *= mul;
  }, { owner: unit });
}
function lowHpHealUp(battle, unit, tb, { atOrBelow = false } = {}) {
  const mul = num(tb.heal_scale), thr = num(tb.hp_ratio);
  if (!(mul > 1) || !(thr > 0)) return;
  const low = atOrBelow ? (t) => t.hpRatio <= thr + 1e-9 : (t) => t.hpRatio < thr;
  battle.on('heal', (c) => {
    if (c.source !== unit || c.opts?.regen || !c.target || c.target.side !== 'ally') return;
    if (low(c.target)) c.amount *= mul;
  }, { owner: unit });
}
function moduleRangeUp(battle, unit, chess) {
  if (!chess?.isGolden || !/攻击范围扩大/.test(String(chess?.trait?.moduleDesc ?? ''))) return;
  const m = chess.module;
  const rec = m && m.active && m.id ? (chess.modules || []).find((x) => x && x.uniEquipId === m.id) : null;
  const g = (rec?.talentChanges || []).find((t) => t && t.talentIndex === -1 && Array.isArray(t.rangeGrid) && t.rangeGrid.length)?.rangeGrid;
  if (g) {
    unit.rangeGrid = g.map((p) => [p[0], p[1]]);
    battle.refreshRange(unit);
    return;
  }
  // a permanent (persist, never-expiring) rangeExtend: the engine counts it in the initial range of the DEFAULT skill
  // trigger ("敌人进入初始攻击范围") as well
  battle.addBuff(unit, { key: 't5:moduleRange', mods: { rangeExtend: 1 }, persist: true, allowDead: true });
}
function permBuff(battle, unit, key, m) {
  const mm = mods(m);
  if (Object.keys(mm).length) battle.addBuff(unit, { key, mods: mm, persist: true, allowDead: true });
}
function enemiesInGrid(battle, unit, grid, n = 0, { ignoreStealth = false } = {}) {
  const keys = absoluteRangeKeys(grid || unit.rangeGrid || [[0, 0]], unit.tileR, unit.tileC, unit.dir, 0);
  let list;
  if (ignoreStealth) {
    const set = new Set(keys);
    list = battle.enemies.filter((e) => e.alive && !e.hidden && e.deployed && !e.s.flags.untargetable && bodyInKeys(e, set));
  } else list = battle.enemiesInKeys(keys, unit, { canHitFly: true });
  sortEnemyTargets(battle, unit, list, null);
  return n > 0 && list.length > n ? list.slice(0, n) : list;
}
const ROAD_CACHE = new WeakMap();
function straightRun(battle, r, c) {
  let m = ROAD_CACHE.get(battle);
  if (!m) {
    m = new Map();
    const g = battle.grid, R = battle.rect;
    const pass = (rr, cc) => g.groundPassable(rr, cc, true);
    for (let rr = R.r0; rr <= R.r1; rr++) {
      for (let cc = R.c0; cc <= R.c1; cc++) {
        if (!pass(rr, cc)) continue;
        let h = 1, v = 1;
        for (let k = cc - 1; k >= R.c0 && pass(rr, k); k--) h++;
        for (let k = cc + 1; k <= R.c1 && pass(rr, k); k++) h++;
        for (let k = rr - 1; k >= R.r0 && pass(k, cc); k--) v++;
        for (let k = rr + 1; k <= R.r1 && pass(k, cc); k++) v++;
        m.set(rr * COLS + cc, Math.max(h, v));
      }
    }
    ROAD_CACHE.set(battle, m);
  }
  return m.get(r * COLS + c) ?? 0;
}
export { COLS, bodyInKeys, bodyInRadius, bodyKeys, absoluteRangeKeys, sortEnemyTargets, frontOf, rotateOffset, toLocal, mitigate, hasHp, isHpLoss, byEnemyAttack, HALF_HP, DUSK_SPLASH_RADIUS, CANDLE_MIN_ATK, CANDLE_KEY, NEARBY_RADIUS, BLAZE_S3_SPLASH, AROUND_RADIUS, WEIGHTLESS_MASS, ICICLE_RADIUS, ICICLE_DELAY, ICICLE_ROWS, MOTE_HIT_RADIUS, ABYSSAL, NEVER, AURA_IV, AURA_DUR, RING1, DUSK_S3_SPLASH, HORN_S2_OVERLOAD_AT, num, on, inRange, talent, talentRec, traitBb, skillGrid, maxCharges, batPct, mods, dist, nationOf, inFaction, isLaterano, isKazimierz, isKjerag, isSargonMinos, isAbyssal, isOp, selectedId, lazySkills, instantKind, skillRange, crowdAspd, burstSpUp, enemySpUp, leaderOf, meleeAttacker, isStill, elementHit, autoCast, whileOn, spAura, burstDamageUp, lowHpHealUp, moduleRangeUp, permBuff, enemiesInGrid, ROAD_CACHE, straightRun };
