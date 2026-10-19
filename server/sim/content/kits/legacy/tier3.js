import { absoluteRangeKeys, sortEnemyTargets, canTargetEnemy } from '../../../targeting.js';
import { COLS, PUSH_DIRECTIONAL_MIN_DIST } from '../../../constants.js';
import { bodyDist, bodyInKeys, bodyOnTile } from '../../../body.js';
import { normalizeChess, normalizeSkill } from '../../../simdata.js';
import { tacticalPoint as sharedTacticalPoint, releaseSkillSummon, wolfTacticalPoint, wolfShadowInterval, wolfReturnNow, installWolfTacticalPoint } from '../../tokens.js';
import { isHpLoss } from '../../../damage.js';
const REGEN_IV = 0.25;
const SWIRE2_BOMB_GRID = Object.freeze([[2, 0], [1, 0], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2], [-1, 0], [-2, 0]]);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const defOf = (chess, def) => def ?? normalizeChess(chess);
const talentBb = (d, i) => d?.talents?.[i]?.bb ?? {};
const traitBb = (d) => d?.traitBb ?? {};
const moduleTalentBb = (chess) => (chess?.talents ?? []).find((t) => t && t.hidden && t.fromModule)?.bb ?? null;
const selectedId = (chess, d) => d?.skill?.id ?? chess?.skill?.skillId ?? null;
function skillData(chess, d, bb, id) {
  if (id != null && selectedId(chess, d) === id && d?.skill) return { ...d.skill, bb: bb ?? d.skill.bb ?? {} };
  const rec = (chess?.skills ?? []).find((s) => s && s.skillId === id);
  return (rec && normalizeSkill({ skill: rec })) || { id, bb: {}, rangeGrid: null, maxCharges: 1, duration: 0, description: '' };
}
function altSkills(chess, d, bb, builders) {
  const out = {};
  for (const [id, build] of Object.entries(builders)) out[id] = build(skillData(chess, d, bb, id));
  return out;
}
const instantKindOf = (s) => ((s?.maxCharges ?? 1) > 1 ? 'charges' : 'instant');
const statSkill = (s) => {
  const b = s.bb || {};
  const mods = {};
  if (num(b.atk)) mods.atkPct = num(b.atk);
  if (num(b.def)) mods.defPct = num(b.def);
  if (num(b.max_hp)) mods.hpPct = num(b.max_hp);
  if (num(b.attack_speed)) mods.aspd = num(b.attack_speed);
  return { kind: 'duration', mods };
};
function profileMul(battle, unit, target) {
  const f = unit.profile?.dmgMul;
  const m = typeof f === 'function' ? f(battle, unit, target) : f;
  return typeof m === 'number' && Number.isFinite(m) ? m : 1;
}
function enemiesAround(battle, unit, x, y, r, skip = null) {
  const out = battle.foesInRadius(x, y, r).filter((e) => !(skip && skip.has(e)) && canTargetEnemy(unit, e, { canHitFly: true }));
  const d = (e) => bodyDist(e, x, y);
  return out.sort((a, b) => d(a) - d(b) || (a.spawnSeq ?? a.id) - (b.spawnSeq ?? b.id));
}
function groundAspd(key, aspd, cnt = 1) {
  return (battle, unit) => {
    let on = false;
    battle.every(0.1, () => {
      const n = alive(unit) ? battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true }).filter((e) => !e.isFlying).length : 0;
      const want = n >= Math.max(1, cnt);
      if (want === on && (!want || unit.findBuff(key))) return;
      on = want;
      if (want) battle.addBuff(unit, { key, mods: { aspd } });
      else battle.removeBuff(unit, key);
    }, { owner: unit });
  };
}
const AROUND_R = 1.5;
const alive = (u) => !!(u && u.alive && u.deployed);
const tileKeyOf = (u) => (u.side === 'ally' ? u.tileR * COLS + u.tileC : Math.round(u.y) * COLS + Math.round(u.x));
const onTiles = (x, set) => (x.side === 'ally' ? set.has(tileKeyOf(x)) : bodyInKeys(x, set));
const gridKeys = (grid, u, ext = 0) => absoluteRangeKeys(grid || [[0, 0]], u.tileR, u.tileC, u.dir, ext);
const fx = (battle, kind, u, extra = {}) => battle.fx(kind, { x: u.x, y: u.y, id: u.id, ...extra });
const copyGrid = (g) => (Array.isArray(g) && g.length ? g.map((p) => [p[0], p[1]]) : null);
const NINE = [[1, -1], [1, 0], [1, 1], [0, -1], [0, 0], [0, 1], [-1, -1], [-1, 0], [-1, 1]];
const SWIRE2_COIN_GRID = Object.freeze([[1, 1], [0, 0], [0, 1], [0, 2], [-1, 1]]);
const COLLIDE = 0.6;
const CAMOU_KEY = 'vulpis:camou';
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function textNum(text, re, fallback) {
  const m = String(text ?? '').match(re);
  if (!m) return fallback;
  return /^\d+(\.\d+)?$/.test(m[1]) ? +m[1] : (CN_NUM[m[1]] ?? fallback);
}
function freeTile(battle, r, c) {
  return Number.isInteger(r) && Number.isInteger(c) && battle.grid.inRect(r, c) && !battle.isReservedTile(r, c);
}
const groundTile = (battle, r, c) => battle.grid.groundPassable(r, c) && battle.grid.canStand(r, c);
function tacticalPoint(battle, unit, prefer = null) {
  const inRange = (r, c) => (unit.baseRangeKeys || unit.rangeKeys || []).includes(r * COLS + c);
  if (prefer && freeTile(battle, prefer[0], prefer[1]) && groundTile(battle, prefer[0], prefer[1]) && inRange(prefer[0], prefer[1])) return prefer;
  return sharedTacticalPoint(battle, unit);
}
const tokensOf = (battle, owner, tokenId) => battle.allyUnits.filter((t) => t.kind === 'token' && t.defId === tokenId && t.ownerUnit === owner && !t.mem.isClone);
const isNormalEnemy = (e) => !e.isBoss && String(e.def?.rank ?? 'NORMAL').toUpperCase() === 'NORMAL';
const ABYSSAL = new Set(['char_263_skadi', 'char_143_ghost', 'char_218_cuttle', 'char_474_glady', 'char_1023_ghost2', 'char_4145_ulpia']);
function enemiesOn(battle, unit, keys, n = 0, profile = null) {
  const list = battle.enemiesInKeys(keys, unit, profile ?? { canHitFly: true });
  sortEnemyTargets(battle, unit, list, (profile ?? unit.profile)?.priority ?? null);
  return n > 0 && list.length > n ? list.slice(0, n) : list;
}
function aura(battle, unit, o) {
  let cur = new Set();
  const iv = o.interval ?? 0.2;
  const dur = Math.max(iv * 2, 0.1) + 0.05;
  const drop = (x) => { const b = x.findBuff(o.key); if (b && b.source === unit) battle.removeBuff(x, b); };
  const update = () => {
    const next = new Set();
    if (alive(unit) && (!o.active || o.active())) {
      const keys = o.tiles();
      const set = keys instanceof Set ? keys : new Set(keys || []);
      const list = o.side === 'ally' ? battle.allyUnits : battle.enemies;
      for (const x of list) {
        if (!x.alive || !x.deployed || x.hidden || x.kind === 'device') continue;
        if (o.side === 'ally' && !battle.allySelectable(x, unit)) continue; // never a 孤立 unit (炎佑)
        if (!onTiles(x, set) || (o.filter && !o.filter(x))) continue;
        const mods = typeof o.mods === 'function' ? o.mods(x) : o.mods;
        if (!mods) continue;
        battle.addBuff(x, { key: o.key, duration: dur, refresh: 'extend', mods, source: unit, tags: ['aura'] });
        next.add(x);
      }
    }
    for (const x of cur) if (!next.has(x)) drop(x);
    cur = next;
  };
  update.clear = () => { for (const x of cur) drop(x); cur = new Set(); };
  // immediate: installed at construction ⇒ first runs right after the initial deployment (t = 0), not 1 interval later
  if (iv > 0) battle.every(iv, update, { owner: unit, immediate: true });
  return update;
}
function whileTrue(battle, unit, key, cond, mods) {
  battle.on('tick', () => {
    const on = alive(unit) && cond();
    const has = !!unit.findBuff(key);
    if (on && !has) battle.addBuff(unit, { key, mods: typeof mods === 'function' ? mods() : mods });
    else if (!on && has) battle.removeBuff(unit, key);
  }, { owner: unit });
}
function isLeader(battle, unit, tag) {
  let best = null;
  for (const a of battle.allyUnits) if (alive(a) && a.ownerId === unit.ownerId && a.mem[tag] && (!best || a.id < best.id)) best = a;
  return best === unit;
}
function giveSp(u, n, reason = 'talent') {
  const sk = u?.skill;
  if (!sk || sk.noSkill || !(n > 0) || (sk.active && sk.isTimed)) return 0;
  return sk.gainSp(n, reason);
}
function funnelMap(battle, unit, target) {
  const f = unit.profile.funnel || { init: 0.2, delta: 0.15, max: 1.1 };
  const m = unit.trait.funnelMap || (unit.trait.funnelMap = new Map());
  const prev = m.get(target.id);
  if (prev && prev.t === battle.time) return prev.s;
  const s = prev == null ? f.init : Math.min(f.max, prev.s + f.delta);
  m.set(target.id, { s, t: battle.time });
  return s;
}
function installFunnelPrune(battle, unit) {
  battle.on('beforeAttack', (ctx) => {
    if (ctx.attacker !== unit || !unit.trait.funnelMap) return;
    const ids = new Set(ctx.targets.map((t) => t.id));
    for (const k of [...unit.trait.funnelMap.keys()]) if (!ids.has(k)) unit.trait.funnelMap.delete(k);
  }, { owner: unit, priority: -100 });
}
function merchantInstall(onPay) {
  return (battle, unit) => {
    const iv = unit.profile.merchantInterval ?? 3;
    const cost = unit.profile.merchantCost ?? 3;
    battle.every(iv, () => {
      if (!alive(unit)) return;
      const pl = battle.getPlayer(unit.ownerId);
      if (!pl) return;
      if (pl.dp >= cost) {
        battle.addDp(unit.ownerId, -cost);
        onPay(battle, unit, cost);
        battle.emit('merchantPay', { unit, cost });
      } else battle.retreat(unit, { reason: 'merchant' });
    }, { owner: unit });
  };
}
export { absoluteRangeKeys, sortEnemyTargets, canTargetEnemy, COLS, PUSH_DIRECTIONAL_MIN_DIST, bodyDist, bodyInKeys, bodyOnTile, normalizeChess, normalizeSkill, sharedTacticalPoint, releaseSkillSummon, wolfTacticalPoint, wolfShadowInterval, wolfReturnNow, installWolfTacticalPoint, isHpLoss, REGEN_IV, SWIRE2_BOMB_GRID, num, defOf, talentBb, traitBb, moduleTalentBb, selectedId, skillData, altSkills, instantKindOf, statSkill, profileMul, enemiesAround, groundAspd, AROUND_R, alive, tileKeyOf, onTiles, gridKeys, fx, copyGrid, NINE, SWIRE2_COIN_GRID, COLLIDE, CAMOU_KEY, CN_NUM, textNum, freeTile, groundTile, tacticalPoint, tokensOf, isNormalEnemy, ABYSSAL, enemiesOn, aura, whileTrue, isLeader, giveSp, funnelMap, installFunnelPrune, merchantInstall };
