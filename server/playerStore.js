// Private registry of anonymous player profiles. An aid is client-reported, not authentication.
import { randomBytes } from 'node:crypto';
import { sanitizeName } from './net.js';
import { isLoadoutEntries, isLoadoutOps, isPresentation } from '../shared/protocol.js';
import { readFileSync } from 'node:fs';
import { StoreWriter } from './historyStore.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const validAid = (aid) => typeof aid === 'string' && /^[0-9a-f]{8,64}$/.test(aid);
const validTime = (value) => Number.isSafeInteger(value) && value > 0;
const nameOf = (value) => typeof value === 'string' ? value.slice(0, 64) : '';
const newId = () => randomBytes(16).toString('hex');

export class PlayerStore {
  constructor({ file = null, now = Date.now, log = null } = {}) {
    this.file = file === null ? null : resolve(file);
    this.now = now;
    this.log = log;
    // Internal only: never serialize this Map or expose its aid keys through the public list.
    this.profiles = new Map();
    this.writer = new StoreWriter(this.file, () => ({ version: 1,
      profiles: [...this.profiles.values()] }), this.log, 'players');
    if (!this.file) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(data?.profiles)) return;
      const ids = new Set();
      for (const value of data.profiles) {
        if (!validAid(value?.aid)) continue;
        const id = typeof value.id === 'string' && /^[0-9a-f]{32}$/.test(value.id) && !ids.has(value.id)
          ? value.id : newId();
        if (!validTime(value.firstSeen) || !validTime(value.lastSeen) || this.profiles.has(value.aid)) continue;
        ids.add(id);
        this.profiles.set(value.aid, {
          id, aid: value.aid, name: nameOf(value.name), firstSeen: value.firstSeen,
          lastSeen: Math.max(value.lastSeen, value.firstSeen),
          ...(value.loadout?.v === 1 && isLoadoutEntries(value.loadout.entries)
            ? { loadout: { v: 1, entries: structuredClone(value.loadout.entries),
              ops: isLoadoutOps(value.loadout.ops) ? structuredClone(value.loadout.ops) : {} } } : {}),
          ...(value.presentation?.v === 1 && isPresentation(value.presentation.value)
            ? { presentation: structuredClone(value.presentation) } : {}),
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log?.warn?.(`[players] cannot read ${this.file}: ${error.message}`);
    }
  }

  get size() { return this.profiles.size; }

  /** 公共名字只选择现有档案，不搬迁、删除或合并旧积分。 */
  resolveName(name, requestedAid, { ranked, history, registry, joining } = {}) {
    const normalized = sanitizeName(name);
    if (!normalized) return null;
    const candidates = new Map();
    // 注册表是名字来源；旧排位/历史只补充尚未登记的 aid。
    for (const store of [this, ranked, history]) {
      for (const [aid, profile] of store?.profiles || []) {
        if (!validAid(aid) || candidates.has(aid)) continue;
        candidates.set(aid, { aid, name: sanitizeName(profile.name) });
      }
    }
    const online = new Set();
    for (const peer of registry?.all?.() || []) {
      // 新连接报告的 aid 不是已经在线的档案，不能用它绕过最高段位选择。
      if (!peer.connected || (peer === joining && (!peer.profileBound || !peer.helloWasOnline || peer.profileName !== normalized)) || !validAid(peer.aid)) continue;
      if (sanitizeName(peer.name) === normalized) {
        online.add(peer.aid);
        if (!candidates.has(peer.aid)) candidates.set(peer.aid, { aid: peer.aid, name: normalized });
      }
    }
    const matching = [...candidates.values()].filter((p) => p.name === normalized);
    matching.sort((a, b) => {
      const activeA = online.has(a.aid), activeB = online.has(b.aid);
      if (activeA !== activeB) return activeA ? -1 : 1;
      // 多个在线不按动态积分或轮次排序，避免结算时来回切换。
      if (!activeA) {
        const pa = ranked?.profile(a.aid), pb = ranked?.profile(b.aid);
        const placed = Number(!!pb?.placementDone) - Number(!!pa?.placementDone);
        if (placed) return placed;
        const points = (pb?.points || 0) - (pa?.points || 0);
        if (points) return points;
      }
      return a.aid < b.aid ? -1 : a.aid > b.aid ? 1 : 0;
    });
    if (matching.length) return matching[0].aid;
    // 换名不能覆盖另一个名字的档案；无有效客户端 aid 时仍生成一个公共档案键。
    return validAid(requestedAid) && !candidates.has(requestedAid) ? requestedAid : newId();
  }

  /** Register a real hello. Sessions without a valid client-reported aid are never persisted. */
  record(aid, name) {
    if (!validAid(aid)) return null;
    const at = this.now();
    if (!validTime(at)) return null;
    let profile = this.profiles.get(aid);
    if (!profile) {
      profile = { id: newId(), aid, name: nameOf(name), firstSeen: at, lastSeen: at };
      this.profiles.set(aid, profile);
    } else {
      const nextName = nameOf(name);
      // A repeated hello on a live socket must not force an atomic disk rewrite each time.
      if (profile.name === nextName && at - profile.lastSeen < 60_000) return profile.id;
      profile.name = nextName;
      profile.lastSeen = Math.max(profile.lastSeen, at);
    }
    this.writer.save();
    return profile.id;
  }

  getPresentation(aid) {
    const value = this.profiles.get(aid)?.presentation;
    return value ? structuredClone(value) : null;
  }

  setPresentation(aid, value) {
    const profile = this.profiles.get(aid);
    if (!profile || value?.v !== 1 || !isPresentation(value.value)) throw new Error('invalid profile presentation');
    const previous = profile.presentation;
    // Older clients send only skins/voice. Preserve cloud appearance fields they do not know.
    const merged = { ...value.value };
    for (const key of ['portraits', 'card']) {
      if (merged[key] === undefined && previous?.value?.[key] !== undefined) merged[key] = previous.value[key];
    }
    profile.presentation = structuredClone({ ...value, value: merged });
    if (!this.save()) {
      if (previous === undefined) delete profile.presentation;
      else profile.presentation = previous;
      throw new Error('presentation save failed');
    }
  }

  getLoadout(aid) {
    const value = this.profiles.get(aid)?.loadout;
    return value ? structuredClone(value) : null;
  }

  /** 保存失败恢复原内存值；只有原子换名成功后才能通知客户端。 */
  setLoadout(aid, value) {
    const profile = this.profiles.get(aid);
    if (!profile || value?.v !== 1 || !isLoadoutEntries(value.entries) || (value.ops != null && !isLoadoutOps(value.ops))) throw new Error('invalid profile loadout');
    const previous = profile.loadout;
    profile.loadout = { v: 1, entries: structuredClone(value.entries), ops: structuredClone(value.ops || {}) };
    if (!this.save()) {
      if (previous === undefined) delete profile.loadout;
      else profile.loadout = previous;
      throw new Error('loadout save failed');
    }
  }

  /** Import historical identities once on startup, merging ranked/history by aid. */
  mergeExisting(ranked, history) {
    let changed = false;
    const merge = (aid, name, times) => {
      if (!validAid(aid)) return;
      const dates = times.filter(validTime);
      if (!dates.length && this.profiles.has(aid)) return;
      const first = dates.length ? Math.min(...dates) : this.now();
      const last = dates.length ? Math.max(...dates) : first;
      if (!validTime(first)) return;
      let profile = this.profiles.get(aid);
      if (!profile) {
        profile = { id: newId(), aid, name: nameOf(name), firstSeen: first, lastSeen: last };
        this.profiles.set(aid, profile);
        changed = true;
      } else {
        const oldFirst = profile.firstSeen;
        const oldLast = profile.lastSeen;
        const oldName = profile.name;
        profile.firstSeen = Math.min(profile.firstSeen, first);
        profile.lastSeen = Math.max(profile.lastSeen, last);
        if (!profile.name && name) profile.name = nameOf(name);
        if (profile.firstSeen !== oldFirst || profile.lastSeen !== oldLast || profile.name !== oldName) changed = true;
      }
    };
    for (const [aid, profile] of ranked?.profiles || []) merge(aid, profile?.name, [profile?.lastActive]);
    for (const [aid, profile] of history?.profiles || []) {
      merge(aid, profile?.name, Array.isArray(profile?.items) ? profile.items.map((item) => item?.at) : []);
    }
    if (changed) this.writer.save();
  }

  /** Safe to serialize: no aid, socket token, network address, or other private fields. */
  list() {
    return [...this.profiles.values()].map(({ name, firstSeen, lastSeen }) => ({ name, firstSeen, lastSeen }));
  }

  /** Internal-only association for an admin snapshot; never send the returned aid to clients. */
  internalSnapshot() {
    return [...this.profiles.values()].map(({ id, aid, name, firstSeen, lastSeen }) => ({ id, aid, name, firstSeen, lastSeen }));
  }

  save() { return this.writer.saveSync(); }

  flush() { return this.writer.flush(); }
}

// Unlike public/data/, this file lives at the private repository root by default.
export function defaultPlayerStore(log) {
  return new PlayerStore({ file: process.env.PLAYER_FILE || resolve(dirname(fileURLToPath(import.meta.url)), '..', 'player-registry.json'), log });
}
