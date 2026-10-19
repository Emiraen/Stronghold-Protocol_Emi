import { t as trA } from '../../../../shared/i18n.js';
// 从 A 原正文按职责拆分；保持原有行为。
import { isObj, sortedPlayers } from './shared.js';
import { isCombatPhase } from './phases.js';

export const ownFieldId = (playerId) => `n:${playerId}`;

export function homeFieldId(pub, playerId) {
  const fields = Array.isArray(pub?.fields) ? pub.fields : [];
  const special = fields.find((f) => isObj(f) && f.kind !== 'normal' && Array.isArray(f.players) && f.players.includes(playerId) && f.live !== false);
  if (special) return special.fieldId;
  const me = sortedPlayers(pub).find((p) => p.playerId === playerId);
  if (me && typeof me.fieldId === 'string' && me.fieldId) return me.fieldId;
  return ownFieldId(playerId);
}

export function cycleField(fields, current, dir = 1) {
  const list = (Array.isArray(fields) ? fields : []).filter((f) => isObj(f) && typeof f.fieldId === 'string' && f.live !== false);
  if (list.length === 0) return null;
  const i = list.findIndex((f) => f.fieldId === current);
  if (i < 0) return list[0].fieldId;
  const n = list.length;
  return list[(((i + dir) % n) + n) % n].fieldId;
}

export function watchTarget(p, pub, myId) {
  if (!isObj(p)) return { reason: '无效的目标' };
  if (p.alive === false) return { reason: '该队友已被淘汰，无法查看其阵地' };
  const combat = isCombatPhase(pub?.phase);
  const fieldId = (combat && typeof p.fieldId === 'string' && p.fieldId) || ownFieldId(p.playerId);
  if (combat) {
    const fields = Array.isArray(pub?.fields) ? pub.fields.filter(isObj) : [];
    const f = fields.find((x) => x.fieldId === fieldId);
    const me = sortedPlayers(pub).find((x) => x.playerId === myId);
    const mine = fields.find((x) => Array.isArray(x.players) && x.players.includes(myId));
    if (f && (f.kind === 'boss' || f.kind === 'hidden') && me?.alive !== false && mine && mine.fieldId !== f.fieldId) {
      return { reason: '无法查看另一组队友的战场' };
    }
  }
  return { fieldId };
}

export function switcherLabel(pub, watching, myId, spectating = false) {
  const fields = (Array.isArray(pub?.fields) ? pub.fields : []).filter(isObj);
  const cur = fields.find((f) => f.fieldId === watching);
  if (cur) return fieldLabel(cur, pub, myId);
  if (typeof watching === 'string' && watching.startsWith('n:') && watching !== ownFieldId(myId)) {
    return sortedPlayers(pub).find((p) => p.playerId === watching.slice(2))?.name || trA("队友");
  }
  return spectating ? trA("观战") : trA("自己");
}

export function fieldLabel(field, pub, myId) {
  if (!isObj(field)) return '—';
  const names = new Map(sortedPlayers(pub).map((p) => [p.playerId, p.name || trA("博士")]));
  const ps = Array.isArray(field.players) ? field.players : [];
  if (field.kind === 'unite') return ps.includes(myId) ? trA("联防（自己）") : trA("联防阵地");
  if (field.kind === 'boss' || field.kind === 'hidden') {
    if (ps.includes(myId)) return ps.length > 1 ? trA("全景") : trA("自己");
    return ps.map((id) => names.get(id) || trA("博士")).join(' · ') || trA("领袖战场");
  }
  if (ps.includes(myId) || field.fieldId === ownFieldId(myId)) return trA("自己");
  const id = ps[0] ?? String(field.fieldId || '').replace(/^n:/, '');
  return names.get(id) || trA("队友");
}

export function activeBubbles(emotes, now, ttl = 3000) {
  const out = new Map();
  for (const e of Array.isArray(emotes) ? emotes : []) {
    if (!isObj(e) || !(now - e.at < ttl) || e.at > now + 1000) continue;
    const cur = out.get(e.playerId);
    if (!cur || cur.seq < e.seq) out.set(e.playerId, { id: e.id, seq: e.seq, at: e.at });
  }
  return out;
}
