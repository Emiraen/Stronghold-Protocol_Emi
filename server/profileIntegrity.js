import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isNameCardGrantMigration } from './nameCardUnlocks.js';

const aidOK = value => typeof value === 'string' && /^[0-9a-f]{8,64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const fields = new Set(['identity', 'loadout', 'presentation', 'rank', 'history']);
const storeFor = field => field === 'rank' ? 'ranked' : field === 'history' ? 'history' : 'players';
const receiptError = () => Object.assign(new Error('历史经济结算或档案交接回执不明，已停止自动重放'),
  { code: 'RESULT_SETTLEMENT_FAILED', receipt: 'unknown' });

function durableWrite(file, state) {
  if (!file) return;
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(state));
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, file);
    let dir;
    try { dir = openSync(directory, 'r'); fsyncSync(dir); }
    catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(error.code)) throw error; }
    finally { if (dir !== undefined) closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function validateIntent(intent) {
  if (!object(intent) || !['record', 'loadout', 'presentation', 'rank.nameCards', 'complete', 'historyRecord'].includes(intent.op)
    || !Array.isArray(intent.args) || !Array.isArray(intent.plan)
    || intent.plan.some(entry => !aidOK(entry?.aid) || !object(entry.before)
      || Object.keys(entry.before).some(field => !fields.has(field)))) throw new Error('本地档案恢复 intent 无效');
}

function validateCommit(commit) {
  if (!object(commit)) throw new Error('本地档案恢复 commit 无效');
  if (commit.snapshot) {
    for (const name of ['players', 'ranked', 'history']) {
      if (!Array.isArray(commit.snapshot[name]) || commit.snapshot[name].some(row => !Array.isArray(row)
        || row.length !== 2 || !aidOK(row[0]) || !object(row[1])
        || (name === 'history' ? Object.hasOwn(row[1], 'aid') && row[1].aid !== row[0] : row[1].aid !== row[0]))) {
        throw new Error('本地档案恢复快照无效');
      }
    }
  } else if (!Array.isArray(commit.patches) || commit.patches.some(patch => !aidOK(patch?.aid)
    || !object(patch.fields) || Object.keys(patch.fields).some(field => !fields.has(field)))) {
    throw new Error('本地档案恢复字段无效');
  }
}

function validateState(state) {
  if (!object(state) || state.schema !== 1 || state.mode !== 'local'
    || !object(state.economicQuarantine) || !object(state.pendingNameCardUnlocks)
    || !object(state.nameCardGrantSnapshots) || !Array.isArray(state.unresolvedHandoffs)
    || state.unresolvedHandoffs.some(aid => !aidOK(aid))) throw new Error('本地档案完整性状态无效');
  if (state.intent) validateIntent(state.intent);
  if (state.commit) validateCommit(state.commit);
  for (const intent of Object.values(state.economicQuarantine)) {
    validateIntent(intent);
    if (intent.op !== 'complete') throw new Error('本地经济隔离记录无效');
  }
  const peer = state.peerEconomicQuarantine;
  if (peer !== undefined && (!object(peer) || typeof peer.rankingPending !== 'boolean'
    || !Array.isArray(peer.aids) || peer.aids.some(aid => !aidOK(aid)))) throw new Error('历史经济隔离状态无效');
  for (const [aid, pending] of Object.entries(state.pendingNameCardUnlocks)) {
    if (!aidOK(aid) || !object(pending) || typeof pending.earned !== 'boolean'
      || !Array.isArray(pending.migrations) || pending.migrations.some(migration => !isNameCardGrantMigration(migration))) {
      throw new Error('待发名片记录无效');
    }
  }
  for (const [migration, snapshot] of Object.entries(state.nameCardGrantSnapshots)) {
    if (!isNameCardGrantMigration(migration) || !object(snapshot) || !Array.isArray(snapshot.aids)
      || snapshot.aids.some(aid => !aidOK(aid))) throw new Error('纪念名片冻结名单无效');
  }
}

function importLegacy(legacy) {
  if (!object(legacy) || legacy.schema !== 1 || legacy.role !== 'main'
    || !Array.isArray(legacy.log) || !Array.isArray(legacy.pending)) throw new Error('旧主服档案复制日志无效');
  // The replication event log and per-field versions are obsolete. Retain only
  // unresolved facts and entitlement metadata; the original file remains intact.
  const state = { schema: 1, mode: 'local', migratedAt: Date.now(),
    economicQuarantine: clone(legacy.economicQuarantine || {}),
    pendingNameCardUnlocks: clone(legacy.pendingNameCardUnlocks || {}),
    nameCardGrantSnapshots: clone(legacy.nameCardGrantSnapshots || {}),
    unresolvedHandoffs: [...new Set([
      ...Object.entries(legacy.owners || {}).filter(([, owner]) => owner?.serverId === 'secondary').map(([aid]) => aid),
      ...legacy.pending.map(patch => patch?.aid), ...(legacy.releases || []).map(release => release?.aid),
    ])],
    ...(legacy.peerEconomicQuarantine ? { peerEconomicQuarantine: clone(legacy.peerEconomicQuarantine) } : {}),
    ...(legacy.commit ? { commit: clone(legacy.commit) } : {}),
    ...(legacy.intent ? { intent: clone(legacy.intent) } : {}) };
  validateState(state);
  return state;
}

/** Local recovery/fencing only. It never creates replication events or grants. */
export class LocalProfileIntegrity {
  #economicContext = new AsyncLocalStorage();
  #economicExecutions = new WeakSet();
  #economicAttempts = new WeakSet();

  constructor({ stores, file = null, legacyFile = null, execute }) {
    this.stores = stores; this.file = file; this.execute = execute;
    this.serial = Promise.resolve(); this.recovered = false;
    let loaded = false;
    if (file) {
      try { this.state = JSON.parse(readFileSync(file, 'utf8')); loaded = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!loaded) {
      this.state = { schema: 1, mode: 'local', migratedAt: Date.now(), economicQuarantine: {},
        pendingNameCardUnlocks: {}, nameCardGrantSnapshots: {}, unresolvedHandoffs: [] };
      if (legacyFile) {
        try { this.state = importLegacy(JSON.parse(readFileSync(legacyFile, 'utf8'))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      // This durable marker makes later starts independent of the large dormant file.
      this.save();
    }
    validateState(this.state);
  }
  get initialized() { return this.recovered; }
  save() { durableWrite(this.file, this.state); }
  quarantinedIntents() {
    return this.#quarantinedIntents();
  }
  #quarantinedIntents(exceptJob = null) {
    return [...Object.values(this.state.economicQuarantine),
      ...(this.state.intent?.op === 'complete' ? [this.state.intent] : []),
      ...[...(this.pendingResults?.jobs?.values() || [])].filter(job => job.op === 'complete' && job.blocked
        && job !== exceptJob && this.pendingResults.activeId !== job.id && !this.pendingResults.firstEconomicAttempts.has(job))
        .map(job => ({ op: job.op, args: job.args, plan: (job.args[0]?.seats || [])
          .filter(seat => !seat.isBot && aidOK(seat.aid))
          .map(seat => ({ aid: seat.aid, before: job.args[0]?.ranked ? { rank: null } : {} })) }))];
  }
  quarantinedAids() {
    return this.#quarantinedAids();
  }
  #quarantinedAids(exceptJob = null) {
    return new Set([...this.#quarantinedIntents(exceptJob).flatMap(intent => [
      ...intent.plan.map(entry => entry.aid), ...(intent.args[0]?.seats || []).filter(seat => !seat.isBot).map(seat => seat.aid),
    ]), ...this.state.unresolvedHandoffs, ...(this.state.peerEconomicQuarantine?.aids || [])].filter(aidOK));
  }
  hasRankUncertainty() {
    return this.#hasRankUncertainty();
  }
  #hasRankUncertainty(exceptJob = null) {
    return this.state.unresolvedHandoffs.length > 0 || this.state.peerEconomicQuarantine?.rankingPending === true
      || this.#quarantinedIntents(exceptJob).some(intent => intent.args[0]?.ranked
        || intent.plan.some(entry => Object.hasOwn(entry.before, 'rank')));
  }
  #ownedEconomicJob() {
    const owner = this.#economicContext.getStore();
    return owner && this.#economicExecutions.has(owner)
      && this.pendingResults?.jobs.get(owner.job.id) === owner.job ? owner.job : null;
  }
  ownEconomicExecution(job, work) {
    if (job.op !== 'complete') return work();
    if (this.pendingResults?.jobs.get(job.id) !== job || this.pendingResults.activeId !== job.id
      || this.#economicAttempts.has(job)) throw receiptError();
    const owner = Object.freeze({ job });
    this.#economicAttempts.add(job);
    this.#economicExecutions.add(owner);
    // This scope follows the actual authority promise, even if its public wait
    // has timed out. No second dispatch can obtain this invocation's owner.
    return this.#economicContext.run(owner, async () => {
      try { return await work(); }
      finally { this.#economicExecutions.delete(owner); }
    });
  }
  authorizeFinalReceiptSnapshot(aid) {
    const job = this.#ownedEconomicJob();
    if (!job || !(job.args[0]?.seats || []).some(seat => !seat.isBot && seat.aid === aid)) throw receiptError();
    // Only the post-flush receipt builder may ignore its own pending fence.
    // Legacy uncertainty and every other pending job remain authoritative.
    this.#assertIndependent('read', [aid], job);
    return this.#hasRankUncertainty(job);
  }
  assertIndependent(op, args = []) {
    let ownJob = null;
    if (op === 'complete' && this.pendingResults) {
      ownJob = this.#ownedEconomicJob();
      // Economic execution is owned by the already durable local pending job.
      // A dormant RPC caller cannot bypass its single-attempt receipt fence.
      if (ownJob?.op !== 'complete' || ownJob.args !== args) throw receiptError();
    }
    this.#assertIndependent(op, args, ownJob);
  }
  #assertIndependent(op, args, exceptJob = null) {
    const affected = this.#quarantinedAids(exceptJob);
    const rankUncertain = this.#hasRankUncertainty(exceptJob);
    if (!affected.size && !rankUncertain) return;
    if (['bootstrap', 'snapshot', 'rank.nameCards'].includes(op)
      || rankUncertain && (op === 'leaderboard' || op === 'complete' && args[0]?.ranked)) throw receiptError();
    const matchId = op === 'complete' ? args[0]?.match?.matchId : op === 'historyRecord' ? args[0]?.matchId : null;
    if (matchId && this.#quarantinedIntents(exceptJob).some(intent => intent.args[0]?.match?.matchId === matchId)) throw receiptError();
    const aids = ['login', 'read', 'record', 'loadout', 'presentation', 'historyList', 'historyDetail', 'grant'].includes(op)
      ? [args[0]] : ['complete', 'historyRecord'].includes(op)
        ? (args[0]?.seats || []).filter(seat => !seat.isBot).map(seat => seat.aid) : [];
    if (aids.some(aid => affected.has(aid))) throw receiptError();
  }
  run(work) {
    const next = this.serial.then(async () => { await this.recover(); return work(); });
    this.serial = next.catch(() => {});
    return next;
  }
  put(aid, field, value) {
    const store = this.stores[storeFor(field)];
    if (field === 'rank' || field === 'history') {
      if (value === null) {
        if (store.profiles.has(aid)) throw new Error('旧恢复 commit 要求删除现有玩家记录，拒绝自动处理');
        return;
      }
      if (!object(value) || (field === 'history'
        ? Object.hasOwn(value, 'aid') && value.aid !== aid : value.aid !== aid)) throw new Error('旧恢复 commit 的玩家身份无效');
      const restored = clone(value);
      if (field === 'history') delete restored.aid;
      const existing = store.profiles.get(aid);
      const current = existing && field === 'history' ? { ...existing } : existing;
      if (current && field === 'history') {
        if (Object.hasOwn(current, 'aid') && current.aid !== aid) throw new Error('现有历史记录的玩家身份无效');
        delete current.aid;
      }
      if (current && !isDeepStrictEqual(current, restored)) {
        throw new Error('旧恢复 commit 与现有玩家档案冲突，保留原档案并停止自动恢复');
      }
      store.profiles.set(aid, restored);
    } else if (field === 'identity') {
      if (!object(value) || value.aid !== aid) throw new Error('旧恢复 commit 的玩家身份无效');
      const previous = store.profiles.get(aid);
      if (previous) {
        const identity = { ...previous };
        delete identity.loadout; delete identity.presentation;
        if (!isDeepStrictEqual(identity, value)) throw new Error('旧恢复 commit 与现有玩家身份冲突');
      }
      store.profiles.set(aid, { ...clone(value), ...(previous?.loadout ? { loadout: previous.loadout } : {}),
        ...(previous?.presentation ? { presentation: previous.presentation } : {}) });
    } else {
      const player = store.profiles.get(aid);
      if (!player) throw new Error('旧恢复字段缺少玩家身份');
      if (value === null) {
        if (player[field] !== undefined) throw new Error('旧恢复 commit 要求删除现有玩家配置，拒绝自动处理');
      } else {
        if (!object(value)) throw new Error('旧恢复 commit 的玩家配置无效');
        if (player[field] !== undefined && !isDeepStrictEqual(player[field], value)) {
          throw new Error('旧恢复 commit 与现有玩家配置冲突');
        }
        player[field] = clone(value);
      }
    }
  }
  async recover() {
    if (this.recovered) return;
    // Freeze the old cohort before replaying any deferred entitlement operation.
    for (const [migration, snapshot] of Object.entries(this.state.nameCardGrantSnapshots)) {
      const frozen = await this.stores.ranked.freezeNameCardGrantSnapshot(migration, snapshot.aids);
      if (!isDeepStrictEqual([...new Set(snapshot.aids)].sort(), [...frozen].sort())) throw new Error('纪念名片冻结名单副本不一致');
    }
    const commit = this.state.commit;
    if (commit) {
      const changed = new Map();
      const mark = (name, aid) => { if (!changed.has(name)) changed.set(name, new Set()); changed.get(name).add(aid); };
      if (commit.snapshot) {
        // Merge established records; a copied snapshot cannot erase extra local players.
        for (const name of ['players', 'ranked', 'history']) for (const [aid, value] of commit.snapshot[name]) {
          if (name === 'players') {
            const existing = this.stores.players.profiles.get(aid);
            if (existing && !isDeepStrictEqual(existing, value)) throw new Error('旧恢复快照与现有玩家配置冲突');
            this.stores.players.profiles.set(aid, clone(value));
          } else this.put(aid, name === 'ranked' ? 'rank' : 'history', value);
          mark(name, aid);
        }
      } else for (const patch of commit.patches) for (const [field, value] of Object.entries(patch.fields)) {
        this.put(patch.aid, field, value); mark(storeFor(field), patch.aid);
      }
      for (const [name, aids] of changed) this.stores[name].writer.save(aids);
      await Promise.all([...changed.keys()].map(name => this.stores[name].flush()));
      delete this.state.commit;
      try { this.save(); } catch (error) { this.state.commit = commit; throw error; }
    }
    const intent = this.state.intent;
    if (intent) {
      if (intent.op === 'complete') {
        const matchId = intent.args[0]?.match?.matchId;
        if (typeof matchId !== 'string' || !/^[0-9a-f]{32}$/.test(matchId)) throw new Error('旧经济结算缺少有效对局编号');
        const key = `complete:${matchId}`, previous = this.state.economicQuarantine[key];
        if (previous && !isDeepStrictEqual(previous.args, intent.args)) throw new Error('经济隔离编号冲突');
        this.state.economicQuarantine[key] = previous || { ...clone(intent), blocked: { code: 'RESULT_SETTLEMENT_FAILED', receipt: 'unknown' } };
      } else await this.execute(intent.op, clone(intent.args));
      delete this.state.intent;
      try { this.save(); } catch (error) { this.state.intent = intent; throw error; }
    }
    this.recovered = true;
  }
  async freezeNameCardGrantSnapshot(migration, aids) {
    const previous = this.state.nameCardGrantSnapshots[migration];
    const frozen = await this.stores.ranked.freezeNameCardGrantSnapshot(migration, previous ? previous.aids : aids);
    if (previous && !isDeepStrictEqual([...new Set(previous.aids)].sort(), [...frozen].sort())) throw new Error('纪念名片冻结名单副本不一致');
    if (!previous) {
      this.state.nameCardGrantSnapshots[migration] = { createdAt: Date.now(), aids: frozen };
      try { this.save(); } catch (error) { delete this.state.nameCardGrantSnapshots[migration]; throw error; }
    }
    return clone(frozen);
  }
  async completeDeferredNameCardUnlock(aid, migration) {
    const previous = this.state.pendingNameCardUnlocks[aid];
    if (!previous) return;
    const next = { earned: previous.earned && migration !== null,
      migrations: previous.migrations.filter(value => value !== migration) };
    if (next.earned || next.migrations.length) this.state.pendingNameCardUnlocks[aid] = next;
    else delete this.state.pendingNameCardUnlocks[aid];
    try { this.save(); } catch (error) { this.state.pendingNameCardUnlocks[aid] = previous; throw error; }
  }
}
