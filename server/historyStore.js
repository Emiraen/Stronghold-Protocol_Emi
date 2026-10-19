// Private match history keyed by the existing anonymous hello.aid (not authentication).
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SEATS, ENTERTAINMENT_MAX_SEATS, CYCLOPS_MAX_SEATS, ENDLESS_VARIANT } from '../shared/constants.js';

const MAX_MATCHES = 10;
const MAX_RESULT_BYTES = 48 * 1024;
const validAid = (aid) => typeof aid === 'string' && /^[0-9a-f]{8,64}$/.test(aid);
const validMatchId = (id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);
/** 娱乐系变体（多人同盟 / 独眼巨人冲锋）：非排位、扩容上限独立。 */
const isEntertainmentVariant = (v) => v === 'entertainment_multi' || v === 'entertainment_cyclops' || v === ENDLESS_VARIANT;
const seatsOf = (v) => v === 'entertainment_cyclops' ? CYCLOPS_MAX_SEATS : v === 'entertainment_multi' || v === ENDLESS_VARIANT ? ENTERTAINMENT_MAX_SEATS : MAX_SEATS;
const text = (value, length = 64) => typeof value === 'string' ? value.slice(0, length) : '';
const integer = (value) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function clean(value, depth = 0) {
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (depth >= 16) throw new RangeError('result too deep');
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  if (!plain(value)) return null;
  const out = {};
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype'
        || /^(aid|clientAid|token|resumeToken|password|passwordHash|secret|addr|limitKey|debugAuthorized|devOps)$/i.test(key)) continue;
    out[key] = clean(value[key], depth + 1);
  }
  return out;
}

function resultOf(summary) {
  try {
    if (!plain(summary) || !Array.isArray(summary.players)) return null;
    const entertainment = summary.mode === 'coop' && isEntertainmentVariant(summary.variant);
    if (summary.players.length > seatsOf(summary.variant)) return null;
    const result = clean(summary);
    result.t = 'm.result';
    delete result.errors;
    const byteLimit = entertainment ? MAX_RESULT_BYTES * (ENTERTAINMENT_MAX_SEATS / MAX_SEATS) : MAX_RESULT_BYTES;
    return Buffer.byteLength(JSON.stringify(result)) <= byteLimit ? result : null;
  } catch { return null; }
}

function sanitizeEntry(entry) {
  if (!plain(entry) || !validMatchId(entry.matchId) || !Number.isFinite(entry.at)
      || typeof entry.playerId !== 'string' || !validAid(entry.aid)) return null;
  const result = resultOf(entry.result);
  if (!result) return null;
  const row = result.players.find((p) => p?.playerId === entry.playerId);
  const item = { matchId: entry.matchId, at: integer(entry.at), victory: !!row?.victory,
    ranked: result.unofficial !== true && !isEntertainmentVariant(result.variant) && !!entry.ranked,
    ...(result.unofficial === true ? { unofficial: true } : {}),
    mode: text(result.mode), variant: isEntertainmentVariant(result.variant) ? text(result.variant) : null,
    difficulty: text(result.difficulty), modeId: text(result.modeId),
    roundsPassed: integer(row?.roundsPassed), playerId: text(entry.playerId), name: text(entry.name) };
  if (item.ranked && row?.rank != null) {
    const rank = clean(row.rank);
    if (Buffer.byteLength(JSON.stringify(rank)) <= 2048) item.rank = rank;
  }
  return { aid: entry.aid, ...item, result };
}

// 三个私有 JSON store 共用；同一轮更新合并，始终只写一个临时快照。
export class StoreWriter {
  constructor(file, snapshot, log, label) {
    this.file = file;
    this.snapshot = snapshot;
    this.log = log;
    this.label = label;
    this.revision = 0;
    this.dirty = false;
    this.pending = null;
  }

  save() {
    if (!this.file) return;
    this.revision++;
    this.dirty = true;
    this.start();
  }

  start() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      try {
        while (this.dirty) {
          const revision = this.revision;
          const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
          this.dirty = false;
          try {
            const data = JSON.stringify(this.snapshot());
            await mkdir(dirname(this.file), { recursive: true });
            await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
            // 检查与换名必须同一同步段，不能覆盖期间成功保存的新配置。
            if (revision === this.revision) renameSync(tmp, this.file);
            else await unlink(tmp);
          } catch (error) {
            try { await unlink(tmp); } catch { /* 临时文件可能尚未创建 */ }
            if (revision !== this.revision) continue;
            this.dirty = true;
            throw error;
          }
        }
        return true;
      } catch (error) {
        this.error = error;
        this.log?.error?.(`[${this.label}] save failed: ${error.message}`);
        return false;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  saveSync() {
    if (!this.file) return true;
    this.revision++;
    const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.snapshot()), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
      this.dirty = false;
      return true;
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* 临时文件可能尚未创建 */ }
      this.dirty = true;
      this.log?.error?.(`[${this.label}] save failed: ${error.message}`);
      return false;
    }
  }

  async flush() {
    if (!this.file) return;
    const ok = await (this.pending || (this.dirty ? this.start() : true));
    if (!ok) throw this.error;
  }
}

export class HistoryStore {
  constructor({ file = null, now = Date.now, log = null } = {}) {
    this.file = file === null ? null : resolve(file);
    this.now = now;
    this.log = log;
    this.profiles = new Map();
    this.writer = new StoreWriter(this.file, () => ({ version: 1,
      profiles: [...this.profiles].map(([aid, value]) => ({ aid, ...value })) }), this.log, 'history');
    if (!this.file) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(data?.profiles)) return;
      for (const profile of data.profiles) {
        if (!validAid(profile?.aid) || !Array.isArray(profile.items)) continue;
        const items = profile.items.map(sanitizeEntry).filter((entry) => entry && entry.aid === profile.aid).slice(0, MAX_MATCHES);
        if (items.length) this.profiles.set(profile.aid, { name: text(profile.name), items });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log?.warn?.(`[history] cannot read ${this.file}: ${error.message}`);
    }
  }

  list(aid) {
    if (!validAid(aid)) return [];
    return (this.profiles.get(aid)?.items || []).map(({ aid: _aid, result: _result, ...item }) => ({ ...item }));
  }

  detail(aid, matchId, playerId = null) {
    if (!validAid(aid) || !validMatchId(matchId)) return null;
    const entry = this.profiles.get(aid)?.items.find((item) => item.matchId === matchId && (!playerId || item.playerId === playerId));
    return entry ? { matchId: entry.matchId, at: entry.at, result: entry.result, playerId: entry.playerId } : null;
  }

  record({ matchId, at = this.now(), seats, ranked, summary }) {
    if (!validMatchId(matchId) || !Array.isArray(seats)) return false;
    const result = resultOf(summary);
    if (!result) {
      this.log?.warn?.(`[history] skipped invalid or oversized result for ${matchId}`);
      return false;
    }
    let changed = false;
    for (const seat of seats) {
      if (seat.isBot || !validAid(seat.aid) || !result.players.some((row) => row?.playerId === seat.playerId)) continue;
      let profile = this.profiles.get(seat.aid);
      if (!profile) { profile = { name: text(seat.name), items: [] }; this.profiles.set(seat.aid, profile); }
      if (profile.items.some((item) => item.matchId === matchId && item.playerId === seat.playerId)) continue;
      profile.name = text(seat.name);
      const entry = sanitizeEntry({ aid: seat.aid, matchId, at, ranked, playerId: seat.playerId, name: seat.name, result });
      if (!entry) continue;
      profile.items.unshift(entry);
      profile.items.length = Math.min(profile.items.length, MAX_MATCHES);
      changed = true;
    }
    if (changed) this.save();
    return true;
  }

  save() { this.writer.save(); }

  flush() { return this.writer.flush(); }
}

// The HTTP static mounts expose public/, data/, shared/, and server/sim/ only.
export function defaultHistoryStore(log) {
  return new HistoryStore({ file: process.env.HISTORY_FILE || resolve(dirname(fileURLToPath(import.meta.url)), '..', 'match-history.json'), log });
}
