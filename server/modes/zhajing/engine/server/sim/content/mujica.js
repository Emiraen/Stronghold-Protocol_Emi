// Ave Mujica shared Fever. Source: PRTS 丰川祥子 / Fever (2026-10-22).
// The auto-chess skill policy supplies the manual activation which triggers Fever.
import { activeBonds, ownedJibianIdsOf } from './jibianBonds.js';

export const MUJICA_CHARS = Object.freeze(['char_4182_oblvns', 'char_4183_mortis', 'char_4184_dolris', 'char_4185_amoris', 'char_4186_tmoris']);
export const FEVER_MAX = 450;
export const FEVER_DURATION = 20;
const CHAR_SET = new Set(MUJICA_CHARS);
export const isMujica = (unit) => CHAR_SET.has(unit?.def?.charId ?? unit?.charId);
const playerId = (unitOrId) => typeof unitOrId === 'object' ? unitOrId?.ownerId : unitOrId;
const live = (u) => u?.alive && u.deployed && !u.hidden;
// ★ 2026-10-23（owner）：戴「谜の假面」（chess_item_mujica_mask）的干员也算【颂乐人偶】成员
//   —— 与袖章让戴的人算 S.E.E.S 成员同一套语义：影响 Fever 鼓舞的「成员攻击力总和」。
const wearsMask = (u) => Array.isArray(u.items) && u.items.some((it) => String(it).startsWith('chess_item_mujica_mask'));
const members = (b, id) => b.allyUnits.filter((u) => live(u) && (isMujica(u) || wearsMask(u)) && u.ownerId === id);

// This module also runs in the browser's local battle simulator. Use the shared
// card-bond definition and this owner's battle snapshot, never the team's picks.
export function getFeverMax(battle, who) {
  if (!/zhajing/i.test(String(battle?.modeId || ''))) return FEVER_MAX;
  const id = playerId(who);
  const player = battle.players.find((p) => p.playerId === id);
  const tier = activeBonds(ownedJibianIdsOf(player)).find((b) => b.def.id === 'ave_mujica')?.tier || 0;
  return tier >= 3 ? 50 : tier >= 2 ? FEVER_MAX / 2 : FEVER_MAX;
}

function state(battle, who) {
  ensureMujica(battle);
  const id = playerId(who);
  if (!battle._mujica.has(id)) battle._mujica.set(id, { playerId: id, value: 0, until: 0, active: false, previous: new Set(), issued: new Set(), doomed: new Set(), nextEmit: 0 });
  return battle._mujica.get(id);
}
export const getFever = (battle, who) => state(battle, who).value;
export const isFeverActive = (battle, who) => state(battle, who).active;
export function feverState(battle, who) {
  const s = state(battle, who);
  return { playerId: s.playerId, value: s.value, max: getFeverMax(battle, who), active: s.active, remaining: Math.max(0, s.until - battle.time) };
}
function emit(b, s) {
  // S1 is an instant effect, but its original Skill_1 clip lasts 1.3 s at
  // baseline speed (the same as Sakiko's 1.3 s BAT). Use the current attack
  // interval for that animation window; this is presentation state only.
  // PRTS says S1 repeats during Fever, but does not specify the original
  // music system's instantaneous-skill sampling window.
  const performers = members(b, s.playerId).filter((u) => u.skill?.active
    || u.skill?.id === 'skchr_oblvns_1' && u.canAct && b.time < (u.mem.mujicaInstantUntil || 0));
  const distinct = new Set(performers.filter((u) => s.issued.has(u.id) && isMujica(u)).map((u) => u.def.charId));
  b.fx('mujicaFever', { ...feverState(b, s.playerId), performing: performers.length > 0, vocal: distinct.size === 5 });
  s.nextEmit = b.time + 0.25;
}
export function addFever(battle, who, amount) {
  const s = state(battle, who);
  if (s.active || !(amount > 0) || !Number.isFinite(amount)) return s.value;
  const before = s.value;
  s.value = Math.min(getFeverMax(battle, who), s.value + amount);
  if (s.value !== before && battle.time >= s.nextEmit) emit(battle, s);
  return s.value;
}
/** 羁绊「Ave Mujica」的鼓舞：Fever 期间全体己方干员 +（成员攻击力总和 × 档位系数）。 */
const INSPIRE_PREFIX = 'mujica:inspire:';

/** 当前档位对应的鼓舞系数：二档 50%，一档 30%，未激活 0。 */
function inspirePct(b, pid) {
  const player = (b.players || []).find((p) => p && p.playerId === pid);
  const tier = activeBonds(ownedJibianIdsOf(player)).find((x) => x.def.id === 'ave_mujica')?.tier || 0;
  return tier >= 3 ? 0.5 : tier >= 2 ? 0.3 : 0;
}

/**
 * 把鼓舞挂到该玩家的所有己方干员身上（Fever 期间）；onlyMissing 时跳过已经挂过的
 * （部署途中新上场的单位用，避免每帧重刷所有人的属性）。
 */
function applyInspire(b, s, onlyMissing = false) {
  const key = INSPIRE_PREFIX + s.playerId;
  const val = Math.max(0, Number(s.inspire) || 0);
  for (const u of b.allyUnits || []) {
    if (!u || u.ownerId !== s.playerId || !u.alive) continue;
    const has = typeof u.findBuff === 'function' && u.findBuff(key);
    if (val > 0) {
      if (onlyMissing && has) continue;
      b.addBuff(u, { key, mods: { atkFlat: val }, persist: true, refresh: 'replace' });
    } else if (has) {
      b.removeBuff(u, key);
    }
  }
}

function begin(b, s) {
  s.active = true; s.value = 0; s.until = b.time + FEVER_DURATION;
  s.previous.clear(); s.issued.clear(); s.doomed.clear();
  for (const u of members(b, s.playerId)) {
    if (u.skill?.active && u.skill.isTimed) s.previous.add(u.id);
    u.mem.mujicaFever = true;
    u.mem.mujicaFeverPaused = s.previous.has(u.id);
  }
  // ★ 2026-10-23（owner）：Fever 期间全体己方干员获得鼓舞（成员攻击力总和 × 档位系数）
  const pct = inspirePct(b, s.playerId);
  let sumAtk = 0;
  for (const u of members(b, s.playerId)) sumAtk += Number(u.s && u.s.atk) || 0;
  s.inspire = pct > 0 ? sumAtk * pct : 0;
  applyInspire(b, s);
  emit(b, s);
}
function end(b, s) {
  s.active = false;
  // 鼓舞随 Fever 结束移除
  s.inspire = 0;
  applyInspire(b, s);
  for (const u of b.allyUnits.filter((u) => u.ownerId === s.playerId && isMujica(u))) {
    u.mem.mujicaFever = false; u.mem.mujicaFeverPaused = false;
    if (s.issued.has(u.id) && !s.previous.has(u.id)) u.skill?.end('fever-ended');
    if (s.doomed.has(u.id) && live(u)) b.retreat(u, { reason: 'mujica-fever', dying: true });
  }
  s.previous.clear(); s.issued.clear(); s.doomed.clear();
  emit(b, s);
}
export function ensureMujica(battle) {
  if (battle._mujica) return battle._mujica;
  battle._mujica = new Map();
  battle.on('beforeSkillStart', (c) => {
    if (!isMujica(c.unit)) return;
    const s = state(battle, c.unit);
    if (!s.active && s.value >= getFeverMax(battle, c.unit) && !['mujica-full', 'mujica-bonus', 'mujica-fever'].includes(c.reason)) begin(battle, s);
    if (s.active) c.free = true;
  }, { priority: 1000 });
  battle.on('skillStart', ({ unit }) => {
    if (!isMujica(unit)) return;
    const s = state(battle, unit);
    if (s.active) {
      s.issued.add(unit.id); unit.mem.mujicaFeverPaused = s.previous.has(unit.id);
      if (unit.skill?.id === 'skchr_oblvns_1') unit.mem.mujicaInstantUntil = Math.max(unit.skillAnimUntil || 0, battle.time + Math.max(0.05, unit.s.interval));
    }
  }, { priority: 1000 });
  battle.on('skillEnd', ({ unit }) => {
    if (!isMujica(unit)) return;
    const s = state(battle, unit);
    if (s.active) { s.previous.delete(unit.id); unit.mem.mujicaFeverPaused = false; }
  });
  battle.on('fatal', (c) => {
    if (c.prevented || !isMujica(c.unit)) return;
    const s = state(battle, c.unit);
    if (!s.active || !members(battle, s.playerId).some((u) => u.def.charId === 'char_4182_oblvns' && u.skill?.active && u.skill?.def?.id === 'skchr_oblvns_3')) return;
    c.prevented = true; s.doomed.add(c.unit.id);
  }, { priority: -3000 });
  battle.on('tick', ({ dt }) => {
    for (const s of battle._mujica.values()) {
      if (s.active && battle.time + dt >= s.until - 1e-9) { end(battle, s); continue; }
      if (s.active) {
        for (const u of members(battle, s.playerId)) {
          u.mem.mujicaFever = true; u.mem.mujicaFeverPaused = s.previous.has(u.id);
          const sk = u.skill;
          if (!sk || sk.active || sk.kind === 'passive' || u.mem.mujicaSwitchSkill || !u.canAct || u.s.flags.silence) continue;
          if (battle.time + 1e-9 >= (sk.nextCastAt || 0)) sk.activate('mujica-fever', { free: true });
        }
      }
      if (s.active) applyInspire(battle, s, true);   // Fever 期间中途上场的单位也吃到鼓舞
      if (battle.time >= s.nextEmit) emit(battle, s);
    }
  });
  battle.on('death', ({ unit }) => {
    if (isMujica(unit)) {
      unit.mem.mujicaFever = false; unit.mem.mujicaFeverPaused = false;
      unit.mem.mujicaInstantUntil = 0;
      const s = state(battle, unit); s.previous.delete(unit.id); s.issued.delete(unit.id); s.doomed.delete(unit.id);
    }
  });
  battle.on('battleEnd', () => {
    for (const s of battle._mujica.values()) {
      s.active = false; s.until = battle.time;
      for (const u of battle.allyUnits) if (u.ownerId === s.playerId && isMujica(u)) { u.mem.mujicaFever = false; u.mem.mujicaFeverPaused = false; }
      emit(battle, s);
    }
  });
  return battle._mujica;
}

